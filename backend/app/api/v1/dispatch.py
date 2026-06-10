from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload
from typing import List, Optional
from app.database import get_db
from app.models.dispatch import DispatchOrder, DispatchOrderItem
from app.models.master import Item
from app.models.indent import Indent
from app.models.issue import MaterialIssue
from app.schemas.dispatch import DispatchCreate, DispatchUpdate, DispatchResponse
from app.services.number_series import generate_number
from app.utils.dependencies import get_current_user
from app.utils.helpers import paginate_params, build_paginated_response, apply_search_filter
from app.models.user import User

router = APIRouter()

async def process_dispatch_stock_deduction(db: AsyncSession, d: DispatchOrder, created_by_id: int):
    # Prevent duplicate stock deductions
    from app.models.stock import StockLedger
    ledger_check = await db.execute(
        select(StockLedger).where(
            StockLedger.reference_type == "dispatch_order",
            StockLedger.reference_id == d.id,
            StockLedger.qty_out > 0
        ).limit(1)
    )
    if ledger_check.scalar_one_or_none():
        # Already processed!
        return

    from app.services.stock_service import release_reservation, post_stock_ledger
    from decimal import Decimal
    from app.models.issue import MaterialIssue, MaterialIssueItem
    from app.models.dispatch import DispatchOrderItem
    from datetime import datetime, timezone
    
    # Fetch items directly from the database to prevent lazy-loading MissingGreenlet exceptions
    items_res = await db.execute(
        select(DispatchOrderItem).where(DispatchOrderItem.dispatch_order_id == d.id)
    )
    items = items_res.scalars().all()

    # Pre-fetch all matching MaterialIssueItems to handle split rows sequentially
    used_mi_item_ids = set()
    mi_ids = {d.material_issue_id}
    for item in items:
        if item.material_issue_id:
            mi_ids.add(item.material_issue_id)
    mi_ids = {mid for mid in mi_ids if mid is not None}
    
    mi_items = []
    if mi_ids:
        from app.models.issue import MaterialIssueItem
        mi_items_res = await db.execute(
            select(MaterialIssueItem)
            .where(MaterialIssueItem.issue_id.in_(mi_ids))
            .order_by(MaterialIssueItem.id.asc())
        )
        mi_items = list(mi_items_res.scalars().all())

    for item in items:
        batch_id = None
        bin_id = None
        rate = Decimal("0")
        uom_id = 1
        
        # Match with the first unused mi_item for this material
        mi_item = None
        target_mi_id = item.material_issue_id or d.material_issue_id
        for mi_it in mi_items:
            if mi_it.item_id == item.material_id and mi_it.issue_id == target_mi_id and mi_it.id not in used_mi_item_ids:
                mi_item = mi_it
                used_mi_item_ids.add(mi_it.id)
                break
                
        if not mi_item and target_mi_id:
            # Fallback to the first matching one
            mi_item = next((mi_it for mi_it in mi_items if mi_it.item_id == item.material_id and mi_it.issue_id == target_mi_id), None)
            
        if mi_item:
            batch_id = mi_item.batch_id
            bin_id = mi_item.bin_id
            rate = mi_item.rate or Decimal("0")
            uom_id = mi_item.uom_id or 1
                
        # 1. Release reservation in source warehouse
        await release_reservation(
            db,
            item_id=item.material_id,
            warehouse_id=d.warehouse_id,
            qty=item.dispatched_quantity,
            bin_id=bin_id,
            batch_id=batch_id,
        )
        
        # 2. Post stock ledger entry to physically deduct stock from source warehouse
        await post_stock_ledger(
            db,
            item_id=item.material_id,
            warehouse_id=d.warehouse_id,
            transaction_type="material_issue",
            qty_out=item.dispatched_quantity,
            rate=rate,
            bin_id=bin_id,
            batch_id=batch_id,
            reference_type="dispatch_order",
            reference_id=d.id,
            uom_id=uom_id,
            created_by=created_by_id,
        )

        # 3. For inter-warehouse transfers, increase the transit_qty in the source warehouse
        if d.destination_warehouse_id and d.destination_warehouse_id != d.warehouse_id:
            from app.services.stock_service import _get_or_create_balance
            src_balance = await _get_or_create_balance(
                db,
                item_id=item.material_id,
                warehouse_id=d.warehouse_id,
                bin_id=bin_id,
                batch_id=batch_id,
                lock=True,
            )
            src_balance.transit_qty = (src_balance.transit_qty or Decimal("0")) + Decimal(str(item.dispatched_quantity))

    # Automatically transition the linked MaterialIssue status to "dispatched"
    if d.material_issue_id:
        mi_res = await db.execute(select(MaterialIssue).where(MaterialIssue.id == d.material_issue_id))
        mi = mi_res.scalar_one_or_none()
        if mi:
            mi.status = "dispatched"
            mi.dispatched_at = datetime.now(timezone.utc)
            db.add(mi)


