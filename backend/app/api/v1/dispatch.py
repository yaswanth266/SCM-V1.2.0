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
            StockLedger.reference_type.in_(["dispatch_order", "logistics_mdo", "mdo"]),
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

    # Pre-fetch MDO for stock deduction rules
    from app.models.logistics import LogisticsMainDispatchOrder
    
    parent_mdo = None
    mdo_res = await db.execute(
        select(LogisticsMainDispatchOrder).where(LogisticsMainDispatchOrder.mdo_number == d.dispatch_number).limit(1)
    )
    parent_mdo = mdo_res.scalar_one_or_none()

    dispatch_mode_val = getattr(d, "dispatch_mode", "direct") or "direct"
    is_multi = dispatch_mode_val.lower() == "multi-level"
    is_tp = False
    if parent_mdo:
        is_tp = (parent_mdo.dispatch_type or "THIRD_PARTY") == "THIRD_PARTY"
    else:
        is_tp = (d.dispatch_type or "THIRD_PARTY") == "THIRD_PARTY"

    # FLOW 1: Non-TP Multi-level dispatches. Skip entirely (L-1/SDO handles everything).
    if is_multi and not is_tp:
        return

    # FLOW 2: TP Multi-level dispatches. Release reservation and increment transit ONLY.
    if is_multi and is_tp:
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
                mi_item = next((mi_it for mi_it in mi_items if mi_it.item_id == item.material_id and mi_it.issue_id == target_mi_id), None)
                
            if mi_item:
                batch_id = mi_item.batch_id
                bin_id = mi_item.bin_id
                rate = mi_item.rate or Decimal("0")
                uom_id = mi_item.uom_id or 1

            # Release reservation (R↓)
            await release_reservation(
                db,
                item_id=item.material_id,
                warehouse_id=d.warehouse_id,
                qty=item.dispatched_quantity,
                bin_id=bin_id,
                batch_id=batch_id,
            )

            # Increment transit_qty (Tr↑)
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
            src_balance.available_qty = max(
                Decimal("0"),
                (src_balance.total_qty or Decimal("0"))
                - (src_balance.reserved_qty or Decimal("0"))
                - (src_balance.transit_qty or Decimal("0"))
            )
        return

    # DIRECT DISPATCH (Standard Flow): Release reservation (R↓), post stock ledger (T↓), and increment transit if inter-warehouse.
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
            mi_item = next((mi_it for mi_it in mi_items if mi_it.item_id == item.material_id and mi_it.issue_id == target_mi_id), None)
            
        if mi_item:
            batch_id = mi_item.batch_id
            bin_id = mi_item.bin_id
            rate = mi_item.rate or Decimal("0")
            uom_id = mi_item.uom_id or 1

        # Release reservation (R↓)
        await release_reservation(
            db,
            item_id=item.material_id,
            warehouse_id=d.warehouse_id,
            qty=item.dispatched_quantity,
            bin_id=bin_id,
            batch_id=batch_id,
        )
        
        # Post stock ledger (T↓)
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

        # Increment transit_qty if inter-warehouse (Tr↑)
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
            src_balance.available_qty = max(
                Decimal("0"),
                (src_balance.total_qty or Decimal("0"))
                - (src_balance.reserved_qty or Decimal("0"))
                - (src_balance.transit_qty or Decimal("0"))
            )

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
        
        # Select only MDOs that either do not have a DispatchOrder, or are out of sync
        from sqlalchemy import or_, and_
        stmt = (
            select(LogisticsMainDispatchOrder)
            .outerjoin(DispatchOrder, DispatchOrder.dispatch_number == LogisticsMainDispatchOrder.mdo_number)
            .where(
                LogisticsMainDispatchOrder.status.in_(["DISPATCHED", "IN_TRANSIT", "COMPLETED", "ACKNOWLEDGED"]),
                or_(
                    DispatchOrder.id.is_(None),
                    and_(LogisticsMainDispatchOrder.status == "DISPATCHED", DispatchOrder.status != "dispatched"),
                    and_(LogisticsMainDispatchOrder.status == "IN_TRANSIT", DispatchOrder.status != "in_transit"),
                    and_(LogisticsMainDispatchOrder.status == "TRANSPORTER_ACKNOWLEDGED", DispatchOrder.status != "in_transit"),
                    and_(LogisticsMainDispatchOrder.status == "COMPLETED", DispatchOrder.status != "delivered"),
                    and_(LogisticsMainDispatchOrder.status == "ACKNOWLEDGED", DispatchOrder.status != "acknowledged"),
                    LogisticsMainDispatchOrder.dispatch_mode != DispatchOrder.dispatch_mode,
                    DispatchOrder.expected_delivery_date != LogisticsMainDispatchOrder.required_delivery_date
                )
            )
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
                    dispatch_mode=mdo.dispatch_mode or "direct",
                    status=mapped_st,
                    remarks=mdo.special_instructions,
                    material_issue_id=mdo.material_issue_id,
                    dispatch_date=mdo.order_date,
                    expected_delivery_date=mdo.required_delivery_date,
                    delivery_acknowledged=(mdo.status == "ACKNOWLEDGED")
                )
                db.add(disp)
                await db.flush()
                
                # Fetch MDO's materials directly for both direct and multi-level dispatches
                stmt_mats = select(LogisticsDispatchMaterial).where(LogisticsDispatchMaterial.mdo_id == mdo.id)
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

                # Trigger stock deduction if status is dispatched, in_transit, delivered, or acknowledged
                if mapped_st in ("dispatched", "in_transit", "delivered", "acknowledged"):
                    await process_dispatch_stock_deduction(db, disp, mdo.created_by or 1)
            else:
                existing.expected_delivery_date = mdo.required_delivery_date
                # Sync dispatch_mode from MDO so acknowledge_delivery picks the right transit warehouse
                if mdo.dispatch_mode and existing.dispatch_mode != mdo.dispatch_mode:
                    existing.dispatch_mode = mdo.dispatch_mode
                db.add(existing)
                # Keep status in sync in case status changed
                if existing.status != mapped_st:
                    old_status = existing.status
                    existing.status = mapped_st
                    existing.delivery_acknowledged = (mdo.status == "ACKNOWLEDGED")
                    await db.flush()

                    # Trigger stock deduction if transitioning to dispatched, in_transit, delivered, or acknowledged
                    if mapped_st in ("dispatched", "in_transit", "delivered", "acknowledged") and old_status not in ("dispatched", "in_transit", "delivered", "acknowledged"):
                        await process_dispatch_stock_deduction(db, existing, mdo.created_by or existing.dispatched_by or 1)

                # Backfill missing items OR update serial_numbers on existing dispatch items
                try:
                    # Fetch MDO's materials directly for both direct and multi-level dispatches
                    stmt_mats = select(LogisticsDispatchMaterial).where(LogisticsDispatchMaterial.mdo_id == mdo.id)
                    res_mats = await db.execute(stmt_mats)
                    mats = res_mats.scalars().all()

                    if not existing.items and mats:
                        # Dispatch order has no items — backfill from LogisticsDispatchMaterial
                        for mat in mats:
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
                            item = DispatchOrderItem(
                                dispatch_order_id=existing.id,
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
                    else:
                        # Items already exist — just patch missing serial numbers
                        for mat in mats:
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

    # Filter by user's warehouse scope if non-managerial
    from app.utils.dependencies import user_is_managerial, user_warehouse_ids, get_warehouse_and_descendants, get_user_role_codes
    role_codes = await get_user_role_codes(db, current_user.id)
    is_admin = bool({"super_admin", "admin"} & set(role_codes))
    is_managerial = await user_is_managerial(db, current_user.id)

    if not (is_admin or is_managerial):
        assigned_whs = await user_warehouse_ids(db, current_user.id)
        if assigned_whs:
            scoped_whs = await get_warehouse_and_descendants(db, assigned_whs)
            query = query.where(
                (DispatchOrder.warehouse_id.in_(scoped_whs)) |
                (DispatchOrder.destination_warehouse_id.in_(scoped_whs))
            )
        else:
            return build_paginated_response([], 0, page, page_size)
    
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
                "serial_numbers": item.serial_numbers or [],
                "special_storage_condition": item.material.special_storage_condition if item.material else False,
                "storage_min_temp": item.material.storage_min_temp if item.material else None,
                "storage_max_temp": item.material.storage_max_temp if item.material else None,
                "storage_min_moisture": item.material.storage_min_moisture if item.material else None,
                "storage_max_moisture": item.material.storage_max_moisture if item.material else None,
                "storage_breakable": item.material.storage_breakable if item.material else False,
                "special_transport_condition": item.material.special_transport_condition if item.material else False,
                "transport_min_temp": item.material.transport_min_temp if item.material else None,
                "transport_max_temp": item.material.transport_max_temp if item.material else None,
                "transport_min_moisture": item.material.transport_min_moisture if item.material else None,
                "transport_max_moisture": item.material.transport_max_moisture if item.material else None,
                "transport_breakable": item.material.transport_breakable if item.material else False
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

    from app.utils.dependencies import user_is_managerial, user_warehouse_ids, get_warehouse_and_descendants, get_user_role_codes
    role_codes = await get_user_role_codes(db, current_user.id)
    is_admin = bool({"super_admin", "admin"} & set(role_codes))
    is_managerial = await user_is_managerial(db, current_user.id)
    if not (is_admin or is_managerial):
        assigned_whs = await user_warehouse_ids(db, current_user.id)
        if assigned_whs:
            scoped_whs = await get_warehouse_and_descendants(db, assigned_whs)
            if h.warehouse_id not in scoped_whs and h.destination_warehouse_id not in scoped_whs:
                raise HTTPException(status_code=403, detail="Not authorized to view this dispatch")
        else:
            raise HTTPException(status_code=403, detail="Not authorized to view this dispatch")
        
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
            "serial_numbers": rec_serials,
            "special_storage_condition": item.material.special_storage_condition if item.material else False,
            "storage_min_temp": item.material.storage_min_temp if item.material else None,
            "storage_max_temp": item.material.storage_max_temp if item.material else None,
            "storage_min_moisture": item.material.storage_min_moisture if item.material else None,
            "storage_max_moisture": item.material.storage_max_moisture if item.material else None,
            "storage_breakable": item.material.storage_breakable if item.material else False,
            "special_transport_condition": item.material.special_transport_condition if item.material else False,
            "transport_min_temp": item.material.transport_min_temp if item.material else None,
            "transport_max_temp": item.material.transport_max_temp if item.material else None,
            "transport_min_moisture": item.material.transport_min_moisture if item.material else None,
            "transport_max_moisture": item.material.transport_max_moisture if item.material else None,
            "transport_breakable": item.material.transport_breakable if item.material else False
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

from pydantic import BaseModel
from datetime import datetime, timezone

async def get_destination_position_id(db: AsyncSession, destination_warehouse_id: Optional[int], destination_user_id: Optional[int]) -> Optional[int]:
    from app.models.user import User, UserRole, Role
    from app.models.settings_master import Employee, Position
    
    resolved_pos_id = None
    
    if destination_user_id:
        user_q = await db.execute(select(User).where(User.id == destination_user_id))
        user = user_q.scalar_one_or_none()
        if user and user.employee_id:
            emp_q = await db.execute(select(Employee).where(Employee.id == user.employee_id))
            emp = emp_q.scalar_one_or_none()
            if emp and emp.position_id:
                resolved_pos_id = emp.position_id

    if not resolved_pos_id and destination_warehouse_id:
        from app.models.user import UserWarehouse
        uw_q = await db.execute(select(UserWarehouse.user_id).where(UserWarehouse.warehouse_id == destination_warehouse_id))
        user_ids = [r[0] for r in uw_q.all()]
        if user_ids:
            res = await db.execute(
                select(Employee.position_id)
                .join(User, User.employee_id == Employee.id)
                .where(User.id.in_(user_ids), Employee.position_id.is_not(None))
                .limit(1)
            )
            resolved_pos_id = res.scalar_one_or_none()

    # If the resolved position is view-only/OE, override it with the Storekeeper position (role ID 34)
    if resolved_pos_id:
        pos_q = await db.execute(select(Position).where(Position.id == resolved_pos_id))
        pos = pos_q.scalar_one_or_none()
        if pos and pos.role_id in (18, 49):  # OE / View Only roles
            # A. Try to find a Storekeeper (role ID 34) user mapped to the destination warehouse
            if destination_warehouse_id:
                from app.models.user import UserWarehouse
                uw_q = await db.execute(select(UserWarehouse.user_id).where(UserWarehouse.warehouse_id == destination_warehouse_id))
                user_ids = [r[0] for r in uw_q.all()]
                if user_ids:
                    sk_res = await db.execute(
                        select(Employee.position_id)
                        .join(User, User.employee_id == Employee.id)
                        .join(UserRole, UserRole.user_id == User.id)
                        .where(
                            User.id.in_(user_ids),
                            UserRole.role_id == 34,
                            Employee.position_id.is_not(None)
                        )
                        .limit(1)
                    )
                    sk_pos_id = sk_res.scalar_one_or_none()
                    if sk_pos_id:
                        return sk_pos_id

            # B. If no Storekeeper user is mapped, locate a Storekeeper position by location name matching from the OE position's name!
            if pos.name:
                suffix = None
                if "-" in pos.name:
                    suffix = pos.name.split("-")[-1].strip()
                elif "@" in pos.name:
                    suffix = pos.name.split("@")[-1].strip()
                else:
                    tokens = [t.strip() for t in pos.name.split() if len(t.strip()) > 3]
                    if tokens:
                        suffix = tokens[-1]
                
                if suffix:
                    sk_pos_q = await db.execute(
                        select(Position.id)
                        .where(
                            Position.role_id == 34,
                            (Position.name.ilike(f"%{suffix}%") | Position.code.ilike(f"%{suffix}%"))
                        )
                        .limit(1)
                    )
                    sk_pos_id = sk_pos_q.scalar_one_or_none()
                    if sk_pos_id:
                        return sk_pos_id

            # C. If that fails, try matching location tokens from the destination warehouse name
            if destination_warehouse_id:
                from app.models.warehouse import Warehouse
                wh_res = await db.execute(select(Warehouse).where(Warehouse.id == destination_warehouse_id))
                wh = wh_res.scalar_one_or_none()
                if wh and wh.name:
                    suffix = None
                    if "@" in wh.name:
                        suffix = wh.name.split("@")[-1].strip()
                    elif "-" in wh.name:
                        suffix = wh.name.split("-")[-1].strip()
                    else:
                        tokens = [t.strip() for t in wh.name.split() if len(t.strip()) > 3]
                        if tokens:
                            suffix = tokens[-1]
                    
                    if suffix:
                        sk_pos_q = await db.execute(
                            select(Position.id)
                            .where(
                                Position.role_id == 34,
                                (Position.name.ilike(f"%{suffix}%") | Position.code.ilike(f"%{suffix}%"))
                            )
                            .limit(1)
                        )
                        sk_pos_id = sk_pos_q.scalar_one_or_none()
                        if sk_pos_id:
                            return sk_pos_id

    return resolved_pos_id


async def get_warehouse_for_position(db: AsyncSession, position_id: int) -> Optional[int]:
    from app.models.settings_master import Employee, Position
    from app.models.user import User, UserWarehouse
    from app.models.warehouse import Warehouse
    
    # Get the position row
    pos_res = await db.execute(
        select(Position).where(Position.id == position_id)
    )
    pos = pos_res.scalar_one_or_none()
    
    # First priority: Match by Position name to avoid incorrect database user-warehouse mappings
    if pos and pos.name:
        pos_name_upper = pos.name.upper()
        # 1. Look for Regional Manager and Regional Warehouse match
        if "REGIONAL MANAGER" in pos_name_upper:
            suffix = pos_name_upper.replace("REGIONAL MANAGER", "").strip(" -")
            if suffix:
                res = await db.execute(
                    select(Warehouse.id)
                    .where(
                        Warehouse.name.like(f"%REGIONAL%"),
                        Warehouse.name.like(f"%{suffix}%")
                    )
                    .limit(1)
                )
                wh_id = res.scalar_one_or_none()
                if wh_id:
                    return wh_id
                
                res = await db.execute(
                    select(Warehouse.id)
                    .where(Warehouse.name.like(f"%{suffix}%"))
                    .limit(1)
                )
                wh_id = res.scalar_one_or_none()
                if wh_id:
                    return wh_id

        # 2. Look for District Manager and District Warehouse match
        if "DISTRICT" in pos_name_upper:
            parts = pos_name_upper.split("-")
            loc = parts[-1].strip() if parts else ""
            if loc:
                res = await db.execute(
                    select(Warehouse.id)
                    .where(
                        Warehouse.name.like(f"%DISTRICT%"),
                        Warehouse.name.like(f"%{loc}%")
                    )
                    .limit(1)
                )
                wh_id = res.scalar_one_or_none()
                if wh_id:
                    return wh_id
                
                res = await db.execute(
                    select(Warehouse.id)
                    .where(
                        (Warehouse.name.like(f"%{loc}%")) |
                        (Warehouse.code.like(f"%{loc}%"))
                    )
                    .limit(1)
                )
                wh_id = res.scalar_one_or_none()
                if wh_id:
                    return wh_id
    
    # 2. Try to find via the assignee (employee_id) directly set on the Position row
    emp_id = pos.employee_id if pos else None
    if emp_id:
        res = await db.execute(
            select(UserWarehouse.warehouse_id)
            .join(User, User.id == UserWarehouse.user_id)
            .where(User.employee_id == emp_id)
            .limit(1)
        )
        wh_id = res.scalar_one_or_none()
        if wh_id:
            return wh_id

    # 3. Try to find via UserWarehouse mapping for users occupying this position via Employee.position_id
    res = await db.execute(
        select(UserWarehouse.warehouse_id)
        .join(User, User.id == UserWarehouse.user_id)
        .join(Employee, Employee.id == User.employee_id)
        .where(Employee.position_id == position_id)
        .limit(1)
    )
    wh_id = res.scalar_one_or_none()
    if wh_id:
        return wh_id
        
    # 4. Try searching by employee's active position or sub-positions
    res_pos = await db.execute(
        select(Employee.id)
        .where(Employee.position_id == position_id)
    )
    emp_ids = [r[0] for r in res_pos.all()]
    if emp_ids:
        res = await db.execute(
            select(UserWarehouse.warehouse_id)
            .join(User, User.id == UserWarehouse.user_id)
            .where(User.employee_id.in_(emp_ids))
            .limit(1)
        )
        wh_id = res.scalar_one_or_none()
        if wh_id:
            return wh_id

    return None

async def get_last_intermediate_warehouse(db: AsyncSession, d) -> int:
    # Default to the source warehouse
    fallback = d.warehouse_id
    if d.dispatch_mode != "multi-level":
        return fallback

    try:
        project_id = await resolve_dispatch_project_id(db, d.items)
        if not project_id:
            return fallback

        dest_pos_id = await get_destination_position_id(db, d.destination_warehouse_id, d.destination_user_id)
        
        # Resolve starting_pos_id
        from app.models.issue import MaterialIssue
        from app.models.indent import Indent
        starting_pos_id = None
        if d.material_issue_id:
            mi_q = await db.execute(select(MaterialIssue).where(MaterialIssue.id == d.material_issue_id))
            mi = mi_q.scalar_one_or_none()
            if mi and mi.indent_id:
                ind_q = await db.execute(select(Indent).where(Indent.id == mi.indent_id))
                indent = ind_q.scalar_one_or_none()
                if indent and indent.created_by:
                    from app.models.settings_master import Employee
                    from app.models.user import User
                    emp_q = await db.execute(
                        select(Employee.position_id)
                        .join(User, User.employee_id == Employee.id)
                        .where(User.id == indent.created_by)
                    )
                    starting_pos_id = emp_q.scalar_one_or_none()

        if not starting_pos_id:
            return fallback

        from app.api.v1.logistics import build_logistics_custody_chain
        chain_data = await build_logistics_custody_chain(db, project_id, starting_pos_id, dest_pos_id)
        chain = [entry["position"] for entry in chain_data if entry.get("can_approve", False) or entry.get("is_destination", False)]

        # The last intermediate position is chain[-2] (since chain[-1] is destination position)
        if len(chain) >= 2:
            last_int_pos = chain[-2]
            last_wh = await get_warehouse_for_position(db, last_int_pos.id)
            if last_wh:
                return last_wh
    except Exception as e:
        print(f"[WARNING] failed to get last intermediate warehouse: {e}")

    return fallback

async def resolve_dispatch_project_id(db: AsyncSession, payload_items) -> Optional[int]:
    from app.models.indent import Indent
    from app.models.issue import MaterialIssue
    
    for it in payload_items:
        if it.indent_id:
            ind_q = await db.execute(select(Indent.project_id).where(Indent.id == it.indent_id))
            proj_id = ind_q.scalar_one_or_none()
            if proj_id:
                return proj_id
        if it.material_issue_id:
            mi_q = await db.execute(select(MaterialIssue).where(MaterialIssue.id == it.material_issue_id))
            mi = mi_q.scalar_one_or_none()
            if mi and mi.indent_id:
                ind_q = await db.execute(select(Indent.project_id).where(Indent.id == mi.indent_id))
                proj_id = ind_q.scalar_one_or_none()
                if proj_id:
                    return proj_id
    return None

async def build_dispatch_custody_chain(db: AsyncSession, project_id: int, dest_warehouse_id: Optional[int], dest_user_id: Optional[int]) -> List:
    from app.models.settings_master import Position
    from app.models.approval import ProjectWorkflowConfig
    from app.services.approval_service import get_position_ancestors
    
    dest_pos_id = await get_destination_position_id(db, dest_warehouse_id, dest_user_id)
    if not dest_pos_id:
        return []
        
    ancestors = await get_position_ancestors(db, dest_pos_id)
    chain = []
    for pos in ancestors:
        if not pos.role_id:
            continue
        cfg_q = await db.execute(
            select(ProjectWorkflowConfig).where(
                ProjectWorkflowConfig.project_id == project_id,
                ProjectWorkflowConfig.role_id == pos.role_id
            )
        )
        cfg = cfg_q.scalar_one_or_none()
        if cfg and cfg.dispatch_approve:
            chain.append(pos)
            
    chain.reverse()
    return chain

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

    dispatch_mode = payload.dispatch_mode.lower() if payload.dispatch_mode else "direct"
    status = payload.status.lower() if payload.status else "draft"
    
    chain = []
    if dispatch_mode == "multi-level":
        project_id = await resolve_dispatch_project_id(db, payload.items)
        if project_id:
            chain = await build_dispatch_custody_chain(db, project_id, payload.destination_warehouse_id, payload.destination_user_id)
            if chain and status in ("dispatched", "in_transit"):
                from app.models.user import Role
                role_res = await db.execute(select(Role).where(Role.id == chain[0].role_id))
                first_role = role_res.scalar_one_or_none()
                if first_role:
                    status = f"at_{first_role.code.lower()}"

    header = DispatchOrder(
        dispatch_number=dispatch_number,
        warehouse_id=warehouse_id,
        dispatch_date=payload.dispatch_date,
        expected_delivery_date=payload.expected_delivery_date,
        status=status,
        remarks=payload.remarks,
        destination_type=payload.destination_type or "USER",
        dispatch_type=payload.dispatch_type or "THIRD_PARTY",
        dispatch_mode=dispatch_mode,
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
        
    if chain:
        from app.models.dispatch_custody import DispatchCustodyTransfer
        for idx, pos in enumerate(chain):
            transfer = DispatchCustodyTransfer(
                dispatch_order_id=header.id,
                position_id=pos.id,
                status="pending",
                sequence=idx + 1
            )
            db.add(transfer)
        
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
    h.dispatch_mode = payload.dispatch_mode.lower() if payload.dispatch_mode else h.dispatch_mode
    
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


# ==================== CUSTODY CHAIN & SEQUENTIAL TRANSFER ====================

class CustodyAcknowledgementInput(BaseModel):
    seal_intact: bool
    packaging_condition: str  # "INTACT", "DAMAGED", "TAMPERED"
    discrepancy_reported: bool
    remarks: Optional[str] = None

@router.get("/custody-chain-preview")
async def preview_custody_chain(
    project_id: int = Query(...),
    destination_warehouse_id: Optional[int] = Query(None),
    destination_user_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    chain = await build_dispatch_custody_chain(db, project_id, destination_warehouse_id, destination_user_id)
    out = []
    from app.models.user import Role
    from app.models.settings_master import Employee
    for idx, pos in enumerate(chain):
        emp_name = "Unassigned"
        if pos.employee_id:
            emp_q = await db.execute(select(Employee).where(Employee.id == pos.employee_id))
            emp = emp_q.scalar_one_or_none()
            if emp:
                emp_name = f"{emp.first_name} {emp.last_name or ''}".strip()
        
        role_name = pos.role_name
        role_code = ""
        if pos.role_id:
            role_q = await db.execute(select(Role).where(Role.id == pos.role_id))
            role_obj = role_q.scalar_one_or_none()
            if role_obj:
                role_name = role_obj.name
                role_code = role_obj.code

        out.append({
            "sequence": idx + 1,
            "position_id": pos.id,
            "position_name": pos.name,
            "role_name": role_name,
            "role_code": role_code,
            "employee_name": emp_name,
            "status": "pending",
        })
    return out

@router.get("/{dispatch_id}/custody-chain")
async def get_dispatch_custody_chain(
    dispatch_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if dispatch_id.isdigit():
        d_q = await db.execute(select(DispatchOrder).where(DispatchOrder.id == int(dispatch_id)))
    else:
        d_q = await db.execute(select(DispatchOrder).where(DispatchOrder.dispatch_number == dispatch_id))
    d = d_q.scalar_one_or_none()
    if not d:
        raise HTTPException(status_code=404, detail="Dispatch not found")
        
    from app.models.dispatch_custody import DispatchCustodyTransfer
    from app.models.settings_master import Position, Employee
    from app.models.user import Role
    
    transfers_q = await db.execute(
        select(DispatchCustodyTransfer)
        .where(DispatchCustodyTransfer.dispatch_order_id == d.id)
        .order_by(DispatchCustodyTransfer.sequence.asc())
    )
    transfers = transfers_q.scalars().all()
    
    # Check current user's position and admin status for can_acknowledge check
    user_pos_id = None
    current_user_emp = None
    if current_user.employee_id:
        emp_res = await db.execute(select(Employee).where(Employee.id == current_user.employee_id))
        current_user_emp = emp_res.scalar_one_or_none()
        if current_user_emp:
            user_pos_id = current_user_emp.position_id
            
    from app.utils.dependencies import get_user_role_codes
    role_codes = set(await get_user_role_codes(db, current_user.id))
    is_admin = bool({"super_admin", "admin"} & role_codes)
    
    active_seq = None
    for t in transfers:
        if t.status == "pending":
            active_seq = t.sequence
            break
            
    out = []
    for t in transfers:
        pos_q = await db.execute(select(Position).where(Position.id == t.position_id))
        pos = pos_q.scalar_one_or_none()
        pos_name = pos.name if pos else "Unknown"
        role_name = pos.role_name if pos else "Unknown"
        role_code = ""
        emp_name = "Unassigned"
        
        if pos:
            if pos.role_id:
                role_res = await db.execute(select(Role).where(Role.id == pos.role_id))
                role_obj = role_res.scalar_one_or_none()
                if role_obj:
                    role_name = role_obj.name
                    role_code = role_obj.code
            if pos.employee_id:
                emp_q = await db.execute(select(Employee).where(Employee.id == pos.employee_id))
                emp = emp_q.scalar_one_or_none()
                if emp:
                    emp_name = emp.name.strip() if emp.name else "Unknown"
                    
        ack_by_name = None
        if t.acknowledged_by_id:
            from app.models.user import User as UserModel
            u_q = await db.execute(select(UserModel).where(UserModel.id == t.acknowledged_by_id))
            u = u_q.scalar_one_or_none()
            if u:
                ack_by_name = f"{u.first_name or ''} {u.last_name or ''}".strip() or u.username
                
        can_ack = False
        if t.status == "pending" and t.sequence == active_seq:
            is_authorized = (user_pos_id == t.position_id or is_admin)
            if not is_authorized and user_pos_id and t.position_id:
                from app.services.approval_service import get_position_ancestors
                ancestors = await get_position_ancestors(db, t.position_id)
                ancestor_ids = {a.id for a in ancestors}
                if current_user_emp:
                    from app.models.settings_master import Position as PositionModel
                    pos_rows = await db.execute(select(PositionModel.id).where(PositionModel.employee_id == current_user_emp.id))
                    curr_pos_ids = {r[0] for r in pos_rows.all()} | ({current_user_emp.position_id} if current_user_emp.position_id else set())
                    if curr_pos_ids & ancestor_ids:
                        is_authorized = True
            can_ack = is_authorized
            
        out.append({
            "id": t.id,
            "sequence": t.sequence,
            "position_id": t.position_id,
            "position_name": pos_name,
            "role_name": role_name,
            "role_code": role_code,
            "employee_name": emp_name,
            "status": t.status,
            "seal_intact": t.seal_intact,
            "packaging_condition": t.packaging_condition,
            "discrepancy_reported": t.discrepancy_reported,
            "remarks": t.remarks,
            "acknowledged_by_name": ack_by_name,
            "acknowledged_at": t.acknowledged_at.isoformat() if t.acknowledged_at else None,
            "can_acknowledge": can_ack,
        })
    return out

@router.post("/{dispatch_id}/acknowledge-custody")
async def acknowledge_custody(
    dispatch_id: str,
    payload: CustodyAcknowledgementInput,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if dispatch_id.isdigit():
        d_q = await db.execute(select(DispatchOrder).where(DispatchOrder.id == int(dispatch_id)).with_for_update())
    else:
        d_q = await db.execute(select(DispatchOrder).where(DispatchOrder.dispatch_number == dispatch_id).with_for_update())
    d = d_q.scalar_one_or_none()
    if not d:
        raise HTTPException(status_code=404, detail="Dispatch not found")
        
    from app.models.dispatch_custody import DispatchCustodyTransfer
    step_q = await db.execute(
        select(DispatchCustodyTransfer)
        .where(
            DispatchCustodyTransfer.dispatch_order_id == d.id,
            DispatchCustodyTransfer.status == "pending"
        )
        .order_by(DispatchCustodyTransfer.sequence.asc())
        .limit(1)
    )
    active_step = step_q.scalar_one_or_none()
    if not active_step:
        raise HTTPException(status_code=400, detail="No pending custody transfers for this dispatch.")
        
    from app.models.settings_master import Employee
    user_pos_id = None
    current_user_emp = None
    if current_user.employee_id:
        emp_res = await db.execute(select(Employee).where(Employee.id == current_user.employee_id))
        current_user_emp = emp_res.scalar_one_or_none()
        if current_user_emp:
            user_pos_id = current_user_emp.position_id
            
    from app.utils.dependencies import get_user_role_codes
    role_codes = set(await get_user_role_codes(db, current_user.id))
    is_admin = bool({"super_admin", "admin"} & role_codes)
    
    is_authorized = (user_pos_id == active_step.position_id or is_admin)
    if not is_authorized and user_pos_id and active_step.position_id:
        from app.services.approval_service import get_position_ancestors
        ancestors = await get_position_ancestors(db, active_step.position_id)
        ancestor_ids = {a.id for a in ancestors}
        if current_user_emp:
            from app.models.settings_master import Position as PositionModel
            pos_rows = await db.execute(select(PositionModel.id).where(PositionModel.employee_id == current_user_emp.id))
            curr_pos_ids = {r[0] for r in pos_rows.all()} | ({current_user_emp.position_id} if current_user_emp.position_id else set())
            if curr_pos_ids & ancestor_ids:
                is_authorized = True

    if not is_authorized:
        raise HTTPException(
            status_code=403,
            detail="You do not occupy the active position required to acknowledge custody for this step."
        )
        
    active_step.status = "acknowledged"
    active_step.acknowledged_by_id = current_user.id
    active_step.acknowledged_at = datetime.now(timezone.utc)
    active_step.seal_intact = payload.seal_intact
    active_step.packaging_condition = payload.packaging_condition
    active_step.discrepancy_reported = payload.discrepancy_reported
    active_step.remarks = payload.remarks
    
    next_step_q = await db.execute(
        select(DispatchCustodyTransfer)
        .where(
            DispatchCustodyTransfer.dispatch_order_id == d.id,
            DispatchCustodyTransfer.status == "pending"
        )
        .order_by(DispatchCustodyTransfer.sequence.asc())
        .limit(1)
    )
    next_step = next_step_q.scalar_one_or_none()
    if next_step:
        from app.models.settings_master import Position
        from app.models.user import Role
        pos_q = await db.execute(select(Position).where(Position.id == next_step.position_id))
        pos = pos_q.scalar_one_or_none()
        if pos and pos.role_id:
            role_q = await db.execute(select(Role).where(Role.id == pos.role_id))
            role_obj = role_q.scalar_one_or_none()
            if role_obj:
                d.status = f"at_{role_obj.code.lower()}"
    else:
        d.status = "in_transit"
        
    await db.commit()
    return {"success": True, "message": "Custody acknowledged successfully.", "new_status": d.status}
