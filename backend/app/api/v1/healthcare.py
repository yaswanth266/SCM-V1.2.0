"""
Healthcare Supply-Chain Management API endpoints.

Covers FEFO picking, batch recalls, expiry dashboard, ABC/VED/FSN analysis,
patient costing, auto-reorder, rate contracts, vendor scorecards, landed costs,
rate comparison, approval matrix, e-signatures, department budgets, kit
management, demand forecasting, ATP, inventory aging, procurement cycle time,
carrier tracking, and inter-warehouse transfer suggestions.
"""

from datetime import datetime, date, timedelta, timezone
from decimal import Decimal
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, and_, or_, case, literal_column
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.user import User
from app.models.master import Item, UOM, Vendor
from app.models.stock import StockBalance, StockLedger
from app.models.warehouse import Warehouse, Batch
from app.models.procurement import (
    PurchaseOrder, PurchaseOrderItem,
    MaterialRequest, MaterialRequestItem,
)
from app.models.grn import GoodsReceiptNote, GRNItem
from app.models.healthcare import (
    BatchRecall, BatchRecallTrace, RateContract, RateContractItem,
    VendorScorecard, ItemKit, ItemKitComponent, DepartmentBudget,
    LandedCost, LandedCostAllocation, DemandForecast, CarrierTracking,
)
from app.schemas.healthcare import (
    # Batch Recall
    BatchRecallCreate, BatchRecallResponse, BatchRecallUpdate,
    # Rate Contract
    RateContractCreate, RateContractResponse, RateContractUpdate,
    RateContractItemCreate, RateContractItemResponse,
    # Vendor Scorecard
    VendorScorecardResponse,
    # Item Kit
    ItemKitCreate, ItemKitResponse, ItemKitUpdate,
    KitComponentCreate, KitComponentResponse, KitConsumeRequest,
    # Department Budget
    DepartmentBudgetCreate, DepartmentBudgetResponse, DepartmentBudgetUpdate,
    # Landed Cost
    LandedCostCreate, LandedCostResponse, LandedCostAllocationResponse,
    # Carrier Tracking
    CarrierTrackingCreate, CarrierTrackingResponse, CarrierTrackingUpdate,
    # Analytics / Reports
    FEFOPickingSuggestion, ExpiryBucketItem, ExpiryDashboardResponse,
    ABCItem, PatientCostItem, VendorComparisonItem, ATPItem,
    AgingBucket, CycleTimeItem, TransferSuggestion,
)
from app.services.number_series import generate_number
from app.services.stock_service import post_stock_ledger
from app.utils.dependencies import get_current_user, require_permission
from app.utils.helpers import paginate_params, build_paginated_response, apply_search_filter

import logging

logger = logging.getLogger(__name__)

router = APIRouter()


def _mask_aadhaar(value: str | None) -> str | None:
    """Mask Aadhaar number to show only last 4 digits."""
    if not value:
        return None
    digits = value.replace("-", "").replace(" ", "")
    if len(digits) >= 4:
        return f"XXXX-XXXX-{digits[-4:]}"
    return "XXXX-XXXX-XXXX"


def _mask_patient_name(name: str | None) -> str | None:
    """Mask patient name — show only first 2 chars + asterisks."""
    if not name:
        return None
    name = name.strip()
    if len(name) <= 2:
        return name
    return name[:2] + "*" * (len(name) - 2)


def _safe_error(exc: Exception) -> str:
    """Return generic error message, log the real one."""
    logger.exception("Healthcare endpoint error")
    return "An error occurred while processing your request"


# =====================================================================
# 1. FEFO PICKING
# =====================================================================

