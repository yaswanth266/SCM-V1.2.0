"""Landed cost API — closes audit gap G-07.

The `landed_costs` + `landed_cost_allocations` tables exist (Wave 7 healthcare).
This module exposes:
  - POST /landed-costs                 — record a freight/insurance/customs cost
  - GET /landed-costs?grn_id=X         — list costs for a GRN (paginated)
  - POST /landed-costs/{id}/allocate   — distribute the cost across GRN items by
                                          value/qty/weight/equal, updating each
                                          item's effective rate AND propagating
                                          to GRNItem.rate / GRNItem.amount.
"""
from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.user import User
from app.models.grn import GoodsReceiptNote, GRNItem
from app.models.healthcare import LandedCost, LandedCostAllocation
from app.utils.dependencies import get_current_user, require_any_role
from app.utils.helpers import paginate_params, build_paginated_response


router = APIRouter()

# Enum values must mirror the DB enums on healthcare.py models.
ALLOWED_COST_TYPES = {"freight", "insurance", "customs", "handling", "other"}
ALLOWED_ALLOC_METHODS = {"by_value", "by_qty", "by_weight", "equal"}
TWOPLACES = Decimal("0.01")


def _q2(d: Decimal) -> Decimal:
    """Round to 2 dp using banker-safe HALF_UP (matches accounting convention)."""
    return d.quantize(TWOPLACES, rounding=ROUND_HALF_UP)


@router.get("")
async def list_landed_costs(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    grn_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    # BUG-PRO-092 fix: gate the list to procurement / accounts / warehouse roles.
    # Landed costs reveal freight + insurance line-items per supplier — not
    # something every authenticated user should see.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "purchase_manager", "purchase_officer",
        "accounts_manager", "warehouse_manager",
    )),
):
    offset, limit = paginate_params(page, page_size)
    q = select(LandedCost).options(selectinload(LandedCost.allocations))
    cq = select(func.count(LandedCost.id))
    if grn_id:
        q = q.where(LandedCost.grn_id == grn_id)
        cq = cq.where(LandedCost.grn_id == grn_id)
    total = (await db.execute(cq)).scalar() or 0
    rows = (await db.execute(
        q.order_by(LandedCost.id.desc()).offset(offset).limit(limit)
    )).scalars().all()
    out = []
    for lc in rows:
        out.append({
            "id": lc.id,
            "grn_id": lc.grn_id,
            "cost_type": lc.cost_type,
            "description": lc.description,
            "amount": float(lc.amount or 0),
            "allocation_method": lc.allocation_method,
            "allocations": [
                {
                    "id": a.id,
                    "grn_item_id": a.grn_item_id,
                    "item_id": a.item_id,
                    "allocated_amount": float(a.allocated_amount or 0),
                    "original_rate": float(a.original_rate or 0),
                    "adjusted_rate": float(a.adjusted_rate or 0),
                }
                for a in (lc.allocations or [])
            ],
            "created_at": lc.created_at.isoformat() if lc.created_at else None,
        })
    return build_paginated_response(out, total, page, page_size)


@router.post("", status_code=201)
async def create_landed_cost(
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "accounts_manager", "warehouse_manager",
    )),
):
    """Body: {grn_id, cost_type, amount, allocation_method, description?}
    cost_type: freight | insurance | customs | handling | other
    allocation_method: by_value | by_qty | by_weight | equal
    """
    grn_id = payload.get("grn_id")
    cost_type = payload.get("cost_type")
    raw_amount = payload.get("amount")
    alloc_method = payload.get("allocation_method", "by_value")

    if not grn_id or not cost_type or raw_amount is None:
        raise HTTPException(status_code=400, detail="grn_id, cost_type, amount are required")
    if cost_type not in ALLOWED_COST_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"cost_type must be one of {sorted(ALLOWED_COST_TYPES)}",
        )
    if alloc_method not in ALLOWED_ALLOC_METHODS:
        raise HTTPException(
            status_code=400,
            detail=f"allocation_method must be one of {sorted(ALLOWED_ALLOC_METHODS)}",
        )
    try:
        amount = Decimal(str(raw_amount))
    except Exception:
        raise HTTPException(status_code=400, detail="amount must be a valid number")
    if amount <= 0:
        raise HTTPException(status_code=400, detail="amount must be greater than zero")

    # Verify GRN exists (friendlier than letting the FK trip).
    grn_row = (await db.execute(
        select(GoodsReceiptNote).where(GoodsReceiptNote.id == grn_id)
    )).scalar_one_or_none()
    if not grn_row:
        raise HTTPException(status_code=404, detail=f"GRN {grn_id} not found")
    # BUG-PRO-101 fix: refuse attaching a landed cost to a draft / cancelled GRN.
    # Landed costs only make sense for GRNs that will actually settle into stock;
    # attaching to a draft means the cost can be live before the receipt itself.
    if grn_row.status in ("draft", "cancelled"):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Cannot attach landed cost to GRN in '{grn_row.status}' status — "
                f"GRN must be at least pending_qi / qi_done / completed."
            ),
        )

    lc = LandedCost(
        grn_id=grn_id,
        cost_type=cost_type,
        description=payload.get("description"),
        amount=amount,
        allocation_method=alloc_method,
        created_by=current_user.id,
    )
    db.add(lc)
    await db.flush()
    return {"id": lc.id, "message": "Landed cost recorded — call /allocate to distribute"}


