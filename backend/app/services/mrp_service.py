"""Wave 9 — Demand planning + MRP service.

Pipeline:
  1. consumption_history(item_id, days)        — sum of stock_ledger.qty_out per day
  2. forecast_for_item(item_id, ...)           — chosen forecast method over horizon
  3. on_order_qty(item_id, warehouse_id?)      — sum of open PO line qty (received_qty subtracted)
  4. compute_mrp_row(item, ...)                — net required = forecast + safety_stock - current - on_order
  5. compute_mrp_run(...)                      — runs the above over a set of items, persists rows
  6. convert_to_pos(run_id, vendor_id?)        — creates draft POs grouped by vendor
"""
from __future__ import annotations
from decimal import Decimal
from datetime import date, datetime, timedelta, timezone
from typing import Optional, Sequence

from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.master import Item, Vendor, VendorItem
from app.models.stock import StockLedger, StockBalance
from app.models.procurement import PurchaseOrder, PurchaseOrderItem
from app.models.mrp import MRPRun, MRPRunItem
from app.models.healthcare import RateContract, RateContractItem
from app.models.indent import Indent, IndentItem
from app.services.number_series import generate_number


# BUG-FIN-070: net pending demand from un-issued indents — these are firm
# requisitions from operations that haven't been satisfied yet, so they
# count against current/on-order supply when computing net required.
async def pending_indent_demand(
    db: AsyncSession, *, item_id: int, warehouse_id: Optional[int] = None,
) -> Decimal:
    """Sum (approved_qty - issued_qty) for indents in pending/approved/partially-issued state."""
    q = (
        select(func.coalesce(func.sum(
            func.coalesce(IndentItem.approved_qty, IndentItem.requested_qty)
            - func.coalesce(IndentItem.issued_qty, 0)
        ), 0))
        .join(Indent, Indent.id == IndentItem.indent_id)
        .where(
            IndentItem.item_id == item_id,
            Indent.status.in_(["approved", "partially_issued", "pending_approval"]),
        )
    )
    if warehouse_id and hasattr(Indent, "warehouse_id"):
        q = q.where(Indent.warehouse_id == warehouse_id)
    val = (await db.execute(q)).scalar() or 0
    if val < 0:
        return D0
    return Decimal(str(val))


D0 = Decimal("0")


# ─────────────────────────────────────────────────────────────────────
# Inputs
# ─────────────────────────────────────────────────────────────────────

async def consumption_per_day(
    db: AsyncSession, *, item_id: int, days: int = 90, warehouse_id: Optional[int] = None,
) -> list[Decimal]:
    """Returns a list of daily qty_out values, oldest first, length `days`.

    Days with zero consumption are 0 (we left-pad the history with zeros so
    moving averages weight low-volume periods correctly).
    """
    cutoff = date.today() - timedelta(days=days)
    q = (
        select(
            func.date(StockLedger.posting_date).label("d"),
            func.coalesce(func.sum(StockLedger.qty_out), 0).label("q"),
        )
        .where(
            StockLedger.item_id == item_id,
            StockLedger.posting_date >= cutoff,
            StockLedger.qty_out > 0,
        )
        .group_by(func.date(StockLedger.posting_date))
    )
    if warehouse_id:
        q = q.where(StockLedger.warehouse_id == warehouse_id)
    rows = (await db.execute(q)).all()
    by_day: dict[str, Decimal] = {}
    for r in rows:
        by_day[str(r.d)] = Decimal(str(r.q or 0))
    series: list[Decimal] = []
    today = date.today()
    # BUG-FIN-061: previously `range(days, 0, -1)` excluded today's bucket,
    # so any consumption posted today was invisible to the forecast. We now
    # cover (today - days + 1) … today inclusive.
    for i in range(days - 1, -1, -1):
        day_key = str(today - timedelta(days=i))
        series.append(by_day.get(day_key, D0))
    return series


