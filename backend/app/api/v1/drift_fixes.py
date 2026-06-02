"""
Drift fixes — adds the API endpoints that the frontend calls but were not
registered in the existing domain routers. Mounted as a supplementary router
so that every button in the UI maps to a working backend handler.

Every endpoint here is exercised by a real frontend call; nothing is
speculative. Do not add routes here without a matching frontend usage.
"""
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional
import os
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from pydantic import BaseModel
from sqlalchemy import select, func, desc, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.user import User
from app.models.master import (
    Vendor, VendorItem, VendorContract, VendorRating,
    Item, PriceList, PriceListItem,
)
from app.models.warehouse import Warehouse
from app.models.procurement import (
    MaterialRequest, MaterialRequestItem,
    Quotation, QuotationItem,
    PurchaseOrder, PurchaseOrderItem,
)
from app.models.accounts import Invoice, Payment, CreditNote
from app.models.asset import Asset
from app.models.approval import ApprovalWorkflow, ApprovalLevel
from app.models.audit import StockAudit, StockAuditItem, BinReplenishmentRule
from app.models.transfer import StockTransfer, StockTransferItem
from app.models.returns import PurchaseReturn
from app.models.consumption import ConsumptionEntry
from app.models.stock import StockLedger, StockBalance
from app.models.grn import PutawayOrder, PutawayItem, GoodsReceiptNote
from app.models.system import SystemSetting, NumberSeries, FileAttachment
from app.utils.dependencies import get_current_user, require_any_role, require_permission
from app.utils.helpers import paginate_params, build_paginated_response, apply_search_filter
from app.config import settings

router = APIRouter()


# ==================== helpers ====================

def _paged(items, total, page, page_size):
    return build_paginated_response(items, total, page, page_size)


async def _require(db, model, pk, name):
    obj = (await db.execute(select(model).where(model.id == pk))).scalar_one_or_none()
    if not obj:
        raise HTTPException(status_code=404, detail=f"{name} not found")
    return obj


def _assert_status(obj, allowed, verb):
    if obj.status not in allowed:
        raise HTTPException(status_code=400, detail=f"Cannot {verb} in '{obj.status}' status")


# ==================== vendors sub-resources ====================

