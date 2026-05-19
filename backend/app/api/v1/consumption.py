import logging
from decimal import Decimal
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.database import get_db
from app.models.user import User
from app.models.consumption import ConsumptionEntry, ConsumptionItem
from app.schemas.consumption import (
    ConsumptionCreate, ConsumptionUpdate, ConsumptionResponse,
)
from app.services.number_series import generate_number
from app.services.stock_service import post_stock_ledger
from app.utils.dependencies import get_current_user, require_any_role, require_permission
from app.utils.helpers import paginate_params, build_paginated_response, apply_search_filter

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/entries")
@router.get("")
async def list_consumption_entries(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    status: str = Query(None),
    source: str = Query(None),
    project_id: int = Query(None),
    department: str = Query(None),
    department_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(ConsumptionEntry).options(
        selectinload(ConsumptionEntry.items).selectinload(ConsumptionItem.item),
        selectinload(ConsumptionEntry.items).selectinload(ConsumptionItem.uom),
    )
    count_query = select(func.count(ConsumptionEntry.id))

    # BUG-ISS-044 — frontend sends department_id (int); resolve to name to
    # match the existing string column. Falls back to literal text filter.
    if department_id and not department:
        try:
            from app.models.master import Department as _Dept
            dr = await db.execute(select(_Dept.name).where(_Dept.id == department_id))
            dname = dr.scalar_one_or_none()
            if dname:
                department = dname
        except Exception:
            pass

    # BUG-ISS-043 — apply the SAME filter conditions to both list and count
    # queries from a shared list to prevent silent divergence between page
    # rows and total. Adding/removing a filter only happens in one place.
    filters = []
    if status:
        filters.append(ConsumptionEntry.status == status)
    if source:
        filters.append(ConsumptionEntry.source == source)
    if project_id:
        filters.append(ConsumptionEntry.project_id == project_id)
    if department:
        filters.append(ConsumptionEntry.department == department)
    for f in filters:
        query = query.where(f)
        count_query = count_query.where(f)

    query = apply_search_filter(query, ConsumptionEntry, search, ["entry_number", "department", "cost_center"])
    count_query = apply_search_filter(count_query, ConsumptionEntry, search, ["entry_number", "department", "cost_center"])

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(ConsumptionEntry.id.desc()))
    entries = result.scalars().all()

    response_items = []
    for entry in entries:
        data = ConsumptionResponse.model_validate(entry).model_dump()
        # BUG-ISS-045 — match by ConsumptionItem.id rather than positional
        # index. Pydantic does not guarantee item ordering when serialising,
        # so a positional join could attach item_name to the wrong line.
        item_by_id = {it.id: it for it in entry.items}
        for d in data.get("items", []):
            ci = item_by_id.get(d.get("id"))
            if not ci:
                continue
            if ci.item:
                d["item_name"] = ci.item.name
                d["item_code"] = ci.item.item_code
            if ci.uom:
                d["uom_name"] = ci.uom.name
        response_items.append(data)
    return build_paginated_response(response_items, total, page, page_size)


