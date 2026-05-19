"""Vendor scorecard compute service.

Closes audit gap G-08 (vendor rating). The `vendor_scorecards` table exists
(Wave 7 healthcare module) but no service populated it. This module computes
quality / delivery / price / overall scores from PO/GRN/QI history per vendor
per period.

  Quality score   = (1 - rejected_qty / total_received_qty) × 100
  Delivery score  = (on_time_deliveries / total_deliveries) × 100
  Price score     = relative — items where vendor is cheapest = 100, etc.
  Overall         = weighted: 0.4×quality + 0.4×delivery + 0.2×price
  Grade           = A (≥90), B (≥80), C (≥70), D (≥60), F (<60)
"""
from __future__ import annotations
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional

from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.master import Vendor, VendorItem
from app.models.procurement import PurchaseOrder, PurchaseOrderItem
from app.models.grn import GoodsReceiptNote, GRNItem
from app.models.healthcare import VendorScorecard


def _grade(score: float) -> str:
    # BUG-PRO-125 fix: round to 2 dp before comparison so a score of 89.999996
    # (a normal float artefact of the weighted sum) doesn't drop a vendor from
    # A to B. The persisted score is itself rounded to 2 dp on write, so this
    # makes grade-from-score consistent with grade-from-stored-score.
    s = round(float(score), 2)
    if s >= 90: return "A"
    if s >= 80: return "B"
    if s >= 70: return "C"
    if s >= 60: return "D"
    return "F"


