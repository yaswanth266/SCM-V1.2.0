import logging
from decimal import Decimal
from datetime import datetime, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.database import get_db
from app.models.user import User
from app.models.warehouse import MaterialInward, MaterialInwardItem, Warehouse
from app.models.procurement import PurchaseOrder, PurchaseOrderItem
from app.models.master import Vendor, Item, UOM
from app.schemas.warehouse import MaterialInwardCreate, MaterialInwardResponse
from app.services.number_series import generate_number
from app.utils.dependencies import get_current_user, require_key
from app.utils.helpers import paginate_params, build_paginated_response, apply_search_filter

logger = logging.getLogger(__name__)
router = APIRouter()


def build_inward_response(inward: MaterialInward) -> dict:
    items_list = []
    for item in inward.items:
        items_list.append({
            "id": item.id,
            "inward_id": item.inward_id,
            "item_id": item.item_id,
            "item_name_manual": item.item_name_manual,
            "ordered_qty": item.ordered_qty,
            "received_qty": item.received_qty,
            "uom_id": item.uom_id,
            "uom_manual": item.uom_manual,
            "remarks": item.remarks,
            "item_code": item.item.item_code if item.item else None,
            "item_name": item.item.name if item.item else None,
            "uom_name": item.uom.name if item.uom else None,
        })
    
    return {
        "id": inward.id,
        "inward_number": inward.inward_number,
        "po_id": inward.po_id,
        "po_number": inward.po_number,
        "vendor_id": inward.vendor_id,
        "vendor_name_manual": inward.vendor_name_manual,
        "warehouse_id": inward.warehouse_id,
        "received_date": inward.received_date,
        "vehicle_number": inward.vehicle_number,
        "driver_name": inward.driver_name,
        "remarks": inward.remarks,
        "status": inward.status,
        "created_by": inward.created_by,
        "created_at": inward.created_at,
        "updated_at": inward.updated_at,
        "warehouse_name": inward.warehouse.name if inward.warehouse else None,
        "vendor_name": inward.vendor.name if inward.vendor else inward.vendor_name_manual,
        "items": items_list,
    }


@router.get("", response_model=dict)
async def list_material_inwards(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    status: str = Query(None),
    warehouse_id: int = Query(None),
    vendor_id: int = Query(None),
    po_number: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("warehouse-material-inward")),
):
    offset, limit = paginate_params(page, page_size)
    query = select(MaterialInward)
    count_query = select(func.count(MaterialInward.id))
    
    if status:
        query = query.where(MaterialInward.status == status)
        count_query = count_query.where(MaterialInward.status == status)
    if warehouse_id:
        query = query.where(MaterialInward.warehouse_id == warehouse_id)
        count_query = count_query.where(MaterialInward.warehouse_id == warehouse_id)
    if vendor_id:
        query = query.where(MaterialInward.vendor_id == vendor_id)
        count_query = count_query.where(MaterialInward.vendor_id == vendor_id)
    if po_number:
        query = query.where(MaterialInward.po_number == po_number)
        count_query = count_query.where(MaterialInward.po_number == po_number)
        
    query = apply_search_filter(query, MaterialInward, search, ["inward_number", "po_number", "vendor_name_manual"])
    count_query = apply_search_filter(count_query, MaterialInward, search, ["inward_number", "po_number", "vendor_name_manual"])
    
    total = (await db.execute(count_query)).scalar()
    
    query = query.options(
        selectinload(MaterialInward.items).selectinload(MaterialInwardItem.item),
        selectinload(MaterialInward.items).selectinload(MaterialInwardItem.uom),
        selectinload(MaterialInward.vendor),
        selectinload(MaterialInward.warehouse),
    )
    result = await db.execute(query.offset(offset).limit(limit).order_by(MaterialInward.id.desc()))
    inwards = result.scalars().all()
    
    items_list = [build_inward_response(i) for i in inwards]
    return build_paginated_response(items_list, total, page, page_size)


@router.get("/fetch-po/{po_number:path}", response_model=dict)
async def fetch_po_details(
    po_number: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("warehouse-material-inward")),
):
    # FIX-INWARD-001: Always look up the is_current version for a given base_po_number.
    # When a PO is amended, the old po_number still exists in the DB but should
    # not be used for inward — use the newest (is_current=True) version instead.
    result = await db.execute(
        select(PurchaseOrder)
        .options(
            selectinload(PurchaseOrder.items).selectinload(PurchaseOrderItem.item),
            selectinload(PurchaseOrder.items).selectinload(PurchaseOrderItem.uom),
            selectinload(PurchaseOrder.vendor),
        )
        .where(PurchaseOrder.po_number == po_number)
    )
    po = result.scalar_one_or_none()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase Order not found")

    # FIX-INWARD-002: If this PO is NOT the current version, upgrade to the
    # current version of the same base_po_number so inward sees latest items/qty.
    if not po.is_current and po.base_po_number:
        current_result = await db.execute(
            select(PurchaseOrder)
            .options(
                selectinload(PurchaseOrder.items).selectinload(PurchaseOrderItem.item),
                selectinload(PurchaseOrder.items).selectinload(PurchaseOrderItem.uom),
                selectinload(PurchaseOrder.vendor),
            )
            .where(
                PurchaseOrder.base_po_number == po.base_po_number,
                PurchaseOrder.is_current == True,  # noqa: E712
            )
        )
        current_po = current_result.scalar_one_or_none()
        if current_po:
            po = current_po

    # Validate PO is in a receivable status
    RECEIVABLE_STATUSES = ("approved", "accepted", "partially_received")
    if po.status not in RECEIVABLE_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Purchase Order '{po.po_number}' is in '{po.status}' status. "
                f"Only approved or supplier-accepted POs can be used for inward."
            )
        )
    
    items = []
    for poi in po.items:
        ordered = poi.qty or Decimal("0")
        received = poi.received_qty or Decimal("0")
        pending = max(Decimal("0"), ordered - received)
        items.append({
            "id": poi.id,
            "item_id": poi.item_id,
            "item_code": poi.item.item_code if poi.item else None,
            "item_name": poi.item.name if poi.item else None,
            "ordered_qty": float(ordered),
            "received_qty": float(received),
            "pending_qty": float(pending),
            "uom_id": poi.uom_id,
            "uom_name": poi.uom.name if poi.uom else None,
        })
    
    return {
        "po_id": po.id,
        "po_number": po.po_number,
        "vendor_id": po.vendor_id,
        "vendor_name": po.vendor.name if po.vendor else None,
        "items": items,
    }


