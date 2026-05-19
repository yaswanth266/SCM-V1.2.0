"""Wave 11C — Indent end-to-end lifecycle.

The Indent is the user-facing 'I need stuff' document. It orchestrates the
SCM journey:

  draft → submit → pending_approval → approved
                                        │
                                        ├─ stock available  → MaterialIssue (draft) → issue → acknowledge → fulfilled
                                        │
                                        └─ stock short      → (purchase manager creates MR manually from approved indents)

Auto-MR was removed 2026-04-28: the Purchase Manager now picks approved
indents from the demand pool and creates an MR manually. Auto-issue from
on-hand stock is still automatic.

This module exposes:
  - on_indent_submit(db, indent_id, user) — fires approval workflow if configured
  - check_stock_for_indent(db, indent) → list of {item_id, requested, available, short}
  - on_indent_approved(db, indent_id, user) — auto-creates MaterialIssue for fulfillable lines only
  - auto_create_issue(db, indent, items_with_stock, user) — draft MaterialIssue
  - on_grn_received(db, grn) — when stock comes in for an MR linked to an
    indent (manual or otherwise), try fulfillment
"""
from __future__ import annotations
from decimal import Decimal
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.indent import Indent, IndentItem
from app.models.issue import MaterialIssue, MaterialIssueItem
from app.models.procurement import (
    MaterialRequest, MaterialRequestItem,
    PurchaseOrder, PurchaseOrderItem,
)
from app.models.grn import GoodsReceiptNote, GRNItem
from app.models.stock import StockBalance
from app.models.master import Item
from app.services.number_series import generate_number


D0 = Decimal("0")


# ─────────────────────────────────────────────────────────────────────
# Stock check
# ─────────────────────────────────────────────────────────────────────

async def check_stock_for_indent(db: AsyncSession, indent: Indent) -> list[dict]:
    """For each line, compute available qty in the indent's warehouse.

    BUG-IND-031 — exclude stock from expired or recalled batches. The raw
    `available_qty` column on `stock_balance` doesn't know about batch
    status, so we left-join `batches` and filter out non-active batches.
    Rows with NULL batch_id (non-batched items) are kept.

    BUG-IND-032 — subtract reservations. The `reserved_qty` column is the
    qty already earmarked for other open issues/transfers/MIs; treating
    `available_qty` as truly available means the stock check returns false
    positives that later cause MI creation to fail or over-issue.

    Returns list of:
      { item_id, requested, available, short, can_fulfill }
    """
    from app.models.warehouse import Batch as _Batch
    out = []
    for line in indent.items:
        bal_q = (
            select(
                func.coalesce(
                    func.sum(StockBalance.available_qty - func.coalesce(StockBalance.reserved_qty, 0)),
                    0,
                )
            )
            .select_from(StockBalance)
            .outerjoin(_Batch, _Batch.id == StockBalance.batch_id)
            .where(StockBalance.item_id == line.item_id)
            .where(
                # Either non-batched (batch_id NULL) or the batch is "active".
                # `expired`, `recalled`, `consumed` rows are excluded.
                (StockBalance.batch_id.is_(None)) | (_Batch.status == "active")
            )
        )
        if indent.warehouse_id:
            bal_q = bal_q.where(StockBalance.warehouse_id == indent.warehouse_id)
        raw_available = (await db.execute(bal_q)).scalar() or 0
        # BUG-IND-040 — only round-trip through `str` when we don't already
        # have a Decimal. SQLAlchemy Numeric columns hand back Decimal
        # directly; the previous `Decimal(str(...))` would lose precision
        # for floats from func.coalesce on dialects that return Python
        # floats and was wasteful for the (common) Decimal case. Same for
        # `requested_qty` which is a Numeric(15,3) ORM column.
        if isinstance(raw_available, Decimal):
            available = max(D0, raw_available)
        else:
            available = max(D0, Decimal(str(raw_available)))
        rq = line.requested_qty or 0
        requested = rq if isinstance(rq, Decimal) else Decimal(str(rq))
        short = max(D0, requested - available)
        out.append({
            "indent_item_id": line.id,
            "item_id": line.item_id,
            "uom_id": line.uom_id,
            "requested": requested,
            "available": available,
            "short": short,
            "can_fulfill": short == 0,
        })
    return out


# ─────────────────────────────────────────────────────────────────────
# Auto-create MaterialIssue from approved indent
# ─────────────────────────────────────────────────────────────────────

