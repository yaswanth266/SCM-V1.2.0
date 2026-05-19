"""Wave 9 — MRP API.

Surface:
  GET    /mrp/runs                           — list runs
  GET    /mrp/runs/{id}                      — run header + items
  POST   /mrp/runs/compute                   — kick off a new MRP run
  PUT    /mrp/runs/{id}/items/{item_id}      — toggle selected / override qty/vendor
  POST   /mrp/runs/{id}/convert-to-pos       — generate draft POs
  GET    /mrp/forecast/preview/{item_id}     — quick forecast preview without persisting
"""
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.user import User
from app.models.master import Item, Vendor
from app.models.mrp import MRPRun, MRPRunItem
from app.services.mrp_service import (
    compute_mrp_run, convert_run_to_pos, FORECAST_METHODS,
    consumption_per_day,
)
from app.utils.dependencies import get_current_user, require_any_role
from app.utils.helpers import paginate_params, build_paginated_response


router = APIRouter()


@router.get("/runs")
async def list_runs(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: Optional[str] = Query(None),
    warehouse_id: Optional[int] = Query(None, description="Filter runs by warehouse (BUG-FIN-079)"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    q = select(MRPRun)
    cq = select(func.count(MRPRun.id))
    if status:
        q = q.where(MRPRun.status == status)
        cq = cq.where(MRPRun.status == status)
    if warehouse_id:
        # BUG-FIN-079: previously the warehouse_id query param was ignored.
        q = q.where(MRPRun.warehouse_id == warehouse_id)
        cq = cq.where(MRPRun.warehouse_id == warehouse_id)
    total = (await db.execute(cq)).scalar() or 0
    rows = (await db.execute(q.offset(offset).limit(limit).order_by(MRPRun.id.desc()))).scalars().all()
    out = []
    for r in rows:
        out.append({
            "id": r.id,
            "run_number": r.run_number,
            "run_date": r.run_date.isoformat() if r.run_date else None,
            "horizon_days": r.horizon_days,
            "history_days": r.history_days,
            "method": r.method,
            "warehouse_id": r.warehouse_id,
            "status": r.status,
            "total_items": r.total_items,
            "items_needing_reorder": r.items_needing_reorder,
            "total_suggested_value": float(r.total_suggested_value or 0),
            "notes": r.notes,
            "created_by": r.created_by,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        })
    return build_paginated_response(out, total, page, page_size)


@router.get("/runs/{run_id}")
async def get_run(
    run_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    r = (await db.execute(
        select(MRPRun).options(selectinload(MRPRun.items)).where(MRPRun.id == run_id)
    )).scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="MRP run not found")

    # Look up item names + vendor names for display
    item_ids = [it.item_id for it in r.items]
    vendor_ids = [it.suggested_vendor_id for it in r.items if it.suggested_vendor_id]
    items_by_id = {}
    vendors_by_id = {}
    if item_ids:
        i_rows = await db.execute(select(Item.id, Item.item_code, Item.name).where(Item.id.in_(item_ids)))
        for row in i_rows.all():
            items_by_id[row.id] = {"item_code": row.item_code, "name": row.name}
    if vendor_ids:
        v_rows = await db.execute(select(Vendor.id, Vendor.name, Vendor.vendor_code).where(Vendor.id.in_(vendor_ids)))
        for row in v_rows.all():
            vendors_by_id[row.id] = {"name": row.name, "vendor_code": row.vendor_code}

    items = []
    for it in r.items:
        i = items_by_id.get(it.item_id) or {}
        v = vendors_by_id.get(it.suggested_vendor_id) or {} if it.suggested_vendor_id else {}
        items.append({
            "id": it.id,
            "item_id": it.item_id,
            "item_code": i.get("item_code"),
            "item_name": i.get("name"),
            "current_stock": float(it.current_stock or 0),
            "on_order_qty": float(it.on_order_qty or 0),
            "reserved_qty": float(it.reserved_qty or 0),
            "forecast_qty": float(it.forecast_qty or 0),
            "safety_stock": float(it.safety_stock or 0),
            "reorder_level": float(it.reorder_level or 0),
            "net_required": float(it.net_required or 0),
            "suggested_qty": float(it.suggested_qty or 0),
            "suggested_vendor_id": it.suggested_vendor_id,
            "suggested_vendor_name": v.get("name"),
            "suggested_rate": float(it.suggested_rate or 0),
            "lead_time_days": it.lead_time_days,
            "confidence_pct": float(it.confidence_pct or 0),
            "selected": it.selected,
            "generated_po_id": it.generated_po_id,
        })

    return {
        "id": r.id,
        "run_number": r.run_number,
        "run_date": r.run_date.isoformat() if r.run_date else None,
        "horizon_days": r.horizon_days,
        "history_days": r.history_days,
        "method": r.method,
        "warehouse_id": r.warehouse_id,
        "status": r.status,
        "total_items": r.total_items,
        "items_needing_reorder": r.items_needing_reorder,
        "total_suggested_value": float(r.total_suggested_value or 0),
        "notes": r.notes,
        "items": items,
    }


@router.post("/runs/compute", status_code=201)
async def compute_new_run(
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "manager", "procurement_manager")),
):
    """Kick off MRP. Body:
      { method, horizon_days, history_days, warehouse_id?, item_category_id?, item_ids?[], notes? }
    """
    method = payload.get("method", "moving_average")
    if method not in FORECAST_METHODS:
        raise HTTPException(status_code=400, detail=f"method must be one of {list(FORECAST_METHODS)}")

    run = await compute_mrp_run(
        db,
        method=method,
        horizon_days=int(payload.get("horizon_days", 30)),
        history_days=int(payload.get("history_days", 90)),
        warehouse_id=payload.get("warehouse_id"),
        item_category_id=payload.get("item_category_id"),
        item_ids=payload.get("item_ids"),
        notes=payload.get("notes"),
        created_by=current_user.id,
    )
    return {
        "id": run.id,
        "run_number": run.run_number,
        "total_items": run.total_items,
        "items_needing_reorder": run.items_needing_reorder,
        "total_suggested_value": float(run.total_suggested_value or 0),
        "message": "MRP run computed",
    }