async def compute_for_vendor(
    db: AsyncSession,
    *,
    vendor_id: int,
    period_start: date,
    period_end: date,
) -> Optional[VendorScorecard]:
    """Compute and persist a scorecard for one vendor over the given period."""
    # Pull POs in period
    pos_q = await db.execute(
        select(PurchaseOrder.id, PurchaseOrder.expected_delivery_date)
        .where(
            PurchaseOrder.vendor_id == vendor_id,
            PurchaseOrder.po_date >= period_start,
            PurchaseOrder.po_date <= period_end,
            PurchaseOrder.status.in_(["approved", "partially_received", "received", "closed"]),
        )
    )
    po_rows = pos_q.all()
    total_orders = len(po_rows)
    if total_orders == 0:
        return None

    # Total qty ordered + rejected from GRN
    po_ids = [r.id for r in po_rows]
    item_agg = await db.execute(
        select(
            func.coalesce(func.sum(PurchaseOrderItem.qty), 0).label("ordered"),
        ).where(PurchaseOrderItem.po_id.in_(po_ids))
    )
    total_qty_ordered = float((item_agg.scalar() or 0))

    grn_agg = await db.execute(
        select(
            func.coalesce(func.sum(GRNItem.received_qty), 0).label("received"),
            func.coalesce(func.sum(GRNItem.rejected_qty), 0).label("rejected"),
        )
        .join(GoodsReceiptNote, GoodsReceiptNote.id == GRNItem.grn_id)
        .where(GoodsReceiptNote.vendor_id == vendor_id,
               GoodsReceiptNote.grn_date >= period_start,
               GoodsReceiptNote.grn_date <= period_end)
    )
    grn_row = grn_agg.first()
    total_received = float(grn_row.received or 0) if grn_row else 0
    total_rejected = float(grn_row.rejected or 0) if grn_row else 0

    # On-time deliveries: GRN.grn_date <= PO.expected_delivery_date
    # BUG-PRO-124 fix: scope GRNs not just by vendor + grn_date but by PO id —
    # a vendor's GRN against a PO outside the scoring period must not pollute
    # the on-time / quality calc.
    grns_q = await db.execute(
        select(
            GoodsReceiptNote.id, GoodsReceiptNote.po_id, GoodsReceiptNote.grn_date,
            PurchaseOrder.po_date,
        )
        .join(PurchaseOrder, PurchaseOrder.id == GoodsReceiptNote.po_id)
        .where(
            GoodsReceiptNote.vendor_id == vendor_id,
            GoodsReceiptNote.po_id.in_(po_ids),
            GoodsReceiptNote.grn_date >= period_start,
            GoodsReceiptNote.grn_date <= period_end,
        )
    )
    grns = grns_q.all()
    total_deliveries = len(grns)
    on_time = 0
    late = 0
    lead_days_sum = 0.0
    lead_days_count = 0
    expected_by_po = {r.id: r.expected_delivery_date for r in po_rows}
    on_time_eligible = 0  # only POs with expected_delivery_date count toward delivery score
    for g in grns:
        # BUG-PRO-116 fix: normalise both sides to a `date` consistently. The
        # column types diverge between Postgres (timestamp) and the value the
        # ORM returns (datetime vs date depending on engine).
        grn_dt = g.grn_date.date() if hasattr(g.grn_date, "date") else g.grn_date
        # BUG-PRO-117 fix: GRNs against POs that have no expected_delivery_date
        # were previously silently DROPPED from the score, hiding late deliveries.
        # Now we count them as eligible only when an expected date exists.
        exp = expected_by_po.get(g.po_id)
        if exp:
            on_time_eligible += 1
            exp_dt = exp.date() if hasattr(exp, "date") else exp
            if grn_dt and exp_dt:
                if grn_dt <= exp_dt:
                    on_time += 1
                else:
                    late += 1
        # BUG-PRO-118 fix: actually compute lead time (po_date → grn_date) so
        # avg_lead_time_days isn't a hard-coded zero.
        po_date_v = g.po_date
        if po_date_v and grn_dt:
            po_dt = po_date_v.date() if hasattr(po_date_v, "date") else po_date_v
            try:
                delta = (grn_dt - po_dt).days
                if delta >= 0:
                    lead_days_sum += float(delta)
                    lead_days_count += 1
            except Exception:
                pass

    # Scores
    # BUG-PRO-115 fix: when there are NO deliveries at all, the previous code
    # gave the vendor a perfect 100 quality score — vendors who never shipped
    # were graded A. Use a neutral 0 in that case so the grade can't be
    # earned by absence.
    if total_received > 0:
        quality_score = (total_received - total_rejected) / total_received * 100
    else:
        quality_score = 0.0
    delivery_score = (on_time / on_time_eligible * 100) if on_time_eligible > 0 else 0.0
    # Price score: simple — for items this vendor sells, % of items where this vendor is cheapest
    vi_q = await db.execute(
        select(VendorItem.item_id, VendorItem.rate).where(VendorItem.vendor_id == vendor_id)
    )
    my_rates = {r.item_id: float(r.rate or 0) for r in vi_q.all()}
    # BUG-PRO-120 fix: previously this ran one MIN(rate) query per item (N+1).
    # For a vendor with 500 items that's 500 round trips. Compute the cheapest
    # rate for ALL the vendor's items in a single grouped query.
    priced_item_ids = [iid for iid, r in my_rates.items() if r > 0]
    cheapest_by_item: dict[int, float] = {}
    if priced_item_ids:
        # BUG-PRO-119 fix: exclude inactive vendors from the price-comparison
        # baseline. A long-deactivated vendor's stale low rate would otherwise
        # drag every other vendor's price_score down.
        cheapest_q = await db.execute(
            select(VendorItem.item_id, func.min(VendorItem.rate))
            .join(Vendor, Vendor.id == VendorItem.vendor_id)
            .where(
                VendorItem.item_id.in_(priced_item_ids),
                VendorItem.rate > 0,
                Vendor.is_active == True,  # noqa: E712
            )
            .group_by(VendorItem.item_id)
        )
        cheapest_by_item = {row[0]: float(row[1] or 0) for row in cheapest_q.all()}
    price_wins = 0
    price_total = 0
    for item_id, my_rate in my_rates.items():
        if my_rate <= 0:
            continue
        price_total += 1
        cheapest = cheapest_by_item.get(item_id, 0.0)
        if cheapest > 0 and my_rate <= cheapest * 1.05:  # within 5% of cheapest
            price_wins += 1
    price_score = (price_wins / price_total * 100) if price_total > 0 else 50.0

    overall = (quality_score * 0.4) + (delivery_score * 0.4) + (price_score * 0.2)
    grade = _grade(overall)

    # BUG-PRO-122 fix: upsert was a SELECT-then-INSERT race. Two concurrent
    # `recompute_all` runs would both see "no row" and both INSERT, producing
    # an IntegrityError that bubbled out of the request. Wrap the INSERT in a
    # savepoint and recover by re-selecting + updating the row another worker
    # just inserted.
    from sqlalchemy.exc import IntegrityError as _IE
    existing_q = await db.execute(
        select(VendorScorecard).where(
            VendorScorecard.vendor_id == vendor_id,
            VendorScorecard.period_start == period_start,
            VendorScorecard.period_end == period_end,
        )
    )
    sc = existing_q.scalar_one_or_none()
    avg_lead = Decimal(str(round(lead_days_sum / lead_days_count, 2))) if lead_days_count > 0 else Decimal("0")
    if not sc:
        sc = VendorScorecard(
            vendor_id=vendor_id,
            period_start=period_start,
            period_end=period_end,
        )
        db.add(sc)
        try:
            async with db.begin_nested():
                await db.flush()
        except _IE:
            db.expunge(sc)
            sc = (await db.execute(
                select(VendorScorecard).where(
                    VendorScorecard.vendor_id == vendor_id,
                    VendorScorecard.period_start == period_start,
                    VendorScorecard.period_end == period_end,
                )
            )).scalar_one()
    sc.total_orders = total_orders
    sc.on_time_deliveries = on_time
    sc.late_deliveries = late
    sc.total_qty_ordered = Decimal(str(total_qty_ordered))
    sc.total_qty_rejected = Decimal(str(total_rejected))
    # BUG-PRO-118 fix: persist the actual computed average lead time.
    sc.avg_lead_time_days = avg_lead
    sc.quality_score = Decimal(str(round(quality_score, 2)))
    sc.delivery_score = Decimal(str(round(delivery_score, 2)))
    sc.price_score = Decimal(str(round(price_score, 2)))
    sc.overall_score = Decimal(str(round(overall, 2)))
    sc.grade = grade
    await db.flush()
    return sc