async def auto_create_issue_for_indent(
    db: AsyncSession, *,
    indent: Indent,
    fulfill_lines: list[dict],   # rows from check_stock_for_indent with can_fulfill=True
    user_id: int,
) -> Optional[MaterialIssue]:
    """Create a draft MaterialIssue for the lines we can fulfill from stock.
    Quantity = min(requested, available)."""
    fulfillable = [l for l in fulfill_lines if l["can_fulfill"] and l["requested"] > 0]
    if not fulfillable:
        # BUG-IND-034 — log loudly when stock check finds nothing to issue,
        # otherwise the lifecycle silently no-ops and operations have no
        # visibility into why an approved indent didn't generate an MI.
        # The caller (on_indent_approved) treats `None` as "all short →
        # raise MR instead", which is correct semantics but invisible
        # without this log.
        import logging
        logging.getLogger(__name__).info(
            "auto_create_issue_for_indent: no fulfillable lines for "
            "indent_id=%s indent_number=%s — lifecycle will fall through "
            "to MaterialRequest auto-create",
            indent.id, indent.indent_number,
        )
        return None

    issue_num = await generate_number(db, "warehouse", "material_issue")
    mi = MaterialIssue(
        issue_number=issue_num,
        indent_id=indent.id,
        warehouse_id=indent.warehouse_id,
        issue_date=datetime.now(timezone.utc),
        department=indent.department,
        status="draft",
        remarks=f"Auto-created from Indent {indent.indent_number}",
        issued_by=user_id,
    )
    db.add(mi)
    await db.flush()

    for line in fulfillable:
        # BUG-IND-033 — pick a weighted-average valuation rate across all
        # active stock for the item in this warehouse, not whichever batch
        # the database happened to return first. The previous LIMIT 1
        # semantics caused issue valuation to swing wildly between calls
        # depending on the row order returned by MySQL.
        from app.models.warehouse import Batch as _Batch
        rate_q = (
            select(
                func.coalesce(
                    func.sum(StockBalance.available_qty * StockBalance.valuation_rate)
                    / func.nullif(func.sum(StockBalance.available_qty), 0),
                    0,
                )
            )
            .select_from(StockBalance)
            .outerjoin(_Batch, _Batch.id == StockBalance.batch_id)
            .where(StockBalance.item_id == line["item_id"])
            .where(StockBalance.warehouse_id == indent.warehouse_id)
            .where(
                (StockBalance.batch_id.is_(None)) | (_Batch.status == "active")
            )
            .where(StockBalance.available_qty > 0)
        )
        rate_raw = (await db.execute(rate_q)).scalar() or 0
        rate = Decimal(str(rate_raw))
        qty = min(line["requested"], line["available"])
        amount = qty * rate
        db.add(MaterialIssueItem(
            issue_id=mi.id,
            item_id=line["item_id"],
            qty=qty,
            uom_id=line["uom_id"],
            rate=rate,
            amount=amount,
        ))
    await db.flush()
    return mi


# ─────────────────────────────────────────────────────────────────────
# Status transitions
# ─────────────────────────────────────────────────────────────────────

async def on_indent_approved(
    db: AsyncSession, *,
    indent_id: int,
    user_id: int,
) -> dict:
    """When indent gets approved, run the fork: stock check → issue + MR.

    Returns summary { lines, fulfillable, short, issue_id?, mr_id? }
    """
    from sqlalchemy.orm import selectinload
    # BUG-IND-011 — take a row lock so two concurrent approve calls (whether
    # via the workflow engine or the bypass /approve endpoint) can't each
    # spawn duplicate MaterialIssue / MaterialRequest rows.
    row = await db.execute(
        select(Indent)
        .options(selectinload(Indent.items))
        .where(Indent.id == indent_id)
        .with_for_update()
    )
    indent = row.scalar_one_or_none()
    if not indent:
        raise HTTPException(status_code=404, detail="Indent not found")

    # BUG-IND-012 — gate on current status. Without this, calling
    # on_indent_approved on a draft / rejected / already-approved /
    # fulfilled indent would happily re-run stock check and re-create
    # MI/MR rows, leading to duplicates.
    if indent.status not in ("pending_approval",):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Indent {indent.indent_number} cannot be approved from "
                f"status '{indent.status}' — must be 'pending_approval'."
            ),
        )

    # Default approved_qty = requested_qty if blank (so issue can pull min(requested, available))
    for line in indent.items:
        if not line.approved_qty or line.approved_qty == 0:
            line.approved_qty = line.requested_qty

    stock_check = await check_stock_for_indent(db, indent)
    fulfillable = [l for l in stock_check if l["can_fulfill"]]
    short = [l for l in stock_check if l["short"] > 0]

    issue_id = None

    if fulfillable:
        mi = await auto_create_issue_for_indent(
            db, indent=indent, fulfill_lines=fulfillable, user_id=user_id,
        )
        if mi:
            issue_id = mi.id
    # Short lines: no auto-MR. Purchase Manager picks approved indents from
    # the demand pool and creates an MR manually.

    indent.status = "approved"
    indent.approved_by = user_id
    indent.approved_date = datetime.now(timezone.utc)
    await db.flush()

    return {
        "indent_id": indent.id,
        "indent_number": indent.indent_number,
        "lines_total": len(stock_check),
        "lines_fulfillable": len(fulfillable),
        "lines_short": len(short),
        "auto_issue_id": issue_id,
    }


# ─────────────────────────────────────────────────────────────────────
# Reverse hook: when GRN happens for an MR raised from an indent,
# attempt auto-issue for the parent indent
# ─────────────────────────────────────────────────────────────────────

