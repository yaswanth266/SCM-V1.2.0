"""Demand Pool — many-indent → one-MR consolidation.

Endpoint surface:
  GET  /procurement/demand-pool
       Returns approved indents whose items haven't yet been linked to an MR,
       grouped by (item_id, uom_id) with summed qty + contributing indent ids.
  POST /procurement/material-requests/consolidate
       Takes {indent_ids: [..]}, creates one MR per (warehouse_id) bucket,
       merging line items by (item_id, uom_id) and recording mr_indent_links
       per source indent line for traceability. Pulled indents become
       "in pool" — same indent_item can't be consolidated twice.
"""
from datetime import datetime, timezone
from typing import List, Optional
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.user import User
from app.models.master import Item, UOM
from app.models.indent import Indent, IndentItem
from app.models.procurement import MaterialRequest, MaterialRequestItem, MrIndentLink
from app.services.number_series import generate_number as gen_num
from app.services.approval_service import submit_for_approval
from app.utils.dependencies import get_current_user, require_any_role


router = APIRouter()


# --------------------------------------------------------------------
# GET /procurement/demand-pool
# --------------------------------------------------------------------

@router.get("/demand-pool")
async def list_demand_pool(
    warehouse_id: Optional[int] = Query(None, description="filter by warehouse"),
    # BUG-PRO-075 fix: paginate the demand pool. Previously the endpoint walked
    # ALL approved indents in one shot; on a busy site this returns thousands
    # of buckets and the FE table struggles. Apply page/page_size after grouping
    # so the buckets returned per call are bounded.
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    # BUG-PRO-061 fix: role-gate the demand pool. The pool exposes raw indent
    # demand across departments and projects — a sensitive procurement view
    # that should not be open to every authenticated user.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "purchase_manager", "purchase_officer",
        "warehouse_manager",
    )),
):
    """List indent line items with outstanding unacknowledged demand, grouped by
    (warehouse_id, item_id, uom_id).

    An indent line stays in the pool until the raiser fully acknowledges receipt
    (acknowledged_qty >= approved_qty). Partially-acknowledged lines remain but
    show the remaining outstanding qty so the warehouse manager knows what is
    still outstanding.

    Status meanings per source indent entry:
      • pending            — approved, not yet consolidated into MR / issued
      • issued             — material issued, awaiting acknowledgement
      • partially_acked    — some qty acknowledged, remainder outstanding
    """
    # Pull approved AND partially_fulfilled indents (both have outstanding demand)
    q = (
        select(Indent)
        .options(
            selectinload(Indent.items).selectinload(IndentItem.item),
            selectinload(Indent.warehouse),
        )
        .where(Indent.status.in_(["approved", "partially_fulfilled"]))
    )
    if warehouse_id:
        q = q.where(Indent.warehouse_id == warehouse_id)

    indents = (await db.execute(q.order_by(Indent.id.asc()))).scalars().all()

    # Pull existing links so we can exclude already-consolidated indent_items
    linked_rows = (await db.execute(select(MrIndentLink.indent_item_id))).all()
    linked_ids = {r[0] for r in linked_rows if r[0] is not None}

    # Also exclude legacy 1:1 MRs (material_requests.indent_id IS NOT NULL)
    legacy_rows = (
        await db.execute(
            select(MaterialRequest.indent_id).where(MaterialRequest.indent_id.is_not(None))
        )
    ).all()
    legacy_indent_ids = {r[0] for r in legacy_rows if r[0] is not None}

    # ------------------------------------------------------------------
    # Load acknowledged qty per indent_item across ALL past ack events
    # ------------------------------------------------------------------
    from app.models.indent import IndentAcknowledgementItem as _IAI
    all_indent_item_ids = [
        it.id
        for ind in indents
        for it in (ind.items or [])
    ]
    ack_map: dict[int, float] = {}  # indent_item_id → total acknowledged qty
    if all_indent_item_ids:
        ack_rows = (await db.execute(
            select(_IAI.indent_item_id, func.sum(_IAI.received_qty).label("total_acked"))
            .where(_IAI.indent_item_id.in_(all_indent_item_ids))
            .group_by(_IAI.indent_item_id)
        )).all()
        ack_map = {r[0]: float(r[1] or 0) for r in ack_rows}

    # Group by (warehouse_id, item_id, uom_id)
    Bucket = lambda: {
        "warehouse_id": None, "warehouse_name": None,
        "item_id": None, "item_code": None, "item_name": None,
        "uom_id": None, "uom_name": None,
        "total_qty": 0.0, "indent_count": 0,
        "sources": [],   # [{indent_id, indent_number, indent_item_id, qty, issued_qty, acknowledged_qty, remaining_qty, ident_status, required_date}]
    }
    buckets = defaultdict(Bucket)

    for ind in indents:
        if ind.id in legacy_indent_ids:
            continue  # already consumed by legacy 1:1 convert-to-mr
        # BUG-PRO-070 fix: indents with NULL warehouse_id were all bucketed under
        # the same key=(None, item_id, uom_id) — this silently collapsed demand
        # from unrelated departments/projects into a single MR. Skip them and
        # surface a separate "needs_warehouse" group instead so an operator picks
        # a warehouse manually before consolidation.
        if ind.warehouse_id is None:
            continue
        for it in (ind.items or []):
            # BUG-PRO-065 fix: an *explicit* approved_qty=0 means the approver
            # rejected the line — do NOT silently fall back to requested_qty.
            # Use approved_qty when it's set (even to 0); fall back only when
            # approved_qty is truly None.
            if it.approved_qty is not None:
                approved_qty = float(it.approved_qty)
            else:
                approved_qty = float(it.requested_qty or 0)
            if approved_qty <= 0:
                continue

            issued_qty = float(it.issued_qty or 0)
            acknowledged_qty = ack_map.get(it.id, 0.0)
            remaining_qty = max(0.0, approved_qty - acknowledged_qty)

            # Skip lines that are already fully acknowledged — they are done
            if remaining_qty <= 0:
                continue

            # Determine per-line status for the UI
            if acknowledged_qty > 0:
                ident_status = "partially_acked"
            elif issued_qty > 0:
                ident_status = "issued"
            elif it.id in linked_ids:
                ident_status = "in_mr"
            else:
                ident_status = "pending"

            key = (ind.warehouse_id, it.item_id, it.uom_id)
            b = buckets[key]
            b["warehouse_id"] = ind.warehouse_id
            b["warehouse_name"] = (ind.warehouse.name if ind.warehouse else None)
            b["item_id"] = it.item_id
            b["item_code"] = it.item.item_code if it.item else None
            b["item_name"] = it.item.name if it.item else None
            b["uom_id"] = it.uom_id
            # Use remaining (unacknowledged) qty as the demand figure
            b["total_qty"] += remaining_qty
            b["indent_count"] += 1
            b["sources"].append({
                "indent_id": ind.id,
                "indent_number": ind.indent_number,
                "indent_item_id": it.id,
                "qty": approved_qty,
                "issued_qty": issued_qty,
                "acknowledged_qty": acknowledged_qty,
                "remaining_qty": remaining_qty,
                "ident_status": ident_status,
                "required_date": ind.required_date.isoformat() if ind.required_date else None,
            })

    # Resolve UOM names in one query
    uom_ids = {b["uom_id"] for b in buckets.values() if b["uom_id"]}
    uom_map = {}
    if uom_ids:
        rows = (await db.execute(select(UOM).where(UOM.id.in_(uom_ids)))).scalars().all()
        uom_map = {u.id: u.name for u in rows}
    for b in buckets.values():
        b["uom_name"] = uom_map.get(b["uom_id"])

    # 2026-05-06 — enrich each bucket with stock at the effective real
    # source warehouse so the warehouse_manager can decide issue vs procure
    # at a glance. Vehicle (virtual) destinations redirect to the first
    # main/regional warehouse.
    from app.models.warehouse import Warehouse as _Wh
    from app.models.stock import StockBalance
    real_main_id = None
    # Prioritize the designated primary 'CENTRAL' depot first
    real_row = await db.execute(
        select(_Wh.id)
        .where(_Wh.type == "main")
        .where(_Wh.name == "CENTRAL")
        .where(_Wh.is_active == True)
        .limit(1)
    )
    real_main_id = real_row.scalar()
    
    if not real_main_id:
        # Fallback to other main/regional warehouses ordered by ID descending
        real_row = await db.execute(
            select(_Wh.id)
            .where(_Wh.type.in_(("main", "regional")))
            .where(_Wh.is_active == True)
            .order_by(_Wh.id.desc())
            .limit(1)
        )
        real_main_id = real_row.scalar()

    item_ids = {b["item_id"] for b in buckets.values() if b["item_id"]}
    stock_map: dict[tuple[int, int], float] = {}
    if item_ids:
        # group stock per (item_id, warehouse_id)
        st_rows = (await db.execute(
            select(
                StockBalance.item_id,
                StockBalance.warehouse_id,
                func.coalesce(func.sum(StockBalance.available_qty), 0),
            )
            .where(StockBalance.item_id.in_(item_ids))
            .group_by(StockBalance.item_id, StockBalance.warehouse_id)
        )).all()
        for it_id, wh_id, qty in st_rows:
            stock_map[(it_id, wh_id)] = float(qty or 0)

    for b in buckets.values():
        # The Source warehouse is ALWAYS the main/regional hub warehouse (CENTRAL)
        # where materials are actually issued from to fulfill indents.
        eff_wh = real_main_id if real_main_id else dest_wh
        avail = stock_map.get((b["item_id"], eff_wh), 0.0)
        b["available_qty"] = avail
        b["stock_at_warehouse_id"] = eff_wh
        if avail >= b["total_qty"]:
            b["stock_status"] = "in_stock"
        elif avail > 0:
            b["stock_status"] = "partial"
        else:
            b["stock_status"] = "no_stock"

    # BUG-PRO-075 fix: page the bucket list so a 5,000-bucket pool doesn't
    # ship 5,000 rows of JSON in a single call. We page AFTER grouping (pre-grouping
    # pagination would lose buckets that span the page boundary).
    all_buckets = list(buckets.values())
    total_groups = len(all_buckets)
    start = (page - 1) * page_size
    end = start + page_size
    page_buckets = all_buckets[start:end]
    return {
        "groups": page_buckets,
        "group_count": total_groups,
        "page": page,
        "page_size": page_size,
        "total_pages": (total_groups + page_size - 1) // page_size if total_groups else 0,
        "indent_count": len({s["indent_id"] for b in all_buckets for s in b["sources"]}),
    }