async def on_order_qty(
    db: AsyncSession, *, item_id: int, warehouse_id: Optional[int] = None,
) -> Decimal:
    """Open PO qty for item: sum of (qty − received_qty) across non-cancelled, non-completed POs."""
    q = (
        select(func.coalesce(func.sum(
            PurchaseOrderItem.qty - func.coalesce(PurchaseOrderItem.received_qty, 0)
        ), 0))
        .join(PurchaseOrder, PurchaseOrder.id == PurchaseOrderItem.po_id)
        .where(
            PurchaseOrderItem.item_id == item_id,
            # BUG-FIN-073: don't count "pending_approval" POs as on-order;
            # they may not actually convert into deliveries. Only firm
            # commitments (approved + partially_received) reduce demand.
            PurchaseOrder.status.in_(["approved", "partially_received"]),
        )
    )
    if warehouse_id:
        q = q.where(PurchaseOrder.warehouse_id == warehouse_id)
    val = (await db.execute(q)).scalar() or 0
    return Decimal(str(val))


# ─────────────────────────────────────────────────────────────────────
# Forecasting
# ─────────────────────────────────────────────────────────────────────

def _sample_size_dampener(n: int, min_samples: int = 14) -> float:
    """BUG-FIN-066: Confidence must scale with how much history we have.

    Returns a [0, 1] multiplier — full confidence at >= min_samples, decaying
    linearly toward 0 below that. With 1 datapoint we get ~1/14 of the raw
    confidence, not 100%.
    """
    if n <= 0:
        return 0.0
    if n >= min_samples:
        return 1.0
    return n / float(min_samples)


def forecast_moving_average(history: Sequence[Decimal], horizon_days: int, window: int = 14) -> tuple[Decimal, Decimal]:
    """Returns (forecast_total_qty, confidence_pct).

    Confidence = inverse coefficient of variation, dampened by sample size,
    clamped to [0, 100].
    """
    if not history:
        return D0, D0
    # BUG-FIN-062: padded zeros for days with no consumption inflate the
    # divisor on new SKUs. Use only non-zero buckets when computing the
    # average AND use the count of those buckets for confidence dampening.
    win = history[-window:] if len(history) >= window else history
    nonzero = [x for x in win if x > 0]
    if not nonzero:
        return D0, D0
    avg = sum(nonzero) / Decimal(str(len(nonzero)))
    forecast_total = avg * Decimal(horizon_days)

    # Confidence: lower stddev/avg → higher confidence
    if avg == 0:
        return forecast_total, D0
    avg_f = float(avg)
    var = sum((float(x) - avg_f) ** 2 for x in nonzero) / max(1, len(nonzero))
    std = var ** 0.5
    # BUG-FIN-068: with avg_f below ~0.01 the previous 0.001 floor inflated
    # confidence on near-zero series. Treat sub-paise averages as "no signal"
    # and return zero confidence rather than dividing through the clamp.
    if avg_f < 0.01:
        return forecast_total, D0
    cv = std / avg_f
    confidence = max(0.0, min(100.0, (1 - cv) * 100)) * _sample_size_dampener(len(nonzero))
    return forecast_total, Decimal(str(round(confidence, 2)))


def forecast_weighted_average(history: Sequence[Decimal], horizon_days: int, window: int = 21) -> tuple[Decimal, Decimal]:
    """Linear weights: most recent gets the heaviest weight."""
    if not history:
        return D0, D0
    win = history[-window:] if len(history) >= window else history
    n = len(win)
    weights = list(range(1, n + 1))
    weight_sum = Decimal(str(sum(weights)))
    # BUG-FIN-067: keep weighted average paise-precise — previous code went
    # through float division which rounds at ~7 decimal digits and lost paise
    # for high-volume items.
    weighted_num = sum((Decimal(weights[i]) * Decimal(str(win[i])) for i in range(n)), Decimal("0"))
    avg = weighted_num / weight_sum if weight_sum else D0
    forecast_total = avg * Decimal(horizon_days)
    # confidence using same idea
    if avg == 0:
        return forecast_total, D0
    avg_f = float(avg)
    var = sum((float(x) - avg_f) ** 2 for x in win) / max(1, n)
    std = var ** 0.5
    cv = std / max(0.001, avg_f)
    # BUG-FIN-066: dampen confidence by sample size so 1 datapoint can't yield
    # 100% confidence.
    nonzero = sum(1 for x in win if x > 0)
    confidence = max(0.0, min(100.0, (1 - cv) * 100)) * _sample_size_dampener(nonzero)
    return forecast_total, Decimal(str(round(confidence, 2)))


