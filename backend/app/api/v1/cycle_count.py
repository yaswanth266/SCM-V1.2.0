"""Cycle count API — closes audit gap G-03 (cycle count / physical stock).

The `stock_audits` and `stock_audit_items` tables exist (audit module) and
already have `audit_type=cycle_count`. This module gives cycle count its own
dedicated endpoints + variance computation + auto-adjustment posting.
"""
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.user import User
from app.models.master import Item
from app.models.stock import StockBalance
from app.models.audit import StockAudit, StockAuditItem
from app.services.number_series import generate_number
from app.services.stock_service import post_stock_ledger
from app.utils.dependencies import get_current_user, require_any_role
from app.utils.helpers import paginate_params, build_paginated_response


router = APIRouter()


@router.get("")
async def list_cycle_counts(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    warehouse_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    q = select(StockAudit).where(StockAudit.audit_type == "cycle_count")
    cq = select(func.count(StockAudit.id)).where(StockAudit.audit_type == "cycle_count")
    if warehouse_id:
        q = q.where(StockAudit.warehouse_id == warehouse_id)
        cq = cq.where(StockAudit.warehouse_id == warehouse_id)
    if status:
        q = q.where(StockAudit.status == status)
        cq = cq.where(StockAudit.status == status)
    total = (await db.execute(cq)).scalar() or 0
    rows = (await db.execute(q.offset(offset).limit(limit).order_by(StockAudit.id.desc()))).scalars().all()
    out = []
    for a in rows:
        out.append({
            "id": a.id,
            "audit_number": a.audit_number,
            "warehouse_id": a.warehouse_id,
            "audit_date": a.audit_date.isoformat() if a.audit_date else None,
            "status": a.status,
            "total_items": a.total_items,
            "variance_items": a.variance_items,
        })
    return build_paginated_response(out, total, page, page_size)


@router.post("", status_code=201)
async def start_cycle_count(
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "warehouse_operator", "store_keeper",
    )),
):
    """Start a new cycle count.
    Body: {warehouse_id, item_ids?[] (optional — if blank, all stocked items in warehouse)}
    """
    if not payload.get("warehouse_id"):
        raise HTTPException(status_code=400, detail="warehouse_id is required")

    # BUG-INV-072: validate UOM presence on every counted item BEFORE creating
    # the StockAudit row. Previously the StockAudit was created and flushed,
    # then UOM validation could raise — leaving an empty in_progress cycle
    # count behind that confused operators.
    # Snapshot current stock per item/batch in the warehouse.
    item_ids = payload.get("item_ids")
    bal_q = select(StockBalance).where(StockBalance.warehouse_id == payload["warehouse_id"])
    if item_ids:
        bal_q = bal_q.where(StockBalance.item_id.in_(item_ids))
    balances = (await db.execute(bal_q)).scalars().all()

    # BUG-INV-076: include rows where available_qty=0 but total_qty>0 (stock
    # is reserved/committed but still owned and physically present — must be
    # counted). Only drop rows with no system stock to count.
    balances = [
        b for b in balances
        if (b.total_qty or Decimal("0")) > 0
    ]

    # Get UOM per item and reject BEFORE creating any audit row.
    item_meta: dict[int, Optional[int]] = {}
    if balances:
        item_ids_list = list({b.item_id for b in balances})
        rows = await db.execute(select(Item.id, Item.primary_uom_id).where(Item.id.in_(item_ids_list)))
        item_meta = {r.id: r.primary_uom_id for r in rows.all()}
        missing = [iid for iid in item_ids_list if not item_meta.get(iid)]
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot start cycle count: items missing primary_uom_id: {missing}",
            )

    audit_number = await generate_number(db, "audit", "stock_audit")
    cc = StockAudit(
        audit_number=audit_number,
        warehouse_id=payload["warehouse_id"],
        audit_date=datetime.now(timezone.utc),
        audit_type="cycle_count",
        status="in_progress",
        conducted_by=current_user.id,
    )
    db.add(cc)
    await db.flush()

    for b in balances:
        # BUG-INV-071: snapshot uses TOTAL qty (not available_qty) so the
        # variance calc compares physical-on-hand against the system's full
        # owned quantity, not the unreserved fraction. Counting against
        # available_qty causes false variance whenever any qty is reserved
        # for an open issue/transfer.
        db.add(StockAuditItem(
            audit_id=cc.id,
            item_id=b.item_id,
            bin_id=b.bin_id,
            batch_id=b.batch_id,
            system_qty=b.total_qty or Decimal("0"),
            physical_qty=Decimal("0"),  # to be filled during count
            variance_qty=Decimal("0"),
            uom_id=item_meta[b.item_id],
        ))
    cc.total_items = len(balances)
    await db.flush()
    return {"id": cc.id, "audit_number": audit_number, "items_to_count": len(balances)}