async def sync_mdos_to_dispatches(db: AsyncSession):
    try:
        from app.models.logistics import LogisticsMainDispatchOrder, LogisticsSubDispatchOrder, LogisticsDispatchMaterial
        from app.models.issue import MaterialIssueItem
        from datetime import datetime, timezone
        
        # Select all MDOs that are in active/terminal status
        stmt = select(LogisticsMainDispatchOrder).where(
            LogisticsMainDispatchOrder.status.in_(["DISPATCHED", "IN_TRANSIT", "COMPLETED", "ACKNOWLEDGED"])
        )
        res = await db.execute(stmt)
        mdos = res.scalars().all()
        
        for mdo in mdos:
            # Check if corresponding DispatchOrder already exists (eager-load items for backfill)
            stmt_check = select(DispatchOrder).options(
                selectinload(DispatchOrder.items)
            ).where(DispatchOrder.dispatch_number == mdo.mdo_number)
            res_check = await db.execute(stmt_check)
            existing = res_check.scalar_one_or_none()
            
            # Map statuses
            dt_map = {
                "own vehicle": "OWN_VEHICLE",
                "COURIER": "COURIER",
                "IN_PERSON": "IN_PERSON",
                "THIRD_PARTY": "THIRD_PARTY"
            }
            mapped_dt = dt_map.get(mdo.dispatch_type, "THIRD_PARTY")
            
            st_map = {
                "DISPATCHED": "dispatched",
                "IN_TRANSIT": "in_transit",
                "TRANSPORTER_ACKNOWLEDGED": "in_transit",
                "COMPLETED": "delivered",
                "ACKNOWLEDGED": "acknowledged"
            }
            mapped_st = st_map.get(mdo.status, "in_transit")
            
            if not existing:
                # Create standard DispatchOrder
                disp = DispatchOrder(
                    dispatch_number=mdo.mdo_number,
                    warehouse_id=mdo.warehouse_id,
                    destination_warehouse_id=mdo.destination_warehouse_id,
                    destination_type="WAREHOUSE" if mdo.destination_warehouse_id else "USER",
                    dispatch_type=mapped_dt,
                    status=mapped_st,
                    remarks=mdo.special_instructions,
                    material_issue_id=mdo.material_issue_id,
                    dispatch_date=mdo.order_date,
                    expected_delivery_date=mdo.required_delivery_date,
                    delivery_acknowledged=(mdo.status == "ACKNOWLEDGED")
                )
                db.add(disp)
                await db.flush()
                
                # Fetch MDO's materials from sub-dispatch orders
                stmt_mats = select(LogisticsDispatchMaterial).join(
                    LogisticsSubDispatchOrder, LogisticsSubDispatchOrder.id == LogisticsDispatchMaterial.sdo_id
                ).where(LogisticsSubDispatchOrder.mdo_id == mdo.id)
                res_mats = await db.execute(stmt_mats)
                mats = res_mats.scalars().all()
                
                for mat in mats:
                    # Carry serial_numbers from MDO material if available
                    serial_numbers = mat.serial_numbers
                    # Fallback: pull serial_numbers from the source MaterialIssueItem
                    if not serial_numbers and mdo.material_issue_id:
                        try:
                            mi_item_res = await db.execute(
                                select(MaterialIssueItem).where(
                                    MaterialIssueItem.issue_id == mdo.material_issue_id,
                                    MaterialIssueItem.item_id == mat.material_id
                                ).limit(1)
                            )
                            mi_item = mi_item_res.scalar_one_or_none()
                            if mi_item and mi_item.serial_numbers:
                                serial_numbers = mi_item.serial_numbers
                        except Exception:
                            pass

                    item = DispatchOrderItem(
                        dispatch_order_id=disp.id,
                        material_id=mat.material_id,
                        indent_id=mdo.indent_id,
                        material_issue_id=mdo.material_issue_id,
                        requested_quantity=mat.quantity,
                        approved_quantity=mat.quantity,
                        dispatched_quantity=mat.quantity,
                        uom=mat.unit_of_measure,
                        request_date=mdo.order_date,
                        serial_numbers=serial_numbers
                    )
                    db.add(item)
                await db.flush()

                # Trigger stock deduction if status is dispatched or in_transit
                if mapped_st in ("dispatched", "in_transit"):
                    await process_dispatch_stock_deduction(db, disp, mdo.created_by or 1)
            else:
                existing.expected_delivery_date = mdo.required_delivery_date
                db.add(existing)
                # Keep status in sync in case status changed
                if existing.status != mapped_st:
                    old_status = existing.status
                    existing.status = mapped_st
                    existing.delivery_acknowledged = (mdo.status == "ACKNOWLEDGED")
                    await db.flush()

                    # Trigger stock deduction if transitioning to dispatched or in_transit
                    if mapped_st in ("dispatched", "in_transit") and old_status not in ("dispatched", "in_transit", "delivered", "acknowledged"):
                        await process_dispatch_stock_deduction(db, existing, mdo.created_by or existing.dispatched_by or 1)

                # Update serial_numbers on existing dispatch items from MDO materials (fix for MDOs synced before this fix)
                try:
                    stmt_mats = select(LogisticsDispatchMaterial).join(
                        LogisticsSubDispatchOrder, LogisticsSubDispatchOrder.id == LogisticsDispatchMaterial.sdo_id
                    ).where(LogisticsSubDispatchOrder.mdo_id == mdo.id)
                    res_mats = await db.execute(stmt_mats)
                    mats = res_mats.scalars().all()
                    
                    for mat in mats:
                        # Find matching existing dispatch item
                        existing_item = next(
                            (i for i in (existing.items or []) if i.material_id == mat.material_id),
                            None
                        )
                        if existing_item and not existing_item.serial_numbers:
                            serial_numbers = mat.serial_numbers
                            if not serial_numbers and mdo.material_issue_id:
                                try:
                                    mi_item_res = await db.execute(
                                        select(MaterialIssueItem).where(
                                            MaterialIssueItem.issue_id == mdo.material_issue_id,
                                            MaterialIssueItem.item_id == mat.material_id
                                        ).limit(1)
                                    )
                                    mi_item = mi_item_res.scalar_one_or_none()
                                    if mi_item and mi_item.serial_numbers:
                                        serial_numbers = mi_item.serial_numbers
                                except Exception:
                                    pass
                            if serial_numbers:
                                existing_item.serial_numbers = serial_numbers
                                db.add(existing_item)
                    await db.flush()
                except Exception:
                    pass
        
        await db.flush()
    except Exception as e:
        print(f"Error syncing MDOs to Dispatches: {e}")