def forecast_seasonal(history: Sequence[Decimal], horizon_days: int, window: int = 14) -> tuple[Decimal, Decimal]:
    """Naive 7-day seasonal average × horizon. Falls back to moving avg if too short."""
    if len(history) < 28:
        # BUG-FIN-065: forward `window` to the moving-average fallback so the
        # caller's tuning is preserved when we don't have enough history for
        # a real seasonal split.
        return forecast_moving_average(history, horizon_days, window=window)
    from datetime import date as _date, timedelta as _td
    today = _date.today()
    n = len(history)
    weekly_buckets: list[list[Decimal]] = [[] for _ in range(7)]
    # BUG-FIN-063: align by *real weekday* (Mon=0..Sun=6) rather than index%7.
    # consumption_per_day returns oldest-first ending today; the bucket for
    # entry at index i corresponds to (today - (n-1-i) days).
    for i, v in enumerate(history):
        d = today - _td(days=(n - 1 - i))
        weekly_buckets[d.weekday()].append(v)
    # Take recent four weeks per bucket
    week_avgs = []
    for bucket in weekly_buckets:
        recent = bucket[-4:] if len(bucket) >= 4 else bucket
        if recent:
            week_avgs.append(sum(recent) / Decimal(str(len(recent))))
        else:
            week_avgs.append(D0)
    weeks = horizon_days // 7
    extra_days = horizon_days % 7
    # BUG-FIN-064: forecast the *next* `extra_days` weekdays starting from
    # tomorrow, not the first N indices of the bucket array.
    forecast = sum(week_avgs) * Decimal(weeks)
    for offset in range(1, extra_days + 1):
        wd = (today + _td(days=offset)).weekday()
        forecast += week_avgs[wd]
    # Confidence: similarity across weeks
    avg_overall = sum(week_avgs) / Decimal(7) if week_avgs else D0
    avg_f = float(avg_overall) if avg_overall > 0 else 1
    var = sum((float(w) - avg_f) ** 2 for w in week_avgs) / 7
    std = var ** 0.5
    cv = std / max(0.001, avg_f)
    nonzero_weeks = sum(1 for w in week_avgs if w > 0)
    confidence = max(0.0, min(100.0, (1 - cv) * 100)) * _sample_size_dampener(nonzero_weeks, min_samples=7)
    return forecast, Decimal(str(round(confidence, 2)))


FORECAST_METHODS = {
    "moving_average": forecast_moving_average,
    "weighted_average": forecast_weighted_average,
    "seasonal": forecast_seasonal,
}


# ─────────────────────────────────────────────────────────────────────
# Vendor suggestion
# ─────────────────────────────────────────────────────────────────────