@router.post("/{lc_id}/allocate")
async def allocate_landed_cost(
    lc_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "accounts_manager", "warehouse_manager",
    )),
):
    """Distribute this landed cost across the GRN's items per the chosen method.

    On re-allocation we ROLL BACK the previous adjustment first (subtract the
    old allocated_amount from GRNItem.amount, restore the original rate), then
    apply the fresh allocation. This keeps `grn_items.rate` and `grn_items.amount`
    in sync with the current allocation set.

    Rounding: each share is rounded to 2 dp; the rounding remainder is dumped
    onto the LAST item so `sum(allocations) == lc.amount` exactly.
    """
    # BUG-PRO-093 fix: take a row lock on the LandedCost so two concurrent
    # /allocate requests against the same lc_id serialise — otherwise both
    # could roll back the prior allocations and double-credit grn_items.
    lc = (await db.execute(
        select(LandedCost).options(selectinload(LandedCost.allocations))
        .where(LandedCost.id == lc_id)
        .with_for_update()
    )).scalar_one_or_none()
    if not lc:
        raise HTTPException(status_code=404, detail="Landed cost not found")

    # BUG-PRO-094 fix: refuse allocation against draft / cancelled GRNs. Landed
    # costs only make sense once goods are physically received and putaway is in
    # progress or done. Allowing allocation on a draft GRN bakes freight into
    # rates that may never settle.
    grn_row = (await db.execute(
        select(GoodsReceiptNote).where(GoodsReceiptNote.id == lc.grn_id)
    )).scalar_one_or_none()
    if grn_row is None:
        raise HTTPException(status_code=404, detail=f"GRN {lc.grn_id} not found")
    if grn_row.status in ("draft", "cancelled"):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Cannot allocate landed cost against GRN in '{grn_row.status}' "
                f"status — GRN must be at least pending_qi / qi_done / completed."
            ),
        )

    # BUG-PRO-100 fix: check eligibility BEFORE rolling back the previous
    # allocation. If a re-allocation request is malformed (zero items / zero
    # eligible qty), the old behaviour rolled back the prior allocation, then
    # 400'd — leaving GRN items un-loaded with their freight when the caller
    # only wanted to retry. Now we abort early so the prior allocation stays
    # intact when the new one is unservicable.
    items = (await db.execute(
        select(GRNItem).where(GRNItem.grn_id == lc.grn_id)
    )).scalars().all()
    if not items:
        raise HTTPException(status_code=400, detail="GRN has no items to allocate against")
    eligible_pre = [it for it in items if (it.received_qty or Decimal("0")) > 0]
    if not eligible_pre:
        raise HTTPException(
            status_code=400,
            detail="GRN has no items with received_qty > 0 — nothing to allocate against",
        )

    # Roll back any prior allocation's effect on grn_items, then delete the rows.
    if lc.allocations:
        prior_by_item = {a.grn_item_id: a for a in lc.allocations}
        prior_items = (await db.execute(
            select(GRNItem).where(GRNItem.id.in_(prior_by_item.keys()))
        )).scalars().all()
        for it in prior_items:
            prior = prior_by_item[it.id]
            it.amount = (it.amount or Decimal("0")) - (prior.allocated_amount or Decimal("0"))
            it.rate = prior.original_rate or it.rate
        await db.execute(
            LandedCostAllocation.__table__.delete().where(LandedCostAllocation.landed_cost_id == lc_id)
        )
        await db.flush()

    # Re-pull GRN items fresh after rollback so subsequent calc sees restored rates.
    items = (await db.execute(
        select(GRNItem).where(GRNItem.grn_id == lc.grn_id)
    )).scalars().all()
    eligible = [it for it in items if (it.received_qty or Decimal("0")) > 0]

    method = lc.allocation_method
    amount = Decimal(str(lc.amount))

    # Compute per-item Decimal weight based on method.
    weights: dict[int, Decimal] = {}
    if method == "by_value":
        # BUG-PRO-096 fix: derive line value strictly from qty × rate at this
        # moment in the transaction. We just rolled back any prior allocation,
        # so `it.rate` is the ORIGINAL rate. Using `it.amount` directly was
        # racy: a stale, post-other-allocation amount could leak in if the
        # rollback path was skipped (e.g. first-time allocation on a row whose
        # amount column was mutated by a different code path).
        for it in eligible:
            qty = Decimal(str(it.received_qty or 0))
            rate = Decimal(str(it.rate or 0))
            weights[it.id] = qty * rate
    elif method == "by_qty":
        for it in eligible:
            weights[it.id] = Decimal(str(it.received_qty or 0))
    elif method == "by_weight":
        # No weight column on GRNItem yet — fall back to qty (caller is warned by
        # the response field `approximated=True`).
        for it in eligible:
            weights[it.id] = Decimal(str(it.received_qty or 0))
    else:  # equal
        for it in eligible:
            weights[it.id] = Decimal("1")

    total_weight = sum(weights.values(), Decimal("0"))
    if total_weight <= 0:
        # Fallback: equal split when all weights zero (e.g., by_value with all rates 0).
        for it in eligible:
            weights[it.id] = Decimal("1")
        total_weight = Decimal(str(len(eligible)))

    # Stable order so the "remainder goes to last item" rule is deterministic.
    eligible_sorted = sorted(eligible, key=lambda x: x.id)
    raw_shares = []
    for it in eligible_sorted:
        share_amt = (amount * weights[it.id]) / total_weight
        raw_shares.append(_q2(share_amt))
    # BUG-PRO-097 fix: previously the entire rounding remainder was dumped onto
    # the LAST item — over many freight allocations a single item systematically
    # absorbed all the paisas. Spread the remainder one paisa at a time across
    # the eligible items (largest-share-first) so no single line is biased.
    diff = amount - sum(raw_shares, Decimal("0"))
    if diff != 0 and raw_shares:
        ONE_PAISA = Decimal("0.01")
        step = ONE_PAISA if diff > 0 else -ONE_PAISA
        # Distribute one paisa per row, in descending raw_share order, looping
        # if needed (rare — only matters when |diff| > len(raw_shares) paisa).
        order = sorted(
            range(len(raw_shares)),
            key=lambda i: raw_shares[i],
            reverse=(diff > 0),
        )
        units = int(abs(diff) / ONE_PAISA)
        for n in range(units):
            idx = order[n % len(order)]
            raw_shares[idx] = _q2(raw_shares[idx] + step)

    allocations_response = []
    for it, alloc_amt in zip(eligible_sorted, raw_shares):
        original_rate = it.rate or Decimal("0")
        qty = it.received_qty or Decimal("0")
        # qty > 0 is guaranteed by `eligible` filter above, but guard anyway.
        per_unit = (alloc_amt / qty) if qty > 0 else Decimal("0")
        adjusted_rate = _q2(original_rate + per_unit) if qty > 0 else original_rate

        # Persist the allocation row + propagate to the GRN item line.
        db.add(LandedCostAllocation(
            landed_cost_id=lc.id,
            grn_item_id=it.id,
            item_id=it.item_id,
            allocated_amount=alloc_amt,
            original_rate=original_rate,
            adjusted_rate=adjusted_rate,
        ))
        it.rate = adjusted_rate
        it.amount = (it.amount or Decimal("0")) + alloc_amt

        # BUG-PRO-102 fix: share_pct must reflect the ACTUAL allocated amount
        # post-rounding-redistribution, not the abstract weight. Otherwise the
        # response told the caller "this item got 33.3%" while the real
        # allocated_amount might be 33.34% or 33.32% depending on remainder
        # spread, which the GL reconciliation can't tie out.
        share_pct = (
            float((alloc_amt / amount) * Decimal("100"))
            if amount > 0 else 0
        )
        allocations_response.append({
            "grn_item_id": it.id,
            "item_id": it.item_id,
            "share_pct": round(share_pct, 2),
            "allocated_amount": float(alloc_amt),
            "original_rate": float(original_rate),
            "adjusted_rate": float(adjusted_rate),
        })

    await db.flush()

    sum_allocated = float(sum(raw_shares, Decimal("0")))
    return {
        "success": True,
        "method": method,
        "total_amount": float(amount),
        "sum_allocated": sum_allocated,  # MUST equal total_amount; if not, alert.
        "approximated": method == "by_weight",
        "allocations": allocations_response,
        "skipped_zero_qty_items": [it.id for it in items if it not in eligible],
    }
