"""Alerts module — expiry, reorder, low-stock, near-expiry, ABC.

Closes audit gap features G-04 (expiry), G-05 (reorder), G-06 (ABC).

Endpoints:
  GET /alerts/summary               — KPI cards for dashboard
  GET /alerts/expiry                — batches expiring in N days
  GET /alerts/expired               — already-expired batches still in stock
  GET /alerts/reorder               — items below reorder level
  GET /alerts/low-stock             — items below safety stock
  GET /alerts/abc-analysis          — items classified A/B/C by consumption value
"""
from __future__ import annotations
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User
from app.models.master import Item, ItemCategory, Vendor, VendorItem
from app.models.warehouse import Batch, Warehouse
from app.models.stock import StockBalance, StockLedger
from app.utils.dependencies import (
    get_current_user, user_is_managerial, user_warehouse_ids,
    require_any_role,
)

# BUG-FIN-139: shared expiry-urgency thresholds. Use these everywhere we
# bucket "critical / warning / info" so a future tightening of the policy
# only edits one place.
EXPIRY_CRITICAL_DAYS = 7
EXPIRY_WARNING_DAYS = 30


def expiry_urgency(days_left: int) -> str:
    if days_left <= EXPIRY_CRITICAL_DAYS:
        return "critical"
    if days_left <= EXPIRY_WARNING_DAYS:
        return "warning"
    return "info"
from app.utils.helpers import paginate_params, build_paginated_response


router = APIRouter()


# ─────────────────────────────────────────────────────────────────────
# Dashboard summary
# ─────────────────────────────────────────────────────────────────────