@router.get("/masters/vendors/{vendor_id}/items")
async def vendor_items_list(
    vendor_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    base = select(VendorItem).where(VendorItem.vendor_id == vendor_id)
    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0
    rows = (await db.execute(
        base.options(selectinload(VendorItem.item)).order_by(desc(VendorItem.id)).offset(offset).limit(limit)
    )).scalars().all()
    items = []
    for v in rows:
        items.append({
            "id": v.id,
            "vendor_id": v.vendor_id,
            "item_id": v.item_id,
            "item_code": v.item.item_code if v.item else None,
            "item_name": v.item.name if v.item else None,
            "vendor_item_code": v.vendor_item_code,
            "lead_time_days": v.lead_time_days,
            "min_order_qty": float(v.min_order_qty or 0),
            "rate": float(v.rate or 0),
            "is_preferred": v.is_preferred,
        })
    return _paged(items, total, page, page_size)


@router.get("/masters/vendors/{vendor_id}/contracts")
async def vendor_contracts_list(
    vendor_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    base = select(VendorContract).where(VendorContract.vendor_id == vendor_id)
    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0
    rows = (await db.execute(base.order_by(desc(VendorContract.id)).offset(offset).limit(limit))).scalars().all()
    items = [{
        "id": c.id,
        "vendor_id": c.vendor_id,
        "contract_number": c.contract_number,
        "title": c.title,
        "start_date": c.start_date.isoformat() if c.start_date else None,
        "end_date": c.end_date.isoformat() if c.end_date else None,
        "terms": c.terms,
        "document_url": c.document_url,
        "status": c.status,
    } for c in rows]
    return _paged(items, total, page, page_size)


@router.get("/masters/vendors/{vendor_id}/ratings")
async def vendor_ratings_list(
    vendor_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    base = select(VendorRating).where(VendorRating.vendor_id == vendor_id)
    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0
    rows = (await db.execute(base.order_by(desc(VendorRating.id)).offset(offset).limit(limit))).scalars().all()
    items = [{
        "id": r.id,
        "vendor_id": r.vendor_id,
        "period_from": r.period_from.isoformat() if r.period_from else None,
        "period_to": r.period_to.isoformat() if r.period_to else None,
        "delivery_timeliness": float(r.delivery_timeliness or 0),
        "cost_efficiency": float(r.cost_efficiency or 0),
        "service_reliability": float(r.service_reliability or 0),
        "delivery_accuracy": float(r.delivery_accuracy or 0),
        "overall_rating": float(r.overall_rating or 0),
        "remarks": r.remarks,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    } for r in rows]
    return _paged(items, total, page, page_size)


@router.get("/masters/vendors/{vendor_id}/purchase-orders")
async def vendor_purchase_orders(
    vendor_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    base = select(PurchaseOrder).where(PurchaseOrder.vendor_id == vendor_id)
    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0
    rows = (await db.execute(base.order_by(desc(PurchaseOrder.id)).offset(offset).limit(limit))).scalars().all()
    items = [{
        "id": p.id,
        "po_number": p.po_number,
        "po_date": p.po_date.isoformat() if p.po_date else None,
        "grand_total": float(p.grand_total or 0),
        "status": p.status,
    } for p in rows]
    return _paged(items, total, page, page_size)


# ==================== items detail tabs ====================

@router.get("/masters/items/{item_id}/stock")
async def item_stock(item_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(require_permission("warehouse", "view", "stock"))):
    rows = (await db.execute(select(StockBalance).where(StockBalance.item_id == item_id))).scalars().all()
    return {"items": [{
        "warehouse_id": r.warehouse_id,
        "bin_id": r.bin_id,
        "batch_id": r.batch_id,
        "available_qty": float(r.available_qty or 0),
        "reserved_qty": float(r.reserved_qty or 0),
        "total_qty": float(r.total_qty or 0),
        "valuation_rate": float(r.valuation_rate or 0),
    } for r in rows]}


@router.get("/masters/items/{item_id}/vendors")
async def item_vendors(item_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(require_permission("masters", "view", "vendor_items"))):
    rows = (await db.execute(
        select(VendorItem).options(selectinload(VendorItem.vendor)).where(VendorItem.item_id == item_id)
    )).scalars().all()
    return {"items": [{
        "id": v.id,
        "vendor_id": v.vendor_id,
        "vendor_name": v.vendor.name if v.vendor else None,
        "vendor_code": v.vendor.vendor_code if v.vendor else None,
        "vendor_item_code": v.vendor_item_code,
        "lead_time_days": v.lead_time_days,
        "rate": float(v.rate or 0),
        "is_preferred": v.is_preferred,
    } for v in rows]}


@router.get("/masters/items/{item_id}/prices")
async def item_prices(item_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(require_permission("masters", "view", "price_lists"))):
    rows = (await db.execute(
        select(PriceListItem).options(selectinload(PriceListItem.price_list))
        .where(PriceListItem.item_id == item_id)
    )).scalars().all()
    return {"items": [{
        "id": p.id,
        "price_list_id": p.price_list_id,
        "price_list_name": p.price_list.name if p.price_list else None,
        "rate": float(p.rate or 0),
        "min_qty": float(p.min_qty or 0),
        "valid_from": p.valid_from.isoformat() if p.valid_from else None,
        "valid_to": p.valid_to.isoformat() if p.valid_to else None,
    } for p in rows]}





@router.get("/masters/items/{item_id}/transactions")
async def item_transactions(
    item_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    base = select(StockLedger).where(StockLedger.item_id == item_id)
    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0
    rows = (await db.execute(base.order_by(desc(StockLedger.id)).offset(offset).limit(limit))).scalars().all()
    items = [{
        "id": r.id,
        "posting_date": r.posting_date.isoformat() if r.posting_date else None,
        "warehouse_id": r.warehouse_id,
        "transaction_type": r.transaction_type,
        "reference_type": r.reference_type,
        "reference_id": r.reference_id,
        "qty_in": float(r.qty_in or 0),
        "qty_out": float(r.qty_out or 0),
        "balance_qty": float(r.balance_qty or 0),
        "rate": float(r.rate or 0),
    } for r in rows]
    return _paged(items, total, page, page_size)


# ==================== price lists ====================

class PriceListUpdate(BaseModel):
    name: Optional[str] = None
    currency: Optional[str] = None
    is_active: Optional[bool] = None
    description: Optional[str] = None


@router.put("/masters/price-lists/{pl_id}")
async def update_price_list(
    pl_id: int, payload: PriceListUpdate,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    pl = await _require(db, PriceList, pl_id, "Price list")
    for k, v in payload.model_dump(exclude_unset=True).items():
        if hasattr(pl, k):
            setattr(pl, k, v)
    await db.flush()
    return {"success": True}


@router.delete("/masters/price-lists/{pl_id}")
async def delete_price_list(
    pl_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-HC-110 fix: hard-delete is destructive; require super_admin role.
    current_user: User = Depends(require_any_role("super_admin")),
):
    pl = await _require(db, PriceList, pl_id, "Price list")
    # Snapshot pre-delete state for audit trail.
    pl_snapshot = {
        "id": pl.id,
        "name": getattr(pl, "name", None),
        "code": getattr(pl, "code", None),
        "currency": getattr(pl, "currency", None),
    }
    # Hard-delete items and price list
    await db.execute(PriceListItem.__table__.delete().where(PriceListItem.price_list_id == pl_id))
    await db.delete(pl)
    await db.flush()

    # BUG-HC-110 fix: audit-log every hard delete of a price list.
    try:
        from app.services.compliance_service import log_audit
        await log_audit(
            db,
            event_type="price_list_hard_deleted",
            severity="warning",
            source_type="price_list",
            source_id=pl_id,
            user_id=current_user.id,
            payload=pl_snapshot,
        )
    except Exception:
        # Audit failure must never block the delete; service already logs.
        pass

    return {"success": True}


@router.get("/masters/price-lists/{pl_id}/items")
async def price_list_items(
    pl_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    base = select(PriceListItem).where(PriceListItem.price_list_id == pl_id)
    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0
    rows = (await db.execute(
        base.options(selectinload(PriceListItem.item)).order_by(desc(PriceListItem.id)).offset(offset).limit(limit)
    )).scalars().all()
    items = [{
        "id": pi.id,
        "price_list_id": pi.price_list_id,
        "item_id": pi.item_id,
        "item_code": pi.item.item_code if pi.item else None,
        "item_name": pi.item.name if pi.item else None,
        "rate": float(pi.rate or 0),
        "min_qty": float(getattr(pi, "min_qty", 0) or 0),
    } for pi in rows]
    return _paged(items, total, page, page_size)


class PriceListItemPayload(BaseModel):
    item_id: int
    rate: float
    min_qty: Optional[float] = 0
    valid_from: Optional[datetime] = None
    valid_to: Optional[datetime] = None


@router.post("/masters/price-lists/{pl_id}/items", status_code=201)
async def add_price_list_item(
    pl_id: int, payload: PriceListItemPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await _require(db, PriceList, pl_id, "Price list")
    pi = PriceListItem(price_list_id=pl_id, item_id=payload.item_id, rate=payload.rate)
    if hasattr(pi, "min_qty"):
        pi.min_qty = payload.min_qty or 0
    if hasattr(pi, "valid_from") and payload.valid_from:
        pi.valid_from = payload.valid_from
    if hasattr(pi, "valid_to") and payload.valid_to:
        pi.valid_to = payload.valid_to
    db.add(pi)
    await db.flush()
    return {"id": pi.id}


@router.put("/masters/price-lists/{pl_id}/items/{item_id}")
async def update_price_list_item(
    pl_id: int, item_id: int, payload: PriceListItemPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    pi = (await db.execute(
        select(PriceListItem).where(PriceListItem.id == item_id, PriceListItem.price_list_id == pl_id)
    )).scalar_one_or_none()
    if not pi:
        raise HTTPException(status_code=404, detail="Price list item not found")
    pi.item_id = payload.item_id
    pi.rate = payload.rate
    if hasattr(pi, "min_qty"):
        pi.min_qty = payload.min_qty or 0
    await db.flush()
    return {"success": True}


@router.delete("/masters/price-lists/{pl_id}/items/{item_id}")
async def delete_price_list_item(
    pl_id: int, item_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    pi = (await db.execute(
        select(PriceListItem).where(PriceListItem.id == item_id, PriceListItem.price_list_id == pl_id)
    )).scalar_one_or_none()
    if not pi:
        raise HTTPException(status_code=404, detail="Price list item not found")
    await db.delete(pi)
    await db.flush()
    return {"success": True}


# ==================== warehouses DELETE ====================

@router.delete("/masters/warehouses/{warehouse_id}")
async def delete_warehouse(
    warehouse_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    wh = await _require(db, Warehouse, warehouse_id, "Warehouse")
    if hasattr(wh, "is_active"):
        wh.is_active = False
        await db.flush()
        return {"success": True, "soft_deleted": True}
    await db.delete(wh)
    await db.flush()
    return {"success": True}


# ==================== assets DELETE ====================

@router.delete("/assets/{asset_id}")
async def delete_asset(
    asset_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    a = await _require(db, Asset, asset_id, "Asset")
    a.status = "disposed"
    await db.flush()
    return {"success": True, "soft_deleted": True}


# ==================== approval workflows ====================

@router.get("/approvals/workflows/{workflow_id}")
async def get_workflow(
    workflow_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    wf = (await db.execute(
        select(ApprovalWorkflow).options(selectinload(ApprovalWorkflow.levels)).where(ApprovalWorkflow.id == workflow_id)
    )).scalar_one_or_none()
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return {
        "id": wf.id,
        "name": wf.name,
        "module": wf.module,
        "document_type": wf.document_type,
        "project_id": wf.project_id,
        "is_active": wf.is_active,
        "levels": [{
            "id": lvl.id,
            "level": lvl.level,
            "approver_role_id": lvl.approver_role_id,
            "approver_user_id": lvl.approver_user_id,
            "min_amount": float(lvl.min_amount or 0),
            "max_amount": float(lvl.max_amount or 0),
            "auto_approve_after_days": lvl.auto_approve_after_days,
        } for lvl in wf.levels],
    }


class WorkflowUpdate(BaseModel):
    name: Optional[str] = None
    module: Optional[str] = None
    document_type: Optional[str] = None
    project_id: Optional[int] = None
    is_active: Optional[bool] = None
    levels: Optional[list] = None


@router.put("/approvals/workflows/{workflow_id}")
async def update_workflow(
    workflow_id: int, payload: WorkflowUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    """NEW-2 fix: only Super Admin / Admin can modify approval workflows."""
    wf = await _require(db, ApprovalWorkflow, workflow_id, "Workflow")
    data = payload.model_dump(exclude_unset=True)
    levels_data = data.pop("levels", None)
    for k, v in data.items():
        setattr(wf, k, v)
    if levels_data is not None:
        await db.execute(ApprovalLevel.__table__.delete().where(ApprovalLevel.workflow_id == workflow_id))
        for lvl in levels_data:
            db.add(ApprovalLevel(
                workflow_id=workflow_id,
                # The frontend sends `level_number` (legacy) or `level` (new shape).
                level=lvl.get("level") or lvl.get("level_number") or 1,
                # Frontend sends `approver_role` / `approver_user`; backend column
                # is suffixed with _id. Accept both shapes.
                approver_role_id=lvl.get("approver_role_id") or lvl.get("approver_role"),
                approver_user_id=lvl.get("approver_user_id") or lvl.get("approver_user"),
                min_amount=lvl.get("min_amount", 0),
                max_amount=lvl.get("max_amount") or 999999999,
                auto_approve_after_days=lvl.get("auto_approve_after_days") or 0,
                send_email=lvl.get("send_email", True),
                send_notification=lvl.get("send_notification", True),
                # Wave 2: SLA escalation
                escalation_user_id=lvl.get("escalation_user_id"),
                escalation_after_hours=lvl.get("escalation_after_hours", 0) or 0,
                # Wave 3: conditional routing
                department=lvl.get("department") or None,
                category=lvl.get("category") or None,
                request_type=lvl.get("request_type") or None,
                condition_json=lvl.get("condition_json") or None,
                # Wave 4: parallel approvers
                requires_all=bool(lvl.get("requires_all", False)),
            ))
    await db.flush()
    return {"success": True}


# ==================== inventory: stock balance breakdown ====================

@router.get("/inventory/stock-balance/{item_id}/breakdown")
async def stock_balance_breakdown(
    item_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    """BUG-INV-119: enforce warehouse-scope isolation on the breakdown view.
    BUG-INV-142: include batch metadata and location hierarchy.
    BUG-INV-143: include UOM name for display in the unique breakdown view.
    """
    from app.models.warehouse import Batch, WarehouseBin, WarehouseRack, WarehouseLine, WarehouseLocation
    from app.models.master import Item, UOM
    from sqlalchemy.orm import joinedload
    
    q = select(StockBalance).options(
        joinedload(StockBalance.warehouse),
        joinedload(StockBalance.batch),
        joinedload(StockBalance.item).joinedload(Item.primary_uom),
        joinedload(StockBalance.bin).joinedload(WarehouseBin.rack).joinedload(WarehouseRack.line).joinedload(WarehouseLine.location),
    ).where(StockBalance.item_id == item_id)

    from app.utils.dependencies import user_is_managerial, user_warehouse_ids
    if not await user_is_managerial(db, current_user.id):
        scoped = await user_warehouse_ids(db, current_user.id)
        if not scoped:
            return {"items": []}
        q = q.where(StockBalance.warehouse_id.in_(scoped))
    
    rows = (await db.execute(q)).scalars().all()
    
    is_serial_tracked = False
    if rows and rows[0].item and rows[0].item.has_serial:
        is_serial_tracked = True
        
    serials_map = {}
    if is_serial_tracked:
        from app.models.warehouse import SerialNumber
        s_query = select(SerialNumber).where(
            SerialNumber.item_id == item_id,
            SerialNumber.status == "available"
        )
        s_result = await db.execute(s_query)
        for s in s_result.scalars().all():
            key = (s.warehouse_id, s.bin_id, s.batch_id)
            if key not in serials_map:
                serials_map[key] = []
            serials_map[key].append(s.serial_number)

    items = []
    for r in rows:
        data = {
            "warehouse_id": r.warehouse_id,
            "warehouse_name": r.warehouse.name if r.warehouse else None,
            "bin_id": r.bin_id,
            "batch_id": r.batch_id,
            "batch_number": r.batch.batch_number if r.batch else None,
            "expiry_date": r.batch.expiry_date.isoformat() if r.batch and r.batch.expiry_date else None,
            "manufacturing_date": r.batch.manufacturing_date.isoformat() if r.batch and r.batch.manufacturing_date else None,
            "lot_number": r.batch.lot_number if r.batch else None,
            "supplier_batch": r.batch.supplier_batch if r.batch else None,
            "available_qty": float(r.available_qty or 0),
            "reserved_qty": float(r.reserved_qty or 0),
            "transit_qty": float(r.transit_qty or 0),
            "total_qty": float(r.total_qty or 0),
            "valuation_rate": float(r.valuation_rate or 0),
            "stock_value": float(r.stock_value or 0),
            "last_updated": r.last_updated.isoformat() if r.last_updated else None,
            "uom_name": r.item.primary_uom.name if r.item and r.item.primary_uom else None,
            "has_serial": is_serial_tracked,
            "serial_numbers": serials_map.get((r.warehouse_id, r.bin_id, r.batch_id), []),
        }
        
        if r.bin:
            data["bin_name"] = r.bin.name
            data["bin_code"] = r.bin.code
            if r.bin.rack:
                data["rack_name"] = r.bin.rack.name
                data["rack_code"] = r.bin.rack.code
                if r.bin.rack.line:
                    if r.bin.rack.line.location:
                        data["location_name"] = r.bin.rack.line.location.name
                        data["location_code"] = r.bin.rack.line.location.code
                    else:
                        data["location_name"] = None
                        data["location_code"] = None
                else:
                    data["location_name"] = None
                    data["location_code"] = None
            else:
                data["rack_name"] = None
                data["rack_code"] = None
                data["location_name"] = None
                data["location_code"] = None
        else:
            data["bin_name"] = None
            data["bin_code"] = None
            data["rack_name"] = None
            data["rack_code"] = None
            data["location_name"] = None
            data["location_code"] = None
            
        items.append(data)
        
    return {"items": items}


# ==================== inventory: replenishment ====================

@router.delete("/inventory/replenishment/rules/{rule_id}")
async def delete_replenishment_rule(
    rule_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    r = await _require(db, BinReplenishmentRule, rule_id, "Rule")
    await db.delete(r)
    await db.flush()
    return {"success": True}


# BUG-INV-113: replenishment "tasks" are now backed by StockTransfer rows
# with transfer_type='bin_to_bin' (created by /inventory/replenishment/trigger
# — see BUG-INV-112). Map the task endpoints to those underlying transfers.

@router.get("/inventory/replenishment/tasks/{task_id}")
async def get_replenishment_task(
    task_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    from app.models.transfer import StockTransfer as _ST, StockTransferItem as _STI
    t = (await db.execute(
        select(_ST).options(selectinload(_ST.items)).where(_ST.id == task_id)
    )).scalar_one_or_none()
    if not t or t.transfer_type != "bin_to_bin":
        raise HTTPException(status_code=404, detail="Replenishment task not found")
    return {
        "id": t.id,
        "transfer_number": t.transfer_number,
        "status": t.status,
        "warehouse_id": t.source_warehouse_id,
        "items": [{
            "item_id": it.item_id,
            "qty": float(it.qty or 0),
            "source_bin_id": it.source_bin_id,
            "destination_bin_id": it.destination_bin_id,
            "status": it.status,
        } for it in t.items],
    }


@router.put("/inventory/replenishment/tasks/{task_id}/start")
async def replenishment_task_start(
    task_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    """Start a replenishment task (delegates to transfer submit + approve + dispatch)."""
    from app.models.transfer import StockTransfer as _ST
    t = (await db.execute(select(_ST).where(_ST.id == task_id))).scalar_one_or_none()
    if not t or t.transfer_type != "bin_to_bin":
        raise HTTPException(status_code=404, detail="Replenishment task not found")
    if t.status == "draft":
        t.status = "pending_approval"
    elif t.status == "pending_approval":
        t.status = "approved"
    elif t.status == "approved":
        t.status = "in_transit"
    else:
        raise HTTPException(status_code=400, detail=f"Cannot start task in '{t.status}' status")
    await db.flush()
    return {"success": True, "status": t.status}


@router.put("/inventory/replenishment/tasks/{task_id}/complete")
async def replenishment_task_complete(
    task_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    from app.models.transfer import StockTransfer as _ST
    t = (await db.execute(select(_ST).where(_ST.id == task_id))).scalar_one_or_none()
    if not t or t.transfer_type != "bin_to_bin":
        raise HTTPException(status_code=404, detail="Replenishment task not found")
    if t.status not in ("in_transit", "received"):
        raise HTTPException(status_code=400, detail=f"Cannot complete task in '{t.status}' status")
    t.status = "completed"
    await db.flush()
    return {"success": True, "status": t.status}


@router.put("/inventory/replenishment/tasks/{task_id}/cancel")
async def replenishment_task_cancel(
    task_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    from app.models.transfer import StockTransfer as _ST
    t = (await db.execute(select(_ST).where(_ST.id == task_id))).scalar_one_or_none()
    if not t or t.transfer_type != "bin_to_bin":
        raise HTTPException(status_code=404, detail="Replenishment task not found")
    if t.status in ("completed", "cancelled"):
        raise HTTPException(status_code=400, detail=f"Cannot cancel task in '{t.status}' status")
    t.status = "cancelled"
    await db.flush()
    return {"success": True, "status": t.status}


# ==================== inventory: stock audits ====================

@router.get("/inventory/stock-audits/{audit_id}")
async def get_stock_audit(
    audit_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    audit = (await db.execute(
        select(StockAudit).options(
            selectinload(StockAudit.items).selectinload(StockAuditItem.item),
            selectinload(StockAudit.items).selectinload(StockAuditItem.uom),
        ).where(StockAudit.id == audit_id)
    )).scalar_one_or_none()
    if not audit:
        raise HTTPException(status_code=404, detail="Stock audit not found")
    return {
        "id": audit.id,
        "audit_number": audit.audit_number,
        "warehouse_id": audit.warehouse_id,
        "warehouse_name": audit.warehouse.name if audit.warehouse else None,
        "audit_date": audit.audit_date.isoformat() if audit.audit_date else None,
        "audit_type": audit.audit_type,
        "status": audit.status,
        "total_items": audit.total_items,
        "variance_items": audit.variance_items,
        "items": [{
            "id": i.id,
            "item_id": i.item_id,
            "item_code": i.item.item_code if i.item else None,
            "item_name": i.item.name if i.item else None,
            "system_qty": float(i.system_qty or 0),
            "physical_qty": float(i.physical_qty or 0),
            "variance_qty": float(i.variance_qty or 0),
            "uom_id": i.uom_id,
            "uom": i.uom.name if i.uom else None,
            "adjustment_type": i.adjustment_type,
            "adjusted": i.adjusted,
            "remarks": i.remarks,
        } for i in audit.items],
    }


class StockAuditUpdate(BaseModel):
    warehouse_id: Optional[int] = None
    audit_date: Optional[datetime] = None
    audit_type: Optional[str] = None
    items: Optional[list] = None


@router.put("/inventory/stock-audits/{audit_id}")
async def update_stock_audit(
    audit_id: int, payload: StockAuditUpdate,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    audit = await _require(db, StockAudit, audit_id, "Stock audit")
    _assert_status(audit, ("draft",), "edit")
    data = payload.model_dump(exclude_unset=True)
    items_data = data.pop("items", None)
    for k, v in data.items():
        if hasattr(audit, k):
            setattr(audit, k, v)
    if items_data is not None:
        await db.execute(StockAuditItem.__table__.delete().where(StockAuditItem.audit_id == audit_id))
        for it in items_data:
            sys_qty = Decimal(str(it.get("system_qty", 0) or 0))
            phys_qty = Decimal(str(it.get("physical_qty", 0) or 0))
            variance = phys_qty - sys_qty
            adj = "none" if variance == 0 else ("increase" if variance > 0 else "decrease")
            db.add(StockAuditItem(
                audit_id=audit_id,
                item_id=it["item_id"],
                uom_id=it.get("uom_id"),
                bin_id=it.get("bin_id"),
                batch_id=it.get("batch_id"),
                system_qty=sys_qty,
                physical_qty=phys_qty,
                variance_qty=variance,
                adjustment_type=adj,
                remarks=it.get("remarks"),
            ))
        audit.total_items = len(items_data)
        audit.variance_items = sum(1 for it in items_data
                                   if Decimal(str(it.get("physical_qty", 0) or 0)) != Decimal(str(it.get("system_qty", 0) or 0)))
    await db.flush()
    return {"success": True}


@router.put("/inventory/stock-audits/{audit_id}/submit")
async def submit_stock_audit(
    audit_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    audit = await _require(db, StockAudit, audit_id, "Stock audit")
    _assert_status(audit, ("draft",), "submit")
    audit.status = "in_progress"
    await db.flush()
    return {"success": True, "message": "Stock audit submitted"}


@router.put("/inventory/stock-audits/{audit_id}/approve")
async def approve_stock_audit(
    audit_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    """Approve a stock audit. For cycle_count audits, refuse if no items have
    been counted (would silently rubber-stamp the warehouse), and post the
    variance adjustments to the stock ledger so the audit actually corrects
    inventory rather than just flipping a status flag.
    """
    audit = await _require(db, StockAudit, audit_id, "Stock audit")
    _assert_status(audit, ("in_progress", "draft"), "approve")

    # Cycle-count specific: must have actually counted something AND post
    # variance adjustments for real (not just status flip).
    if audit.audit_type == "cycle_count":
        items_result = await db.execute(
            select(StockAuditItem).where(StockAuditItem.audit_id == audit.id)
        )
        items = items_result.scalars().all()

        def _was_counted(row: StockAuditItem) -> bool:
            if row.physical_qty and row.physical_qty > 0:
                return True
            if row.remarks:
                return True
            if row.adjustment_type in ("increase", "decrease"):
                return True
            return False

        counted = sum(1 for r in items if _was_counted(r))
        if counted == 0 and items:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Cannot approve cycle-count: no count lines have been recorded. "
                    "Update at least one line's physical_qty before approving."
                ),
            )

        # Post variance adjustments — same logic as /cycle-count/{id}/finalize.
        from app.services.stock_service import post_stock_ledger
        from sqlalchemy import and_
        posted = 0
        variance_count = 0
        failures: list = []
        for row in items:
            v = row.variance_qty or Decimal("0")
            if v == 0:
                continue
            variance_count += 1
            try:
                bal_conds = [
                    StockBalance.item_id == row.item_id,
                    StockBalance.warehouse_id == audit.warehouse_id,
                ]
                bal_conds.append(
                    StockBalance.bin_id == row.bin_id if row.bin_id is not None
                    else StockBalance.bin_id.is_(None)
                )
                bal_conds.append(
                    StockBalance.batch_id == row.batch_id if row.batch_id is not None
                    else StockBalance.batch_id.is_(None)
                )
                bal = (await db.execute(
                    select(StockBalance).where(and_(*bal_conds)).limit(1)
                )).scalar_one_or_none()
                rate = (bal.valuation_rate if bal else Decimal("0")) or Decimal("0")
                if v > 0:
                    await post_stock_ledger(
                        db,
                        item_id=row.item_id,
                        warehouse_id=audit.warehouse_id,
                        transaction_type="audit_adjustment",
                        qty_in=v, rate=rate,
                        bin_id=row.bin_id, batch_id=row.batch_id,
                        reference_type="stock_audit", reference_id=audit.id,
                        uom_id=row.uom_id, created_by=current_user.id,
                        allow_negative=True,
                    )
                else:
                    await post_stock_ledger(
                        db,
                        item_id=row.item_id,
                        warehouse_id=audit.warehouse_id,
                        transaction_type="audit_adjustment",
                        qty_out=abs(v), rate=rate,
                        bin_id=row.bin_id, batch_id=row.batch_id,
                        reference_type="stock_audit", reference_id=audit.id,
                        uom_id=row.uom_id, created_by=current_user.id,
                        allow_negative=True,
                    )
                row.adjusted = True
                posted += 1
            except Exception as exc:
                import logging
                logging.getLogger(__name__).exception(
                    "Cycle-count adjust failed for item %s: %s", row.item_id, exc
                )
                failures.append({"audit_item_id": row.id, "item_id": row.item_id, "error": str(exc)})

        audit.variance_items = variance_count
        if failures:
            await db.flush()
            raise HTTPException(
                status_code=500,
                detail={
                    "message": (
                        f"{posted} adjustments posted, {len(failures)} failed. "
                        "Audit left in 'in_progress' state — fix and retry."
                    ),
                    "posted": posted,
                    "failures": failures,
                },
            )

    audit.status = "completed"
    audit.approved_by = current_user.id
    await db.flush()
    return {"success": True, "message": "Stock audit approved"}


@router.put("/inventory/stock-audits/{audit_id}/reject")
async def reject_stock_audit(
    audit_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    audit = await _require(db, StockAudit, audit_id, "Stock audit")
    _assert_status(audit, ("in_progress", "draft"), "reject")
    audit.status = "cancelled"
    await db.flush()
    return {"success": True, "message": "Stock audit rejected"}


# ==================== inventory: stock transfers ====================

class StockTransferUpdate(BaseModel):
    source_warehouse_id: Optional[int] = None
    destination_warehouse_id: Optional[int] = None
    transfer_date: Optional[datetime] = None
    expected_date: Optional[datetime] = None
    transfer_type: Optional[str] = None
    remarks: Optional[str] = None


@router.put("/inventory/stock-transfers/{transfer_id}")
async def update_stock_transfer(
    transfer_id: int, payload: StockTransferUpdate,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    t = await _require(db, StockTransfer, transfer_id, "Stock transfer")
    _assert_status(t, ("draft",), "edit")
    for k, v in payload.model_dump(exclude_unset=True).items():
        if hasattr(t, k):
            setattr(t, k, v)
    await db.flush()
    return {"success": True}


@router.delete("/inventory/stock-transfers/{transfer_id}")
async def delete_stock_transfer(
    transfer_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    t = await _require(db, StockTransfer, transfer_id, "Stock transfer")
    _assert_status(t, ("draft",), "delete")
    await db.execute(StockTransferItem.__table__.delete().where(StockTransferItem.transfer_id == transfer_id))
    await db.delete(t)
    await db.flush()
    return {"success": True}


@router.post("/inventory/stock-transfers/{transfer_id}/complete")
async def complete_stock_transfer(
    transfer_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    t = await _require(db, StockTransfer, transfer_id, "Stock transfer")
    _assert_status(t, ("received", "in_transit"), "complete")
    t.status = "completed"
    await db.flush()
    return {"success": True, "message": "Stock transfer completed"}


# ==================== procurement: material requests ====================

@router.delete("/procurement/material-requests/{mr_id}")
async def delete_material_request(
    mr_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    mr = await _require(db, MaterialRequest, mr_id, "Material request")
    if mr.status not in ("draft", "rejected", "cancelled"):
        raise HTTPException(status_code=400, detail=f"Cannot delete MR in '{mr.status}' status")
    await db.execute(MaterialRequestItem.__table__.delete().where(MaterialRequestItem.mr_id == mr_id))
    await db.delete(mr)
    await db.flush()
    return {"success": True}


@router.post("/procurement/material-requests/{mr_id}/cancel")
async def cancel_material_request(
    mr_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    mr = await _require(db, MaterialRequest, mr_id, "Material request")
    if mr.status in ("ordered", "cancelled"):
        raise HTTPException(status_code=400, detail=f"Cannot cancel MR in '{mr.status}' status")
    mr.status = "cancelled"
    await db.flush()
    return {"success": True, "message": "Material request cancelled"}


@router.get("/procurement/material-requests/{mr_id}/purchase-orders")
async def mr_purchase_orders(
    mr_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    rows = (await db.execute(
        select(PurchaseOrder).where(PurchaseOrder.mr_id == mr_id).order_by(desc(PurchaseOrder.id))
    )).scalars().all()
    return {"items": [{
        "id": p.id, "po_number": p.po_number,
        "po_date": p.po_date.isoformat() if p.po_date else None,
        "grand_total": float(p.grand_total or 0), "status": p.status,
        "vendor_id": p.vendor_id,
    } for p in rows]}


# ==================== procurement: purchase orders ====================

@router.delete("/procurement/purchase-orders/{po_id}")
async def delete_purchase_order(
    po_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    po = await _require(db, PurchaseOrder, po_id, "Purchase order")
    if po.status not in ("draft", "cancelled"):
        raise HTTPException(status_code=400, detail=f"Cannot delete PO in '{po.status}' status")

    # BUG-PRO-042 fix: refuse delete when child rows exist. Previously the FK
    # constraint blew up at flush time with an IntegrityError 500. Check up
    # front so the caller gets a clean 409 with a clear reason.
    blockers: list[str] = []
    inv_count = (await db.execute(
        select(func.count(Invoice.id)).where(Invoice.po_id == po_id)
    )).scalar() or 0
    if inv_count:
        blockers.append(f"{inv_count} invoice(s)")
    pay_count = (await db.execute(
        select(func.count(Payment.id)).where(Payment.po_id == po_id)
    )).scalar() or 0
    if pay_count:
        blockers.append(f"{pay_count} payment(s)")
    grn_count = (await db.execute(
        select(func.count(GoodsReceiptNote.id)).where(GoodsReceiptNote.po_id == po_id)
    )).scalar() or 0
    if grn_count:
        blockers.append(f"{grn_count} GRN(s)")
    # Landed costs hang off GRNs, not POs directly — but if any GRN survived
    # against this PO the GRN check above already covers it.
    if blockers:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot delete PO {po.po_number}: it has " + ", ".join(blockers)
                + ". Cancel and retain instead."
            ),
        )

    await db.execute(PurchaseOrderItem.__table__.delete().where(PurchaseOrderItem.po_id == po_id))
    await db.delete(po)
    await db.flush()
    return {"success": True}


@router.get("/procurement/purchase-orders/{po_id}/grns")
async def po_grns(
    po_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    rows = (await db.execute(
        select(GoodsReceiptNote).where(GoodsReceiptNote.po_id == po_id).order_by(desc(GoodsReceiptNote.id))
    )).scalars().all()
    return {"items": [{
        "id": g.id,
        "grn_number": getattr(g, "grn_number", None),
        "grn_date": g.grn_date.isoformat() if getattr(g, "grn_date", None) else None,
        "status": getattr(g, "status", None),
    } for g in rows]}


@router.get("/procurement/purchase-orders/{po_id}/invoices")
async def po_invoices(
    po_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    rows = (await db.execute(
        select(Invoice).where(Invoice.po_id == po_id).order_by(desc(Invoice.id))
    )).scalars().all()
    return {"items": [{
        "id": i.id, "invoice_number": i.invoice_number,
        "invoice_date": i.invoice_date.isoformat() if i.invoice_date else None,
        "grand_total": float(i.grand_total or 0),
        "paid_amount": float(i.paid_amount or 0),
        "balance_amount": float(i.balance_amount or 0),
        "status": i.status,
    } for i in rows]}


@router.get("/procurement/purchase-orders/{po_id}/payments")
async def po_payments(
    po_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    rows = (await db.execute(
        select(Payment).where(Payment.po_id == po_id).order_by(desc(Payment.id))
    )).scalars().all()
    return {"items": [{
        "id": p.id, "payment_number": p.payment_number,
        "payment_date": p.payment_date.isoformat() if p.payment_date else None,
        "amount": float(p.amount or 0),
        "payment_mode": p.payment_mode, "status": p.status,
    } for p in rows]}


# ==================== procurement: quotations ====================

@router.delete("/procurement/quotations/{quotation_id}")
async def delete_quotation(
    quotation_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    q = await _require(db, Quotation, quotation_id, "Quotation")
    if q.status not in ("draft", "rejected", "expired"):
        raise HTTPException(status_code=400, detail=f"Cannot delete quotation in '{q.status}' status")
    await db.execute(QuotationItem.__table__.delete().where(QuotationItem.quotation_id == quotation_id))
    await db.delete(q)
    await db.flush()
    return {"success": True}


@router.post("/procurement/quotations/{quotation_id}/accept")
@router.put("/procurement/quotations/{quotation_id}/accept")
async def accept_quotation(
    quotation_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-PRO-053 fix: role gate. Anyone with get_current_user could mark a
    # quotation accepted before — that's a price-setting decision and must be
    # restricted to procurement managers.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "purchase_manager",
    )),
):
    from datetime import date as _date
    q = await _require(db, Quotation, quotation_id, "Quotation")
    if q.status in ("accepted", "rejected", "expired"):
        raise HTTPException(status_code=400, detail=f"Quotation already '{q.status}'")
    # BUG-PRO-059 spirit: refuse expired quotations (date check) — keeps stale
    # rates from being locked in.
    if q.valid_until is not None:
        vu = q.valid_until.date() if hasattr(q.valid_until, "date") else q.valid_until
        if vu < _date.today():
            raise HTTPException(
                status_code=400,
                detail="Quotation has expired (valid_until < today) — cannot accept",
            )
    q.status = "accepted"

    # BUG-PRO-052 fix: auto-reject sibling quotations on the same MR. Once one
    # vendor wins, the others are decisions made — leaving them in 'submitted'
    # bloats the worklist and risks a second accept that bypasses the
    # one-vendor-per-MR rule.
    if q.mr_id:
        try:
            siblings = (await db.execute(
                select(Quotation).where(
                    Quotation.mr_id == q.mr_id,
                    Quotation.id != q.id,
                    Quotation.status.in_(("draft", "submitted")),
                )
            )).scalars().all()
            for s in siblings:
                s.status = "rejected"
                s.remarks = (
                    (s.remarks or "")
                    + f"\n[Auto-rejected: quotation {q.quotation_number} accepted on this MR]"
                )
        except Exception:
            import logging as _l
            _l.getLogger(__name__).exception(
                "Failed to auto-reject sibling quotations for MR %s", q.mr_id
            )

    await db.flush()
    return {"success": True, "message": "Quotation accepted"}


@router.post("/procurement/quotations/{quotation_id}/reject")
@router.put("/procurement/quotations/{quotation_id}/reject")
async def reject_quotation(
    quotation_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-PRO-054 fix: role gate. Same reasoning as accept_quotation.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "purchase_manager",
    )),
):
    q = await _require(db, Quotation, quotation_id, "Quotation")
    if q.status in ("accepted", "rejected", "expired"):
        raise HTTPException(status_code=400, detail=f"Quotation already '{q.status}'")
    q.status = "rejected"
    await db.flush()
    return {"success": True, "message": "Quotation rejected"}


# ==================== warehouse: purchase returns DELETE ====================

@router.delete("/warehouse/purchase-returns/{return_id}")
async def delete_purchase_return(
    return_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    pr = await _require(db, PurchaseReturn, return_id, "Purchase return")
    if getattr(pr, "status", None) not in (None, "draft"):
        raise HTTPException(status_code=400, detail=f"Cannot delete return in '{pr.status}' status")
    await db.delete(pr)
    await db.flush()
    return {"success": True}


# ==================== warehouse: putaway actions (plural path aliases) ====================

@router.put("/warehouse/putaways/{putaway_id}/start")
async def start_putaway(
    putaway_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    p = await _require(db, PutawayOrder, putaway_id, "Putaway")
    # Accept both "draft" and "pending" — QI-auto-generated putaways use pending.
    _assert_status(p, ("draft", "pending"), "start")
    p.status = "in_progress"
    p.started_at = datetime.now(timezone.utc)
    await db.flush()
    return {"success": True}


@router.put("/warehouse/putaways/{putaway_id}/complete")
async def complete_putaway(
    putaway_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    """Complete a putaway AND post stock to stock_balance. Previously this
    just flipped status and stock never showed up — the whole point of
    putaway is to record that goods physically landed in bins.
    """
    from sqlalchemy.orm import selectinload as _sl
    from app.services.stock_service import post_stock_ledger
    from app.models.grn import PutawayOrder as _PO, PutawayItem as _PI

    result = await db.execute(
        select(_PO).options(_sl(_PO.items)).where(_PO.id == putaway_id)
    )
    p = result.scalar_one_or_none()
    if not p:
        raise HTTPException(status_code=404, detail="Putaway not found")
    _assert_status(p, ("in_progress", "draft", "pending"), "complete")

    # Post stock ledger entry for each item — this updates stock_balance.
    for pi in p.items:
        if not pi.item_id or not pi.qty:
            continue
        try:
            await post_stock_ledger(
                db,
                item_id=pi.item_id,
                warehouse_id=p.warehouse_id,
                transaction_type="putaway",
                qty_in=pi.qty,
                rate=0,
                bin_id=pi.actual_bin_id or pi.suggested_bin_id,
                batch_id=pi.batch_id,
                reference_type="putaway",
                reference_id=p.id,
                uom_id=pi.uom_id,
                created_by=current_user.id,
            )
        except Exception as e:
            # Don't swallow — fail the complete if stock can't be posted
            raise HTTPException(
                status_code=500,
                detail=f"Failed to post stock for putaway item {pi.id}: {e}",
            )
        pi.status = "done"  # putaway_items enum: pending/in_progress/done/skipped

    p.status = "completed"
    p.completed_at = datetime.now(timezone.utc)
    await db.flush()
    return {"success": True, "message": "Putaway completed and stock posted"}


class PutawayBinsPayload(BaseModel):
    items: list  # list of {item_id, actual_bin_id}


@router.put("/warehouse/putaways/{putaway_id}/bins")
async def set_putaway_bins(
    putaway_id: int, payload: PutawayBinsPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    p = await _require(db, PutawayOrder, putaway_id, "Putaway")
    updated = 0
    for it in payload.items:
        item_id = it.get("item_id")
        bin_id = it.get("actual_bin_id") or it.get("bin_id")
        if not item_id:
            continue
        pi = (await db.execute(
            select(PutawayItem).where(PutawayItem.id == item_id, PutawayItem.putaway_id == putaway_id)
        )).scalar_one_or_none()
        if pi:
            pi.actual_bin_id = bin_id
            updated += 1
    await db.flush()
    return {"success": True, "updated": updated}


@router.put("/warehouse/putaways/{putaway_id}/items/{item_id}/confirm")
async def confirm_putaway_item_plural(
    putaway_id: int, item_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    pi = (await db.execute(
        select(PutawayItem).where(PutawayItem.id == item_id, PutawayItem.putaway_id == putaway_id)
    )).scalar_one_or_none()
    if not pi:
        raise HTTPException(status_code=404, detail="Putaway item not found")
    pi.status = "done"
    pi.scanned_at = datetime.now(timezone.utc)
    pi.scanned_by = current_user.id
    await db.flush()
    return {"success": True}


@router.put("/warehouse/putaways/{putaway_id}/items/{item_id}/skip")
async def skip_putaway_item(
    putaway_id: int, item_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    pi = (await db.execute(
        select(PutawayItem).where(PutawayItem.id == item_id, PutawayItem.putaway_id == putaway_id)
    )).scalar_one_or_none()
    if not pi:
        raise HTTPException(status_code=404, detail="Putaway item not found")
    pi.status = "skipped"
    await db.flush()
    return {"success": True}


class PutawayUpdate(BaseModel):
    status: Optional[str] = None
    assigned_to: Optional[int] = None


@router.put("/warehouse/putaways/{putaway_id}")
async def update_putaway(
    putaway_id: int, payload: PutawayUpdate,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    p = await _require(db, PutawayOrder, putaway_id, "Putaway")
    for k, v in payload.model_dump(exclude_unset=True).items():
        if hasattr(p, k):
            setattr(p, k, v)
    await db.flush()
    return {"success": True}


# ==================== warehouse: QI edit ====================

class QIUpdate(BaseModel):
    inspection_type: Optional[str] = None
    inspection_date: Optional[datetime] = None
    overall_result: Optional[str] = None
    remarks: Optional[str] = None


@router.put("/warehouse/quality-inspections/{qi_id}")
async def update_quality_inspection(
    qi_id: int, payload: QIUpdate,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    from app.models.grn import QualityInspection  # local import to avoid cycles
    qi = await _require(db, QualityInspection, qi_id, "Quality inspection")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(qi, k, v)
    await db.flush()
    return {"success": True}


# ==================== consumption: cancel ====================

@router.post("/consumption/entries/{entry_id}/cancel")
async def cancel_consumption_entry(
    entry_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    """BUG-ISS-024 — Cancel consumption entry.

    If the entry was already 'submitted' the stock ledger had been
    decremented; we must post a reversing entry per item or stock + GL stay
    deducted forever. Lock the row FOR UPDATE so a concurrent submit/cancel
    cannot double-process.
    """
    from app.services.stock_service import post_stock_ledger as _post_ledger

    result = await db.execute(
        select(ConsumptionEntry)
        .options(selectinload(ConsumptionEntry.items))
        .where(ConsumptionEntry.id == entry_id)
        .with_for_update()
    )
    e = result.scalar_one_or_none()
    if not e:
        raise HTTPException(status_code=404, detail="Consumption entry not found")
    if e.status == "cancelled":
        raise HTTPException(status_code=400, detail="Already cancelled")

    if e.status == "submitted" and e.warehouse_id:
        for it in e.items:
            try:
                await _post_ledger(
                    db,
                    item_id=it.item_id,
                    warehouse_id=e.warehouse_id,
                    transaction_type="consumption_reversal",
                    qty_in=it.qty,
                    rate=it.rate,
                    batch_id=it.batch_id,
                    reference_type="consumption_cancel",
                    reference_id=e.id,
                    uom_id=it.uom_id,
                    created_by=current_user.id,
                )
            except Exception:
                # Reversal must not silently corrupt — bubble up.
                raise HTTPException(
                    status_code=500,
                    detail=f"Failed to reverse stock for consumption {e.entry_number}",
                )

    e.status = "cancelled"
    await db.flush()
    return {"success": True}


# ==================== accounts: invoices ====================

@router.delete("/accounts/invoices/{invoice_id}")
async def delete_invoice(
    invoice_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    inv = await _require(db, Invoice, invoice_id, "Invoice")
    if inv.status not in ("draft", "cancelled"):
        raise HTTPException(status_code=400, detail=f"Cannot delete invoice in '{inv.status}' status")
    await db.delete(inv)
    await db.flush()
    return {"success": True}


@router.get("/accounts/invoices/{invoice_id}/payments")
async def invoice_payments(
    invoice_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    rows = (await db.execute(
        select(Payment).where(Payment.invoice_id == invoice_id).order_by(desc(Payment.id))
    )).scalars().all()
    return {"items": [{
        "id": p.id, "payment_number": p.payment_number,
        "payment_date": p.payment_date.isoformat() if p.payment_date else None,
        "amount": float(p.amount or 0),
        "payment_mode": p.payment_mode, "status": p.status,
        "reference_number": p.reference_number,
    } for p in rows]}


@router.get("/accounts/invoices/{invoice_id}/print")
async def invoice_print(
    invoice_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    inv = (await db.execute(
        select(Invoice).options(selectinload(Invoice.items)).where(Invoice.id == invoice_id)
    )).scalar_one_or_none()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return {
        "id": inv.id,
        "invoice_number": inv.invoice_number,
        "invoice_date": inv.invoice_date.isoformat() if inv.invoice_date else None,
        "due_date": inv.due_date.isoformat() if inv.due_date else None,
        "party_type": inv.party_type,
        "party_id": inv.party_id,
        "subtotal": float(inv.subtotal or 0),
        "tax_amount": float(inv.tax_amount or 0),
        "grand_total": float(inv.grand_total or 0),
        "paid_amount": float(inv.paid_amount or 0),
        "balance_amount": float(inv.balance_amount or 0),
        "status": inv.status,
        "items": [{
            "id": i.id, "item_id": i.item_id,
            "qty": float(i.qty or 0),
            "rate": float(i.rate or 0),
            "amount": float(i.amount or 0),
        } for i in inv.items],
    }


# ==================== accounts: payments ====================

@router.get("/accounts/payments/{payment_id}")
async def get_payment(
    payment_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    p = await _require(db, Payment, payment_id, "Payment")
    return {
        "id": p.id, "payment_number": p.payment_number,
        "payment_type": p.payment_type, "party_type": p.party_type, "party_id": p.party_id,
        "invoice_id": p.invoice_id, "po_id": p.po_id, "project_id": p.project_id,
        "payment_date": p.payment_date.isoformat() if p.payment_date else None,
        "amount": float(p.amount or 0), "payment_mode": p.payment_mode,
        "reference_number": p.reference_number, "bank_account": p.bank_account,
        "is_advance": p.is_advance, "status": p.status, "remarks": p.remarks,
    }


class PaymentUpdate(BaseModel):
    payment_date: Optional[datetime] = None
    amount: Optional[float] = None
    payment_mode: Optional[str] = None
    reference_number: Optional[str] = None
    bank_account: Optional[str] = None
    remarks: Optional[str] = None
    status: Optional[str] = None


@router.put("/accounts/payments/{payment_id}")
async def update_payment(
    payment_id: int, payload: PaymentUpdate,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    p = await _require(db, Payment, payment_id, "Payment")
    if p.status in ("reconciled", "cancelled"):
        raise HTTPException(status_code=400, detail=f"Cannot edit payment in '{p.status}' status")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(p, k, v)
    await db.flush()
    return {"success": True}


@router.delete("/accounts/payments/{payment_id}")
async def delete_payment(
    payment_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    p = await _require(db, Payment, payment_id, "Payment")
    if p.status not in ("draft", "cancelled"):
        raise HTTPException(status_code=400, detail=f"Cannot delete payment in '{p.status}' status")
    await db.delete(p)
    await db.flush()
    return {"success": True}


# ==================== accounts: credit notes ====================

@router.get("/accounts/credit-notes/{cn_id}")
async def get_credit_note(
    cn_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    cn = await _require(db, CreditNote, cn_id, "Credit note")
    return {
        "id": cn.id, "cn_number": cn.cn_number, "invoice_id": cn.invoice_id,
        "party_type": cn.party_type, "party_id": cn.party_id,
        "cn_date": cn.cn_date.isoformat() if cn.cn_date else None,
        "amount": float(cn.amount or 0), "reason": cn.reason, "status": cn.status,
    }


class CreditNoteUpdate(BaseModel):
    invoice_id: Optional[int] = None
    party_type: Optional[str] = None
    party_id: Optional[int] = None
    cn_date: Optional[datetime] = None
    amount: Optional[float] = None
    reason: Optional[str] = None


@router.put("/accounts/credit-notes/{cn_id}")
async def update_credit_note(
    cn_id: int, payload: CreditNoteUpdate,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    cn = await _require(db, CreditNote, cn_id, "Credit note")
    if cn.status != "draft":
        raise HTTPException(status_code=400, detail=f"Cannot edit credit note in '{cn.status}' status")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(cn, k, v)
    await db.flush()
    return {"success": True}


@router.delete("/accounts/credit-notes/{cn_id}")
async def delete_credit_note(
    cn_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    cn = await _require(db, CreditNote, cn_id, "Credit note")
    if cn.status not in ("draft", "cancelled"):
        raise HTTPException(status_code=400, detail=f"Cannot delete credit note in '{cn.status}' status")
    await db.delete(cn)
    await db.flush()
    return {"success": True}


@router.post("/accounts/credit-notes/{cn_id}/issue")
async def issue_credit_note(
    cn_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    cn = await _require(db, CreditNote, cn_id, "Credit note")
    _assert_status(cn, ("draft",), "issue")
    cn.status = "issued"
    await db.flush()
    return {"success": True, "message": "Credit note issued"}


@router.post("/accounts/credit-notes/{cn_id}/adjust")
async def adjust_credit_note(
    cn_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    cn = await _require(db, CreditNote, cn_id, "Credit note")
    _assert_status(cn, ("issued",), "adjust")
    cn.status = "adjusted"
    await db.flush()
    return {"success": True, "message": "Credit note adjusted"}


@router.post("/accounts/credit-notes/{cn_id}/cancel")
async def cancel_credit_note(
    cn_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    cn = await _require(db, CreditNote, cn_id, "Credit note")
    if cn.status == "cancelled":
        raise HTTPException(status_code=400, detail="Already cancelled")
    cn.status = "cancelled"
    await db.flush()
    return {"success": True, "message": "Credit note cancelled"}


# ==================== settings ====================

# BUG-AUTH-109: setting keys whose values are credentials and must be masked
# in any list response, even to authorised callers.
_MASKED_SETTING_KEYS = {
    "smtp_password",
    "smtp_pass",
    "email_password",
    "smtp_secret",
}


@router.get("/settings/system")
async def list_system_settings(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin")),
):
    """List system settings.

    BUG-AUTH-109 fix:
    - Restricted to super_admin (was: any authenticated user).
    - smtp_password / other credential-type settings are masked as ``***`` in
      the response so the plaintext never leaves the server.
    """
    rows = (await db.execute(select(SystemSetting))).scalars().all()
    items = []
    for s in rows:
        value = s.setting_value
        if s.setting_key in _MASKED_SETTING_KEYS and value:
            value = "***"
        items.append({
            "id": s.id, "setting_key": s.setting_key, "setting_value": value,
            "setting_type": s.setting_type, "module": s.module, "description": s.description,
        })
    return {"items": items}


class SystemSettingsUpdate(BaseModel):
    # Accept either {"settings": {k: v}} OR a flat {k: v} body — the
    # frontend sends flat values, but legacy clients wrap in `settings`.
    settings: Optional[dict] = None

    model_config = {"extra": "allow"}


# BUG-AUTH-114 fix: explicit allow-list of setting keys that admins are
# permitted to write through /settings/system/{module}. Anything outside this
# set is silently dropped so a malicious or buggy client can't inject
# arbitrary key/value pairs into the system_settings table (which is read by
# many other code paths).
_ALLOWED_SETTING_KEYS = {
    "general": {
        "company_name", "company_logo", "fiscal_year_start", "date_format",
        "currency", "timezone", "language",
    },
    "email": {
        "smtp_host", "smtp_port", "smtp_username", "smtp_password",
        "smtp_ssl", "from_email", "from_name",
    },
}


def _coerce_settings_payload(payload):
    """Return a flat {key: value} dict from either of the two body shapes."""
    if payload.settings:
        return dict(payload.settings)
    # Pydantic stashes extra keys on `model_extra` when extra=allow.
    extra = getattr(payload, "model_extra", None) or {}
    return dict(extra)


async def _upsert_settings(db, module, payload):
    raw = _coerce_settings_payload(payload)
    allowed = _ALLOWED_SETTING_KEYS.get(module, set())
    items = {k: v for k, v in raw.items() if k in allowed}

    # BUG-AUTH-116 fix: validate from_email format. Without this guard a typo
    # like "noreply" or "noreply@" silently lands in system_settings and the
    # outbound mailer fails with cryptic SMTP errors.
    from_email = items.get("from_email")
    if from_email is not None and str(from_email).strip():
        import re
        v = str(from_email).strip()
        if not re.match(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$", v):
            raise HTTPException(
                status_code=400,
                detail="from_email is not a valid email address",
            )

    for k, v in items.items():
        # BUG-AUTH-110/111 fix: when frontend sends a blank or masked value
        # for a credential key, treat it as "no change" so admins editing
        # other email fields don't accidentally wipe smtp_password.
        if k in _MASKED_SETTING_KEYS and (v in (None, "", "***")):
            continue
        existing = (await db.execute(
            select(SystemSetting).where(SystemSetting.setting_key == k)
        )).scalar_one_or_none()
        if existing:
            existing.setting_value = str(v) if v is not None else None
            existing.module = module
        else:
            db.add(SystemSetting(setting_key=k, setting_value=str(v) if v is not None else None, module=module))
    await db.flush()


@router.put("/settings/system/general")
async def update_settings_general(
    payload: SystemSettingsUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin")),
):
    """NEW-3 fix: only Super Admin can change system settings."""
    await _upsert_settings(db, "general", payload)
    return {"success": True}


@router.put("/settings/system/email")
async def update_settings_email(
    payload: SystemSettingsUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin")),
):
    """NEW-3 fix: only Super Admin can change SMTP / email settings."""
    await _upsert_settings(db, "email", payload)
    return {"success": True}


@router.get("/settings/number-series")
async def list_number_series(
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    rows = (await db.execute(select(NumberSeries).order_by(NumberSeries.module, NumberSeries.document_type))).scalars().all()
    return {"items": [{
        "id": n.id, "prefix": n.prefix, "module": n.module,
        "document_type": n.document_type, "current_number": n.current_number,
        "pad_length": n.pad_length, "fiscal_year": n.fiscal_year,
    } for n in rows]}


class NumberSeriesPayload(BaseModel):
    prefix: str
    module: str
    document_type: str
    current_number: Optional[int] = 0
    pad_length: Optional[int] = 5
    fiscal_year: Optional[str] = None


@router.post("/settings/number-series", status_code=201)
async def create_number_series(
    payload: NumberSeriesPayload,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin")),
):
    """NEW-4 fix: only Super Admin can create/modify number series."""
    # BUG-AUTH-112 fix: refuse to create a duplicate (module, document_type,
    # fiscal_year) — without this guard admins could end up with two
    # competing series for the same document type and either silently issue
    # collisions or re-use prefixes.
    dup_q = select(NumberSeries).where(
        NumberSeries.module == payload.module,
        NumberSeries.document_type == payload.document_type,
    )
    if payload.fiscal_year:
        dup_q = dup_q.where(NumberSeries.fiscal_year == payload.fiscal_year)
    else:
        dup_q = dup_q.where(NumberSeries.fiscal_year.is_(None))
    existing = (await db.execute(dup_q.limit(1))).scalar_one_or_none()
    if existing:
        raise HTTPException(
            status_code=409,
            detail=(
                f"A number series for module='{payload.module}', "
                f"document_type='{payload.document_type}'"
                + (f", fiscal_year='{payload.fiscal_year}'" if payload.fiscal_year else "")
                + " already exists."
            ),
        )
    n = NumberSeries(
        prefix=payload.prefix, module=payload.module, document_type=payload.document_type,
        current_number=payload.current_number or 0, pad_length=payload.pad_length or 5,
        fiscal_year=payload.fiscal_year,
    )
    db.add(n)
    await db.flush()
    return {"id": n.id}


@router.put("/settings/number-series/{series_id}")
async def update_number_series(
    series_id: int, payload: NumberSeriesPayload,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin")),
):
    n = await _require(db, NumberSeries, series_id, "Number series")
    n.prefix = payload.prefix
    n.module = payload.module
    n.document_type = payload.document_type
    if payload.current_number is not None:
        # BUG-AUTH-113 fix: number series counters must never run backwards
        # — that would let an admin re-issue document numbers and create
        # collisions with previously issued POs/Indents.
        if payload.current_number < (n.current_number or 0):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"current_number cannot be reduced (was {n.current_number}, "
                    f"requested {payload.current_number}). Numbers must be monotonic."
                ),
            )
        n.current_number = payload.current_number
    if payload.pad_length is not None:
        n.pad_length = payload.pad_length
    n.fiscal_year = payload.fiscal_year
    await db.flush()
    return {"success": True}


@router.delete("/settings/number-series/{series_id}")
async def delete_number_series(
    series_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin")),
):
    n = await _require(db, NumberSeries, series_id, "Number series")
    await db.delete(n)
    await db.flush()
    return {"success": True}


# ==================== attachments ====================

# Allowed extensions for attachment uploads. Anything outside this list is
# rejected — stops stored XSS via .html/.svg/.js and executable uploads.
_ALLOWED_UPLOAD_EXTS = {
    ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp",
    ".doc", ".docx", ".xls", ".xlsx", ".csv", ".txt",
}

# BUG-HC-111 fix: magic-byte signature map. Files whose first bytes don't
# match the declared extension are refused so a renamed .exe / .html cannot
# be served back to other users.
_MAGIC_BYTES_BY_EXT_DF: dict = {
    ".pdf": [b"%PDF-"],
    ".png": [b"\x89PNG\r\n\x1a\n"],
    ".jpg": [b"\xff\xd8\xff"],
    ".jpeg": [b"\xff\xd8\xff"],
    ".gif": [b"GIF87a", b"GIF89a"],
    ".webp": [b"RIFF"],
    ".bmp": [b"BM"],
    ".doc": [b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"],
    ".docx": [b"PK\x03\x04"],
    ".xls": [b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"],
    ".xlsx": [b"PK\x03\x04"],
}


def _df_validate_magic(content: bytes, ext: str) -> bool:
    if ext in (".csv", ".txt"):
        sample = content[:1024]
        try:
            sample.decode("utf-8")
        except UnicodeDecodeError:
            return False
        return b"\x00" not in sample
    sigs = _MAGIC_BYTES_BY_EXT_DF.get(ext)
    if not sigs:
        return True
    return any(content.startswith(s) for s in sigs)


# Allowed `entity_type` folders — prevents path traversal via "../../etc".
_ALLOWED_ENTITY_TYPES = {
    "general", "indent", "material_request", "purchase_order", "quotation",
    "grn", "invoice", "payment", "vendor", "item", "user", "asset",
    "consumption", "stock_transfer", "stock_audit", "material_issue",
    "transport_requirement", "healthcare",
}


@router.post("/attachments/upload", status_code=201)
async def upload_attachment(
    file: UploadFile = File(...),
    entity_type: str = Form("general"),
    entity_id: int = Form(0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Sanitize entity_type against a whitelist (path-traversal defense)
    safe_entity_type = (entity_type or "general").strip().lower()
    if safe_entity_type not in _ALLOWED_ENTITY_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"entity_type must be one of {sorted(_ALLOWED_ENTITY_TYPES)}",
        )

    # Extension whitelist (stored-XSS defense)
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in _ALLOWED_UPLOAD_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"File extension {ext or '(none)'} not allowed. Allowed: {sorted(_ALLOWED_UPLOAD_EXTS)}",
        )

    content = await file.read()
    if len(content) > settings.MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=400, detail="File too large")
    if len(content) == 0:
        raise HTTPException(status_code=400, detail="Empty file")
    # BUG-HC-111 fix: enforce magic-byte content/extension match.
    if not _df_validate_magic(content, ext):
        raise HTTPException(
            status_code=400,
            detail=f"File content does not match {ext} format (magic-byte check failed).",
        )

    upload_dir = os.path.join(settings.UPLOAD_DIR, safe_entity_type)
    os.makedirs(upload_dir, exist_ok=True)
    stored_name = f"{uuid.uuid4().hex}{ext}"
    stored_path = os.path.join(upload_dir, stored_name)
    with open(stored_path, "wb") as f:
        f.write(content)
    public_url = f"/uploads/{safe_entity_type}/{stored_name}"
    att = FileAttachment(
        entity_type=safe_entity_type,
        entity_id=entity_id or 0,
        file_name=file.filename or stored_name,
        file_path=public_url,
        file_type=ext.lstrip("."),
        file_size=len(content),
        uploaded_by=current_user.id,
    )
    db.add(att)
    await db.flush()
    return {
        "id": att.id,
        "file_name": att.file_name,
        "file_path": att.file_path,
        "url": att.file_path,
        "file_size": att.file_size,
        "file_type": att.file_type,
    }


@router.get("/attachments")
async def list_attachments(
    entity_type: str,
    entity_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    safe_entity_type = (entity_type or "").strip().lower()
    if safe_entity_type not in _ALLOWED_ENTITY_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"entity_type must be one of {sorted(_ALLOWED_ENTITY_TYPES)}",
        )
    # BUG-HC-112 fix: gate cross-entity attachment listings. Without this, any
    # auth user could enumerate vendor / payment / user / consumption
    # attachments by guessing entity_id. Privileged roles can list anything;
    # everyone else only gets attachments they uploaded themselves.
    from app.utils.dependencies import get_user_role_codes
    user_roles = set(await get_user_role_codes(db, current_user.id))
    privileged = {
        "super_admin", "admin", "compliance_officer", "compliance",
        "procurement_manager", "store_manager", "warehouse_manager",
        "finance_manager", "accounts_manager", "documents_admin",
    }
    is_privileged = bool(user_roles & privileged)

    q = (
        select(FileAttachment)
        .where(FileAttachment.entity_type == safe_entity_type)
        .where(FileAttachment.entity_id == entity_id)
    )
    if not is_privileged:
        q = q.where(FileAttachment.uploaded_by == current_user.id)
    result = await db.execute(q.order_by(FileAttachment.id.desc()))
    rows = result.scalars().all()
    return [
        {
            "id": a.id,
            "file_name": a.file_name,
            "file_path": a.file_path,
            "url": a.file_path,
            "file_type": a.file_type,
            "file_size": a.file_size,
            "uploaded_by": a.uploaded_by,
            "created_at": a.created_at.isoformat() if a.created_at else None,
        }
        for a in rows
    ]


# ==================== healthcare: transfer-suggestions/create ====================

class TransferSuggestionCreate(BaseModel):
    source_warehouse_id: int
    destination_warehouse_id: int
    item_id: int
    qty: float
    reason: Optional[str] = None


@router.post("/healthcare/analytics/transfer-suggestions/create", status_code=201)
async def create_transfer_suggestion(
    payload: TransferSuggestionCreate,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    # Create a draft stock transfer as the concrete result of accepting a suggestion.
    from app.services.number_series import generate_number
    transfer_number = await generate_number(db, "inventory", "stock_transfer")
    t = StockTransfer(
        transfer_number=transfer_number,
        source_warehouse_id=payload.source_warehouse_id,
        destination_warehouse_id=payload.destination_warehouse_id,
        transfer_date=datetime.now(timezone.utc),
        transfer_type="warehouse_to_warehouse",
        status="draft",
        remarks=payload.reason or "Created from healthcare transfer suggestion",
        requested_by=current_user.id,
    )
    db.add(t)
    await db.flush()
    return {"id": t.id, "transfer_number": t.transfer_number}