# Alias: /consumption/entry -> list (must be before /{entry_id} to avoid path param conflict)
@router.get("/entry")
async def list_consumption_alias(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    status: str = Query(None),
    source: str = Query(None),
    project_id: int = Query(None),
    department: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await list_consumption_entries(
        page=page, page_size=page_size, search=search, status=status,
        source=source, project_id=project_id, department=department,
        db=db, current_user=current_user
    )


@router.get("/entries/{entry_id}", response_model=ConsumptionResponse)
@router.get("/{entry_id}", response_model=ConsumptionResponse)
async def get_consumption_entry(
    entry_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(ConsumptionEntry).options(
            selectinload(ConsumptionEntry.items).selectinload(ConsumptionItem.item),
            selectinload(ConsumptionEntry.items).selectinload(ConsumptionItem.uom),
        ).where(ConsumptionEntry.id == entry_id)
    )
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Consumption entry not found")
    data = ConsumptionResponse.model_validate(entry).model_dump()
    # BUG-ISS-045 — match by ConsumptionItem.id, not positional index.
    item_by_id = {it.id: it for it in entry.items}
    for d in data.get("items", []):
        ci = item_by_id.get(d.get("id"))
        if not ci:
            continue
        if ci.item:
            d["item_name"] = ci.item.name
            d["item_code"] = ci.item.item_code
        if ci.uom:
            d["uom_name"] = ci.uom.name
    return data


@router.post("/entries", status_code=201)
@router.post("", status_code=201)
async def create_consumption_entry(
    payload: ConsumptionCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("consumption", "create", "entries")),
):
    """Create consumption entry - supports both web and mobile_app sources.

    Mobile clients don't ask the field user to pick a warehouse — it is
    auto-resolved on the server so consumption always lands somewhere.
    Resolution priority:
      1. payload.warehouse_id (explicit from caller)
      2. first warehouse assigned to the user via user_warehouses
      3. first active warehouse in the user's organization
    """
    from app.models.user import UserWarehouse
    from app.models.warehouse import Warehouse

    # BUG-ISS-027 — prefer the user's default/explicitly-assigned warehouse
    # so mobile field users don't accidentally consume from the central depot.
    # Resolution priority:
    #   1. payload.warehouse_id (explicit from caller)
    #   2. user.default_warehouse_id if set
    #   3. first warehouse assigned via user_warehouses
    #   4. (only if user has no warehouse assignment) first active org warehouse
    resolved_wh = payload.warehouse_id
    if not resolved_wh:
        resolved_wh = getattr(current_user, "default_warehouse_id", None)
    if not resolved_wh:
        uw_r = await db.execute(
            select(UserWarehouse.warehouse_id)
            .where(UserWarehouse.user_id == current_user.id)
            .order_by(UserWarehouse.warehouse_id)
            .limit(1)
        )
        resolved_wh = uw_r.scalar_one_or_none()
    if not resolved_wh:
        # Last-resort fallback only if user truly has no warehouse mapping —
        # avoids silently picking the central depot for assigned users.
        w_r = await db.execute(
            select(Warehouse.id)
            .where(
                (Warehouse.organization_id == current_user.organization_id)
                & (Warehouse.is_active == True)
            )
            .order_by(Warehouse.id)
            .limit(1)
        )
        resolved_wh = w_r.scalar_one_or_none()

    # BUG-ISS-033 — validate every supplied batch_id belongs to the SAME
    # item_id on the line. Without this, a caller can pass another item's
    # batch and silently issue from a foreign batch.
    from app.models.warehouse import Batch as _Batch
    _bids = [it.batch_id for it in payload.items if it.batch_id]
    if _bids:
        _br = await db.execute(select(_Batch).where(_Batch.id.in_(set(_bids))))
        _bmap = {b.id: b for b in _br.scalars().all()}
        for it in payload.items:
            if it.batch_id and it.batch_id in _bmap:
                if _bmap[it.batch_id].item_id != it.item_id:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Batch {it.batch_id} does not belong to item {it.item_id}"
                        ),
                    )

    # BUG-ISS-039 — server-side attestation of `source`. Don't trust the body
    # blindly: a web client could send source='mobile_app' to dodge any future
    # mobile-only audit/logging path. We re-derive the source from the
    # User-Agent unless the caller passed a Bavya-mobile attestation header.
    ua = (request.headers.get("user-agent") or "").lower()
    mobile_attest = (request.headers.get("x-bhspl-client") or "").lower()
    looks_mobile = "dart" in ua or "flutter" in ua or mobile_attest == "mobile_app"
    safe_source = payload.source
    if payload.source == "mobile_app" and not looks_mobile:
        safe_source = "web"
    elif payload.source == "web" and looks_mobile:
        safe_source = "mobile_app"

    # Auto-resolve project_id when payload omits it and the user is mapped
    # to exactly one project. Mirrors the warehouse auto-fill above.
    resolved_proj = payload.project_id
    if not resolved_proj:
        from app.models.user import UserProject
        up_r = await db.execute(
            select(UserProject.project_id).where(UserProject.user_id == current_user.id)
        )
        proj_ids = [r[0] for r in up_r.all()]
        if len(proj_ids) == 1:
            resolved_proj = proj_ids[0]

    entry_number = await generate_number(db, "consumption", "consumption_entry")
    entry = ConsumptionEntry(
        entry_number=entry_number,
        project_id=resolved_proj,
        warehouse_id=resolved_wh,
        consumption_date=payload.consumption_date,
        department=payload.department,
        cost_center=payload.cost_center,
        consumed_by=current_user.id,
        source=safe_source,
        patient_name=payload.patient_name,
        patient_aadhaar=payload.patient_aadhaar,
        case_id=payload.case_id,
        remarks=payload.remarks,
    )
    db.add(entry)
    await db.flush()

    for item in payload.items:
        amount = item.qty * item.rate
        ci = ConsumptionItem(
            entry_id=entry.id, item_id=item.item_id, batch_id=item.batch_id,
            qty=item.qty, uom_id=item.uom_id, rate=item.rate,
            amount=amount, remarks=item.remarks,
        )
        db.add(ci)

    await db.flush()
    return {"id": entry.id, "entry_number": entry_number, "message": "Consumption entry created"}