@router.get("", response_model=dict)
async def list_dispatches(
    db: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1),
    search: Optional[str] = None,
    status: Optional[str] = None,
    current_user: User = Depends(get_current_user)
):
    await sync_mdos_to_dispatches(db)
    query = select(DispatchOrder).options(
        selectinload(DispatchOrder.items).selectinload(DispatchOrderItem.material),
        selectinload(DispatchOrder.destination_warehouse),
        selectinload(DispatchOrder.destination_user)
    )
    
    if status:
        query = query.where(DispatchOrder.status == status.lower())
        
    if search:
        # Search filter on remarks or dispatch_number
        query = query.where(
            (DispatchOrder.dispatch_number.ilike(f"%{search}%")) |
            (DispatchOrder.remarks.ilike(f"%{search}%"))
        )
        
    # Count total
    total_query = select(func.count()).select_from(query.subquery())
    total_res = await db.execute(total_query)
    total = total_res.scalar() or 0
    
    # Paginate
    query = query.order_by(DispatchOrder.id.desc())
    query = query.offset((page - 1) * page_size).limit(page_size)
    
    res = await db.execute(query)
    headers = res.scalars().all()
    
    items_out = []
    for h in headers:
        header_dict = {
            "id": h.id,
            "dispatch_id": h.dispatch_number,
            "dispatch_date": h.dispatch_date,
            "expected_delivery_date": h.expected_delivery_date,
            "status": h.status.capitalize() if h.status else "Draft",
            "remarks": h.remarks,
            "destination_type": h.destination_type,
            "dispatch_type": h.dispatch_type,
            "warehouse_id": h.warehouse_id,
            "destination_warehouse_id": h.destination_warehouse_id,
            "destination_user_id": h.destination_user_id,
            "destination_warehouse_name": h.destination_warehouse.name if h.destination_warehouse else None,
            "destination_user_name": f"{h.destination_user.first_name} {h.destination_user.last_name or ''}".strip() if h.destination_user else None,
            "delivery_acknowledged": h.delivery_acknowledged,
            "delivery_acknowledged_at": h.delivery_acknowledged_at,
            "delivery_acknowledged_by_name": h.delivery_acknowledged_by_name,
            "receiver_signature_url": h.receiver_signature_url,
            "delivery_photo_urls": h.delivery_photo_urls,
            "goods_condition_on_delivery": h.goods_condition_on_delivery,
            "delivery_remarks": h.delivery_remarks,
            "items": []
        }
        for item in h.items:
            header_dict["items"].append({
                "id": item.id,
                "dispatch_id": h.dispatch_number,
                "material_id": item.material_id,
                "indent_id": item.indent_id,
                "material_issue_id": item.material_issue_id,
                "requested_quantity": item.requested_quantity,
                "approved_quantity": item.approved_quantity,
                "dispatched_quantity": item.dispatched_quantity,
                "uom": item.uom,
                "request_date": item.request_date,
                "material_name": item.material.name if item.material else None,
                "material_code": item.material.item_code if item.material else None,
                "serial_numbers": item.serial_numbers or []
            })
        items_out.append(header_dict)
        
    return build_paginated_response(items_out, total, page, page_size)