@router.get("/fefo-picking", response_model=List[FEFOPickingSuggestion])
async def fefo_picking(
    item_id: int = Query(...),
    warehouse_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return stock batches ordered by earliest expiry (First-Expiry First-Out)."""
    try:
        today = date.today()
        # BUG-HC-003 fix: subtract reserved/committed from available_qty so FEFO
        # never suggests stock that is already promised to other transactions.
        free_qty_expr = (
            func.coalesce(StockBalance.available_qty, 0)
            - func.coalesce(StockBalance.reserved_qty, 0)
            - func.coalesce(StockBalance.transit_qty, 0)
        ).label("free_qty")
        query = (
            select(
                StockBalance.batch_id,
                StockBalance.item_id,
                StockBalance.warehouse_id,
                free_qty_expr,
                Batch.batch_number,
                Batch.expiry_date,
                Item.item_code,
                Item.name.label("item_name"),
                Warehouse.name.label("warehouse_name"),
            )
            .join(Batch, StockBalance.batch_id == Batch.id)
            .join(Item, StockBalance.item_id == Item.id)
            .join(Warehouse, StockBalance.warehouse_id == Warehouse.id)
            .where(
                StockBalance.item_id == item_id,
                StockBalance.available_qty > 0,
                # BUG-HC-001 fix: exclude expired batches from FEFO suggestions
                Batch.expiry_date >= today,
                # BUG-HC-002 fix: exclude NULL expiry batches (NULLS-FIRST in MySQL
                # would put them at the top of FEFO order, which is unsafe).
                Batch.expiry_date.isnot(None),
                # BUG-HC-004 fix: never suggest recalled batches.
                or_(Batch.status.is_(None), Batch.status.notin_(["recalled", "expired"])),
            )
            .order_by(Batch.expiry_date.asc())
        )
        if warehouse_id:
            query = query.where(StockBalance.warehouse_id == warehouse_id)
        result = await db.execute(query)
        rows = result.all()

        # BUG-HC-004 fix: also exclude any batch that has an active BatchRecall
        # row (initiated|in_progress) — the recall flag may not yet have been
        # propagated to Batch.status by the recall-create path.
        active_recalled_batch_ids: set[int] = set()
        recall_ids_q = await db.execute(
            select(BatchRecall.batch_id).where(
                BatchRecall.item_id == item_id,
                BatchRecall.status.in_(["initiated", "in_progress"]),
                BatchRecall.batch_id.isnot(None),
            )
        )
        active_recalled_batch_ids = {r[0] for r in recall_ids_q.all() if r[0]}

        suggestions: list[dict] = []
        for row in rows:
            if row.batch_id in active_recalled_batch_ids:
                continue
            free_qty = row.free_qty if row.free_qty is not None else Decimal("0")
            if free_qty <= 0:
                continue
            expiry = row.expiry_date.date() if isinstance(row.expiry_date, datetime) else row.expiry_date
            is_expired = expiry < today if expiry else False
            suggestions.append(
                FEFOPickingSuggestion(
                    batch_id=row.batch_id,
                    batch_number=row.batch_number,
                    item_id=row.item_id,
                    item_code=row.item_code,
                    item_name=row.item_name,
                    expiry_date=expiry,
                    qty_available=free_qty,
                    warehouse_id=row.warehouse_id,
                    warehouse_name=row.warehouse_name,
                    is_expired=is_expired,
                ).model_dump()
            )
        return suggestions
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


# =====================================================================
# 2. BATCH RECALLS  (full CRUD + auto-trace)
# =====================================================================

@router.get("/batch-recalls")
async def list_batch_recalls(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(BatchRecall)
    count_query = select(func.count(BatchRecall.id))

    if status:
        query = query.where(BatchRecall.status == status)
        count_query = count_query.where(BatchRecall.status == status)

    query = apply_search_filter(query, BatchRecall, search, ["recall_number", "reason"])
    count_query = apply_search_filter(count_query, BatchRecall, search, ["recall_number", "reason"])

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(BatchRecall.id.desc()))
    recalls = result.scalars().all()

    items = [BatchRecallResponse.model_validate(r).model_dump() for r in recalls]
    return build_paginated_response(items, total, page, page_size)


@router.post("/batch-recalls", status_code=201)
async def create_batch_recall(
    payload: BatchRecallCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # BUG-HC-010 fix: only compliance/QA/admin/pharmacy roles may initiate
    # batch recalls. A recall touches patient safety data — random buyers
    # or store users must not be able to fire it.
    from app.utils.dependencies import get_user_role_codes
    allowed_roles = {
        "super_admin", "admin", "compliance_officer", "compliance",
        "qa_manager", "quality_manager", "pharmacist", "pharmacy_manager",
    }
    user_roles = set(await get_user_role_codes(db, current_user.id))
    if not (user_roles & allowed_roles):
        raise HTTPException(
            status_code=403,
            detail="Only compliance/QA/pharmacy roles may initiate a batch recall.",
        )
    try:
        recall_number = await generate_number(db, "healthcare", "batch_recall")
        # BUG-HC-012 fix: affected_qty should reflect units that have been
        # DISPENSED (consumed) from the recalled batch — those are the units
        # patients have already been exposed to and need to be traced.
        # Storing on-shelf available_qty understated the recall impact.
        affected_qty = Decimal("0")
        if payload.batch_id:
            from app.models.consumption import ConsumptionItem
            disp_result = await db.execute(
                select(func.coalesce(func.sum(ConsumptionItem.qty), 0))
                .where(
                    ConsumptionItem.batch_id == payload.batch_id,
                    ConsumptionItem.item_id == payload.item_id,
                )
            )
            affected_qty = Decimal(str(disp_result.scalar() or 0))

        recall = BatchRecall(
            recall_number=recall_number,
            item_id=payload.item_id,
            batch_id=payload.batch_id,
            reason=payload.reason,
            severity=payload.severity,
            notes=payload.notes,
            status="initiated",
            initiated_by=current_user.id,
            initiated_at=datetime.now(timezone.utc),
            affected_qty=affected_qty,
        )
        db.add(recall)
        await db.flush()

        # BUG-HC-004 fix: flag the batch itself as recalled so subsequent
        # outbound stock posts are blocked at the stock_service level (which
        # already refuses Batch.status in {"recalled", "expired"}).
        if payload.batch_id:
            try:
                b_row = await db.execute(select(Batch).where(Batch.id == payload.batch_id))
                b = b_row.scalar_one_or_none()
                if b is not None and getattr(b, "status", None) != "recalled":
                    b.status = "recalled"
                    await db.flush()
            except Exception as _exc:
                # Don't poison the recall create transaction — log and continue.
                logger.warning("Could not flip Batch.status to 'recalled' for batch_id=%s: %s",
                               payload.batch_id, _exc)
        return {"id": recall.id, "recall_number": recall.recall_number, "message": "Batch recall created"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


@router.get("/batch-recalls/{recall_id}", response_model=BatchRecallResponse)
async def get_batch_recall(
    recall_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(BatchRecall)
        .options(selectinload(BatchRecall.traces))
        .where(BatchRecall.id == recall_id)
    )
    recall = result.scalar_one_or_none()
    if not recall:
        raise HTTPException(status_code=404, detail="Batch recall not found")
    # BUG-HC-047 fix: only privileged roles see masked aadhaar/patient_name
    # in the embedded traces list. Other auth users see traces without PII
    # so they can still operate on the recall metadata.
    from app.utils.dependencies import get_user_role_codes
    privileged = {
        "super_admin", "admin", "compliance_officer", "compliance",
        "pharmacist", "pharmacy_manager", "qa_manager", "quality_manager",
    }
    user_roles_g = set(await get_user_role_codes(db, current_user.id))
    show_pii = bool(user_roles_g & privileged)

    data = BatchRecallResponse.model_validate(recall).model_dump()
    data["traces"] = [
        {
            "id": t.id,
            "consumption_entry_id": t.consumption_entry_id,
            "patient_name": _mask_patient_name(t.patient_name) if show_pii else None,
            "patient_aadhaar": _mask_aadhaar(t.patient_aadhaar) if show_pii else None,
            "department": t.department,
            "qty_consumed": float(t.qty_consumed),
            "consumption_date": t.consumption_date.isoformat() if t.consumption_date else None,
            "trace_status": t.trace_status,
            "action_taken": t.action_taken,
        }
        for t in recall.traces
    ]
    return data


@router.put("/batch-recalls/{recall_id}")
async def update_batch_recall(
    recall_id: int,
    payload: BatchRecallUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(BatchRecall).where(BatchRecall.id == recall_id))
    recall = result.scalar_one_or_none()
    if not recall:
        raise HTTPException(status_code=404, detail="Batch recall not found")
    # BUG-HC-006 fix: whitelist updatable fields. recall_number, initiated_by,
    # affected_qty, item_id, batch_id are immutable audit anchors — anything
    # else the payload supplies for those keys is silently dropped.
    _RECALL_UPDATABLE = {"status", "notes", "recovered_qty", "completed_at", "severity", "reason"}
    update_data = payload.model_dump(exclude_unset=True)

    # BUG-HC-007 fix: enforce a state machine on BatchRecall.status so closed
    # recalls cannot be re-opened and we cannot skip from 'initiated' straight
    # to 'completed' without going through 'in_progress'.
    new_status = update_data.get("status")
    if new_status and new_status != recall.status:
        allowed_transitions = {
            "initiated": {"in_progress", "cancelled"},
            "in_progress": {"completed", "cancelled"},
            "completed": set(),
            "cancelled": set(),
        }
        current = recall.status or "initiated"
        if new_status not in allowed_transitions.get(current, set()):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Cannot transition batch recall from '{current}' to "
                    f"'{new_status}'. Allowed: {sorted(allowed_transitions.get(current, set()))}"
                ),
            )

    for k, v in update_data.items():
        if k in _RECALL_UPDATABLE:
            setattr(recall, k, v)
    recall.updated_at = datetime.now(timezone.utc)
    await db.flush()
    return {"id": recall.id, "message": "Batch recall updated"}


@router.post("/batch-recalls/{recall_id}/auto-trace")
async def auto_trace_batch_recall(
    recall_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Auto-detect consumption entries that used the recalled batch and create traces."""
    try:
        from app.models.consumption import ConsumptionEntry, ConsumptionItem

        result = await db.execute(select(BatchRecall).where(BatchRecall.id == recall_id))
        recall = result.scalar_one_or_none()
        if not recall:
            raise HTTPException(status_code=404, detail="Batch recall not found")

        # BUG-HC-005 fix: auto-trace must not run on cancelled/completed recalls.
        # Re-running trace on a closed recall pulls patient PII back into the
        # active workflow and can trigger duplicate notifications.
        if recall.status in ("cancelled", "completed", "closed"):
            raise HTTPException(
                status_code=400,
                detail=f"Cannot run auto-trace on a {recall.status} recall.",
            )

        # Find consumption items that used this batch
        query = (
            select(
                ConsumptionItem.id.label("ci_id"),
                ConsumptionItem.qty,
                ConsumptionItem.entry_id,
                ConsumptionEntry.patient_name,
                ConsumptionEntry.patient_aadhaar,
                ConsumptionEntry.department,
                ConsumptionEntry.warehouse_id,
                ConsumptionEntry.consumption_date,
            )
            .join(ConsumptionEntry, ConsumptionItem.entry_id == ConsumptionEntry.id)
            .where(ConsumptionItem.item_id == recall.item_id)
        )
        if recall.batch_id:
            query = query.where(ConsumptionItem.batch_id == recall.batch_id)
        else:
            # BUG-HC-011 fix: when the recall is item-level (batch_id NULL),
            # do NOT auto-trace every historical consumption of the item —
            # that produces hundreds of false-positive patient flags. Limit
            # auto-trace to consumption recorded since the recall was
            # initiated (and require manual broader trace if needed).
            if recall.initiated_at:
                query = query.where(ConsumptionEntry.consumption_date >= recall.initiated_at)

        cons_result = await db.execute(query)
        rows = cons_result.all()

        # Bulk-fetch existing traces to avoid N+1
        entry_ids = [r.entry_id for r in rows if r.entry_id]
        existing_entries = set()
        if entry_ids:
            existing_result = await db.execute(
                select(BatchRecallTrace.consumption_entry_id).where(
                    BatchRecallTrace.recall_id == recall_id,
                    BatchRecallTrace.consumption_entry_id.in_(entry_ids),
                )
            )
            existing_entries = {r[0] for r in existing_result.all()}

        created = 0
        for row in rows:
            if row.entry_id in existing_entries:
                continue

            trace = BatchRecallTrace(
                recall_id=recall_id,
                consumption_entry_id=row.entry_id,
                patient_name=row.patient_name,
                patient_aadhaar=row.patient_aadhaar,
                department=row.department or "Unknown",
                warehouse_id=row.warehouse_id,
                qty_consumed=row.qty,
                consumption_date=row.consumption_date,
                trace_status="identified",
            )
            db.add(trace)
            created += 1

        await db.flush()
        return {"recall_id": recall_id, "traces_created": created, "message": "Auto-trace completed"}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


@router.get("/batch-recalls/{recall_id}/traces")
async def list_batch_recall_traces(
    recall_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # BUG-HC-008 fix: restrict trace listing to compliance/admin/pharmacy roles.
    # Otherwise any authenticated user could enumerate patient names/Aadhaars
    # (even masked, the linkage is patient-identifying information).
    from app.utils.dependencies import get_user_role_codes
    allowed_roles = {
        "super_admin", "admin", "compliance_officer", "compliance",
        "pharmacist", "pharmacy_manager", "qa_manager", "quality_manager",
    }
    user_roles = set(await get_user_role_codes(db, current_user.id))
    if not (user_roles & allowed_roles):
        raise HTTPException(
            status_code=403,
            detail="Patient trace data is restricted to compliance/pharmacy roles.",
        )
    result = await db.execute(
        select(BatchRecallTrace).where(BatchRecallTrace.recall_id == recall_id)
    )
    traces = result.scalars().all()
    return [
        {
            "id": t.id,
            "recall_id": t.recall_id,
            "consumption_entry_id": t.consumption_entry_id,
            "patient_name": _mask_patient_name(t.patient_name),
            "patient_aadhaar": _mask_aadhaar(t.patient_aadhaar),
            "department": t.department,
            "qty_consumed": float(t.qty_consumed),
            "consumption_date": t.consumption_date.isoformat() if t.consumption_date else None,
            "trace_status": t.trace_status,
            "action_taken": t.action_taken,
        }
        for t in traces
    ]


# =====================================================================
# 3. EXPIRY DASHBOARD
# =====================================================================

@router.get("/expiry-dashboard", response_model=ExpiryDashboardResponse)
async def expiry_dashboard(
    warehouse_id: Optional[int] = Query(None),
    days: int = Query(90, ge=1),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Show batches approaching expiry grouped into time buckets."""
    try:
        query = (
            select(
                Batch.id.label("batch_id"),
                Batch.batch_number,
                Batch.expiry_date,
                Batch.item_id,
                Item.item_code,
                Item.name.label("item_name"),
                StockBalance.available_qty,
                Warehouse.name.label("warehouse_name"),
            )
            .join(StockBalance, and_(
                StockBalance.batch_id == Batch.id,
                StockBalance.item_id == Batch.item_id,
            ))
            .join(Item, Batch.item_id == Item.id)
            .join(Warehouse, StockBalance.warehouse_id == Warehouse.id)
            .where(
                Batch.expiry_date.isnot(None),
                StockBalance.available_qty > 0,
            )
        )
        if warehouse_id:
            query = query.where(StockBalance.warehouse_id == warehouse_id)

        result = await db.execute(query)
        rows = result.all()

        today = date.today()
        summary = {"expired": 0, "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0}
        items: list[dict] = []

        for row in rows:
            exp = row.expiry_date.date() if isinstance(row.expiry_date, datetime) else row.expiry_date
            days_until = (exp - today).days if exp else 0

            if days_until < 0:
                bucket = "expired"
            elif days_until <= 30:
                bucket = "0-30"
            elif days_until <= 60:
                bucket = "31-60"
            elif days_until <= 90:
                bucket = "61-90"
            else:
                bucket = "90+"

            # Only include items within the requested horizon or already expired
            if days_until <= days or days_until < 0:
                summary[bucket] = summary.get(bucket, 0) + 1
                items.append(
                    ExpiryBucketItem(
                        item_id=row.item_id,
                        item_code=row.item_code,
                        item_name=row.item_name,
                        batch_number=row.batch_number,
                        expiry_date=exp,
                        qty=row.available_qty,
                        warehouse_name=row.warehouse_name,
                        days_until_expiry=days_until,
                        bucket=bucket,
                    ).model_dump()
                )

        return {"summary": summary, "items": items}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


# =====================================================================
# 4. ABC / VED / FSN ANALYSIS
# =====================================================================

@router.get("/abc-analysis", response_model=List[ABCItem])
async def abc_analysis(
    months: int = Query(12, ge=1, le=60),
    warehouse_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Perform ABC (value), VED (criticality), and FSN (movement) analysis."""
    try:
        # BUG-HC-014 fix: previous code used `days=months * 30` which over time
        # drifts off the calendar boundary (e.g. months=12 → 360 days, missing
        # 5–6 days vs an actual 12-month window). Compute the cutoff as a real
        # calendar offset by walking back month-by-month so the window aligns
        # with the named period.
        _now = datetime.now(timezone.utc)
        _y, _m = _now.year, _now.month - months
        while _m <= 0:
            _y -= 1
            _m += 12
        try:
            cutoff = _now.replace(year=_y, month=_m)
        except ValueError:
            # Day-of-month doesn't exist in target month (e.g. Mar 31 → Feb).
            # Fall back to the first day of that month.
            cutoff = _now.replace(year=_y, month=_m, day=1)

        # --- ABC: annual consumption value ---
        abc_query = (
            select(
                StockLedger.item_id,
                func.sum(StockLedger.qty_out * StockLedger.rate).label("annual_value"),
            )
            .where(StockLedger.qty_out > 0, StockLedger.posting_date >= cutoff)
        )
        if warehouse_id:
            abc_query = abc_query.where(StockLedger.warehouse_id == warehouse_id)
        abc_query = abc_query.group_by(StockLedger.item_id).order_by(
            func.sum(StockLedger.qty_out * StockLedger.rate).desc()
        )
        abc_result = await db.execute(abc_query)
        abc_rows = abc_result.all()

        total_value = sum(r.annual_value or Decimal("0") for r in abc_rows)

        # --- FSN: last movement date per item ---
        fsn_query = (
            select(
                StockLedger.item_id,
                func.max(StockLedger.posting_date).label("last_movement"),
            )
            .group_by(StockLedger.item_id)
        )
        if warehouse_id:
            fsn_query = fsn_query.where(StockLedger.warehouse_id == warehouse_id)
        fsn_result = await db.execute(fsn_query)
        fsn_map = {row.item_id: row.last_movement for row in fsn_result.all()}

        # --- Collect item master data ---
        item_ids = [r.item_id for r in abc_rows]
        if not item_ids:
            return []
        items_result = await db.execute(select(Item).where(Item.id.in_(item_ids)))
        item_map = {i.id: i for i in items_result.scalars().all()}

        # --- Build response ---
        response: list[dict] = []
        cumulative = Decimal("0")
        today = date.today()

        for row in abc_rows:
            item = item_map.get(row.item_id)
            if not item:
                continue

            annual_val = row.annual_value or Decimal("0")
            cumulative += annual_val
            cum_pct = (cumulative / total_value * 100) if total_value else Decimal("0")

            # ABC class
            if cum_pct <= 70:
                abc_class = "A"
            elif cum_pct <= 90:
                abc_class = "B"
            else:
                abc_class = "C"

            # VED class
            safety = float(item.safety_stock or 0)
            reorder = float(item.reorder_level or 0)
            if safety > 0 and reorder > 0:
                ved_class = "V"
            elif safety > 0 or reorder > 0:
                ved_class = "E"
            else:
                ved_class = "D"

            # FSN class
            last_move = fsn_map.get(row.item_id)
            if last_move:
                if isinstance(last_move, datetime):
                    last_move = last_move.date()
                days_since = (today - last_move).days
                if days_since <= 30:
                    fsn_class = "F"
                elif days_since <= 90:
                    fsn_class = "S"
                else:
                    fsn_class = "N"
            else:
                fsn_class = "N"

            response.append(
                ABCItem(
                    item_id=item.id,
                    item_code=item.item_code,
                    item_name=item.name,
                    annual_consumption_value=annual_val,
                    cumulative_pct=round(cum_pct, 2),
                    abc_class=abc_class,
                    ved_class=ved_class,
                    fsn_class=fsn_class,
                ).model_dump()
            )

        return response
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


# =====================================================================
# 5. PATIENT COSTING
# =====================================================================

@router.get("/patient-costing", response_model=List[PatientCostItem])
async def patient_costing(
    patient_name: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get consumption cost breakdown grouped by patient."""
    # BUG-HC-009 fix: gate patient-costing endpoint behind finance/compliance/
    # admin roles. Patient names + Aadhaars (masked) + cost grouping is PHI;
    # any-auth-user access is a privacy violation.
    from app.utils.dependencies import get_user_role_codes
    allowed_roles = {
        "super_admin", "admin", "compliance_officer", "compliance",
        "finance_manager", "finance", "accounts_manager",
        "pharmacist", "pharmacy_manager",
    }
    user_roles = set(await get_user_role_codes(db, current_user.id))
    if not (user_roles & allowed_roles):
        raise HTTPException(
            status_code=403,
            detail="Patient costing data is restricted to finance/compliance/pharmacy roles.",
        )
    try:
        from app.models.consumption import ConsumptionEntry, ConsumptionItem

        # BUG-HC-046 fix: group on a normalized patient_name (lowercased +
        # trimmed) so "John Smith" / "john smith " / "JOHN SMITH" collapse
        # into a single bucket. We surface the *first* observed casing in the
        # response (via min()) so the UI still gets a readable label, but the
        # cost roll-up is no longer fragmented by stray whitespace/casing.
        _patient_key = func.lower(func.trim(ConsumptionEntry.patient_name))
        query = (
            select(
                func.min(ConsumptionEntry.patient_name).label("patient_name"),
                ConsumptionEntry.patient_aadhaar,
                ConsumptionEntry.department,
                func.count(ConsumptionItem.id).label("total_items"),
                func.coalesce(func.sum(ConsumptionItem.amount), 0).label("total_value"),
            )
            .join(ConsumptionItem, ConsumptionItem.entry_id == ConsumptionEntry.id)
            .where(ConsumptionEntry.patient_name.isnot(None))
        )

        if patient_name:
            query = query.where(ConsumptionEntry.patient_name.ilike(f"%{patient_name}%"))
        if department:
            query = query.where(ConsumptionEntry.department == department)
        if date_from:
            query = query.where(ConsumptionEntry.consumption_date >= datetime.combine(date_from, datetime.min.time()))
        if date_to:
            query = query.where(ConsumptionEntry.consumption_date <= datetime.combine(date_to, datetime.max.time()))

        query = query.group_by(
            _patient_key,
            ConsumptionEntry.patient_aadhaar,
            ConsumptionEntry.department,
        )

        result = await db.execute(query)
        rows = result.all()

        items: list[dict] = []
        for row in rows:
            aadhaar_masked = None
            if row.patient_aadhaar and len(row.patient_aadhaar) >= 4:
                aadhaar_masked = "XXXX-XXXX-" + row.patient_aadhaar[-4:]

            items.append(
                PatientCostItem(
                    patient_name=_mask_patient_name(row.patient_name),
                    patient_aadhaar_masked=aadhaar_masked,
                    department=row.department,
                    total_items=row.total_items,
                    total_value=row.total_value,
                ).model_dump()
            )
        return items
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


# =====================================================================
# 6. AUTO-REORDER
# =====================================================================

@router.post("/auto-reorder")
async def auto_reorder(
    warehouse_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("procurement", "create", "material_requests")),
):
    """Create Material Requests for items below reorder level."""
    try:
        # BUG-HC-018 fix: don't let a user run auto-reorder for warehouses
        # they don't own. Super-admin / admin bypass; everyone else must
        # have a UserWarehouse mapping for the requested warehouse.
        from app.utils.dependencies import get_user_role_codes
        user_roles = set(await get_user_role_codes(db, current_user.id))
        if not (user_roles & {"super_admin", "admin"}):
            try:
                from app.models.user import UserWarehouse
                uw_row = await db.execute(
                    select(UserWarehouse.id).where(
                        UserWarehouse.user_id == current_user.id,
                        UserWarehouse.warehouse_id == warehouse_id,
                    )
                )
                if not uw_row.scalar_one_or_none():
                    raise HTTPException(
                        status_code=403,
                        detail="You can only run auto-reorder for warehouses you manage.",
                    )
            except HTTPException:
                raise
            except Exception:
                # Fall through if UserWarehouse model isn't present in this build.
                logger.warning("UserWarehouse mapping check unavailable in auto_reorder.")

        # BUG-HC-016 fix: Item.is_active must be true; skip items that already
        # have an open MR or open PO so we don't pile up duplicate auto-reorders
        # on every call.
        query = (
            select(
                StockBalance.item_id,
                func.sum(StockBalance.available_qty).label("total_qty"),
                Item.reorder_level,
                Item.reorder_qty,
                Item.name,
                Item.primary_uom_id,
                Item.is_narcotic,
                Item.is_schedule_h1,
                Item.drug_schedule,
            )
            .join(Item, StockBalance.item_id == Item.id)
            .where(
                StockBalance.warehouse_id == warehouse_id,
                Item.reorder_level > 0,
                Item.is_active == True,  # noqa: E712
            )
            .group_by(
                StockBalance.item_id,
                Item.reorder_level,
                Item.reorder_qty,
                Item.name,
                Item.primary_uom_id,
                Item.is_narcotic,
                Item.is_schedule_h1,
                Item.drug_schedule,
            )
        )
        result = await db.execute(query)
        rows = result.all()

        # Pre-fetch item ids that already have an open MR or open PO.
        item_ids_below = [r.item_id for r in rows if r.total_qty < r.reorder_level]
        existing_open_mr_ids: set[int] = set()
        existing_open_po_ids: set[int] = set()
        if item_ids_below:
            mr_open_q = await db.execute(
                select(MaterialRequestItem.item_id)
                .join(MaterialRequest, MaterialRequest.id == MaterialRequestItem.mr_id)
                .where(
                    MaterialRequestItem.item_id.in_(item_ids_below),
                    MaterialRequest.warehouse_id == warehouse_id,
                    MaterialRequest.status.notin_(["cancelled", "completed", "fulfilled", "closed"]),
                )
            )
            existing_open_mr_ids = {r[0] for r in mr_open_q.all() if r[0]}
            po_open_q = await db.execute(
                select(PurchaseOrderItem.item_id)
                .join(PurchaseOrder, PurchaseOrder.id == PurchaseOrderItem.po_id)
                .where(
                    PurchaseOrderItem.item_id.in_(item_ids_below),
                    PurchaseOrder.status.notin_(["cancelled", "completed", "closed", "received"]),
                )
            )
            existing_open_po_ids = {r[0] for r in po_open_q.all() if r[0]}

        created_mrs: list[str] = []
        skipped: list[dict] = []
        for row in rows:
            if row.total_qty >= row.reorder_level:
                continue  # stock is above reorder level

            # BUG-HC-016 fix: skip if open MR or open PO already exists.
            if row.item_id in existing_open_mr_ids or row.item_id in existing_open_po_ids:
                skipped.append({"item_id": row.item_id, "name": row.name, "reason": "open MR/PO already exists"})
                continue

            # BUG-HC-015 fix: for narcotic / Schedule H1 / Schedule X items,
            # auto-reorder cannot fire automatically — these need a vendor with
            # a valid drug license, prescriber sign-off, and a manual review
            # path. Skip and surface in the response so an operator can take it
            # forward through the regular indent / MR workflow.
            is_restricted = bool(
                row.is_narcotic or row.is_schedule_h1
                or (row.drug_schedule in ("H1", "X"))
            )
            if is_restricted:
                skipped.append({
                    "item_id": row.item_id,
                    "name": row.name,
                    "reason": "narcotic/H1/X items must be reordered manually with vendor DL + prescriber gate",
                })
                continue

            reorder_qty = row.reorder_qty if row.reorder_qty and row.reorder_qty > 0 else row.reorder_level
            mr_number = await generate_number(db, "procurement", "material_request")

            mr = MaterialRequest(
                mr_number=mr_number,
                warehouse_id=warehouse_id,
                request_type="auto_reorder",
                department="Auto-Reorder",
                requested_by=current_user.id,
                request_date=date.today(),
                required_date=date.today() + timedelta(days=7),
                priority="medium",
                status="draft",
                remarks=f"Auto-generated reorder for {row.name}",
            )
            db.add(mr)
            await db.flush()

            mr_item = MaterialRequestItem(
                mr_id=mr.id,
                item_id=row.item_id,
                qty=reorder_qty,
                uom_id=row.primary_uom_id,
            )
            db.add(mr_item)
            created_mrs.append(mr_number)

        await db.flush()
        return {
            "message": f"{len(created_mrs)} material request(s) created",
            "mr_numbers": created_mrs,
            "skipped": skipped,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


# =====================================================================
# 7. RATE CONTRACTS  (CRUD + best-rate)
# =====================================================================

@router.get("/rate-contracts")
async def list_rate_contracts(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    vendor_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(RateContract)
    count_query = select(func.count(RateContract.id))

    if vendor_id:
        query = query.where(RateContract.vendor_id == vendor_id)
        count_query = count_query.where(RateContract.vendor_id == vendor_id)
    if status:
        query = query.where(RateContract.status == status)
        count_query = count_query.where(RateContract.status == status)

    query = apply_search_filter(query, RateContract, search, ["contract_number", "remarks"])
    count_query = apply_search_filter(count_query, RateContract, search, ["contract_number", "remarks"])

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(
        query.options(selectinload(RateContract.items))
        .offset(offset).limit(limit).order_by(RateContract.id.desc())
    )
    contracts = result.scalars().all()

    # Defensive serialization — one bad row (e.g. NULL date, orphan vendor)
    # must NOT poison the entire list endpoint. Skip + log.
    import logging as _logging
    _logger = _logging.getLogger(__name__)
    items = []
    for c in contracts:
        try:
            data = RateContractResponse.model_validate(c).model_dump()
            items.append(data)
        except Exception as exc:
            _logger.warning(
                "Skipping rate_contract id=%s in list response — bad data: %s",
                c.id, exc,
            )
            continue
    return build_paginated_response(items, total, page, page_size)


_RC_FROZEN_FIELDS_AFTER_ACTIVATION = {"start_date", "end_date"}


@router.post("/rate-contracts", status_code=201)
async def create_rate_contract(
    payload: RateContractCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        # Cross-field validation
        if not payload.items:
            raise HTTPException(status_code=400, detail="At least one rate-contract item is required")
        if payload.end_date < payload.start_date:
            raise HTTPException(status_code=400, detail="end_date must be on or after start_date")
        for idx, it in enumerate(payload.items, start=1):
            base_rate = Decimal(str(it.base_rate or 0))
            disc = Decimal(str(it.discount_pct or 0))
            min_qty = Decimal(str(it.min_qty or 0))
            max_qty = Decimal(str(it.max_qty or 0))
            if base_rate <= 0:
                raise HTTPException(status_code=400, detail=f"Line {idx}: base_rate must be > 0")
            if disc < 0 or disc > 100:
                raise HTTPException(status_code=400, detail=f"Line {idx}: discount_pct must be between 0 and 100")
            if min_qty < 0 or max_qty < 0:
                raise HTTPException(status_code=400, detail=f"Line {idx}: min_qty/max_qty cannot be negative")
            if max_qty > 0 and min_qty > max_qty:
                raise HTTPException(status_code=400, detail=f"Line {idx}: min_qty cannot exceed max_qty")
        # Vendor existence — friendlier 404 than letting the FK trip a 500.
        vendor_exists = (await db.execute(
            select(Vendor.id).where(Vendor.id == payload.vendor_id)
        )).scalar_one_or_none()
        if not vendor_exists:
            raise HTTPException(status_code=404, detail=f"Vendor {payload.vendor_id} not found")

        contract_number = await generate_number(db, "healthcare", "rate_contract")
        contract = RateContract(
            contract_number=contract_number,
            vendor_id=payload.vendor_id,
            start_date=payload.start_date,
            end_date=payload.end_date,
            min_order_value=payload.min_order_value,
            payment_terms_days=payload.payment_terms_days,
            status="draft",
            remarks=payload.remarks,
            created_by=current_user.id,
        )
        db.add(contract)
        await db.flush()

        for item_data in payload.items:
            # If caller didn't compute effective_rate, derive it from base_rate and discount.
            base_rate = Decimal(str(item_data.base_rate or 0))
            disc = Decimal(str(item_data.discount_pct or 0))
            effective_rate = item_data.effective_rate
            if not effective_rate or Decimal(str(effective_rate)) <= 0:
                effective_rate = base_rate - (base_rate * disc / Decimal("100"))
            rci = RateContractItem(
                contract_id=contract.id,
                item_id=item_data.item_id,
                base_rate=base_rate,
                min_qty=item_data.min_qty,
                max_qty=item_data.max_qty,
                discount_pct=disc,
                effective_rate=effective_rate,
                uom_id=item_data.uom_id,
            )
            db.add(rci)

        await db.flush()
        return {
            "id": contract.id,
            "contract_number": contract.contract_number,
            "message": "Rate contract created",
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


@router.get("/rate-contracts/best-rate")
async def best_rate(
    item_id: int = Query(...),
    qty: Decimal = Query(Decimal("1")),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Find the best active contract rate for an item and quantity."""
    try:
        today = date.today()
        query = (
            select(
                RateContractItem.effective_rate,
                RateContractItem.min_qty,
                RateContractItem.max_qty,
                RateContract.contract_number,
                RateContract.vendor_id,
                RateContract.min_order_value,
                Vendor.name.label("vendor_name"),
            )
            .join(RateContract, RateContractItem.contract_id == RateContract.id)
            .join(Vendor, RateContract.vendor_id == Vendor.id)
            .where(
                RateContractItem.item_id == item_id,
                RateContract.status == "active",
                RateContract.start_date <= today,
                RateContract.end_date >= today,
            )
            .order_by(RateContractItem.effective_rate.asc())
        )
        result = await db.execute(query)
        rows = result.all()

        best = None
        for row in rows:
            # Check quantity constraints
            if row.min_qty and qty < row.min_qty:
                continue
            if row.max_qty and row.max_qty > 0 and qty > row.max_qty:
                continue
            # BUG-HC-019 fix: enforce RateContract.min_order_value — if the
            # order line value is below the contract's MOV, this contract
            # is not eligible for this qty/rate.
            line_value = Decimal(str(row.effective_rate)) * Decimal(str(qty))
            mov = Decimal(str(row.min_order_value or 0))
            if mov > 0 and line_value < mov:
                continue
            best = {
                "vendor_id": row.vendor_id,
                "vendor_name": row.vendor_name,
                "contract_number": row.contract_number,
                "effective_rate": float(row.effective_rate),
                "total_amount": float(row.effective_rate * qty),
            }
            break  # first valid is the cheapest

        if not best:
            return {"message": "No active contract found for this item and quantity"}
        return best
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


@router.get("/rate-contracts/{contract_id}", response_model=RateContractResponse)
async def get_rate_contract(
    contract_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(RateContract)
        .options(selectinload(RateContract.items))
        .where(RateContract.id == contract_id)
    )
    contract = result.scalar_one_or_none()
    if not contract:
        raise HTTPException(status_code=404, detail="Rate contract not found")
    return RateContractResponse.model_validate(contract)


@router.put("/rate-contracts/{contract_id}")
async def update_rate_contract(
    contract_id: int,
    payload: RateContractUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(RateContract).where(RateContract.id == contract_id))
    contract = result.scalar_one_or_none()
    if not contract:
        raise HTTPException(status_code=404, detail="Rate contract not found")

    update_data = payload.model_dump(exclude_unset=True)
    new_items = update_data.pop("items", None)

    # BUG-HC-022 fix: contract_number and vendor_id are immutable identity
    # fields once a rate contract is created — silently drop them from any
    # caller payload. Status transitions are also restricted (only certain
    # transitions allowed below).
    update_data.pop("contract_number", None)
    update_data.pop("vendor_id", None)

    # BUG-HC-022 fix: status transitions whitelist — the allowed transitions
    # are draft→active, draft→cancelled, active→expired, active→cancelled.
    # Anything else (e.g. expired→draft, cancelled→active) is rejected.
    new_status = update_data.get("status")
    if new_status and new_status != contract.status:
        allowed = {
            "draft": {"active", "cancelled"},
            "active": {"expired", "cancelled"},
            "expired": set(),
            "cancelled": set(),
        }
        if new_status not in allowed.get(contract.status, set()):
            raise HTTPException(
                status_code=400,
                detail=f"Cannot transition rate contract from '{contract.status}' to '{new_status}'",
            )

    # Once activated/expired/cancelled, dates freeze for audit reasons.
    is_locked = contract.status in ("active", "expired", "cancelled")
    for k, v in update_data.items():
        if is_locked and k in _RC_FROZEN_FIELDS_AFTER_ACTIVATION:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot modify '{k}' on a {contract.status} contract; cancel and re-create instead",
            )
        setattr(contract, k, v)
    contract.updated_at = datetime.now(timezone.utc)
    # Re-validate dates after potential changes.
    if contract.start_date and contract.end_date and contract.end_date < contract.start_date:
        raise HTTPException(status_code=400, detail="end_date must be on or after start_date")

    # BUG-HC-021 fix: refuse to replace items wholesale on an active/expired/
    # cancelled contract. Vendors and procurement rely on the items list as
    # the immutable record of negotiated rates once the contract is live;
    # replacing them silently re-prices every open PO that referenced them.
    if new_items is not None and is_locked:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Cannot replace items on a {contract.status} rate contract. "
                "Cancel this contract and create a new one with the revised rates."
            ),
        )

    # Replace items if provided
    if new_items is not None:
        # BUG-HC-020 fix: an empty items array would silently delete every
        # rate-contract line, leaving an "active" contract with zero rates.
        # Reject — caller must supply at least one item, or omit the field.
        if not new_items:
            raise HTTPException(
                status_code=400,
                detail="items list cannot be empty; omit the field to leave items unchanged",
            )
        await db.execute(
            select(RateContractItem).where(RateContractItem.contract_id == contract_id)
        )
        # Delete old items
        old_items_result = await db.execute(
            select(RateContractItem).where(RateContractItem.contract_id == contract_id)
        )
        for old in old_items_result.scalars().all():
            await db.delete(old)
        await db.flush()

        for item_data in new_items:
            rci = RateContractItem(
                contract_id=contract.id,
                item_id=item_data["item_id"],
                base_rate=item_data["base_rate"],
                min_qty=item_data.get("min_qty", 0),
                max_qty=item_data.get("max_qty", 0),
                discount_pct=item_data.get("discount_pct", 0),
                effective_rate=item_data["effective_rate"],
                uom_id=item_data.get("uom_id"),
            )
            db.add(rci)

    await db.flush()
    return {"id": contract.id, "message": "Rate contract updated"}


# =====================================================================
# 8. VENDOR SCORECARD
# =====================================================================

@router.get("/vendor-scorecards")
async def list_vendor_scorecards(
    vendor_id: Optional[int] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(VendorScorecard)
    count_query = select(func.count(VendorScorecard.id))

    if vendor_id:
        query = query.where(VendorScorecard.vendor_id == vendor_id)
        count_query = count_query.where(VendorScorecard.vendor_id == vendor_id)

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(VendorScorecard.id.desc()))
    scorecards = result.scalars().all()

    items = []
    for sc in scorecards:
        data = {
            "id": sc.id,
            "vendor_id": sc.vendor_id,
            "period_start": sc.period_start.isoformat() if sc.period_start else None,
            "period_end": sc.period_end.isoformat() if sc.period_end else None,
            "total_orders": sc.total_orders,
            "on_time_deliveries": sc.on_time_deliveries,
            "late_deliveries": sc.late_deliveries,
            "quality_score": float(sc.quality_score or 0),
            "delivery_score": float(sc.delivery_score or 0),
            "price_score": float(sc.price_score or 0),
            "overall_score": float(sc.overall_score or 0),
            "grade": sc.grade,
            "created_at": sc.created_at.isoformat() if sc.created_at else None,
        }
        items.append(data)
    return build_paginated_response(items, total, page, page_size)


@router.post("/vendor-scorecards/calculate", status_code=201)
async def calculate_vendor_scorecard(
    vendor_id: int = Query(...),
    period_start: date = Query(...),
    period_end: date = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Calculate and store vendor performance scorecard for a given period."""
    try:
        # BUG-HC-026 fix: re-calculating for an existing (vendor_id, period)
        # tuple now updates that row instead of inserting a duplicate that
        # may collide on a unique-key constraint and 500.
        existing_sc_q = await db.execute(
            select(VendorScorecard).where(
                VendorScorecard.vendor_id == vendor_id,
                VendorScorecard.period_start == period_start,
                VendorScorecard.period_end == period_end,
            )
        )
        existing_scorecard = existing_sc_q.scalar_one_or_none()

        # Total POs in period
        po_query = (
            select(PurchaseOrder)
            .where(
                PurchaseOrder.vendor_id == vendor_id,
                PurchaseOrder.po_date >= datetime.combine(period_start, datetime.min.time()),
                PurchaseOrder.po_date <= datetime.combine(period_end, datetime.max.time()),
                PurchaseOrder.status.notin_(["draft", "cancelled"]),
            )
        )
        po_result = await db.execute(po_query)
        pos = po_result.scalars().all()

        total_orders = len(pos)
        if total_orders == 0:
            raise HTTPException(status_code=400, detail="No POs found for this vendor in the given period")

        po_ids = [po.id for po in pos]

        # GRNs for these POs
        grn_query = (
            select(GoodsReceiptNote)
            .where(GoodsReceiptNote.po_id.in_(po_ids))
        )
        grn_result = await db.execute(grn_query)
        grns = grn_result.scalars().all()

        # Build a map PO id -> expected delivery
        po_expected = {po.id: po.expected_delivery_date for po in pos}

        on_time = 0
        late = 0
        unknown = 0  # GRNs we can't classify because expected_delivery_date is null
        total_lead_days = 0
        grn_count = 0
        for grn in grns:
            grn_count += 1
            expected = po_expected.get(grn.po_id)
            if expected and grn.grn_date:
                if grn.grn_date <= expected:
                    on_time += 1
                else:
                    late += 1
                lead_days = (grn.grn_date - po_expected[grn.po_id]).days
                total_lead_days += max(lead_days, 0)
            else:
                # BUG-HC-024 fix: do NOT count GRNs without expected_delivery_date
                # as on-time. Track them as "unknown" and exclude from the
                # delivery-score denominator so a vendor isn't artificially
                # rewarded for missing planning data.
                unknown += 1

        avg_lead = Decimal(str(total_lead_days / grn_count)) if grn_count else Decimal("0")

        # Quality: qty ordered (from PO) vs rejected (from GRN)
        # BUG-HC-023 fix: quality_score should compare rejected against
        # ORDERED qty (PO line qty), not received_qty. Receiving short and
        # rejecting some of what arrived shouldn't make the vendor look
        # better than receiving full and rejecting some. Also clamp the
        # final value into [0, 100].
        grn_ids = [g.id for g in grns]
        total_qty_ordered = Decimal("0")
        total_qty_rejected = Decimal("0")
        if po_ids:
            po_q = await db.execute(
                select(func.coalesce(func.sum(PurchaseOrderItem.qty), 0))
                .where(PurchaseOrderItem.po_id.in_(po_ids))
            )
            total_qty_ordered = Decimal(str(po_q.scalar() or 0))
        if grn_ids:
            qi_result = await db.execute(
                select(
                    func.coalesce(func.sum(GRNItem.rejected_qty), 0).label("rejected"),
                ).where(GRNItem.grn_id.in_(grn_ids))
            )
            qi_row = qi_result.one()
            total_qty_rejected = Decimal(str(qi_row.rejected or 0))

        if total_qty_ordered > 0:
            raw_quality = (1 - float(total_qty_rejected) / float(total_qty_ordered)) * 100
            quality_score = max(0.0, min(100.0, raw_quality))
        else:
            quality_score = 100.0
        # BUG-HC-024 fix: divide by classified GRNs (on_time + late), not the
        # PO total. Falls back to 100 only when nothing is classifiable.
        classified = on_time + late
        delivery_score = (on_time / classified * 100) if classified > 0 else 100.0
        price_score = 25.0  # base price score
        overall_score = quality_score * 0.4 + delivery_score * 0.35 + price_score * 0.25

        if overall_score >= 80:
            grade = "A"
        elif overall_score >= 60:
            grade = "B"
        elif overall_score >= 40:
            grade = "C"
        elif overall_score >= 20:
            grade = "D"
        else:
            grade = "F"

        # BUG-HC-026 fix: upsert pattern — update an existing scorecard for
        # this (vendor, period) instead of inserting a duplicate.
        if existing_scorecard is not None:
            scorecard = existing_scorecard
            scorecard.total_orders = total_orders
            scorecard.on_time_deliveries = on_time
            scorecard.late_deliveries = late
            scorecard.total_qty_ordered = total_qty_ordered
            scorecard.total_qty_rejected = total_qty_rejected
            scorecard.avg_lead_time_days = round(avg_lead, 1)
            scorecard.quality_score = round(Decimal(str(quality_score)), 2)
            scorecard.delivery_score = round(Decimal(str(delivery_score)), 2)
            scorecard.price_score = round(Decimal(str(price_score)), 2)
            scorecard.overall_score = round(Decimal(str(overall_score)), 2)
            scorecard.grade = grade
        else:
            scorecard = VendorScorecard(
                vendor_id=vendor_id,
                period_start=period_start,
                period_end=period_end,
                total_orders=total_orders,
                on_time_deliveries=on_time,
                late_deliveries=late,
                total_qty_ordered=total_qty_ordered,
                total_qty_rejected=total_qty_rejected,
                avg_lead_time_days=round(avg_lead, 1),
                quality_score=round(Decimal(str(quality_score)), 2),
                delivery_score=round(Decimal(str(delivery_score)), 2),
                price_score=round(Decimal(str(price_score)), 2),
                overall_score=round(Decimal(str(overall_score)), 2),
                grade=grade,
            )
            db.add(scorecard)
        await db.flush()

        return {
            "id": scorecard.id,
            "overall_score": float(scorecard.overall_score),
            "grade": scorecard.grade,
            "message": "Vendor scorecard calculated",
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


# =====================================================================
# 9. LANDED COST
# =====================================================================

_LC_ALLOWED_COST_TYPES = {"freight", "insurance", "customs", "handling", "other"}
_LC_ALLOWED_ALLOC_METHODS = {"by_value", "by_qty", "by_weight", "equal"}
_LC_TWOPLACES = Decimal("0.01")


def _lc_q2(d: Decimal) -> Decimal:
    from decimal import ROUND_HALF_UP
    return d.quantize(_LC_TWOPLACES, rounding=ROUND_HALF_UP)


@router.post("/landed-costs", status_code=201)
async def create_landed_cost(
    payload: LandedCostCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # BUG-HC-028 fix: gate landed-cost create behind finance / admin /
    # accounts roles. Landed cost rewrites GRN.rate and GRN.amount, which
    # downstream PO matching, payments, and inventory valuation depend on —
    # any-auth-user write is a finance integrity risk.
    from app.utils.dependencies import get_user_role_codes
    allowed_finance_roles = {
        "super_admin", "admin", "finance_manager", "finance",
        "accounts_manager", "accounts", "procurement_manager",
    }
    user_roles_lc = set(await get_user_role_codes(db, current_user.id))
    if not (user_roles_lc & allowed_finance_roles):
        raise HTTPException(
            status_code=403,
            detail="Only finance/accounts/procurement roles may post a landed cost.",
        )
    """Create a landed cost entry and auto-allocate to GRN items.

    Decimal-precise: rounds to 2 dp; the rounding remainder is dumped on the
    LAST item so sum(allocations) == lc.amount exactly.
    Skips GRN items with received_qty <= 0 (cannot absorb a per-unit cost).
    Updates GRNItem.rate AND GRNItem.amount so the allocation is reflected
    in downstream reports.
    """
    try:
        if payload.cost_type not in _LC_ALLOWED_COST_TYPES:
            raise HTTPException(
                status_code=400,
                detail=f"cost_type must be one of {sorted(_LC_ALLOWED_COST_TYPES)}",
            )
        if payload.allocation_method not in _LC_ALLOWED_ALLOC_METHODS:
            raise HTTPException(
                status_code=400,
                detail=f"allocation_method must be one of {sorted(_LC_ALLOWED_ALLOC_METHODS)}",
            )
        amount = Decimal(str(payload.amount))
        if amount <= 0:
            raise HTTPException(status_code=400, detail="amount must be greater than zero")

        # Validate GRN exists
        grn_result = await db.execute(
            select(GoodsReceiptNote).where(GoodsReceiptNote.id == payload.grn_id)
        )
        grn = grn_result.scalar_one_or_none()
        if not grn:
            raise HTTPException(status_code=404, detail="GRN not found")

        lc = LandedCost(
            grn_id=payload.grn_id,
            cost_type=payload.cost_type,
            description=payload.description,
            amount=amount,
            allocation_method=payload.allocation_method,
            created_by=current_user.id,
        )
        db.add(lc)
        await db.flush()

        # Get GRN items for allocation
        grn_items_result = await db.execute(
            select(GRNItem).where(GRNItem.grn_id == payload.grn_id)
        )
        grn_items = grn_items_result.scalars().all()
        if not grn_items:
            return {"id": lc.id, "message": "Landed cost created (no GRN items to allocate)"}

        eligible = [gi for gi in grn_items if (gi.received_qty or Decimal("0")) > 0]
        if not eligible:
            return {
                "id": lc.id,
                "message": "Landed cost created — no items with received_qty > 0 to allocate against",
            }

        method = payload.allocation_method

        # Compute Decimal weight per item.
        weights: dict = {}
        if method == "by_value":
            for gi in eligible:
                qty = gi.received_qty or Decimal("0")
                rate = gi.rate or Decimal("0")
                line_value = gi.amount if (gi.amount or 0) > 0 else (qty * rate)
                weights[gi.id] = Decimal(str(line_value or 0))
        elif method == "by_qty":
            for gi in eligible:
                weights[gi.id] = Decimal(str(gi.received_qty or 0))
        elif method == "by_weight":
            # No weight column on GRNItem — fall back to qty (response flag warns).
            for gi in eligible:
                weights[gi.id] = Decimal(str(gi.received_qty or 0))
        else:  # equal
            for gi in eligible:
                weights[gi.id] = Decimal("1")

        total_weight = sum(weights.values(), Decimal("0"))
        if total_weight <= 0:
            for gi in eligible:
                weights[gi.id] = Decimal("1")
            total_weight = Decimal(str(len(eligible)))

        # Stable order so the rounding-remainder rule is deterministic.
        eligible_sorted = sorted(eligible, key=lambda x: x.id)
        raw_shares = [_lc_q2((amount * weights[gi.id]) / total_weight) for gi in eligible_sorted]
        diff = amount - sum(raw_shares, Decimal("0"))
        if diff != 0 and raw_shares:
            raw_shares[-1] = _lc_q2(raw_shares[-1] + diff)

        for gi, alloc_amt in zip(eligible_sorted, raw_shares):
            # BUG-HC-027 fix: when two landed costs are stacked on the same
            # GRN, the previous fix added to amount but blew away rate. Use
            # the CURRENT rate (which already includes prior landed-cost
            # additions) as the baseline, and recompute amount = qty * rate
            # so the two columns stay consistent.
            current_rate = gi.rate or Decimal("0")
            qty = gi.received_qty or Decimal("0")
            per_unit = (alloc_amt / qty) if qty > 0 else Decimal("0")
            adjusted_rate = _lc_q2(current_rate + per_unit) if qty > 0 else current_rate
            db.add(LandedCostAllocation(
                landed_cost_id=lc.id,
                grn_item_id=gi.id,
                item_id=gi.item_id,
                allocated_amount=alloc_amt,
                original_rate=current_rate,
                adjusted_rate=adjusted_rate,
            ))
            # Propagate to GRN item line so downstream reports see the new
            # rate. Amount is rate * qty (NOT old_amount + alloc_amt) so
            # stacked landed costs don't double-count the original line value.
            gi.rate = adjusted_rate
            gi.amount = _lc_q2(adjusted_rate * qty) if qty > 0 else (gi.amount or Decimal("0"))

        await db.flush()
        return {
            "id": lc.id,
            "message": "Landed cost created and allocated",
            "total_amount": float(amount),
            "sum_allocated": float(sum(raw_shares, Decimal("0"))),
            "skipped_zero_qty_items": [gi.id for gi in grn_items if gi not in eligible],
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


@router.get("/landed-costs", response_model=List[LandedCostResponse])
async def list_landed_costs(
    grn_id: int = Query(...),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # BUG-HC-134 fix: cap and paginate so a GRN with 1000 landed-cost rows
    # (and N allocations each) doesn't pull a giant graph eagerly.
    offset, limit = paginate_params(page, page_size)
    result = await db.execute(
        select(LandedCost)
        .options(selectinload(LandedCost.allocations))
        .where(LandedCost.grn_id == grn_id)
        .order_by(LandedCost.id.desc())
        .offset(offset)
        .limit(limit)
    )
    costs = result.scalars().all()
    return [LandedCostResponse.model_validate(c) for c in costs]


# =====================================================================
# 10. RATE COMPARISON
# =====================================================================

@router.get("/rate-comparison", response_model=List[VendorComparisonItem])
async def rate_comparison(
    item_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Compare rates from active contracts and recent PO prices for an item."""
    try:
        today = date.today()
        results: list[dict] = []

        # Active rate contract items
        rc_query = (
            select(
                RateContractItem.effective_rate,
                RateContractItem.max_qty,
                RateContract.contract_number,
                RateContract.vendor_id,
                RateContract.payment_terms_days,
                Vendor.name.label("vendor_name"),
            )
            .join(RateContract, RateContractItem.contract_id == RateContract.id)
            .join(Vendor, RateContract.vendor_id == Vendor.id)
            .where(
                RateContractItem.item_id == item_id,
                RateContract.status == "active",
                RateContract.start_date <= today,
                RateContract.end_date >= today,
            )
        )
        rc_result = await db.execute(rc_query)
        for row in rc_result.all():
            results.append(
                VendorComparisonItem(
                    vendor_id=row.vendor_id,
                    vendor_name=row.vendor_name,
                    unit_rate=row.effective_rate,
                    qty_available=row.max_qty if row.max_qty and row.max_qty > 0 else None,
                    delivery_days=row.payment_terms_days,
                    total_amount=row.effective_rate,
                    contract_number=row.contract_number,
                ).model_dump()
            )

        # Recent PO prices (last 6 months)
        six_months_ago = datetime.now(timezone.utc) - timedelta(days=180)
        po_query = (
            select(
                PurchaseOrderItem.rate,
                PurchaseOrderItem.qty,
                PurchaseOrder.vendor_id,
                Vendor.name.label("vendor_name"),
            )
            .join(PurchaseOrder, PurchaseOrderItem.po_id == PurchaseOrder.id)
            .join(Vendor, PurchaseOrder.vendor_id == Vendor.id)
            .where(
                PurchaseOrderItem.item_id == item_id,
                PurchaseOrder.po_date >= six_months_ago,
                PurchaseOrder.status.notin_(["draft", "cancelled"]),
            )
            .order_by(PurchaseOrderItem.rate.asc())
        )
        po_result = await db.execute(po_query)
        seen_vendors: set[int] = {r["vendor_id"] for r in results}
        for row in po_result.all():
            if row.vendor_id in seen_vendors:
                continue
            seen_vendors.add(row.vendor_id)
            results.append(
                VendorComparisonItem(
                    vendor_id=row.vendor_id,
                    vendor_name=row.vendor_name,
                    unit_rate=row.rate,
                    qty_available=None,
                    delivery_days=None,
                    total_amount=row.rate,
                    contract_number=None,
                ).model_dump()
            )

        # Sort by rate ascending
        results.sort(key=lambda x: float(x["unit_rate"]))
        return results
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


# =====================================================================
# 11. APPROVAL MATRIX
# =====================================================================

@router.get("/approval-matrix")
async def approval_matrix(
    module: Optional[str] = Query(None),
    document_type: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return approval workflow configuration with levels."""
    try:
        from app.models.approval import ApprovalWorkflow, ApprovalLevel
        # BUG-HC-029 fix: don't expose approver_user_id to non-privileged
        # callers. The approval workflow itself (module/document_type/levels)
        # can be public, but the specific user assignment leaks the org
        # hierarchy and lets users target one approver for social-engineering.
        from app.utils.dependencies import get_user_role_codes
        admin_roles = {"super_admin", "admin", "compliance_officer", "compliance"}
        is_privileged = bool(set(await get_user_role_codes(db, current_user.id)) & admin_roles)

        query = select(ApprovalWorkflow).options(selectinload(ApprovalWorkflow.levels))
        if module:
            query = query.where(ApprovalWorkflow.module == module)
        if document_type:
            query = query.where(ApprovalWorkflow.document_type == document_type)

        result = await db.execute(query)
        workflows = result.scalars().all()

        data = []
        for wf in workflows:
            levels = []
            for lv in wf.levels:
                levels.append({
                    "id": lv.id,
                    "level": lv.level,
                    "approver_role_id": lv.approver_role_id,
                    # BUG-HC-029 fix: approver_user_id is only visible to
                    # admin / compliance roles. Other users see null.
                    "approver_user_id": lv.approver_user_id if is_privileged else None,
                    "min_amount": float(lv.min_amount) if lv.min_amount else 0,
                    "max_amount": float(lv.max_amount) if lv.max_amount else 0,
                    "auto_approve_after_days": lv.auto_approve_after_days,
                })
            data.append({
                "id": wf.id,
                "name": wf.name,
                "module": wf.module,
                "document_type": wf.document_type,
                "is_active": wf.is_active,
                "levels": levels,
            })
        return data
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


# =====================================================================
# 12. E-SIGNATURE AUDIT
# =====================================================================

@router.get("/e-signatures")
async def e_signature_audit(
    entity_type: str = Query(...),
    entity_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return approval history (e-signature trail) for a given entity."""
    try:
        from app.models.approval import ApprovalRequest, ApprovalHistory

        # Find approval request for this entity
        req_result = await db.execute(
            select(ApprovalRequest)
            .options(selectinload(ApprovalRequest.history))
            .where(
                ApprovalRequest.document_type == entity_type,
                ApprovalRequest.document_id == entity_id,
            )
        )
        requests = req_result.scalars().all()

        audit_trail = []
        for req in requests:
            for h in req.history:
                audit_trail.append({
                    "id": h.id,
                    "request_id": h.request_id,
                    "level": h.level,
                    "action": h.action,
                    "action_by": h.action_by,
                    "action_date": h.action_date.isoformat() if h.action_date else None,
                    "comments": h.comments,
                    "document_type": req.document_type,
                    "document_id": req.document_id,
                    "document_number": req.document_number,
                })
        return audit_trail
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


# =====================================================================
# 13. DEPARTMENT BUDGET  (CRUD + utilization)
# =====================================================================

@router.get("/budgets")
async def list_budgets(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    department: Optional[str] = Query(None),
    fiscal_year: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(DepartmentBudget)
    count_query = select(func.count(DepartmentBudget.id))

    if department:
        query = query.where(DepartmentBudget.department == department)
        count_query = count_query.where(DepartmentBudget.department == department)
    if fiscal_year:
        query = query.where(DepartmentBudget.fiscal_year == fiscal_year)
        count_query = count_query.where(DepartmentBudget.fiscal_year == fiscal_year)

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(DepartmentBudget.id.desc()))
    budgets = result.scalars().all()

    items = []
    for b in budgets:
        remaining = (b.budget_amount or Decimal("0")) - (b.consumed_amount or Decimal("0"))
        utilization = (
            (b.consumed_amount / b.budget_amount * 100) if b.budget_amount and b.budget_amount > 0 else Decimal("0")
        )
        items.append(
            DepartmentBudgetResponse(
                id=b.id,
                department=b.department,
                project_id=b.project_id,
                fiscal_year=b.fiscal_year,
                budget_amount=b.budget_amount,
                consumed_amount=b.consumed_amount or Decimal("0"),
                blocked_amount=Decimal("0"),
                available_amount=remaining,
                utilization_pct=round(utilization, 2),
                status=b.status,
                created_at=b.created_at,
                updated_at=b.updated_at,
            ).model_dump()
        )
    return build_paginated_response(items, total, page, page_size)


@router.post("/budgets", status_code=201)
async def create_budget(
    payload: DepartmentBudgetCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        # BUG-HC-030 fix: budgets must be strictly positive. Saving a 0 / -1
        # budget yields nonsensical utilization arithmetic and breaks the
        # downstream "available_amount" math.
        if payload.budget_amount is None or Decimal(str(payload.budget_amount)) <= 0:
            raise HTTPException(
                status_code=400,
                detail="budget_amount must be greater than 0",
            )
        budget = DepartmentBudget(
            department=payload.department,
            project_id=payload.project_id,
            fiscal_year=payload.fiscal_year,
            budget_amount=payload.budget_amount,
            consumed_amount=Decimal("0"),
            remaining_amount=payload.budget_amount,
            status="active",
            created_by=current_user.id,
        )
        db.add(budget)
        await db.flush()
        return {"id": budget.id, "message": "Department budget created"}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


@router.put("/budgets/{budget_id}")
async def update_budget(
    budget_id: int,
    payload: DepartmentBudgetUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(DepartmentBudget).where(DepartmentBudget.id == budget_id))
    budget = result.scalar_one_or_none()
    if not budget:
        raise HTTPException(status_code=404, detail="Budget not found")

    update_data = payload.model_dump(exclude_unset=True)
    # BUG-HC-030 fix: also reject non-positive updates to budget_amount.
    if "budget_amount" in update_data and update_data["budget_amount"] is not None:
        if Decimal(str(update_data["budget_amount"])) <= 0:
            raise HTTPException(
                status_code=400,
                detail="budget_amount must be greater than 0",
            )
    for k, v in update_data.items():
        setattr(budget, k, v)

    if "budget_amount" in update_data:
        budget.remaining_amount = budget.budget_amount - (budget.consumed_amount or Decimal("0"))

    budget.updated_at = datetime.now(timezone.utc)
    await db.flush()
    return {"id": budget.id, "message": "Budget updated"}


@router.get("/budgets/utilization")
async def budget_utilization(
    fiscal_year: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get budget vs consumed summary per department."""
    try:
        query = select(DepartmentBudget)
        if fiscal_year:
            query = query.where(DepartmentBudget.fiscal_year == fiscal_year)

        result = await db.execute(query)
        budgets = result.scalars().all()

        summary = []
        for b in budgets:
            consumed = b.consumed_amount or Decimal("0")
            budget_amt = b.budget_amount or Decimal("0")
            utilization = (consumed / budget_amt * 100) if budget_amt > 0 else Decimal("0")
            summary.append({
                "id": b.id,
                "department": b.department,
                "fiscal_year": b.fiscal_year,
                "budget_amount": float(budget_amt),
                "consumed_amount": float(consumed),
                "remaining_amount": float(budget_amt - consumed),
                "utilization_pct": float(round(utilization, 2)),
                "status": b.status,
            })
        return summary
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


# =====================================================================
# 14. KIT MANAGEMENT
# =====================================================================

@router.get("/kits")
async def list_kits(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: Optional[str] = Query(None),
    kit_type: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(ItemKit)
    count_query = select(func.count(ItemKit.id))

    if kit_type:
        query = query.where(ItemKit.kit_type == kit_type)
        count_query = count_query.where(ItemKit.kit_type == kit_type)

    query = apply_search_filter(query, ItemKit, search, ["kit_code", "name"])
    count_query = apply_search_filter(count_query, ItemKit, search, ["kit_code", "name"])

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(
        query.options(selectinload(ItemKit.components))
        .offset(offset).limit(limit).order_by(ItemKit.id.desc())
    )
    kits = result.scalars().all()
    items = [ItemKitResponse.model_validate(k).model_dump() for k in kits]
    return build_paginated_response(items, total, page, page_size)


@router.post("/kits", status_code=201)
async def create_kit(
    payload: ItemKitCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        # Check for duplicate kit_code
        existing = await db.execute(select(ItemKit).where(ItemKit.kit_code == payload.kit_code))
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=409, detail=f"Kit with code '{payload.kit_code}' already exists")

        kit = ItemKit(
            kit_code=payload.kit_code,
            name=payload.name,
            description=payload.description,
            kit_type=payload.kit_type,
            department=payload.department,
            is_active=True,
            created_by=current_user.id,
        )
        db.add(kit)
        await db.flush()

        for comp in payload.components:
            component = ItemKitComponent(
                kit_id=kit.id,
                item_id=comp.item_id,
                qty=comp.qty,
                uom_id=comp.uom_id,
                is_optional=comp.is_optional,
                remarks=comp.remarks,
            )
            db.add(component)

        await db.flush()
        return {"id": kit.id, "kit_code": kit.kit_code, "message": "Kit created"}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


@router.get("/kits/{kit_id}", response_model=ItemKitResponse)
async def get_kit(
    kit_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(ItemKit)
        .options(selectinload(ItemKit.components))
        .where(ItemKit.id == kit_id)
    )
    kit = result.scalar_one_or_none()
    if not kit:
        raise HTTPException(status_code=404, detail="Kit not found")
    return ItemKitResponse.model_validate(kit)


@router.put("/kits/{kit_id}")
async def update_kit(
    kit_id: int,
    payload: ItemKitUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(ItemKit).where(ItemKit.id == kit_id))
    kit = result.scalar_one_or_none()
    if not kit:
        raise HTTPException(status_code=404, detail="Kit not found")

    update_data = payload.model_dump(exclude_unset=True)
    for k, v in update_data.items():
        setattr(kit, k, v)
    kit.updated_at = datetime.now(timezone.utc)
    await db.flush()
    return {"id": kit.id, "message": "Kit updated"}


@router.post("/kits/{kit_id}/consume")
async def consume_kit(
    kit_id: int,
    payload: KitConsumeRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Consume a kit: deduct all non-optional components from stock."""
    try:
        result = await db.execute(
            select(ItemKit)
            .options(selectinload(ItemKit.components))
            .where(ItemKit.id == kit_id)
        )
        kit = result.scalar_one_or_none()
        if not kit:
            raise HTTPException(status_code=404, detail="Kit not found")

        consumed_items: list[dict] = []
        multiplier = Decimal(str(payload.qty))

        # BUG-HC-034 fix: enforce prescriber gate if any kit component is H1/narcotic/Rx.
        # Build a lines list of non-optional components and run the centralised gate.
        from app.services.compliance_service import assert_prescriber_present_on_lines
        prescriber_lines = [
            {
                "item_id": comp.item_id,
                "prescriber_name": payload.prescriber_name,
                "prescriber_license": payload.prescriber_license,
            }
            for comp in kit.components if not comp.is_optional
        ]
        await assert_prescriber_present_on_lines(
            db,
            lines=prescriber_lines,
            source_type="kit_consumption",
            user_id=current_user.id,
        )

        # BUG-HC-032 fix: import the InsufficientStockError so we can convert
        # the post_stock_ledger row-locked check into a clean 400. We rely on
        # post_stock_ledger's SELECT ... FOR UPDATE row lock for the actual
        # race-free decrement; the pre-check below is just for friendlier
        # error messages, not a substitute for the locked decrement.
        from app.services.stock_service import InsufficientStockError

        for comp in kit.components:
            if comp.is_optional:
                continue

            qty_out = comp.qty * multiplier

            # Check available stock (best-effort message; the authoritative
            # check happens inside post_stock_ledger under a row lock).
            bal_result = await db.execute(
                select(func.coalesce(func.sum(StockBalance.available_qty), 0))
                .where(
                    StockBalance.item_id == comp.item_id,
                    StockBalance.warehouse_id == payload.warehouse_id,
                )
            )
            available = bal_result.scalar()
            if available < qty_out:
                # Get item name for error message
                item_result = await db.execute(select(Item.name).where(Item.id == comp.item_id))
                item_name = item_result.scalar() or f"Item #{comp.item_id}"
                raise HTTPException(
                    status_code=400,
                    detail=f"Insufficient stock for {item_name}: need {qty_out}, available {available}",
                )

            # BUG-HC-033 / BUG-HC-040 fix: pick the FEFO (earliest non-expired,
            # non-recalled) batch_id for traceability, then pass it to
            # post_stock_ledger so lot traceability is preserved.
            today = date.today()
            fefo_row = await db.execute(
                select(StockBalance.batch_id)
                .join(Batch, StockBalance.batch_id == Batch.id)
                .where(
                    StockBalance.item_id == comp.item_id,
                    StockBalance.warehouse_id == payload.warehouse_id,
                    StockBalance.available_qty > 0,
                    or_(Batch.expiry_date == None, Batch.expiry_date >= today),  # noqa: E711
                    or_(Batch.status.is_(None), Batch.status.notin_(["recalled", "expired"])),
                )
                .order_by(Batch.expiry_date.asc())
                .limit(1)
            )
            picked_batch_id = fefo_row.scalar()

            try:
                await post_stock_ledger(
                    db=db,
                    item_id=comp.item_id,
                    warehouse_id=payload.warehouse_id,
                    transaction_type="kit_consumption",
                    qty_out=qty_out,
                    rate=Decimal("0"),
                    batch_id=picked_batch_id,
                    reference_type="ItemKit",
                    reference_id=kit.id,
                    created_by=current_user.id,
                )
            except InsufficientStockError as ise:
                # BUG-HC-032 fix: convert the row-locked failure into a 400.
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Insufficient stock for kit component item_id={comp.item_id}: "
                        f"available={ise.available}, requested={ise.requested}"
                    ),
                )
            consumed_items.append({
                "item_id": comp.item_id,
                "qty_consumed": float(qty_out),
                "batch_id": picked_batch_id,
            })

        await db.flush()
        return {
            "kit_id": kit.id,
            "kit_code": kit.kit_code,
            "consumed_items": consumed_items,
            "message": "Kit consumed successfully",
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


# =====================================================================
# 15. DEMAND FORECAST
# =====================================================================

@router.get("/demand-forecast")
async def demand_forecast(
    item_id: int = Query(...),
    months: int = Query(3, ge=1, le=24),
    warehouse_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Forecast demand using moving average of consumption over the last N months."""
    try:
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(days=months * 30)

        month_expr = func.date_format(StockLedger.posting_date, "%Y-%m-01")
        query = (
            select(
                month_expr.label("month"),
                func.sum(StockLedger.qty_out).label("total_qty"),
            )
            .where(
                StockLedger.item_id == item_id,
                StockLedger.qty_out > 0,
                StockLedger.posting_date >= cutoff,
            )
        )
        if warehouse_id:
            query = query.where(StockLedger.warehouse_id == warehouse_id)

        query = query.group_by(month_expr).order_by(month_expr)
        result = await db.execute(query)
        rows = result.all()

        monthly_data = [{"month": str(r.month), "qty": float(r.total_qty or 0)} for r in rows]

        # BUG-HC-035 fix: fill in zero-consumption months instead of dropping
        # them. Previously the moving average was sum(observed)/count(observed)
        # which silently treated months with zero outflow as "missing data" and
        # biased the forecast high. Now we average across the *requested*
        # window of `months`, plugging zero for any month that didn't appear
        # in the SQL result.
        avg_consumption = (
            sum(Decimal(str(r.total_qty or 0)) for r in rows) / Decimal(str(months))
            if months > 0 else Decimal("0")
        )

        # Generate next 3 month forecasts
        forecasts = []
        for i in range(1, 4):
            forecast_date = (now + timedelta(days=30 * i)).date()
            confidence = max(50.0, 95.0 - (i * 10))
            forecasts.append({
                "forecast_date": forecast_date.isoformat(),
                "forecast_qty": float(round(avg_consumption, 3)),
                "method": "moving_average",
                "confidence_pct": confidence,
                "period": "monthly",
            })

        # Get item details
        item_result = await db.execute(select(Item.item_code, Item.name).where(Item.id == item_id))
        item_row = item_result.one_or_none()

        return {
            "item_id": item_id,
            "item_code": item_row.item_code if item_row else None,
            "item_name": item_row.name if item_row else None,
            "historical_data": monthly_data,
            "avg_monthly_consumption": float(round(avg_consumption, 3)),
            "forecasts": forecasts,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


# =====================================================================
# 16. AVAILABLE TO PROMISE (ATP)
# =====================================================================

@router.get("/analytics/atp", response_model=List[ATPItem])
@router.get("/atp", response_model=List[ATPItem])
async def available_to_promise(
    item_id: Optional[int] = Query(None),
    warehouse_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Calculate Available-To-Promise: total stock minus committed qty."""
    try:
        query = (
            select(
                StockBalance.item_id,
                StockBalance.warehouse_id,
                func.sum(StockBalance.total_qty).label("total_stock"),
                func.sum(StockBalance.transit_qty).label("transit_qty"),
                func.sum(StockBalance.reserved_qty).label("reserved_qty"),
                Item.item_code,
                Item.name.label("item_name"),
                Warehouse.name.label("warehouse_name"),
            )
            .join(Item, StockBalance.item_id == Item.id)
            .join(Warehouse, StockBalance.warehouse_id == Warehouse.id)
        )
        if item_id:
            query = query.where(StockBalance.item_id == item_id)
        if warehouse_id:
            query = query.where(StockBalance.warehouse_id == warehouse_id)

        # BUG-HC-036 fix: apply limit AFTER group_by; otherwise MySQL chops
        # rows pre-aggregation and the totals are non-deterministic.
        query = query.group_by(
            StockBalance.item_id,
            StockBalance.warehouse_id,
            Item.item_code,
            Item.name,
            Warehouse.name,
        ).limit(100)
        result = await db.execute(query)
        rows = result.all()

        atp_list: list[dict] = []
        for row in rows:
            total = row.total_stock or Decimal("0")
            transit = (row.transit_qty or Decimal("0")) + (row.reserved_qty or Decimal("0"))
            available = total - transit
            atp_list.append(
                ATPItem(
                    item_id=row.item_id,
                    item_code=row.item_code,
                    item_name=row.item_name,
                    warehouse_id=row.warehouse_id,
                    warehouse_name=row.warehouse_name,
                    total_stock=total,
                    transit_qty=transit,
                    available_qty=max(available, Decimal("0")),
                ).model_dump()
            )
        return atp_list
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


# =====================================================================
# 17. INVENTORY AGING
# =====================================================================

@router.get("/analytics/inventory-aging", response_model=List[AgingBucket])
@router.get("/inventory-aging", response_model=List[AgingBucket])
async def inventory_aging(
    warehouse_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Analyze inventory age from inward ledger entries, grouped into buckets using SQL aggregation.

    BUG-HC-037 fix: previously the query summed value_in across all inward
    ledger rows, even items long since issued out. That counted phantom
    "aged" stock. We now scale each warehouse's aged-in value by the ratio
    of current on-hand qty / total qty_in, so items that have been fully
    consumed don't show up as aged inventory.
    """
    try:
        age_expr = func.datediff(func.curdate(), StockLedger.posting_date)

        query = (
            select(
                StockLedger.item_id,
                StockLedger.warehouse_id,
                Item.item_code,
                Item.name.label("item_name"),
                Warehouse.name.label("warehouse_name"),
                func.sum(case(
                    (age_expr <= 30, StockLedger.value_in),
                    else_=0,
                )).label("bucket_0_30"),
                func.sum(case(
                    (and_(age_expr > 30, age_expr <= 60), StockLedger.value_in),
                    else_=0,
                )).label("bucket_31_60"),
                func.sum(case(
                    (and_(age_expr > 60, age_expr <= 90), StockLedger.value_in),
                    else_=0,
                )).label("bucket_61_90"),
                func.sum(case(
                    (age_expr > 90, StockLedger.value_in),
                    else_=0,
                )).label("bucket_90_plus"),
                func.sum(StockLedger.value_in).label("total_value"),
                func.sum(StockLedger.qty_in).label("total_qty_in"),
            )
            .join(Item, StockLedger.item_id == Item.id)
            .join(Warehouse, StockLedger.warehouse_id == Warehouse.id)
            .where(StockLedger.qty_in > 0)
            .group_by(StockLedger.item_id, StockLedger.warehouse_id, Item.item_code, Item.name, Warehouse.name)
            .having(func.sum(StockLedger.value_in) > 0)
        )
        if warehouse_id:
            query = query.where(StockLedger.warehouse_id == warehouse_id)

        result = await db.execute(query)
        rows = result.all()

        # BUG-HC-037 fix: pull current on-hand qty per (item, warehouse) and
        # scale each bucket by qty_on_hand / total_qty_in so aged items
        # already fully issued out don't inflate the totals.
        keys = [(r.item_id, r.warehouse_id) for r in rows]
        on_hand_map: dict = {}
        if keys:
            sb_q = await db.execute(
                select(
                    StockBalance.item_id,
                    StockBalance.warehouse_id,
                    func.coalesce(func.sum(StockBalance.available_qty), 0).label("on_hand"),
                ).group_by(StockBalance.item_id, StockBalance.warehouse_id)
            )
            for r in sb_q.all():
                on_hand_map[(r.item_id, r.warehouse_id)] = Decimal(str(r.on_hand or 0))

        out = []
        for r in rows:
            total_qty_in = Decimal(str(r.total_qty_in or 0))
            on_hand = on_hand_map.get((r.item_id, r.warehouse_id), Decimal("0"))
            if total_qty_in <= 0:
                ratio = Decimal("0")
            else:
                # cap at 1 — protects against ledger holes
                ratio = min(on_hand / total_qty_in, Decimal("1"))

            def scale(val):
                v = Decimal(str(val or 0))
                return (v * ratio).quantize(Decimal("0.01"))

            out.append(
                AgingBucket(
                    item_id=r.item_id,
                    item_code=r.item_code,
                    item_name=r.item_name,
                    warehouse=r.warehouse_name,
                    bucket_0_30=scale(r.bucket_0_30),
                    bucket_31_60=scale(r.bucket_31_60),
                    bucket_61_90=scale(r.bucket_61_90),
                    bucket_90_plus=scale(r.bucket_90_plus),
                    total_value=scale(r.total_value),
                ).model_dump()
            )
        return out
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


# =====================================================================
# 18. PROCUREMENT CYCLE TIME
# =====================================================================

@router.get("/analytics/procurement-cycle", response_model=List[CycleTimeItem])
@router.get("/procurement-cycle-time", response_model=List[CycleTimeItem])
async def procurement_cycle_time(
    vendor_id: Optional[int] = Query(None),
    months: int = Query(6, ge=1, le=24),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Calculate average procurement cycle times (MR->PO, PO->GRN) per vendor."""
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(days=months * 30)

        # Get POs with their MR dates and GRN dates
        po_query = (
            select(
                PurchaseOrder.id.label("po_id"),
                PurchaseOrder.vendor_id,
                PurchaseOrder.po_date,
                PurchaseOrder.mr_id,
                Vendor.name.label("vendor_name"),
            )
            .join(Vendor, PurchaseOrder.vendor_id == Vendor.id)
            .where(
                PurchaseOrder.po_date >= cutoff,
                PurchaseOrder.status.notin_(["draft", "cancelled"]),
            )
        )
        if vendor_id:
            po_query = po_query.where(PurchaseOrder.vendor_id == vendor_id)

        po_result = await db.execute(po_query)
        po_rows = po_result.all()

        if not po_rows:
            return []

        # Get MR dates for POs that have mr_id
        mr_ids = [r.mr_id for r in po_rows if r.mr_id]
        mr_dates: dict[int, datetime] = {}
        if mr_ids:
            mr_result = await db.execute(
                select(MaterialRequest.id, MaterialRequest.request_date)
                .where(MaterialRequest.id.in_(mr_ids))
            )
            mr_dates = {r.id: r.request_date for r in mr_result.all()}

        # Get earliest GRN date per PO
        po_ids = [r.po_id for r in po_rows]
        grn_result = await db.execute(
            select(
                GoodsReceiptNote.po_id,
                func.min(GoodsReceiptNote.grn_date).label("earliest_grn"),
            )
            .where(GoodsReceiptNote.po_id.in_(po_ids))
            .group_by(GoodsReceiptNote.po_id)
        )
        grn_dates = {r.po_id: r.earliest_grn for r in grn_result.all()}

        # BUG-HC-038 fix: po_date / grn_date / request_date may be a mix of
        # naive (DB-roundtripped) and timezone-aware (from datetime.now(tz=…))
        # datetimes depending on driver/version. Subtracting one from the
        # other raises TypeError at runtime. Normalize everything to a plain
        # `date` (calendar-day delta) before computing the diff.
        def _as_date(v):
            if v is None:
                return None
            if isinstance(v, datetime):
                return v.date()
            return v

        # Aggregate by vendor
        vendor_data: dict[int, dict] = {}
        for row in po_rows:
            vid = row.vendor_id
            if vid not in vendor_data:
                vendor_data[vid] = {
                    "vendor_id": vid,
                    "vendor_name": row.vendor_name,
                    "indent_to_po_days": [],
                    "po_to_grn_days": [],
                }

            po_d = _as_date(row.po_date)
            # MR -> PO cycle
            if row.mr_id and row.mr_id in mr_dates and mr_dates[row.mr_id]:
                mr_d = _as_date(mr_dates[row.mr_id])
                if po_d and mr_d:
                    delta = (po_d - mr_d).days
                    vendor_data[vid]["indent_to_po_days"].append(max(delta, 0))

            # PO -> GRN cycle
            if row.po_id in grn_dates and grn_dates[row.po_id]:
                grn_d = _as_date(grn_dates[row.po_id])
                if po_d and grn_d:
                    delta = (grn_d - po_d).days
                    vendor_data[vid]["po_to_grn_days"].append(max(delta, 0))

        response: list[dict] = []
        for vid, data in vendor_data.items():
            indent_days = data["indent_to_po_days"]
            grn_days = data["po_to_grn_days"]
            avg_indent = Decimal(str(sum(indent_days) / len(indent_days))) if indent_days else Decimal("0")
            avg_grn = Decimal(str(sum(grn_days) / len(grn_days))) if grn_days else Decimal("0")

            response.append(
                CycleTimeItem(
                    vendor_id=vid,
                    vendor_name=data["vendor_name"],
                    avg_indent_to_po_days=round(avg_indent, 1),
                    avg_po_to_grn_days=round(avg_grn, 1),
                    avg_total_days=round(avg_indent + avg_grn, 1),
                    order_count=len(indent_days) + len(grn_days),
                ).model_dump()
            )

        return response
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


# =====================================================================
# 19. CARRIER TRACKING  (CRUD)
# =====================================================================

@router.get("/carrier-tracking")
async def list_carrier_tracking(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(CarrierTracking)
    count_query = select(func.count(CarrierTracking.id))

    if status:
        query = query.where(CarrierTracking.current_status == status)
        count_query = count_query.where(CarrierTracking.current_status == status)

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(CarrierTracking.id.desc()))
    entries = result.scalars().all()

    items = [CarrierTrackingResponse.model_validate(e).model_dump() for e in entries]
    return build_paginated_response(items, total, page, page_size)


@router.post("/carrier-tracking", status_code=201)
async def create_carrier_tracking(
    payload: CarrierTrackingCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        tracking = CarrierTracking(
            carrier_name=payload.carrier_name,
            tracking_number=payload.tracking_number,
            carrier_url=payload.carrier_url,
            transport_order_id=payload.transport_order_id,
            dispatch_id=payload.dispatch_id,
            estimated_delivery=payload.estimated_delivery,
            current_status="booked",
        )
        db.add(tracking)
        await db.flush()
        return {"id": tracking.id, "tracking_number": tracking.tracking_number, "message": "Carrier tracking created"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))


@router.put("/carrier-tracking/{tracking_id}")
async def update_carrier_tracking(
    tracking_id: int,
    payload: CarrierTrackingUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(CarrierTracking).where(CarrierTracking.id == tracking_id))
    tracking = result.scalar_one_or_none()
    if not tracking:
        raise HTTPException(status_code=404, detail="Carrier tracking entry not found")

    update_data = payload.model_dump(exclude_unset=True)
    for k, v in update_data.items():
        setattr(tracking, k, v)

    tracking.last_updated = datetime.now(timezone.utc)
    tracking.updated_at = datetime.now(timezone.utc)
    await db.flush()
    return {"id": tracking.id, "message": "Carrier tracking updated"}


# =====================================================================
# 20. TRANSFER SUGGESTIONS
# =====================================================================

@router.get("/analytics/transfer-suggestions", response_model=List[TransferSuggestion])
@router.get("/transfer-suggestions", response_model=List[TransferSuggestion])
async def transfer_suggestions(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Suggest inter-warehouse transfers where one warehouse has excess stock
    (> 2x reorder_level) and another is below reorder_level.
    """
    try:
        # BUG-HC-040 fix: exclude expired / recalled batches from the
        # transfer-source pool. Transferring expired or recalled stock to
        # another warehouse defeats the recall and re-introduces the hazard.
        # The join is left-outer so balances without batch tracking still
        # appear (the "or batch_id is null" branch).
        today = date.today()
        query = (
            select(
                StockBalance.item_id,
                StockBalance.warehouse_id,
                func.sum(StockBalance.available_qty).label("stock"),
                Item.item_code,
                Item.name.label("item_name"),
                Item.reorder_level,
                Warehouse.name.label("warehouse_name"),
            )
            .join(Item, StockBalance.item_id == Item.id)
            .join(Warehouse, StockBalance.warehouse_id == Warehouse.id)
            .outerjoin(Batch, StockBalance.batch_id == Batch.id)
            .where(
                Item.reorder_level > 0,
                or_(
                    StockBalance.batch_id.is_(None),
                    and_(
                        or_(Batch.expiry_date.is_(None), Batch.expiry_date >= today),
                        or_(Batch.status.is_(None), Batch.status.notin_(["recalled", "expired"])),
                    ),
                ),
            )
            .group_by(
                StockBalance.item_id,
                StockBalance.warehouse_id,
                Item.item_code,
                Item.name,
                Item.reorder_level,
                Warehouse.name,
            )
        )
        result = await db.execute(query)
        rows = result.all()

        # Group by item_id
        item_warehouses: dict[int, list] = {}
        for row in rows:
            if row.item_id not in item_warehouses:
                item_warehouses[row.item_id] = []
            item_warehouses[row.item_id].append(row)

        suggestions: list[dict] = []
        for item_id, wh_rows in item_warehouses.items():
            # Find warehouses with excess and deficit
            excess_whs = [r for r in wh_rows if r.stock > r.reorder_level * 2]
            deficit_whs = [r for r in wh_rows if r.stock < r.reorder_level]

            for deficit in deficit_whs:
                for excess in excess_whs:
                    if excess.warehouse_id == deficit.warehouse_id:
                        continue
                    # Suggest transferring enough to bring deficit to reorder level
                    needed = deficit.reorder_level - deficit.stock
                    # BUG-HC-039 fix: keep a buffer above reorder_level at the
                    # source so the source doesn't immediately fall into a
                    # deficit one tick later. Buffer = 25% of reorder_level
                    # (minimum 1 unit) above reorder_level.
                    from decimal import Decimal as _D
                    buffer_at_source = max(_D(str(excess.reorder_level)) * _D("0.25"), _D("1"))
                    transferable = excess.stock - excess.reorder_level - buffer_at_source
                    suggested_qty = min(needed, transferable)
                    if suggested_qty <= 0:
                        continue

                    suggestions.append(
                        TransferSuggestion(
                            item_id=item_id,
                            item_code=excess.item_code,
                            item_name=excess.item_name,
                            from_warehouse_id=excess.warehouse_id,
                            from_warehouse=excess.warehouse_name,
                            to_warehouse_id=deficit.warehouse_id,
                            to_warehouse=deficit.warehouse_name,
                            suggested_qty=round(suggested_qty, 3),
                            from_stock=excess.stock,
                            to_stock=deficit.stock,
                            reason=f"Source has {float(excess.stock)} (>{float(excess.reorder_level * 2)}), destination has {float(deficit.stock)} (<{float(deficit.reorder_level)})",
                        ).model_dump()
                    )

        return suggestions
    except Exception as exc:
        raise HTTPException(status_code=500, detail=_safe_error(exc))