@router.put("/entries/{entry_id}")
@router.put("/{entry_id}")
async def update_consumption_entry(
    entry_id: int,
    payload: ConsumptionUpdate,
    db: AsyncSession = Depends(get_db),
    # BUG-ISS-029 — update must require the same permission as create.
    current_user: User = Depends(require_permission("consumption", "edit", "entries")),
):
    result = await db.execute(select(ConsumptionEntry).where(ConsumptionEntry.id == entry_id))
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Consumption entry not found")

    payload_data = payload.model_dump(exclude_unset=True)
    new_items = payload_data.pop("items", None)

    if new_items is not None and entry.status != "draft":
        raise HTTPException(
            status_code=400,
            detail="Items can only be edited while the entry is in draft status",
        )

    # BUG-ISS-030 — never blindly mass-assign FK columns. Validate ownership
    # before re-pointing across orgs/warehouses.
    SAFE_FIELDS = {
        "consumption_date", "department", "cost_center", "case_id",
        "patient_name", "remarks", "source",
    }
    if "warehouse_id" in payload_data and payload_data["warehouse_id"] is not None:
        from app.models.warehouse import Warehouse as _WH
        wr = await db.execute(select(_WH).where(_WH.id == payload_data["warehouse_id"]))
        wh = wr.scalar_one_or_none()
        if not wh or wh.organization_id != current_user.organization_id:
            raise HTTPException(
                status_code=403,
                detail="Warehouse is not in your organization",
            )
    if "project_id" in payload_data and payload_data["project_id"] is not None:
        try:
            from app.models.user import Project as _Proj
            pr = await db.execute(select(_Proj).where(_Proj.id == payload_data["project_id"]))
            proj = pr.scalar_one_or_none()
            if proj and getattr(proj, "organization_id", None) and \
                    proj.organization_id != current_user.organization_id:
                raise HTTPException(
                    status_code=403,
                    detail="Project is not in your organization",
                )
        except ImportError:
            pass

    # status transition is restricted (only via /submit, /approve, /cancel routes)
    payload_data.pop("status", None)

    for k, v in payload_data.items():
        if k in SAFE_FIELDS or k in ("warehouse_id", "project_id"):
            setattr(entry, k, v)

    if new_items is not None:
        from app.models.master import Item
        # BUG-ISS-028 — model column is `entry_id`, not `consumption_id`.
        # The previous filter/insert silently failed (DELETE no-op, INSERT
        # NULL on a non-null FK). Fixed to use the correct column.
        # BUG-ISS-040 — drop existing rows via ORM (await db.delete) so that
        # cascade rules / ORM events fire instead of going around them with a
        # raw __table__.delete().
        existing_q = await db.execute(
            select(ConsumptionItem).where(ConsumptionItem.entry_id == entry.id)
        )
        for existing_ci in existing_q.scalars().all():
            await db.delete(existing_ci)
        await db.flush()
        for item in new_items:
            uom_id = item.get("uom_id")
            if not uom_id:
                item_result = await db.execute(
                    select(Item).where(Item.id == item["item_id"])
                )
                found_item = item_result.scalar_one_or_none()
                if found_item:
                    uom_id = found_item.primary_uom_id
            # BUG-ISS-041 — amount must be persisted (rate * qty) so reports
            # don't underreport consumption value.
            _qty = Decimal(str(item.get("qty") or 0))
            _rate = Decimal(str(item.get("rate") or 0))
            db.add(ConsumptionItem(
                entry_id=entry.id,
                item_id=item["item_id"],
                batch_id=item.get("batch_id"),
                qty=_qty,
                uom_id=uom_id,
                rate=_rate,
                amount=_qty * _rate,
                remarks=item.get("remarks"),
            ))

    await db.flush()
    return {"success": True, "message": "Consumption entry updated"}