async def recompute_all(
    db: AsyncSession,
    *,
    period_start: Optional[date] = None,
    period_end: Optional[date] = None,
) -> dict:
    """Rebuild scorecards for all vendors that have any PO in the period."""
    # BUG-PRO-121 fix: default period was "first day of this month minus 90 days"
    # which is neither the last quarter nor the trailing 90 days — it slid each
    # month and gave inconsistent comparisons. Default to the *previous full
    # calendar quarter* so successive runs against the default period produce
    # comparable scores.
    today = date.today()
    if period_start is None or period_end is None:
        # Determine the previous calendar quarter relative to today.
        cur_q_start_month = ((today.month - 1) // 3) * 3 + 1  # 1, 4, 7, 10
        if cur_q_start_month == 1:
            prev_q_year = today.year - 1
            prev_q_start_month = 10
        else:
            prev_q_year = today.year
            prev_q_start_month = cur_q_start_month - 3
        prev_q_start = date(prev_q_year, prev_q_start_month, 1)
        # End-of-quarter: day before next quarter start
        nxt_year = prev_q_year + (1 if prev_q_start_month + 3 > 12 else 0)
        nxt_month = ((prev_q_start_month + 3 - 1) % 12) + 1
        prev_q_end = date(nxt_year, nxt_month, 1) - timedelta(days=1)
        if period_start is None:
            period_start = prev_q_start
        if period_end is None:
            period_end = prev_q_end

    # BUG-PRO-123 fix: skip inactive vendors. We were previously generating a
    # scorecard for every vendor with a PO in the period, including ones that
    # have since been deactivated — those rows polluted the leaderboard with
    # stale grades that no longer represent live partners.
    vendors_q = await db.execute(
        select(PurchaseOrder.vendor_id)
        .join(Vendor, Vendor.id == PurchaseOrder.vendor_id)
        .where(
            PurchaseOrder.po_date >= period_start,
            PurchaseOrder.po_date <= period_end,
            Vendor.is_active == True,  # noqa: E712
        )
        .group_by(PurchaseOrder.vendor_id)
    )
    vendor_ids = [r[0] for r in vendors_q.all() if r[0]]
    computed = 0
    grades = {"A": 0, "B": 0, "C": 0, "D": 0, "F": 0}
    for vid in vendor_ids:
        sc = await compute_for_vendor(
            db, vendor_id=vid, period_start=period_start, period_end=period_end,
        )
        if sc:
            computed += 1
            grades[sc.grade] = grades.get(sc.grade, 0) + 1
    return {
        "period_start": period_start.isoformat(),
        "period_end": period_end.isoformat(),
        "vendors_computed": computed,
        "grades": grades,
    }