# --------------------------------------------------------------------
# POST /procurement/material-requests/consolidate
# --------------------------------------------------------------------

class ConsolidatePayload(BaseModel):
    indent_ids: List[int]
    remarks: Optional[str] = None


@router.post("/material-requests/consolidate", status_code=201)
async def consolidate_indents_to_mr(
    payload: ConsolidatePayload,
    db: AsyncSession = Depends(get_db),
    # 2026-05-06 — warehouse_manager is the orchestrator who decides
    # issue-vs-procure at the Demand Pool, so they MUST be able to raise
    # the MR. Procurement roles kept for admin-side consolidation.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager",
        "purchase_manager", "purchase_officer",
    )),
):
    """Create one MR per warehouse covering the supplied approved indents.
    Lines from the same (item_id, uom_id) are merged, qty summed.
    Each indent_item that contributed gets a mr_indent_links row for audit.
    """
    if not payload.indent_ids:
        raise HTTPException(422, "indent_ids must be non-empty")

    # BUG-PRO-067 fix: lock the selected indent rows for the duration of the
    # transaction so two concurrent consolidations cannot both pass the
    # already-linked check on the same indent_items.
    # We use SELECT ... FOR UPDATE on the parent indent rows; that serialises
    # any other consolidate attempt on the same indents and naturally fences
    # the linked-item check below.
    indents = (
        await db.execute(
            select(Indent)
            .options(selectinload(Indent.items))
            .where(Indent.id.in_(payload.indent_ids))
            .with_for_update()
        )
    ).scalars().all()
    if len(indents) != len(set(payload.indent_ids)):
        raise HTTPException(404, "One or more indents not found")
    not_approved = [i for i in indents if i.status != "approved"]
    if not_approved:
        nums = ", ".join(i.indent_number for i in not_approved)
        raise HTTPException(400, f"Only approved indents can be consolidated. Not approved: {nums}")

    # Already-linked items? Reject — caller should refresh the pool view.
    # Scope this query to the indent_item_ids in scope rather than scanning
    # the whole link table (BUG-PRO-074 spirit) and pair with the row lock above.
    submitted_item_ids = {it.id for ind in indents for it in (ind.items or [])}
    if submitted_item_ids:
        linked_rows = (await db.execute(
            select(MrIndentLink.indent_item_id)
            .where(MrIndentLink.indent_item_id.in_(submitted_item_ids))
        )).all()
    else:
        linked_rows = []
    already_linked = {r[0] for r in linked_rows if r[0] is not None}
    overlap = submitted_item_ids & already_linked
    if overlap:
        raise HTTPException(
            409,
            f"{len(overlap)} indent line(s) are already linked to another MR. "
            "Refresh the demand pool and retry.",
        )

    # 2026-05-06 — Vehicle model: indents destined for a virtual warehouse
    # (mobile unit / vehicle) must consolidate against CENTRAL. Pre-fetch the
    # type for every distinct warehouse_id used by the loaded indents so we
    # avoid lazy-loading `ind.warehouse` (which raises MissingGreenlet in
    # async sessions).
    from app.models.warehouse import Warehouse as _Wh
    real_wh_id = (await db.execute(
        select(_Wh.id)
        .where(_Wh.type.in_(("main", "regional")))
        .where(_Wh.is_active == True)
        .order_by(_Wh.id.asc())
        .limit(1)
    )).scalar()
    wh_ids_in_play = {ind.warehouse_id for ind in indents if ind.warehouse_id}
    wh_type_map: dict[int, str] = {}
    if wh_ids_in_play:
        type_rows = (await db.execute(
            select(_Wh.id, _Wh.type).where(_Wh.id.in_(wh_ids_in_play))
        )).all()
        wh_type_map = {wid: wtype for wid, wtype in type_rows}

    def _eff_wh(ind_wh_id):
        if ind_wh_id is None:
            return None
        if wh_type_map.get(ind_wh_id) == "virtual" and real_wh_id:
            return real_wh_id
        return ind_wh_id

    # Group by warehouse → then by (item_id, uom_id)
    by_wh: dict[int, dict[tuple, list]] = defaultdict(lambda: defaultdict(list))
    # BUG-PRO-070 fix: refuse to consolidate indents with NULL warehouse_id —
    # they would all bucket under key=None and produce one undirected MR.
    no_wh = [i for i in indents if i.warehouse_id is None]
    if no_wh:
        nums = ", ".join(i.indent_number for i in no_wh)
        raise HTTPException(
            400,
            f"Cannot consolidate indents with no warehouse: {nums}. "
            f"Set a warehouse on each indent first.",
        )
    for ind in indents:
        wh = _eff_wh(ind.warehouse_id)
        for it in (ind.items or []):
            # BUG-PRO-065 fix: same approved_qty=0 semantics as the list view.
            if it.approved_qty is not None:
                qty = float(it.approved_qty)
            else:
                qty = float(it.requested_qty or 0)
            if qty <= 0:
                continue
            by_wh[wh][(it.item_id, it.uom_id)].append((ind, it, qty))

    if not by_wh:
        raise HTTPException(400, "Selected indents have no positive-qty items")

    created_mrs = []

    for warehouse_id, lines_by_item in by_wh.items():
        mr_number = await gen_num(db, "procurement", "material_request")
        # BUG-PRO-071 fix: instead of "first non-null", pick the modal project_id
        # for this warehouse. If indents disagree on project, the consolidated
        # MR shouldn't silently inherit whichever indent we happened to load
        # first — pick the project most indents agree on, or leave it null when
        # there is no clear majority.
        from collections import Counter as _Counter
        wh_projects = [
            ind.project_id for ind in indents
            if _eff_wh(ind.warehouse_id) == warehouse_id and ind.project_id
        ]
        if wh_projects:
            counts = _Counter(wh_projects).most_common()
            top_pid, top_n = counts[0]
            # Tie or weak majority → leave null so a human picks it.
            if len(counts) > 1 and counts[1][1] == top_n:
                rep_project = None
            else:
                rep_project = top_pid
        else:
            rep_project = None
        # Earliest required_date wins
        required_dates = [
            ind.required_date for ind in indents
            if _eff_wh(ind.warehouse_id) == warehouse_id and ind.required_date
        ]
        required_date = min(required_dates) if required_dates else None

        source_numbers = sorted({
            ind.indent_number for ind in indents if _eff_wh(ind.warehouse_id) == warehouse_id
        })
        remarks = (
            (payload.remarks + " — " if payload.remarks else "")
            + f"Consolidated from {len(source_numbers)} indent(s): "
            + ", ".join(source_numbers[:10])
            + ("…" if len(source_numbers) > 10 else "")
        )

        mr = MaterialRequest(
            mr_number=mr_number,
            indent_id=None,  # legacy 1:1 column — leave null for consolidated MRs
            project_id=rep_project,
            warehouse_id=warehouse_id,
            request_type="purchase",
            requested_by=current_user.id,
            request_date=datetime.now(timezone.utc),
            required_date=required_date,
            priority="medium",
            status="draft",
            remarks=remarks,
        )
        db.add(mr)
        await db.flush()

        # One MR line per (item_id, uom_id), summed qty
        # BUG-PRO-076 fix: previously we flushed per (item_id, uom_id) bucket
        # AND once at the bottom — N+1 round trips for an N-line MR. Build the
        # MaterialRequestItem rows first, flush ONCE to populate primary keys,
        # then build all MrIndentLink rows referencing those keys.
        mr_items_buffer: list[tuple[MaterialRequestItem, list]] = []
        for (item_id, uom_id), contribs in lines_by_item.items():
            total_qty = sum(c[2] for c in contribs)
            mr_item = MaterialRequestItem(
                mr_id=mr.id,
                item_id=item_id,
                qty=total_qty,
                uom_id=uom_id,
                remarks=None,
            )
            db.add(mr_item)
            mr_items_buffer.append((mr_item, contribs))

        # Single flush populates mr_item.id for every line in this MR
        await db.flush()

        for mr_item, contribs in mr_items_buffer:
            for (ind, ind_item, qty) in contribs:
                db.add(
                    MrIndentLink(
                        mr_id=mr.id,
                        indent_id=ind.id,
                        indent_item_id=ind_item.id,
                        mr_item_id=mr_item.id,
                        qty=qty,
                    )
                )

        await db.flush()

        # 2026-05-06 — auto-submit consolidated MRs so they land in
        # purchase_manager's inbox immediately. Without this they sat in
        # `draft` and the warehouse_manager had to navigate to the MR
        # detail page and click Submit — easy to miss, and the typical
        # "raise MR" intent is "send to procurement now".
        try:
            mr.status = "pending_approval"
            await submit_for_approval(
                db, "procurement", "material_request", mr.id, mr_number,
                current_user.id, rep_project,
                department=getattr(mr, "department", None),
                request_type=getattr(mr, "request_type", None),
            )
        except Exception:
            import logging as _logging
            _logging.getLogger(__name__).exception(
                "auto-submit failed for consolidated MR %s", mr_number,
            )

        created_mrs.append({
            "id": mr.id,
            "mr_number": mr_number,
            "warehouse_id": warehouse_id,
            "line_count": len(lines_by_item),
            "source_indent_count": len(source_numbers),
        })

    # NOTE: We intentionally do NOT change indent.status after consolidation.
    # An indent remains "approved" until material is actually issued (at which
    # point warehouse.py sets it to "partially_fulfilled").  The demand pool
    # shows consolidated items with ident_status = "in_mr" based on the presence
    # of MrIndentLink rows — no status flip needed here.

    return {
        "success": True,
        "message": f"Created {len(created_mrs)} consolidated MR(s)",
        "mrs": created_mrs,
    }


# --------------------------------------------------------------------
# GET /procurement/material-requests/{mr_id}/source-indents
# --------------------------------------------------------------------

@router.get("/material-requests/{mr_id}/source-indents")
async def list_mr_source_indents(
    mr_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-PRO-073 fix: gate behind procurement / warehouse / store roles. The
    # source-indents trace exposes which departments contributed demand and
    # the per-line qty — the same sensitivity as the demand-pool view.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "purchase_manager", "purchase_officer",
        "warehouse_manager", "store_keeper",
    )),
):
    """Trace which indents contributed to this MR (for the MR detail page)."""
    rows = (
        await db.execute(
            select(MrIndentLink, Indent)
            .join(Indent, Indent.id == MrIndentLink.indent_id)
            .where(MrIndentLink.mr_id == mr_id)
            .order_by(MrIndentLink.id)
        )
    ).all()
    return [
        {
            "id": link.id,
            "indent_id": link.indent_id,
            "indent_number": ind.indent_number,
            "indent_item_id": link.indent_item_id,
            "mr_item_id": link.mr_item_id,
            "qty": float(link.qty or 0),
        }
        for link, ind in rows
    ]