async def suggest_vendor_for_item(
    db: AsyncSession, *, item_id: int,
) -> tuple[Optional[int], Decimal, int]:
    """Returns (vendor_id, rate, lead_time_days).

    Priority:
      1. Active rate contract for this item → cheapest effective_rate
      2. VendorItem with is_preferred=True
      3. Any VendorItem with the lowest rate
    """
    # 1. Rate contract
    rc_row = await db.execute(
        select(RateContract, RateContractItem)
        .join(RateContractItem, RateContractItem.contract_id == RateContract.id)
        .where(
            RateContractItem.item_id == item_id,
            RateContract.status == "active",
            RateContract.start_date <= date.today(),
            RateContract.end_date >= date.today(),
        )
        .order_by(RateContractItem.effective_rate.asc())
        .limit(1)
    )
    rc = rc_row.first()
    if rc:
        contract, ci = rc
        # Lead time from vendor master
        lt_row = await db.execute(
            select(Vendor.payment_terms_days).where(Vendor.id == contract.vendor_id)
        )
        return contract.vendor_id, ci.effective_rate or D0, 0

    # 2. Preferred VendorItem
    pref_row = await db.execute(
        select(VendorItem, Vendor)
        .join(Vendor, Vendor.id == VendorItem.vendor_id)
        .where(VendorItem.item_id == item_id, VendorItem.is_preferred == True, Vendor.is_active == True)  # noqa: E712
        .order_by(VendorItem.rate.asc())
        .limit(1)
    )
    pref = pref_row.first()
    if pref:
        vi, vendor = pref
        return vi.vendor_id, vi.rate or D0, vi.lead_time_days or 0

    # 3. Cheapest VendorItem
    any_row = await db.execute(
        select(VendorItem, Vendor)
        .join(Vendor, Vendor.id == VendorItem.vendor_id)
        .where(VendorItem.item_id == item_id, Vendor.is_active == True)  # noqa: E712
        .order_by(VendorItem.rate.asc())
        .limit(1)
    )
    any_v = any_row.first()
    if any_v:
        vi, vendor = any_v
        return vi.vendor_id, vi.rate or D0, vi.lead_time_days or 0

    return None, D0, 0


# ─────────────────────────────────────────────────────────────────────
# Per-item MRP row computation
# ─────────────────────────────────────────────────────────────────────

async def compute_mrp_row_for_item(
    db: AsyncSession,
    *,
    item: Item,
    method: str,
    horizon_days: int,
    history_days: int,
    warehouse_id: Optional[int] = None,
) -> dict:
    """Compute net requirement for one item. Returns dict matching MRPRunItem fields."""
    # 1. Current stock
    cs_q = select(func.coalesce(func.sum(StockBalance.available_qty), 0)).where(
        StockBalance.item_id == item.id
    )
    if warehouse_id:
        cs_q = cs_q.where(StockBalance.warehouse_id == warehouse_id)
    current_stock = Decimal(str((await db.execute(cs_q)).scalar() or 0))

    # 2. Reserved
    # BUG-FIN-069: when warehouse_id is supplied we must scope reserved_qty
    # to that warehouse — previously the filter was applied AFTER the sum so
    # cross-warehouse reservations leaked in.
    rs_q = select(func.coalesce(func.sum(StockBalance.reserved_qty), 0)).where(
        StockBalance.item_id == item.id
    )
    if warehouse_id:
        rs_q = rs_q.where(StockBalance.warehouse_id == warehouse_id)
    reserved = Decimal(str((await db.execute(rs_q)).scalar() or 0))

    # 3. On-order
    on_order = await on_order_qty(db, item_id=item.id, warehouse_id=warehouse_id)

    # 4. Forecast
    history = await consumption_per_day(db, item_id=item.id, days=history_days, warehouse_id=warehouse_id)
    fn = FORECAST_METHODS.get(method, forecast_moving_average)
    forecast_qty, confidence = fn(history, horizon_days)

    # 5. Net required = forecast + safety_stock + pending_demand
    #    - (current - reserved) - on_order
    # BUG-FIN-070: subtract pending indent demand so we don't ignore firm
    # internal requisitions when sizing replenishment.
    safety = Decimal(str(item.safety_stock or 0))
    reorder_lvl = Decimal(str(item.reorder_level or 0))
    pending_demand = await pending_indent_demand(
        db, item_id=item.id, warehouse_id=warehouse_id,
    )
    available = current_stock - reserved
    net = forecast_qty + safety + pending_demand - available - on_order
    if net < 0:
        net = D0

    # 6. Suggested qty: max(net, reorder_qty) so we don't order below the EOQ.
    # BUG-FIN-072: also trigger a reorder when current stock has fallen below
    # the configured reorder_level — even if there's no consumption history
    # (e.g. brand-new SKUs that haven't moved yet but were stocked initially).
    reorder_qty = Decimal(str(item.reorder_qty or 0))
    suggested = net if net >= reorder_qty else reorder_qty if net > 0 else D0
    if suggested == 0 and reorder_lvl > 0 and available < reorder_lvl and reorder_qty > 0:
        suggested = reorder_qty
    # BUG-FIN-071: small-quantity items ( e.g. surgical sutures ordered in
    # tens) lose any positive net to integer-style rounding downstream.
    # If net is positive but tiny, bump it to at least 1 so the row still
    # surfaces in the MRP review grid.
    if suggested == 0 and net > 0:
        suggested = Decimal("1")

    # 7. Vendor suggestion
    vendor_id, rate, lead_time = await suggest_vendor_for_item(db, item_id=item.id)

    return {
        "item_id": item.id,
        "current_stock": current_stock,
        "on_order_qty": on_order,
        "reserved_qty": reserved,
        "forecast_qty": forecast_qty,
        "safety_stock": safety,
        "reorder_level": reorder_lvl,
        "net_required": net,
        "suggested_qty": suggested,
        "suggested_vendor_id": vendor_id,
        "suggested_rate": rate,
        "lead_time_days": lead_time or (item.lead_time_days or 0),
        "confidence_pct": confidence,
        "selected": suggested > 0,
    }