@router.put("/{cc_id}/items/{item_row_id}")
async def update_count_qty(
    cc_id: int,
    item_row_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "warehouse_operator", "store_keeper",
    )),
):
    """Update physical_qty for one count line. Auto-computes variance."""
    row = (await db.execute(
        select(StockAuditItem).where(StockAuditItem.id == item_row_id, StockAuditItem.audit_id == cc_id)
    )).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Count line not found")
    raw_qty = payload.get("physical_qty")
    if raw_qty is None:
        raise HTTPException(status_code=400, detail="physical_qty is required")
    try:
        physical = Decimal(str(raw_qty))
    except Exception:
        raise HTTPException(status_code=400, detail="physical_qty must be a number")
    if physical < 0:
        raise HTTPException(status_code=400, detail="physical_qty cannot be negative")
    # BUG-INV-073: upper sanity bound. Without this, a typo of "1000" instead
    # of "10" silently records a 100x over-count and finalize will post a
    # massive false adjustment. We allow up to 1000x system_qty (or an absolute
    # 10,000,000 units cap when system_qty is zero) and force callers to pass
    # ?force=true if they really intend to record a physical-discovery line.
    sys_qty = row.system_qty or Decimal("0")
    abs_cap = Decimal("10000000")
    rel_cap = sys_qty * Decimal("1000") if sys_qty > 0 else abs_cap
    sanity_cap = max(rel_cap, Decimal("1000"))
    forced = bool(payload.get("force"))
    if not forced and physical > sanity_cap:
        raise HTTPException(
            status_code=400,
            detail=(
                f"physical_qty {physical} exceeds sanity bound {sanity_cap} "
                f"(system_qty={sys_qty}). Pass force=true to override if this "
                "is a genuine large discovery."
            ),
        )
    if physical > abs_cap:
        raise HTTPException(
            status_code=400,
            detail=f"physical_qty {physical} exceeds absolute cap {abs_cap}",
        )
    row.physical_qty = physical
    row.variance_qty = physical - (row.system_qty or Decimal("0"))
    if row.variance_qty > 0:
        row.adjustment_type = "increase"
    elif row.variance_qty < 0:
        row.adjustment_type = "decrease"
    else:
        row.adjustment_type = "none"
    if "remarks" in payload:
        row.remarks = payload["remarks"]
    await db.flush()
    return {"success": True, "variance_qty": float(row.variance_qty)}


@router.delete("/{cc_id}/items/{item_row_id}")
async def remove_count_line(
    cc_id: int,
    item_row_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager",
    )),
):
    """BUG-INV-077: remove an erroneous cycle-count line.

    Only allowed while the audit is still in_progress and only on lines that
    have NOT been adjusted (`adjusted=False`). Once finalize has posted a
    ledger adjustment for the line, deleting the line would orphan the ledger
    entry — we 400 in that case.
    """
    audit = (await db.execute(
        select(StockAudit).where(StockAudit.id == cc_id)
    )).scalar_one_or_none()
    if not audit:
        raise HTTPException(status_code=404, detail="Cycle count not found")
    if audit.status not in ("draft", "in_progress"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot remove count line: audit is in '{audit.status}' status",
        )
    row = (await db.execute(
        select(StockAuditItem).where(
            StockAuditItem.id == item_row_id,
            StockAuditItem.audit_id == cc_id,
        )
    )).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Count line not found")
    if row.adjusted:
        raise HTTPException(
            status_code=400,
            detail=(
                "Cannot remove a count line that has already posted an "
                "adjustment to the stock ledger."
            ),
        )
    await db.delete(row)
    audit.total_items = max(0, (audit.total_items or 0) - 1)
    await db.flush()
    return {"success": True, "message": "Count line removed"}


def _was_counted(row: StockAuditItem) -> bool:
    """A line is 'touched' if the user explicitly recorded a count, left
    remarks, or produced a non-zero variance. Used to refuse finalize on
    completely-untouched audits (would otherwise post zero adjustments and
    rubber-stamp the warehouse)."""
    if row.physical_qty and row.physical_qty > 0:
        return True
    if row.remarks:
        return True
    if row.adjustment_type in ("increase", "decrease"):
        return True
    return False