@router.post("/entries/{entry_id}/submit")
@router.post("/{entry_id}/submit")
async def submit_consumption(
    entry_id: int,
    payload: dict | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Submit consumption entry and post stock ledger.

    Wave 7 — Healthcare compliance:
      - For H1/narcotic items: prescriber_name + prescriber_license required
        on the entry header (consumption applies to a single patient/case).
      - E-signature: caller may pass {"password": "..."} to sign with re-auth.
        Re-auth is currently optional; will become mandatory once frontend
        presents the dialog uniformly.
    """
    # BUG-ISS-006-style race fix: lock entry row FOR UPDATE so concurrent
    # submits cannot both pass the draft check.
    result = await db.execute(
        select(ConsumptionEntry).options(selectinload(ConsumptionEntry.items))
        .where(ConsumptionEntry.id == entry_id)
        .with_for_update()
    )
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Consumption entry not found")
    if entry.status != "draft":
        raise HTTPException(status_code=400, detail="Only draft entries can be submitted")

    # BUG-ISS-022 — submit MUST have a warehouse, otherwise stock ledger
    # is silently skipped and inventory drifts. Reject explicitly.
    if not entry.warehouse_id:
        raise HTTPException(
            status_code=400,
            detail="Consumption entry has no warehouse assigned — cannot submit",
        )

    if not entry.items or len(entry.items) == 0:
        raise HTTPException(status_code=400, detail="Consumption entry has no items")

    # BUG-ISS-034 — patient-safety: block consuming expired batches.
    from datetime import date as _date
    from app.models.warehouse import Batch as _Batch
    _batch_ids = [i.batch_id for i in entry.items if i.batch_id]
    if _batch_ids:
        _batch_rows = await db.execute(
            select(_Batch).where(_Batch.id.in_(_batch_ids))
        )
        for _b in _batch_rows.scalars().all():
            # BUG-ISS-009 — the original `<` allowed an IST clinic at 23:30 on
            # the expiry day to dispense from a batch that's expiring at
            # midnight. Use `<=` so the expiry date itself is treated as
            # already-expired (matches warehouse.py:2014 behaviour).
            _exp = _b.expiry_date
            if _exp is not None and hasattr(_exp, "date"):
                _exp = _exp.date()
            if _exp is not None and _exp <= _date.today():
                _verb = "expired" if _exp < _date.today() else "expires today"
                raise HTTPException(
                    status_code=400,
                    detail=f"Batch {_b.batch_number} {_verb} on {_b.expiry_date} — cannot consume expired stock",
                )
            # BUG-HC-004 fix: also block recalled batches at submit time.
            if getattr(_b, "status", None) == "recalled":
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Batch {_b.batch_number} is under active recall and "
                        "cannot be dispensed. Contact compliance to release."
                    ),
                )
        # BUG-HC-004 fix: cross-check with the BatchRecall table — the batch
        # status flag may not have propagated yet on a freshly initiated recall.
        from app.models.healthcare import BatchRecall as _BatchRecall
        active_recall_rows = await db.execute(
            select(_BatchRecall.batch_id).where(
                _BatchRecall.batch_id.in_(_batch_ids),
                _BatchRecall.status.in_(["initiated", "in_progress"]),
            )
        )
        active_recall_ids = {r[0] for r in active_recall_rows.all() if r[0]}
        if active_recall_ids:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"One or more batches in this consumption are under active recall "
                    f"(batch_ids={sorted(active_recall_ids)}). Cannot submit."
                ),
            )

    payload = payload or {}

    # Wave 7 — H1/narcotic prescriber gate
    from app.services.compliance_service import (
        items_requiring_prescriber, record_prescription, assert_reauth_and_sign,
    )
    flagged_items = await items_requiring_prescriber(db, [i.item_id for i in entry.items])
    if flagged_items:
        if not entry.prescriber_name or not entry.prescriber_license:
            names = ", ".join(v["name"] for v in flagged_items.values())
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Prescriber name and license required for: {names}. "
                    "Edit the consumption entry and add prescriber details before submit."
                ),
            )

    # BUG-ISS-031 — e-signature is MANDATORY when any flagged H1/narcotic item
    # is being dispensed. Anyone with a session token must re-confirm with
    # their password to satisfy the regulatory audit trail.
    if flagged_items and not payload.get("password"):
        raise HTTPException(
            status_code=400,
            detail=(
                "E-signature required: please re-enter your password to dispense "
                "Schedule-H1 / narcotic items."
            ),
        )

    if payload.get("password"):
        sig = await assert_reauth_and_sign(
            db,
            user=current_user,
            submitted_password=payload["password"],
            source_type="consumption_entry",
            source_id=entry.id,
            payload={
                "entry_number": entry.entry_number,
                "items": [{"item_id": i.item_id, "qty": str(i.qty)} for i in entry.items],
            },
        )
        entry.e_signature_id = sig.id

    # BUG-ISS-023 — atomicity: pre-validate available stock for ALL lines
    # before posting any ledger row. Without this, line-1 could post and
    # line-2 raise InsufficientStockError leaving stock half-deducted.
    from app.models.stock import StockBalance as _StockBalance
    for _it in entry.items:
        _bal_q = select(func.coalesce(func.sum(_StockBalance.available_qty), 0)).where(
            _StockBalance.item_id == _it.item_id,
            _StockBalance.warehouse_id == entry.warehouse_id,
        )
        if _it.batch_id:
            _bal_q = _bal_q.where(_StockBalance.batch_id == _it.batch_id)
        _avail = (await db.execute(_bal_q)).scalar() or 0
        if Decimal(str(_avail)) < Decimal(str(_it.qty or 0)):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Insufficient stock for item {_it.item_id} "
                    f"(requested {_it.qty}, available {_avail})"
                ),
            )

    # Post stock ledger for each item — warehouse_id non-null guaranteed above
    consumption_gl_items: list[dict] = []
    for item in entry.items:
        ledger_row = await post_stock_ledger(
            db, item_id=item.item_id, warehouse_id=entry.warehouse_id,
            transaction_type="consumption", qty_out=item.qty,
            rate=item.rate, batch_id=item.batch_id,
            reference_type="consumption_entry", reference_id=entry.id,
            uom_id=item.uom_id, created_by=current_user.id,
        )
        consumption_gl_items.append({
            "item_id": item.item_id,
            "qty": item.qty,
            "rate": getattr(ledger_row, "rate", None) or item.rate or 0,
        })

    # BUG-ISS-032 — fire GL posting (Expense/Consumption Dr, Inventory Cr) so
    # the financial books mirror the stock-ledger movement. Mirrors MI flow.
    try:
        from app.services.gl_posting import post_issue_gl
        org_id = current_user.organization_id or 1
        await post_issue_gl(
            db,
            organization_id=org_id,
            issue_id=entry.id,
            issue_number=entry.entry_number,
            issue_date=entry.consumption_date,
            warehouse_id=entry.warehouse_id,
            items=consumption_gl_items,
            created_by=current_user.id,
        )
    except Exception:
        logger.exception("GL posting failed for consumption entry %s", entry.entry_number)

    # Record prescription audit rows for flagged items
    try:
        for item in entry.items:
            if item.item_id in flagged_items:
                info = flagged_items[item.item_id]
                await record_prescription(
                    db,
                    source_type="consumption_entry",
                    source_id=entry.id,
                    item_id=item.item_id,
                    batch_id=item.batch_id,
                    qty=item.qty,
                    drug_schedule=info["drug_schedule"],
                    prescriber_name=entry.prescriber_name,
                    prescriber_license=entry.prescriber_license,
                    patient_name=entry.patient_name,
                    patient_id=entry.patient_aadhaar,
                    prescription_image_url=None,
                    dispensed_by=current_user.id,
                )
    except Exception:
        logger.exception("Prescription audit recording failed for consumption entry %s", entry.id)

    entry.status = "submitted"
    await db.flush()
    return {
        "success": True,
        "message": "Consumption submitted and stock updated",
        "e_signature_id": entry.e_signature_id,
    }


@router.post("/entries/{entry_id}/approve")
@router.post("/{entry_id}/approve")
async def approve_consumption(
    entry_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-ISS-037 — super_admin was excluded; matches the
    # project_approval_403_fix.md pattern requiring super_admin/admin bypass.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "manager", "approver"
    )),
):
    result = await db.execute(select(ConsumptionEntry).where(ConsumptionEntry.id == entry_id))
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Consumption entry not found")
    # BUG-ISS-025 — only submitted entries can be approved. Approving from
    # cancelled / draft / approved is meaningless and corrupts audit trail.
    if entry.status != "submitted":
        raise HTTPException(
            status_code=400,
            detail=(
                f"Cannot approve consumption in '{entry.status}' status — "
                "must be 'submitted'"
            ),
        )
    entry.status = "approved"
    await db.flush()
    return {"success": True, "message": "Consumption approved"}


# ==================== CONSUMPTION RETURNS (BUG-ISS-063) ====================
# Minimal create endpoint that records the return and writes positive
# qty_in to the stock ledger so balances are restored. Authoritative
# accounting reversal is left to a follow-up that wires GL.
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime, timezone
from decimal import Decimal as _D
from app.models.consumption import ConsumptionReturn, ConsumptionReturnItem


class _ConsumptionReturnItemIn(BaseModel):
    consumption_item_id: Optional[int] = None
    item_id: int
    batch_id: Optional[int] = None
    qty: float
    uom_id: int
    rate: Optional[float] = 0
    reason: Optional[str] = None


class _ConsumptionReturnIn(BaseModel):
    entry_id: int
    warehouse_id: int
    return_date: Optional[datetime] = None
    reason: Optional[str] = None
    items: List[_ConsumptionReturnItemIn]


@router.post("/returns", status_code=201)
async def create_consumption_return(
    payload: _ConsumptionReturnIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "warehouse_operator"
    )),
):
    if not payload.items:
        raise HTTPException(status_code=400, detail="At least one return line is required")

    entry = (await db.execute(
        select(ConsumptionEntry).where(ConsumptionEntry.id == payload.entry_id)
    )).scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Consumption entry not found")

    return_number = await generate_number(db, "consumption", "consumption_return")
    cr = ConsumptionReturn(
        return_number=return_number,
        entry_id=payload.entry_id,
        warehouse_id=payload.warehouse_id,
        return_date=payload.return_date or datetime.now(timezone.utc),
        reason=payload.reason,
        status="completed",
        created_by=current_user.id,
    )
    db.add(cr)
    await db.flush()

    for line in payload.items:
        if line.qty <= 0:
            raise HTTPException(status_code=400, detail="Return qty must be > 0")
        cri = ConsumptionReturnItem(
            return_id=cr.id,
            consumption_item_id=line.consumption_item_id,
            item_id=line.item_id,
            batch_id=line.batch_id,
            qty=_D(str(line.qty)),
            uom_id=line.uom_id,
            rate=_D(str(line.rate or 0)),
            reason=line.reason,
        )
        db.add(cri)
        await post_stock_ledger(
            db,
            item_id=line.item_id,
            warehouse_id=payload.warehouse_id,
            transaction_type="consumption_return",
            qty_in=_D(str(line.qty)),
            rate=_D(str(line.rate or 0)),
            batch_id=line.batch_id,
            uom_id=line.uom_id,
            reference_type="consumption_return",
            reference_id=cr.id,
            created_by=current_user.id,
        )
    await db.flush()
    return {"id": cr.id, "return_number": cr.return_number, "status": cr.status}