async def try_fulfill_indents_after_grn(
    db: AsyncSession, *,
    grn_id: int,
    user_id: int,
) -> list[dict]:
    """When putaway completes for a GRN whose PO traces back to an MR linked
    to an indent, see if we can now create an issue against that indent.
    """
    from sqlalchemy.orm import selectinload
    grn_row = await db.execute(
        select(GoodsReceiptNote).where(GoodsReceiptNote.id == grn_id)
    )
    grn = grn_row.scalar_one_or_none()
    if not grn or not grn.po_id:
        return []

    # PO → MR
    po_row = await db.execute(select(PurchaseOrder).where(PurchaseOrder.id == grn.po_id))
    po = po_row.scalar_one_or_none()
    if not po or not getattr(po, "mr_id", None):
        return []

    mr_row = await db.execute(select(MaterialRequest).where(MaterialRequest.id == po.mr_id))
    mr = mr_row.scalar_one_or_none()
    if not mr:
        return []

    # BUG-IND-036 — also follow the demand-pool junction to find every
    # indent that contributed to this MR. The legacy flow only used
    # `mr.indent_id` (single-source), so consolidated MRs (one MR
    # absorbing multiple indents) only re-tried fulfillment for whichever
    # indent happened to be stamped on the MR header — the rest stayed
    # stuck at "approved" forever.
    indent_ids: set[int] = set()
    if mr.indent_id:
        indent_ids.add(mr.indent_id)
    try:
        from app.models.procurement import MrIndentLink as _MrIndentLink
        link_rows = await db.execute(
            select(_MrIndentLink.indent_id).where(_MrIndentLink.mr_id == mr.id)
        )
        for r in link_rows.all():
            if r[0]:
                indent_ids.add(r[0])
    except Exception:
        pass
    if not indent_ids:
        return []

    out_all: list[dict] = []
    for ind_id in indent_ids:
        partial = await _try_fulfill_one_indent(db, indent_id=ind_id, user_id=user_id)
        if partial:
            out_all.extend(partial)
    return out_all


async def _try_fulfill_one_indent(
    db: AsyncSession, *,
    indent_id: int,
    user_id: int,
) -> list[dict]:
    """Inner worker for try_fulfill_indents_after_grn — splits the original
    body so the loop above can iterate every indent linked to the GRN's MR
    via the demand-pool junction."""
    from sqlalchemy.orm import selectinload
    ind_row = await db.execute(
        select(Indent).options(selectinload(Indent.items)).where(Indent.id == indent_id)
    )
    indent = ind_row.scalar_one_or_none()
    if not indent or indent.status not in ("approved", "partially_fulfilled"):
        return []

    stock_check = await check_stock_for_indent(db, indent)

    # BUG-IND-037 — also subtract qty on any non-cancelled MaterialIssue
    # already created against this indent (including drafts that haven't
    # posted yet). Without this, a second GRN-driven fulfillment pass
    # would re-issue the same lines because `IndentItem.issued_qty` only
    # bumps when the MI is finalized, not when the row is drafted.
    pending_mi_qty: dict[int, Decimal] = {}
    try:
        from app.models.issue import MaterialIssue as _MI, MaterialIssueItem as _MII
        mi_rows = await db.execute(
            select(_MII.item_id, func.coalesce(func.sum(_MII.qty), 0))
            .select_from(_MII)
            .join(_MI, _MI.id == _MII.issue_id)
            .where(_MI.indent_id == indent.id)
            .where(_MI.status.notin_(["cancelled", "rejected"]))
            .group_by(_MII.item_id)
        )
        for r in mi_rows.all():
            pending_mi_qty[r[0]] = Decimal(str(r[1] or 0))
    except Exception:
        pending_mi_qty = {}

    # Subtract qty already issued
    pending = []
    for s in stock_check:
        line = next((it for it in indent.items if it.id == s["indent_item_id"]), None)
        if not line:
            continue
        already_issued = Decimal(str(line.issued_qty or 0))
        # Treat draft / posted MI qty as committed against this indent so we
        # don't double-count when GRN-fulfillment fires again.
        in_flight = pending_mi_qty.get(s["item_id"], D0)
        committed = max(already_issued, in_flight)
        remaining_needed = max(D0, Decimal(str(line.approved_qty or line.requested_qty or 0)) - committed)
        if remaining_needed > 0:
            pending.append({
                **s,
                "requested": remaining_needed,
                "short": max(D0, remaining_needed - s["available"]),
                "can_fulfill": remaining_needed <= s["available"],
            })

    fulfillable_now = [p for p in pending if p["can_fulfill"]]
    out = []
    if fulfillable_now:
        mi = await auto_create_issue_for_indent(
            db, indent=indent, fulfill_lines=fulfillable_now, user_id=user_id,
        )
        if mi:
            out.append({
                "indent_id": indent.id,
                "indent_number": indent.indent_number,
                "auto_issue_id": mi.id,
                "issue_number": mi.issue_number,
                "lines": len(fulfillable_now),
            })
    return out