@router.get("/summary")
async def alerts_summary(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Single KPI payload for the alerts dashboard."""
    today = date.today()
    in_30 = today + timedelta(days=30)
    in_90 = today + timedelta(days=90)

    # Apply warehouse scope
    scoped_wh = None
    if not await user_is_managerial(db, current_user.id):
        scoped_wh = await user_warehouse_ids(db, current_user.id)
        if not scoped_wh:
            scoped_wh = [-1]  # no warehouses → 0 results

    # BUG-FIN-130/131/170: roll the three expiry-bucket counts into a single
    # aggregate query. The previous implementation issued 3 separate round-trips
    # to the DB; we now use a single COUNT(DISTINCT CASE WHEN ...) per bucket.
    from sqlalchemy import case as _case
    expired_case = _case(
        (Batch.expiry_date <= today, Batch.id),
        else_=None,
    )
    soon_case = _case(
        (and_(Batch.expiry_date > today, Batch.expiry_date <= in_30), Batch.id),
        else_=None,
    )
    near_case = _case(
        (and_(Batch.expiry_date > in_30, Batch.expiry_date <= in_90), Batch.id),
        else_=None,
    )
    bucket_q = (
        select(
            func.count(func.distinct(expired_case)).label("expired"),
            func.count(func.distinct(soon_case)).label("soon"),
            func.count(func.distinct(near_case)).label("near"),
        )
        .select_from(Batch)
        .join(StockBalance, StockBalance.batch_id == Batch.id)
        .where(
            Batch.expiry_date.isnot(None),
            StockBalance.available_qty > 0,
        )
    )
    if scoped_wh is not None:
        bucket_q = bucket_q.where(StockBalance.warehouse_id.in_(scoped_wh))
    bucket_row = (await db.execute(bucket_q)).one()
    expired_count = int(bucket_row.expired or 0)
    expiring_30d = int(bucket_row.soon or 0)
    expiring_90d = int(bucket_row.near or 0)

    # Reorder + low-stock counts: items where total stock < reorder_level
    # Aggregate stock per item across all (scoped) warehouses
    stock_q = (
        select(
            StockBalance.item_id,
            func.coalesce(func.sum(StockBalance.available_qty), 0).label("avail"),
        )
        .group_by(StockBalance.item_id)
    )
    if scoped_wh is not None:
        stock_q = stock_q.where(StockBalance.warehouse_id.in_(scoped_wh))
    stock_rows = (await db.execute(stock_q)).all()
    stock_by_item = {r.item_id: float(r.avail) for r in stock_rows}

    # Items with reorder_level > 0 (only meaningful targets)
    items_q = await db.execute(
        select(Item.id, Item.reorder_level, Item.safety_stock)
        .where(Item.is_active == True, Item.reorder_level > 0)  # noqa: E712
    )
    reorder_count = 0
    low_stock_count = 0
    for row in items_q.all():
        avail = stock_by_item.get(row.id, 0)
        if avail < float(row.reorder_level or 0):
            reorder_count += 1
        if avail < float(row.safety_stock or 0):
            low_stock_count += 1

    return {
        "as_of": today.isoformat(),
        "expired_in_stock": expired_count,
        "expiring_30d": expiring_30d,
        "expiring_31_90d": expiring_90d,
        "items_below_reorder": reorder_count,
        "items_below_safety_stock": low_stock_count,
    }


# ─────────────────────────────────────────────────────────────────────
# Expiry / expired batches
# ─────────────────────────────────────────────────────────────────────

async def _scope_warehouse_filter(db: AsyncSession, user: User) -> Optional[list[int]]:
    if await user_is_managerial(db, user.id):
        return None
    wh = await user_warehouse_ids(db, user.id)
    return wh if wh else [-1]


@router.get("/expiry")
async def expiry_alerts(
    days: int = Query(30, ge=1, le=365, description="Show batches expiring within N days"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Batches expiring in the next N days (excludes already-expired)."""
    today = date.today()
    cutoff = today + timedelta(days=days)
    scoped_wh = await _scope_warehouse_filter(db, current_user)
    offset, limit = paginate_params(page, page_size)

    q = (
        select(
            Batch.id, Batch.batch_number, Batch.item_id, Batch.expiry_date,
            Batch.manufacturing_date,
            Item.item_code, Item.name.label("item_name"),
            func.sum(StockBalance.available_qty).label("available_qty"),
        )
        .join(StockBalance, StockBalance.batch_id == Batch.id)
        .join(Item, Item.id == Batch.item_id)
        .where(
            Batch.expiry_date.isnot(None),
            Batch.expiry_date >= today,
            Batch.expiry_date <= cutoff,
            StockBalance.available_qty > 0,
        )
        .group_by(Batch.id, Batch.batch_number, Batch.item_id, Batch.expiry_date,
                  Batch.manufacturing_date, Item.item_code, Item.name)
    )
    if scoped_wh is not None:
        q = q.where(StockBalance.warehouse_id.in_(scoped_wh))

    q = q.order_by(Batch.expiry_date.asc())
    rows = (await db.execute(q.offset(offset).limit(limit))).all()

    out = []
    for r in rows:
        days_left = (r.expiry_date - today).days
        out.append({
            "batch_id": r.id,
            "batch_number": r.batch_number,
            "item_id": r.item_id,
            "item_code": r.item_code,
            "item_name": r.item_name,
            "available_qty": float(r.available_qty or 0),
            "expiry_date": r.expiry_date.isoformat() if r.expiry_date else None,
            "manufacturing_date": r.manufacturing_date.isoformat() if r.manufacturing_date else None,
            "days_left": days_left,
            "urgency": expiry_urgency(days_left),
        })
    return {"data": out, "total": len(out)}


@router.get("/expired")
async def expired_alerts(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Batches already past expiry but still showing stock (must be quarantined)."""
    today = date.today()
    scoped_wh = await _scope_warehouse_filter(db, current_user)
    offset, limit = paginate_params(page, page_size)

    q = (
        select(
            Batch.id, Batch.batch_number, Batch.item_id, Batch.expiry_date,
            Item.item_code, Item.name.label("item_name"),
            func.sum(StockBalance.available_qty).label("available_qty"),
            func.sum(StockBalance.stock_value).label("stock_value"),
        )
        .join(StockBalance, StockBalance.batch_id == Batch.id)
        .join(Item, Item.id == Batch.item_id)
        .where(
            Batch.expiry_date.isnot(None),
            Batch.expiry_date < today,
            StockBalance.available_qty > 0,
        )
        .group_by(Batch.id, Batch.batch_number, Batch.item_id, Batch.expiry_date,
                  Item.item_code, Item.name)
    )
    if scoped_wh is not None:
        q = q.where(StockBalance.warehouse_id.in_(scoped_wh))
    q = q.order_by(Batch.expiry_date.asc())

    rows = (await db.execute(q.offset(offset).limit(limit))).all()
    out = []
    total_value = 0.0
    for r in rows:
        days_expired = (today - r.expiry_date).days if r.expiry_date else 0
        value = float(r.stock_value or 0)
        total_value += value
        out.append({
            "batch_id": r.id,
            "batch_number": r.batch_number,
            "item_id": r.item_id,
            "item_code": r.item_code,
            "item_name": r.item_name,
            "available_qty": float(r.available_qty or 0),
            "stock_value": value,
            "expiry_date": r.expiry_date.isoformat() if r.expiry_date else None,
            "days_expired": days_expired,
        })
    return {"data": out, "total": len(out), "write_off_value_estimate": total_value}


# ─────────────────────────────────────────────────────────────────────
# Reorder + low-stock alerts
# ─────────────────────────────────────────────────────────────────────

@router.get("/reorder")
async def reorder_alerts(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Items where current stock < reorder_level. Suggests qty + preferred vendor.

    BUG-FIN-132/172: previously this loaded every item into Python and
    filtered there. Now the HAVING clause does the predicate at SQL level
    so we don't pull thousands of rows over the wire.
    """
    scoped_wh = await _scope_warehouse_filter(db, current_user)
    offset, limit = paginate_params(page, page_size)

    avail_expr = func.coalesce(func.sum(StockBalance.available_qty), 0)
    base_q = (
        select(
            Item.id.label("item_id"),
            Item.item_code,
            Item.name.label("item_name"),
            Item.reorder_level,
            Item.safety_stock,
            Item.reorder_qty,
            Item.lead_time_days,
            avail_expr.label("avail"),
        )
        .outerjoin(StockBalance, StockBalance.item_id == Item.id)
        .where(Item.is_active == True, Item.reorder_level > 0)  # noqa: E712
        .group_by(
            Item.id, Item.item_code, Item.name,
            Item.reorder_level, Item.safety_stock, Item.reorder_qty, Item.lead_time_days,
        )
        .having(avail_expr < Item.reorder_level)
        .order_by((Item.reorder_level - avail_expr).desc())
    )
    if scoped_wh is not None:
        base_q = base_q.where(StockBalance.warehouse_id.in_(scoped_wh))

    # Total count via subquery wrapper (HAVING-aware)
    total = (await db.execute(
        select(func.count()).select_from(base_q.subquery())
    )).scalar() or 0

    rows = (await db.execute(base_q.offset(offset).limit(limit))).all()
    needing = []
    for r in rows:
        avail = float(r.avail or 0)
        reorder = float(r.reorder_level or 0)
        needing.append({
            "item_id": r.item_id,
            "item_code": r.item_code,
            "item_name": r.item_name,
            "current_stock": avail,
            "reorder_level": reorder,
            "safety_stock": float(r.safety_stock or 0),
            "reorder_qty": float(r.reorder_qty or 0),
            "shortage": max(0.0, reorder - avail),
            "suggested_qty": max(float(r.reorder_qty or 0), reorder - avail),
            "lead_time_days": r.lead_time_days or 0,
        })
    return {
        "data": needing,
        "total": int(total),
    }


@router.get("/low-stock")
async def low_stock_alerts(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Items where current stock < safety_stock (more critical than reorder).

    BUG-FIN-134: previously this returned every shortfall row in a single
    payload. We now paginate so the API stays responsive on large catalogs.
    """
    scoped_wh = await _scope_warehouse_filter(db, current_user)
    stock_q = (
        select(
            StockBalance.item_id,
            func.coalesce(func.sum(StockBalance.available_qty), 0).label("avail"),
        )
        .group_by(StockBalance.item_id)
    )
    if scoped_wh is not None:
        stock_q = stock_q.where(StockBalance.warehouse_id.in_(scoped_wh))
    stock_by_item = {r.item_id: float(r.avail) for r in (await db.execute(stock_q)).all()}

    items = (await db.execute(
        select(Item).where(Item.is_active == True, Item.safety_stock > 0)  # noqa: E712
    )).scalars().all()

    rows = []
    for it in items:
        avail = stock_by_item.get(it.id, 0)
        safety = float(it.safety_stock or 0)
        if avail < safety:
            rows.append({
                "item_id": it.id,
                "item_code": it.item_code,
                "item_name": it.name,
                "current_stock": avail,
                "safety_stock": safety,
                "shortfall": safety - avail,
                "stockout": avail <= 0,
            })
    rows.sort(key=lambda x: (not x["stockout"], -x["shortfall"]))

    total = len(rows)
    offset, limit = paginate_params(page, page_size)
    page_rows = rows[offset:offset + limit]
    return {"data": page_rows, "total": total, "page": page, "page_size": page_size}


# ─────────────────────────────────────────────────────────────────────
# ABC Analysis
# ─────────────────────────────────────────────────────────────────────

@router.get("/abc-analysis")
async def abc_analysis(
    days: int = Query(90, ge=7, le=730, description="Look-back window for consumption"),
    a_threshold: float = Query(80.0, gt=0, lt=100, description="% cumulative value for A class"),
    b_threshold: float = Query(95.0, gt=0, lt=100, description="% cumulative value for B class"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Classifies items by consumption value over the lookback window.

    A class = items contributing top `a_threshold`% (default 80%) of value
    B class = next `b_threshold - a_threshold`% (default 15%)
    C class = remaining

    Used by procurement to prioritize attention on A items.
    """
    cutoff = date.today() - timedelta(days=days)
    scoped_wh = await _scope_warehouse_filter(db, current_user)

    # Sum consumption value per item from stock_ledger (qty_out × rate)
    # BUG-FIN-136: value_out may be NULL when the issue posted before its
    # valuation rate was finalized. Fall back to qty_out * rate when value_out
    # is missing so the ABC tally doesn't lose those rows.
    value_expr = func.sum(
        func.coalesce(
            StockLedger.value_out,
            func.coalesce(StockLedger.qty_out, 0) * func.coalesce(StockLedger.rate, 0),
            0,
        )
    )
    q = (
        select(
            StockLedger.item_id,
            func.coalesce(value_expr, 0).label("value"),
            func.coalesce(func.sum(StockLedger.qty_out), 0).label("qty"),
        )
        .where(
            StockLedger.posting_date >= cutoff,
            StockLedger.qty_out > 0,
        )
        .group_by(StockLedger.item_id)
    )
    if scoped_wh is not None:
        q = q.where(StockLedger.warehouse_id.in_(scoped_wh))
    rows = (await db.execute(q)).all()

    if not rows:
        return {
            "data": [],
            "totals": {"A": 0, "B": 0, "C": 0, "total_value": 0},
            "lookback_days": days,
        }

    # Resolve item codes/names
    item_ids = [r.item_id for r in rows]
    item_meta_q = await db.execute(
        select(Item.id, Item.item_code, Item.name).where(Item.id.in_(item_ids))
    )
    meta_by_id = {r.id: (r.item_code, r.name) for r in item_meta_q.all()}

    sorted_rows = sorted(rows, key=lambda r: float(r.value or 0), reverse=True)
    total_value = sum(float(r.value or 0) for r in sorted_rows)
    # BUG-FIN-135: when total_value is 0 (every issue posted with rate=0 or
    # value_out=NULL fallback also empty), fall back to ranking by qty so the
    # report doesn't claim "all items are C" — at minimum users still see
    # which SKUs move the most.
    fallback_qty_basis = total_value <= 0
    if fallback_qty_basis:
        sorted_rows = sorted(rows, key=lambda r: float(r.qty or 0), reverse=True)
        total_value = sum(float(r.qty or 0) for r in sorted_rows)

    out = []
    cumulative = 0.0
    counts = {"A": 0, "B": 0, "C": 0}
    for r in sorted_rows:
        value = float(r.value or 0) if not fallback_qty_basis else float(r.qty or 0)
        cumulative += value
        cum_pct = (cumulative / total_value * 100) if total_value > 0 else 100
        if cum_pct <= a_threshold:
            cls = "A"
        elif cum_pct <= b_threshold:
            cls = "B"
        else:
            cls = "C"
        counts[cls] += 1
        code, name = meta_by_id.get(r.item_id, (None, None))
        out.append({
            "item_id": r.item_id,
            "item_code": code,
            "item_name": name,
            "qty_consumed": float(r.qty or 0),
            "value": value,
            "value_pct": (value / total_value * 100) if total_value > 0 else 0,
            "cumulative_pct": cum_pct,
            "abc_class": cls,
        })

    return {
        "data": out,
        "totals": {
            "A": counts["A"], "B": counts["B"], "C": counts["C"],
            "total_value": total_value,
            "total_items": len(out),
        },
        "lookback_days": days,
        "a_threshold": a_threshold,
        "b_threshold": b_threshold,
        "ranked_by": "qty" if fallback_qty_basis else "value",
    }


# ─────────────────────────────────────────────────────────────────────
# Vendor Scorecard
# ─────────────────────────────────────────────────────────────────────

@router.get("/vendor-scorecards")
async def list_vendor_scorecards(
    db: AsyncSession = Depends(get_db),
    # BUG-FIN-137: scorecard data exposes vendor evaluation info — gate it
    # to procurement / accounts roles, the same group that can recompute.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "purchase_manager", "accounts_manager",
        "procurement_manager", "procurement_officer",
    )),
):
    """List the latest scorecard per vendor."""
    from app.models.healthcare import VendorScorecard
    rows = (await db.execute(
        select(VendorScorecard, Vendor.name, Vendor.vendor_code)
        .join(Vendor, Vendor.id == VendorScorecard.vendor_id)
        .order_by(VendorScorecard.overall_score.desc())
    )).all()
    out = []
    for r in rows:
        sc = r[0]
        out.append({
            "vendor_id": sc.vendor_id,
            "vendor_name": r.name,
            "vendor_code": r.vendor_code,
            "period_start": sc.period_start.isoformat() if sc.period_start else None,
            "period_end": sc.period_end.isoformat() if sc.period_end else None,
            "total_orders": sc.total_orders,
            "on_time_deliveries": sc.on_time_deliveries,
            "late_deliveries": sc.late_deliveries,
            "total_qty_ordered": float(sc.total_qty_ordered or 0),
            "total_qty_rejected": float(sc.total_qty_rejected or 0),
            "quality_score": float(sc.quality_score or 0),
            "delivery_score": float(sc.delivery_score or 0),
            "price_score": float(sc.price_score or 0),
            "overall_score": float(sc.overall_score or 0),
            "grade": sc.grade,
        })
    return {"data": out, "total": len(out)}


@router.post("/vendor-scorecards/recompute")
async def recompute_vendor_scorecards(
    payload: dict | None = None,
    db: AsyncSession = Depends(get_db),
    # BUG-FIN-138: writes to vendor scorecards must be gated to procurement
    # managers / admins. Any authenticated user could trigger a heavy
    # recompute, which is also a DoS vector.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "purchase_manager", "accounts_manager",
    )),
):
    """Recompute all vendor scorecards. Body (optional): {period_start, period_end}."""
    from app.services.vendor_scorecard import recompute_all
    from datetime import date as _date
    p = payload or {}
    ps = _date.fromisoformat(p["period_start"]) if p.get("period_start") else None
    pe = _date.fromisoformat(p["period_end"]) if p.get("period_end") else None
    return await recompute_all(db, period_start=ps, period_end=pe)