@router.get("/{dispatch_id}", response_model=DispatchResponse)
async def get_dispatch(
    dispatch_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    await sync_mdos_to_dispatches(db)
    if isinstance(dispatch_id, int) or (isinstance(dispatch_id, str) and dispatch_id.isdigit()):
        query = select(DispatchOrder).where(DispatchOrder.id == int(dispatch_id))
    else:
        query = select(DispatchOrder).where(DispatchOrder.dispatch_number == str(dispatch_id))
        
    query = query.options(
        selectinload(DispatchOrder.items).selectinload(DispatchOrderItem.material),
        selectinload(DispatchOrder.destination_warehouse),
        selectinload(DispatchOrder.destination_user)
    )
    res = await db.execute(query)
    h = res.scalar_one_or_none()
    
    if not h:
        raise HTTPException(status_code=404, detail="Dispatch not found")
        
    actual_qtys = {}
    remarks_map = {}
    ack_serials_map = {}
    actual_delivery_loc = None
    acknowledged_by_designation = getattr(h, "delivery_acknowledged_by_designation", None)
    acknowledged_by_phone = getattr(h, "delivery_acknowledged_by_phone", None)
    acknowledged_by_email = getattr(h, "delivery_acknowledged_by_email", None)
    acknowledged_by_department = None
    acknowledged_by_employee_code = None
    receiver_id_proof_type = getattr(h, "receiver_id_proof_type", None)
    receiver_id_proof_number = getattr(h, "receiver_id_proof_number", None)
    delivery_latitude = getattr(h, "delivery_location_latitude", None)
    delivery_longitude = getattr(h, "delivery_location_longitude", None)

    if h.delivery_acknowledged:
        from app.models.dispatch import DispatchDeliveryAcknowledgement
        res_ack = await db.execute(
            select(DispatchDeliveryAcknowledgement)
            .options(selectinload(DispatchDeliveryAcknowledgement.items))
            .where(DispatchDeliveryAcknowledgement.dispatch_id == h.id)
            .order_by(DispatchDeliveryAcknowledgement.created_at.desc())
        )
        delivery_ack = res_ack.scalar_one_or_none()
        if delivery_ack:
            actual_delivery_loc = delivery_ack.actual_delivery_location
            acknowledged_by_department = delivery_ack.acknowledged_by_department
            acknowledged_by_employee_code = delivery_ack.acknowledged_by_employee_code
            
            if not acknowledged_by_designation:
                acknowledged_by_designation = delivery_ack.acknowledged_by_designation
            if not acknowledged_by_phone:
                acknowledged_by_phone = delivery_ack.acknowledged_by_phone
            if not acknowledged_by_email:
                acknowledged_by_email = delivery_ack.acknowledged_by_email
            if not receiver_id_proof_type:
                receiver_id_proof_type = delivery_ack.receiver_id_proof_type
            if not receiver_id_proof_number:
                receiver_id_proof_number = delivery_ack.receiver_id_proof_number
            if not delivery_latitude:
                delivery_latitude = delivery_ack.delivery_latitude
            if not delivery_longitude:
                delivery_longitude = delivery_ack.delivery_longitude

            for ack_item in delivery_ack.items:
                actual_qtys[ack_item.dispatch_item_id] = ack_item.quantity_received
                remarks_map[ack_item.dispatch_item_id] = ack_item.remarks
                ack_serials_map[ack_item.dispatch_item_id] = ack_item.serial_numbers

    items_list = []
    for item in h.items:
        rec_qty = actual_qtys.get(item.id, item.dispatched_quantity)
        item_remarks = remarks_map.get(item.id, None)
        rec_serials = ack_serials_map.get(item.id, item.serial_numbers or []) if h.delivery_acknowledged else (item.serial_numbers or [])
        items_list.append({
            "id": item.id,
            "dispatch_id": h.dispatch_number,
            "material_id": item.material_id,
            "indent_id": item.indent_id,
            "material_issue_id": item.material_issue_id,
            "requested_quantity": item.requested_quantity,
            "approved_quantity": item.approved_quantity,
            "dispatched_quantity": item.dispatched_quantity,
            "acknowledged_qty": rec_qty,
            "remarks": item_remarks,
            "uom": item.uom,
            "request_date": item.request_date,
            "material_name": item.material.name if item.material else None,
            "material_code": item.material.item_code if item.material else None,
            "serial_numbers": rec_serials
        })
        
    is_ready_for_acknowledgement = True
    transporter_status_message = ""
    if h.dispatch_number.startswith("MDO-") or h.dispatch_number.startswith("DO-"):
        from app.models.logistics import LogisticsMainDispatchOrder, LogisticsServiceOrder, LogisticsServiceOrderVehicle
        res_mdo = await db.execute(
            select(LogisticsMainDispatchOrder).where(LogisticsMainDispatchOrder.mdo_number == h.dispatch_number)
        )
        mdo = res_mdo.scalar_one_or_none()
        if mdo:
            res_so = await db.execute(
                select(LogisticsServiceOrder).where(LogisticsServiceOrder.mdo_id == mdo.id)
            )
            so = res_so.scalars().first()
            if so:
                res_v = await db.execute(
                    select(LogisticsServiceOrderVehicle).where(LogisticsServiceOrderVehicle.so_id == so.id)
                )
                vehicles = res_v.scalars().all()
                for veh in vehicles:
                    veh_status = veh.vehicle_status.name if hasattr(veh.vehicle_status, "name") else veh.vehicle_status
                    if veh_status not in ("TRANSPORTER_ACKNOWLEDGED", "DELIVERY_ACKNOWLEDGED"):
                        is_ready_for_acknowledgement = False
                        transporter_status_message = f"Pending transporter arrival confirmation for vehicle {veh.vehicle_registration_no}."
                        break

    return {
        "id": h.id,
        "dispatch_id": h.dispatch_number,
        "dispatch_date": h.dispatch_date,
        "expected_delivery_date": h.expected_delivery_date,
        "status": h.status.capitalize() if h.status else "Draft",
        "remarks": h.remarks,
        "destination_type": h.destination_type,
        "dispatch_type": h.dispatch_type,
        "warehouse_id": h.warehouse_id,
        "destination_warehouse_id": h.destination_warehouse_id,
        "destination_user_id": h.destination_user_id,
        "destination_warehouse_name": h.destination_warehouse.name if h.destination_warehouse else None,
        "destination_user_name": f"{h.destination_user.first_name} {h.destination_user.last_name or ''}".strip() if h.destination_user else None,
        "delivery_acknowledged": h.delivery_acknowledged,
        "delivery_acknowledged_at": h.delivery_acknowledged_at,
        "delivery_acknowledged_by_name": h.delivery_acknowledged_by_name,
        "delivery_acknowledged_by_designation": acknowledged_by_designation,
        "delivery_acknowledged_by_phone": acknowledged_by_phone,
        "delivery_acknowledged_by_email": acknowledged_by_email,
        "delivery_acknowledged_by_department": acknowledged_by_department,
        "delivery_acknowledged_by_employee_code": acknowledged_by_employee_code,
        "receiver_signature_url": h.receiver_signature_url,
        "receiver_id_proof_type": receiver_id_proof_type,
        "receiver_id_proof_number": receiver_id_proof_number,
        "actual_delivery_location": actual_delivery_loc,
        "delivery_location_latitude": delivery_latitude,
        "delivery_location_longitude": delivery_longitude,
        "delivery_photo_urls": h.delivery_photo_urls,
        "goods_condition_on_delivery": h.goods_condition_on_delivery,
        "delivery_remarks": h.delivery_remarks,
        "items": items_list,
        "is_ready_for_acknowledgement": is_ready_for_acknowledgement,
        "transporter_status_message": transporter_status_message
    }

@router.post("", response_model=DispatchResponse)
async def create_dispatch(
    payload: DispatchCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    dispatch_number = await generate_number(db, "warehouse", "dispatch_order")
    
    # Determine warehouse_id
    warehouse_id = None
    if payload.items:
        first_it = payload.items[0]
        if first_it.material_issue_id:
            mi_q = await db.execute(select(MaterialIssue).where(MaterialIssue.id == first_it.material_issue_id))
            mi = mi_q.scalar_one_or_none()
            if mi:
                warehouse_id = mi.warehouse_id
                
    if not warehouse_id:
        from app.models.user import UserWarehouse as _UW
        uw_q = await db.execute(select(_UW).where(_UW.user_id == current_user.id).limit(1))
        uw = uw_q.scalar_one_or_none()
        warehouse_id = uw.warehouse_id if uw else 1

    header = DispatchOrder(
        dispatch_number=dispatch_number,
        warehouse_id=warehouse_id,
        dispatch_date=payload.dispatch_date,
        expected_delivery_date=payload.expected_delivery_date,
        status=payload.status.lower() if payload.status else "draft",
        remarks=payload.remarks,
        destination_type=payload.destination_type or "USER",
        dispatch_type=payload.dispatch_type or "THIRD_PARTY",
        destination_warehouse_id=payload.destination_warehouse_id,
        destination_user_id=payload.destination_user_id,
        dispatched_by=current_user.id
    )
    db.add(header)
    await db.flush()
    
    for it in payload.items:
        item = DispatchOrderItem(
            dispatch_order_id=header.id,
            material_id=it.material_id,
            indent_id=it.indent_id,
            material_issue_id=it.material_issue_id,
            requested_quantity=it.requested_quantity,
            approved_quantity=it.approved_quantity,
            dispatched_quantity=it.dispatched_quantity,
            uom=it.uom,
            request_date=it.request_date,
            serial_numbers=it.serial_numbers or None
        )
        db.add(item)
        
    await db.commit()
    
    # Reload
    query = select(DispatchOrder).where(DispatchOrder.id == header.id).options(
        selectinload(DispatchOrder.items).selectinload(DispatchOrderItem.material),
        selectinload(DispatchOrder.destination_warehouse),
        selectinload(DispatchOrder.destination_user)
    )
    res = await db.execute(query)
    h = res.scalar_one()
    
    items_list = []
    for item in h.items:
        items_list.append({
            "id": item.id,
            "dispatch_id": h.dispatch_number,
            "material_id": item.material_id,
            "indent_id": item.indent_id,
            "material_issue_id": item.material_issue_id,
            "requested_quantity": item.requested_quantity,
            "approved_quantity": item.approved_quantity,
            "dispatched_quantity": item.dispatched_quantity,
            "uom": item.uom,
            "request_date": item.request_date,
            "material_name": item.material.name if item.material else None,
            "material_code": item.material.item_code if item.material else None,
            "serial_numbers": item.serial_numbers or []
        })
        
    return {
        "id": h.id,
        "dispatch_id": h.dispatch_number,
        "dispatch_date": h.dispatch_date,
        "expected_delivery_date": h.expected_delivery_date,
        "status": h.status.capitalize() if h.status else "Draft",
        "remarks": h.remarks,
        "destination_type": h.destination_type,
        "dispatch_type": h.dispatch_type,
        "warehouse_id": h.warehouse_id,
        "destination_warehouse_id": h.destination_warehouse_id,
        "destination_user_id": h.destination_user_id,
        "destination_warehouse_name": h.destination_warehouse.name if h.destination_warehouse else None,
        "destination_user_name": f"{h.destination_user.first_name} {h.destination_user.last_name or ''}".strip() if h.destination_user else None,
        "items": items_list
    }

@router.put("/{dispatch_id}", response_model=DispatchResponse)
async def update_dispatch(
    dispatch_id: str,
    payload: DispatchUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    if dispatch_id.isdigit():
        query = select(DispatchOrder).where(DispatchOrder.id == int(dispatch_id))
    else:
        query = select(DispatchOrder).where(DispatchOrder.dispatch_number == dispatch_id)
        
    query = query.options(selectinload(DispatchOrder.items))
    res = await db.execute(query)
    h = res.scalar_one_or_none()
    
    if not h:
        raise HTTPException(status_code=404, detail="Dispatch not found")
        
    h.dispatch_date = payload.dispatch_date
    h.expected_delivery_date = payload.expected_delivery_date
    h.status = payload.status.lower() if payload.status else h.status
    h.remarks = payload.remarks
    h.destination_type = payload.destination_type
    h.dispatch_type = payload.dispatch_type
    h.destination_warehouse_id = payload.destination_warehouse_id
    h.destination_user_id = payload.destination_user_id
    
    # Reassign items (SQLAlchemy delete-orphan handles deletions)
    h.items = [
        DispatchOrderItem(
            dispatch_order_id=h.id,
            material_id=it.material_id,
            indent_id=it.indent_id,
            material_issue_id=it.material_issue_id,
            requested_quantity=it.requested_quantity,
            approved_quantity=it.approved_quantity,
            dispatched_quantity=it.dispatched_quantity,
            uom=it.uom,
            request_date=it.request_date,
            serial_numbers=it.serial_numbers or None
        )
        for it in payload.items
    ]
        
    await db.commit()
    
    # Reload
    query = select(DispatchOrder).where(DispatchOrder.id == h.id).options(
        selectinload(DispatchOrder.items).selectinload(DispatchOrderItem.material),
        selectinload(DispatchOrder.destination_warehouse),
        selectinload(DispatchOrder.destination_user)
    )
    res = await db.execute(query)
    h = res.scalar_one()
    
    items_list = []
    for item in h.items:
        items_list.append({
            "id": item.id,
            "dispatch_id": h.dispatch_number,
            "material_id": item.material_id,
            "indent_id": item.indent_id,
            "material_issue_id": item.material_issue_id,
            "requested_quantity": item.requested_quantity,
            "approved_quantity": item.approved_quantity,
            "dispatched_quantity": item.dispatched_quantity,
            "uom": item.uom,
            "request_date": item.request_date,
            "material_name": item.material.name if item.material else None,
            "material_code": item.material.item_code if item.material else None,
            "serial_numbers": item.serial_numbers or []
        })
        
    return {
        "id": h.id,
        "dispatch_id": h.dispatch_number,
        "dispatch_date": h.dispatch_date,
        "expected_delivery_date": h.expected_delivery_date,
        "status": h.status.capitalize() if h.status else "Draft",
        "remarks": h.remarks,
        "destination_type": h.destination_type,
        "dispatch_type": h.dispatch_type,
        "warehouse_id": h.warehouse_id,
        "destination_warehouse_id": h.destination_warehouse_id,
        "destination_user_id": h.destination_user_id,
        "destination_warehouse_name": h.destination_warehouse.name if h.destination_warehouse else None,
        "destination_user_name": f"{h.destination_user.first_name} {h.destination_user.last_name or ''}".strip() if h.destination_user else None,
        "items": items_list
    }

@router.delete("/{dispatch_id}")
async def delete_dispatch(
    dispatch_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    if dispatch_id.isdigit():
        query = select(DispatchOrder).where(DispatchOrder.id == int(dispatch_id))
    else:
        query = select(DispatchOrder).where(DispatchOrder.dispatch_number == dispatch_id)
        
    res = await db.execute(query)
    h = res.scalar_one_or_none()
    
    if not h:
        raise HTTPException(status_code=404, detail="Dispatch not found")
        
    if h.status.lower() not in ("draft", "pending"):
        raise HTTPException(status_code=400, detail="Only Draft dispatches can be deleted")
        
    await db.delete(h)
    await db.commit()
    return {"message": "Dispatch deleted successfully"}