# ─────────────────────────────────────────────────────────────────────
# Run-level orchestration
# ─────────────────────────────────────────────────────────────────────

async def compute_mrp_run(
    db: AsyncSession,
    *,
    method: str = "moving_average",
    horizon_days: int = 30,
    history_days: int = 90,
    warehouse_id: Optional[int] = None,
    item_category_id: Optional[int] = None,
    item_ids: Optional[Sequence[int]] = None,
    notes: Optional[str] = None,
    created_by: Optional[int] = None,
) -> MRPRun:
    """Run MRP for a set of items. Persists MRPRun + MRPRunItem rows."""
    # Resolve target items
    iq = select(Item).where(Item.is_active == True)  # noqa: E712
    if item_category_id:
        iq = iq.where(Item.category_id == item_category_id)
    if item_ids:
        iq = iq.where(Item.id.in_(item_ids))
    items = (await db.execute(iq)).scalars().all()

    run_number = await generate_number(db, "mrp", "run")
    run = MRPRun(
        run_number=run_number,
        run_date=datetime.now(timezone.utc),
        horizon_days=horizon_days,
        history_days=history_days,
        method=method,
        warehouse_id=warehouse_id,
        item_category_id=item_category_id,
        status="computed",
        notes=notes,
        created_by=created_by,
    )
    db.add(run)
    await db.flush()

    needing = 0
    total_value = D0
    for item in items:
        row = await compute_mrp_row_for_item(
            db, item=item, method=method, horizon_days=horizon_days,
            history_days=history_days, warehouse_id=warehouse_id,
        )
        if row["suggested_qty"] > 0:
            needing += 1
            total_value += row["suggested_qty"] * row["suggested_rate"]
        db.add(MRPRunItem(run_id=run.id, **row))

    run.total_items = len(items)
    run.items_needing_reorder = needing
    run.total_suggested_value = total_value
    await db.flush()
    return run


# ─────────────────────────────────────────────────────────────────────
# Auto-PO conversion
# ─────────────────────────────────────────────────────────────────────