@router.put("/runs/{run_id}/items/{mri_id}")
async def update_run_item(
    run_id: int,
    mri_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    mri = (await db.execute(
        select(MRPRunItem).where(MRPRunItem.id == mri_id, MRPRunItem.run_id == run_id)
    )).scalar_one_or_none()
    if not mri:
        raise HTTPException(status_code=404, detail="MRP run item not found")
    for k in ("selected", "suggested_qty", "suggested_vendor_id", "suggested_rate", "notes"):
        if k in payload:
            setattr(mri, k, payload[k])
    await db.flush()
    return {"success": True}


@router.post("/runs/{run_id}/convert-to-pos")
async def convert_to_pos(
    run_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "manager", "procurement_manager", "procurement_officer")),
):
    """Generate draft POs for all selected items, grouped by vendor."""
    return await convert_run_to_pos(db, run_id=run_id, only_selected=True, created_by=current_user.id)


@router.get("/forecast/preview/{item_id}")
async def forecast_preview(
    item_id: int,
    method: str = Query("moving_average"),
    horizon_days: int = Query(30, ge=1, le=365),
    history_days: int = Query(90, ge=7, le=730),
    warehouse_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if method not in FORECAST_METHODS:
        raise HTTPException(status_code=400, detail=f"method must be one of {list(FORECAST_METHODS)}")
    item = (await db.execute(select(Item).where(Item.id == item_id))).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    history = await consumption_per_day(db, item_id=item_id, days=history_days, warehouse_id=warehouse_id)
    fn = FORECAST_METHODS[method]
    forecast_qty, confidence = fn(history, horizon_days)
    # BUG-FIN-082: zero-padding inflates the apparent total/average for new
    # SKUs because consumption_per_day pads days with no movement. Compute the
    # avg-per-day from non-zero days only so preview matches the forecast logic.
    nonzero_history = [h for h in history if h and float(h) > 0]
    history_total_val = sum(history)
    avg_denominator = len(nonzero_history) if nonzero_history else max(1, len(history))
    avg_per_day = history_total_val / avg_denominator if avg_denominator else 0
    return {
        "item_id": item_id,
        "item_code": item.item_code,
        "item_name": item.name,
        "method": method,
        "history_days": history_days,
        "horizon_days": horizon_days,
        "history_total": float(history_total_val),
        "history_active_days": len(nonzero_history),
        "history_avg_per_day": float(avg_per_day),
        "forecast_qty": float(forecast_qty),
        "confidence_pct": float(confidence),
        "history": [float(h) for h in history],
    }