@router.post("", response_model=MaterialInwardResponse, status_code=201)
async def create_material_inward(
    payload: MaterialInwardCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("warehouse-material-inward")),
):
    if payload.po_id:
        po_res = await db.execute(
            select(PurchaseOrder).where(PurchaseOrder.id == payload.po_id)
        )
        po = po_res.scalar_one_or_none()
        if not po:
            raise HTTPException(status_code=404, detail="Purchase Order not found")
        if po.supplier_acknowledgement != "accepted":
            raise HTTPException(
                status_code=400,
                detail=f"Cannot receive items: PO {po.po_number} has not been accepted by the supplier (current status: '{po.supplier_acknowledgement or 'pending'}').",
            )

    inward_number = await generate_number(db, "warehouse", "material_inward")
    
    inward = MaterialInward(
        inward_number=inward_number,
        po_id=payload.po_id,
        po_number=payload.po_number,
        vendor_id=payload.vendor_id,
        vendor_name_manual=payload.vendor_name_manual,
        warehouse_id=payload.warehouse_id,
        received_date=payload.received_date,
        vehicle_number=payload.vehicle_number,
        driver_name=payload.driver_name,
        remarks=payload.remarks,
        status="draft",
        created_by=current_user.id,
    )
    
    db.add(inward)
    await db.flush()
    
    for item in payload.items:
        inward_item = MaterialInwardItem(
            inward_id=inward.id,
            item_id=item.item_id,
            item_name_manual=item.item_name_manual,
            ordered_qty=item.ordered_qty,
            received_qty=item.received_qty,
            uom_id=item.uom_id,
            uom_manual=item.uom_manual,
            remarks=item.remarks,
        )
        db.add(inward_item)
        
    await db.flush()
    await db.commit()
    
    # Reload with relationships for response
    result = await db.execute(
        select(MaterialInward)
        .options(
            selectinload(MaterialInward.items).selectinload(MaterialInwardItem.item),
            selectinload(MaterialInward.items).selectinload(MaterialInwardItem.uom),
            selectinload(MaterialInward.vendor),
            selectinload(MaterialInward.warehouse),
        )
        .where(MaterialInward.id == inward.id)
    )
    inward = result.scalar_one_or_none()

    try:
        from app.services.notification_service import create_notification, notify_warehouse_managers
        # Notify the creator
        await create_notification(
            db=db,
            user_id=current_user.id,
            title="Inward Gate Entry Registered",
            message=f"Inward gate entry draft {inward_number} has been registered successfully.",
            notification_type="info",
            module="warehouse",
            reference_type="material_inward",
            reference_id=inward.id,
        )
        # Notify warehouse managers
        await notify_warehouse_managers(
            db=db,
            warehouse_id=inward.warehouse_id,
            title="New Inward Gate Entry",
            message=f"A new inward gate entry draft {inward_number} has been registered for your warehouse.",
            notification_type="info",
            reference_type="material_inward",
            reference_id=inward.id,
        )
    except Exception as notif_err:
        logger.warning("Failed to create notification for create_material_inward: %s", notif_err)
    
    return build_inward_response(inward)


@router.get("/{id}", response_model=MaterialInwardResponse)
async def get_material_inward(
    id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("warehouse-material-inward")),
):
    result = await db.execute(
        select(MaterialInward)
        .options(
            selectinload(MaterialInward.items).selectinload(MaterialInwardItem.item),
            selectinload(MaterialInward.items).selectinload(MaterialInwardItem.uom),
            selectinload(MaterialInward.vendor),
            selectinload(MaterialInward.warehouse),
        )
        .where(MaterialInward.id == id)
    )
    inward = result.scalar_one_or_none()
    if not inward:
        raise HTTPException(status_code=404, detail="Material Inward not found")
        
    return build_inward_response(inward)


@router.post("/{id}/complete", response_model=MaterialInwardResponse)
async def complete_material_inward(
    id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("warehouse-material-inward")),
):
    result = await db.execute(
        select(MaterialInward)
        .options(
            selectinload(MaterialInward.items).selectinload(MaterialInwardItem.item),
            selectinload(MaterialInward.items).selectinload(MaterialInwardItem.uom),
            selectinload(MaterialInward.vendor),
            selectinload(MaterialInward.warehouse),
        )
        .where(MaterialInward.id == id)
    )
    inward = result.scalar_one_or_none()
    if not inward:
        raise HTTPException(status_code=404, detail="Material Inward not found")
        
    if inward.status != "draft":
        raise HTTPException(status_code=400, detail=f"Material Inward is already '{inward.status}'")
        
    inward.status = "received"
    await db.flush()
    await db.commit()
    
    return build_inward_response(inward)