@router.post("/{cc_id}/finalize")
async def finalize_cycle_count(
    cc_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager",
    )),
):
    """Post all variance adjustments to the stock ledger and mark audit completed.
    For each line with variance != 0, posts a stock_audit_adjustment entry.

    Refuses to finalize an audit where ZERO lines have been touched
    (would silently rubber-stamp the warehouse).
    Leaves status='in_progress' if any per-line posting fails so the operator
    can retry; only marks 'completed' on a clean run.
    """
    cc = (await db.execute(
        select(StockAudit).options(selectinload(StockAudit.items))
        .where(StockAudit.id == cc_id)
    )).scalar_one_or_none()
    if not cc:
        raise HTTPException(status_code=404, detail="Cycle count not found")
    if cc.status == "completed":
        return {"already_completed": True}

    counted = sum(1 for r in cc.items if _was_counted(r))
    if counted == 0 and cc.items:
        raise HTTPException(
            status_code=400,
            detail=(
                "Cannot finalize: no count lines have been recorded. "
                "Update at least one line's physical_qty before finalizing."
            ),
        )

    posted = 0
    variance_count = 0
    failures: list[dict] = []
    for row in cc.items:
        v = row.variance_qty or Decimal("0")
        if v == 0:
            continue
        variance_count += 1
        try:
            # Match the bin/batch dimension when fetching the rate so a batched
            # item's adjustment uses the rate of THAT batch, not a sibling.
            bal_conds = [
                StockBalance.item_id == row.item_id,
                StockBalance.warehouse_id == cc.warehouse_id,
            ]
            bal_conds.append(
                StockBalance.bin_id == row.bin_id if row.bin_id is not None
                else StockBalance.bin_id.is_(None)
            )
            bal_conds.append(
                StockBalance.batch_id == row.batch_id if row.batch_id is not None
                else StockBalance.batch_id.is_(None)
            )
            # BUG-INV-074: take SELECT FOR UPDATE so a concurrent posting
            # (issue/transfer) cannot mutate valuation_rate between this read
            # and the post_stock_ledger call. post_stock_ledger acquires its
            # own lock, but reading the rate without one risks using a stale
            # value when a concurrent transfer changed valuation_rate in
            # the milliseconds since we read it.
            bal = (await db.execute(
                select(StockBalance).where(and_(*bal_conds)).with_for_update().limit(1)
            )).scalar_one_or_none()
            rate = (bal.valuation_rate if bal else Decimal("0")) or Decimal("0")
            if v > 0:
                await post_stock_ledger(
                    db,
                    item_id=row.item_id,
                    warehouse_id=cc.warehouse_id,
                    transaction_type="audit_adjustment",
                    qty_in=v,
                    rate=rate,
                    bin_id=row.bin_id,
                    batch_id=row.batch_id,
                    reference_type="stock_audit",
                    reference_id=cc.id,
                    uom_id=row.uom_id,
                    created_by=current_user.id,
                    # BUG-INV-069: do NOT bypass the negative-stock guard at
                    # cycle-count finalize. A single typo on physical_qty would
                    # otherwise post a huge negative adjustment with no integrity
                    # check. If a legitimate negative is needed it must go through
                    # the explicit Stock Audit / opening-balance flow.
                    allow_negative=False,
                )
            else:
                await post_stock_ledger(
                    db,
                    item_id=row.item_id,
                    warehouse_id=cc.warehouse_id,
                    transaction_type="audit_adjustment",
                    qty_out=abs(v),
                    rate=rate,
                    bin_id=row.bin_id,
                    batch_id=row.batch_id,
                    reference_type="stock_audit",
                    reference_id=cc.id,
                    uom_id=row.uom_id,
                    created_by=current_user.id,
                    # BUG-INV-069: re-enable negative-stock guard on the
                    # qty-out branch as well.
                    allow_negative=False,
                )
            row.adjusted = True
            posted += 1
        except Exception as exc:
            import logging
            logging.getLogger(__name__).exception(
                "Cycle-count adjust failed for item %s: %s", row.item_id, exc
            )
            failures.append({
                "audit_item_id": row.id,
                "item_id": row.item_id,
                "error": str(exc),
            })

    cc.variance_items = variance_count
    if failures:
        # Keep status as in_progress so the operator can fix and retry.
        await db.flush()
        raise HTTPException(
            status_code=500,
            detail={
                "message": (
                    f"{posted} adjustments posted, {len(failures)} failed. "
                    "Audit left in 'in_progress' state — fix the failures and retry."
                ),
                "posted": posted,
                "failures": failures,
            },
        )

    cc.status = "completed"
    cc.approved_by = current_user.id
    await db.flush()
    return {
        "success": True,
        "variance_items": variance_count,
        "adjustments_posted": posted,
        "message": f"{posted} adjustments posted; {variance_count} lines had variance",
    }


@router.get("/{cc_id}")
async def get_cycle_count(
    cc_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    cc = (await db.execute(
        select(StockAudit).options(selectinload(StockAudit.items))
        .where(StockAudit.id == cc_id)
    )).scalar_one_or_none()
    if not cc:
        raise HTTPException(status_code=404, detail="Cycle count not found")

    item_ids = [r.item_id for r in cc.items]
    items_map = {}
    if item_ids:
        rows = await db.execute(select(Item.id, Item.item_code, Item.name).where(Item.id.in_(item_ids)))
        items_map = {r.id: r for r in rows.all()}
    items_out = []
    for row in cc.items:
        meta = items_map.get(row.item_id)
        items_out.append({
            "id": row.id,
            "item_id": row.item_id,
            "item_code": meta.item_code if meta else None,
            "item_name": meta.name if meta else None,
            "bin_id": row.bin_id,
            "batch_id": row.batch_id,
            "system_qty": float(row.system_qty or 0),
            "physical_qty": float(row.physical_qty or 0),
            "variance_qty": float(row.variance_qty or 0),
            "adjustment_type": row.adjustment_type,
            "adjusted": row.adjusted,
            "remarks": row.remarks,
        })
    return {
        "id": cc.id,
        "audit_number": cc.audit_number,
        "warehouse_id": cc.warehouse_id,
        "audit_date": cc.audit_date.isoformat() if cc.audit_date else None,
        "status": cc.status,
        "total_items": cc.total_items,
        "variance_items": cc.variance_items,
        "items": items_out,
    }