async def convert_run_to_pos(
    db: AsyncSession,
    *,
    run_id: int,
    only_selected: bool = True,
    created_by: int,
) -> dict:
    """Group selected MRP items by vendor → create one draft PO per vendor."""
    items_q = select(MRPRunItem).where(MRPRunItem.run_id == run_id)
    if only_selected:
        items_q = items_q.where(MRPRunItem.selected == True)  # noqa: E712
    rows = (await db.execute(items_q)).scalars().all()

    # Group by suggested_vendor_id (skip rows without vendor)
    by_vendor: dict[int, list[MRPRunItem]] = {}
    skipped_no_vendor = 0
    skipped_already_generated = 0
    for r in rows:
        if r.generated_po_id:
            skipped_already_generated += 1
            continue
        if not r.suggested_vendor_id or r.suggested_qty <= 0:
            skipped_no_vendor += 1
            continue
        by_vendor.setdefault(r.suggested_vendor_id, []).append(r)

    # Look up the run for warehouse_id
    run_row = await db.execute(select(MRPRun).where(MRPRun.id == run_id))
    run = run_row.scalar_one_or_none()
    if not run:
        return {"created": 0, "vendors": [], "skipped_no_vendor": skipped_no_vendor}

    # BUG-FIN-169: pre-fetch all items in one SELECT instead of 2 queries per item.
    all_item_ids = {r.item_id for rs in by_vendor.values() for r in rs}
    items_meta: dict[int, Item] = {}
    if all_item_ids:
        rows = (await db.execute(
            select(Item).where(Item.id.in_(all_item_ids))
        )).scalars().all()
        items_meta = {it.id: it for it in rows}

    # BUG-FIN-076: derive expected delivery from each row's lead_time so
    # downstream "overdue PO" alerting works on auto-generated POs too.
    pos_created = []
    for vendor_id, mri_rows in by_vendor.items():
        po_number = await generate_number(db, "procurement", "purchase_order")
        max_lead = max((mri.lead_time_days or 0) for mri in mri_rows) if mri_rows else 0
        po_date = datetime.now(timezone.utc)
        expected = po_date + timedelta(days=int(max_lead)) if max_lead else None
        po_kwargs = dict(
            po_number=po_number,
            vendor_id=vendor_id,
            warehouse_id=run.warehouse_id,
            po_date=po_date,
            status="draft",
            remarks=f"Auto-generated from MRP run {run.run_number}",
            created_by=created_by,
        )
        if expected and hasattr(PurchaseOrder, "expected_delivery_date"):
            po_kwargs["expected_delivery_date"] = expected
        po = PurchaseOrder(**po_kwargs)
        db.add(po)
        await db.flush()

        subtotal = D0
        total_tax = D0
        for mri in mri_rows:
            it = items_meta.get(mri.item_id)
            amount = mri.suggested_qty * mri.suggested_rate
            # BUG-FIN-077: copy GST percentages from item master so the
            # resulting draft PO has the right tax fields populated.
            cgst_rate = Decimal(str(getattr(it, "cgst_rate", 0) or 0)) if it else D0
            sgst_rate = Decimal(str(getattr(it, "sgst_rate", 0) or 0)) if it else D0
            igst_rate = Decimal(str(getattr(it, "igst_rate", 0) or 0)) if it else D0
            tax_amt = (amount * (cgst_rate + sgst_rate + igst_rate) / Decimal("100"))
            poi_kwargs = dict(
                po_id=po.id, item_id=mri.item_id,
                qty=mri.suggested_qty,
                received_qty=0,
                uom_id=getattr(it, "primary_uom_id", None) if it else None,
                rate=mri.suggested_rate,
                amount=amount,
            )
            for fname, fval in (
                ("cgst_rate", cgst_rate), ("sgst_rate", sgst_rate),
                ("igst_rate", igst_rate), ("tax_amount", tax_amt),
            ):
                if hasattr(PurchaseOrderItem, fname):
                    poi_kwargs[fname] = fval
            poi = PurchaseOrderItem(**poi_kwargs)
            db.add(poi)
            subtotal += amount
            total_tax += tax_amt
            mri.generated_po_id = po.id

        po.subtotal = subtotal
        if hasattr(PurchaseOrder, "tax_amount"):
            po.tax_amount = total_tax
        po.grand_total = subtotal + total_tax
        await db.flush()
        pos_created.append({"po_id": po.id, "po_number": po_number, "vendor_id": vendor_id, "lines": len(mri_rows), "total": float(subtotal + total_tax)})

    if pos_created:
        run.status = "po_generated"
        await db.flush()

    return {
        "created": len(pos_created),
        "vendors": pos_created,
        "skipped_no_vendor": skipped_no_vendor,
        "skipped_already_generated": skipped_already_generated,
    }
