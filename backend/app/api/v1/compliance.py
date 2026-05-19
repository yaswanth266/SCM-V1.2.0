"""Wave 7 — Compliance API endpoints.

Public surface:
  GET  /compliance/dashboard
  GET  /compliance/vendors-by-license-status
  POST /compliance/vendors/refresh-status        (admin)
  GET  /compliance/prescription-records
  GET  /compliance/cold-chain/breaches
  POST /compliance/cold-chain/log
  GET  /compliance/audits
  GET  /compliance/items/restricted
"""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User
from app.models.master import Vendor, Item
from app.models.warehouse import Batch
from app.models.compliance import (
    PrescriptionRecord, ColdChainLog, ESignature, ComplianceAudit,
)
from app.utils.dependencies import get_current_user, require_any_role
from app.utils.helpers import paginate_params, build_paginated_response


router = APIRouter()


# ─────────────────────────────────────────────────────────────────────
# Dashboard
# ─────────────────────────────────────────────────────────────────────

@router.get("/dashboard")
async def compliance_dashboard(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """High-level compliance KPIs for the org.

    BUG-HC-136 fix: previously this endpoint issued ten sequential
    `await db.execute(...)` count queries — every request paid the round-trip
    cost ten times in serial. We now build all the count subqueries up front
    and execute them in a single CTE-style aggregate query so the dashboard
    returns in ~one round-trip per logical group instead of ten serial trips.
    """
    today = date.today()
    in_30 = today + timedelta(days=30)
    in_90 = today + timedelta(days=90)
    yesterday = datetime.now(timezone.utc) - timedelta(days=1)
    month_start = today.replace(day=1)
    week_ago = datetime.now(timezone.utc) - timedelta(days=7)

    # Combine all counts into a single SELECT using subquery scalars so MySQL
    # handles them in one query plan. Each line below is a scalar subquery.
    from sqlalchemy import literal

    counts_q = select(
        select(func.count(Vendor.id)).scalar_subquery().label("total_v"),
        select(func.count(Vendor.id)).where(
            Vendor.drug_license_expiry.isnot(None),
            Vendor.drug_license_expiry < today,
        ).scalar_subquery().label("expired_v"),
        select(func.count(Vendor.id)).where(
            Vendor.drug_license_expiry.isnot(None),
            Vendor.drug_license_expiry >= today,
            Vendor.drug_license_expiry <= in_30,
        ).scalar_subquery().label("expiring_v"),
        select(func.count(Vendor.id)).where(
            or_(Vendor.drug_license_number.is_(None), Vendor.drug_license_number == "")
        ).scalar_subquery().label("no_license_v"),
        select(func.count(Item.id)).where(
            or_(Item.is_schedule_h1 == True, Item.drug_schedule.in_(["H1", "X"])),  # noqa: E712
            Item.is_active == True,
        ).scalar_subquery().label("h1_items"),
        select(func.count(Item.id)).where(
            Item.requires_cold_chain == True, Item.is_active == True,  # noqa: E712
        ).scalar_subquery().label("cold_items"),
        select(func.count(ColdChainLog.id)).where(
            ColdChainLog.is_breach == True,  # noqa: E712
            ColdChainLog.reading_at >= yesterday,
        ).scalar_subquery().label("cc_breaches_24h"),
        select(func.count(PrescriptionRecord.id)).where(
            PrescriptionRecord.dispensed_at >= datetime.combine(month_start, datetime.min.time()),
        ).scalar_subquery().label("h1_disp_month"),
        select(func.count(ComplianceAudit.id)).where(
            ComplianceAudit.severity.in_(["error", "critical"]),
            ComplianceAudit.created_at >= week_ago,
        ).scalar_subquery().label("crit_audits"),
        select(func.count(Batch.id)).where(
            Batch.expiry_date.isnot(None),
            Batch.expiry_date >= today,
            Batch.expiry_date <= in_90,
        ).scalar_subquery().label("near_exp_batches"),
        select(func.count(Batch.id)).where(
            Batch.expiry_date.isnot(None),
            Batch.expiry_date < today,
        ).scalar_subquery().label("expired_batches"),
    )
    row = (await db.execute(counts_q)).first()
    total_v = (row.total_v if row else 0) or 0
    expired_v = (row.expired_v if row else 0) or 0
    expiring_v = (row.expiring_v if row else 0) or 0
    no_license_v = (row.no_license_v if row else 0) or 0
    h1_items = (row.h1_items if row else 0) or 0
    cold_items = (row.cold_items if row else 0) or 0
    cc_breaches_24h = (row.cc_breaches_24h if row else 0) or 0
    h1_disp_month = (row.h1_disp_month if row else 0) or 0
    crit_audits = (row.crit_audits if row else 0) or 0
    near_exp_batches = (row.near_exp_batches if row else 0) or 0
    expired_batches = (row.expired_batches if row else 0) or 0

    return {
        "as_of": today.isoformat(),
        "vendors": {
            "total": total_v,
            "expired_dl": expired_v,
            "expiring_dl_30d": expiring_v,
            "no_dl": no_license_v,
        },
        "items": {
            "h1_or_narcotic": h1_items,
            "cold_chain": cold_items,
        },
        "events_recent": {
            "cold_chain_breaches_24h": cc_breaches_24h,
            "h1_dispenses_this_month": h1_disp_month,
            "critical_audits_7d": crit_audits,
        },
        "batches": {
            "expired": expired_batches,
            "near_expiry_90d": near_exp_batches,
        },
    }


# ─────────────────────────────────────────────────────────────────────
# Vendors by license status
# ─────────────────────────────────────────────────────────────────────

@router.get("/vendors-by-license-status")
async def vendors_by_license_status(
    status: Optional[str] = Query(None, description="expired | expiring_soon | compliant | no_license"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    today = date.today()
    in_30 = today + timedelta(days=30)
    q = select(Vendor)
    if status == "expired":
        q = q.where(Vendor.drug_license_expiry.isnot(None), Vendor.drug_license_expiry < today)
    elif status == "expiring_soon":
        q = q.where(
            Vendor.drug_license_expiry.isnot(None),
            Vendor.drug_license_expiry >= today,
            Vendor.drug_license_expiry <= in_30,
        )
    elif status == "compliant":
        q = q.where(
            Vendor.drug_license_expiry.isnot(None),
            Vendor.drug_license_expiry > in_30,
        )
    elif status == "no_license":
        q = q.where(or_(Vendor.drug_license_number.is_(None), Vendor.drug_license_number == ""))
    rows = (await db.execute(q.order_by(Vendor.drug_license_expiry.asc().nullslast()))).scalars().all()
    out = []
    for v in rows:
        days_left = None
        if v.drug_license_expiry:
            days_left = (v.drug_license_expiry - today).days
        out.append({
            "id": v.id, "vendor_code": v.vendor_code, "name": v.name,
            "drug_license_number": v.drug_license_number,
            "drug_license_state": v.drug_license_state,
            "drug_license_expiry": v.drug_license_expiry.isoformat() if v.drug_license_expiry else None,
            "vendor_compliance_status": v.vendor_compliance_status,
            "days_left": days_left,
            "is_active": v.is_active,
        })
    return out


@router.post("/vendors/refresh-status")
async def refresh_vendor_status(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "compliance_officer")),
):
    # BUG-HC-056 fix: pass the actor user id so the bulk recompute is
    # attributable in the compliance audit log.
    from app.services.compliance_service import refresh_all_vendor_compliance
    return await refresh_all_vendor_compliance(db, actor_user_id=current_user.id)


# ─────────────────────────────────────────────────────────────────────
# Prescription records (H1/narcotic dispense audit)
# ─────────────────────────────────────────────────────────────────────

@router.get("/prescription-records")
async def list_prescription_records(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    drug_schedule: Optional[str] = Query(None),
    item_id: Optional[int] = Query(None),
    from_date: Optional[str] = Query(None),
    to_date: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    q = (
        select(
            PrescriptionRecord,
            Item.item_code.label("item_code"),
            Item.name.label("item_name"),
        )
        .join(Item, Item.id == PrescriptionRecord.item_id)
    )
    cq = select(func.count(PrescriptionRecord.id))
    if drug_schedule:
        q = q.where(PrescriptionRecord.drug_schedule == drug_schedule)
        cq = cq.where(PrescriptionRecord.drug_schedule == drug_schedule)
    if item_id:
        q = q.where(PrescriptionRecord.item_id == item_id)
        cq = cq.where(PrescriptionRecord.item_id == item_id)
    if from_date:
        try:
            f = date.fromisoformat(from_date)
            q = q.where(PrescriptionRecord.dispensed_at >= datetime.combine(f, datetime.min.time()))
            cq = cq.where(PrescriptionRecord.dispensed_at >= datetime.combine(f, datetime.min.time()))
        except Exception:
            pass
    if to_date:
        try:
            t = date.fromisoformat(to_date)
            q = q.where(PrescriptionRecord.dispensed_at <= datetime.combine(t, datetime.max.time()))
            cq = cq.where(PrescriptionRecord.dispensed_at <= datetime.combine(t, datetime.max.time()))
        except Exception:
            pass

    total = (await db.execute(cq)).scalar() or 0
    result = await db.execute(q.offset(offset).limit(limit).order_by(PrescriptionRecord.dispensed_at.desc()))
    rows = []
    for r in result.all():
        pr = r[0]
        rows.append({
            "id": pr.id,
            "source_type": pr.source_type,
            "source_id": pr.source_id,
            "item_id": pr.item_id,
            "item_code": r.item_code,
            "item_name": r.item_name,
            "batch_id": pr.batch_id,
            "qty_dispensed": float(pr.qty_dispensed or 0),
            "drug_schedule": pr.drug_schedule,
            "prescriber_name": pr.prescriber_name,
            "prescriber_license": pr.prescriber_license,
            "patient_name": pr.patient_name,
            "patient_id": pr.patient_id,
            "dispensed_by": pr.dispensed_by,
            "dispensed_at": pr.dispensed_at.isoformat() if pr.dispensed_at else None,
            "retention_until": pr.retention_until.isoformat() if pr.retention_until else None,
        })
    return build_paginated_response(rows, total, page, page_size)


# ─────────────────────────────────────────────────────────────────────
# Cold chain
# ─────────────────────────────────────────────────────────────────────

@router.post("/cold-chain/log", status_code=201)
async def log_cold_chain_reading(
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Log a temperature reading for a batch.

    Body: { batch_id, temperature_c, humidity_pct?, warehouse_id?, notes? }
    Auto-evaluates breach severity against the item's min/max storage temp.
    """
    from app.services.compliance_service import evaluate_cold_chain_breach, log_audit
    batch_id = payload.get("batch_id")
    temp_c = payload.get("temperature_c")
    if batch_id is None or temp_c is None:
        raise HTTPException(status_code=400, detail="batch_id and temperature_c are required")
    try:
        temp_dec = Decimal(str(temp_c))
    except Exception:
        raise HTTPException(status_code=400, detail="temperature_c must be numeric")

    # BUG-HC-057 fix: validate the batch exists and that the user has rights
    # in the warehouse where the batch lives. Otherwise any auth user can
    # inject false readings against any batch in the system.
    batch_row = await db.execute(select(Batch).where(Batch.id == batch_id))
    batch = batch_row.scalar_one_or_none()
    if not batch:
        raise HTTPException(status_code=404, detail=f"Batch {batch_id} not found")

    from app.utils.dependencies import get_user_role_codes
    user_roles_cc = set(await get_user_role_codes(db, current_user.id))
    privileged_cc = {
        "super_admin", "admin", "compliance_officer", "compliance",
        "qa_manager", "quality_manager",
    }
    if not (user_roles_cc & privileged_cc):
        # Non-privileged users must have a UserWarehouse mapping to the
        # batch's warehouse (or to the explicitly-passed warehouse_id).
        target_wh = payload.get("warehouse_id")
        if target_wh is None:
            # Fall back to the batch's stock_balance warehouse, if any.
            from app.models.stock import StockBalance as _SB
            wh_row = await db.execute(
                select(_SB.warehouse_id).where(_SB.batch_id == batch_id).limit(1)
            )
            target_wh = wh_row.scalar()
        try:
            from app.models.user import UserWarehouse
            uw_row = await db.execute(
                select(UserWarehouse.id).where(
                    UserWarehouse.user_id == current_user.id,
                    UserWarehouse.warehouse_id == target_wh,
                )
            )
            if not target_wh or not uw_row.scalar_one_or_none():
                raise HTTPException(
                    status_code=403,
                    detail="You can only log cold-chain readings for warehouses you manage.",
                )
        except HTTPException:
            raise
        except Exception:
            # If UserWarehouse isn't available, fall through (best-effort gate).
            pass

    is_breach, severity = await evaluate_cold_chain_breach(db, batch_id=batch_id, temperature_c=temp_dec)
    log = ColdChainLog(
        batch_id=batch_id,
        warehouse_id=payload.get("warehouse_id"),
        temperature_c=temp_dec,
        humidity_pct=Decimal(str(payload["humidity_pct"])) if payload.get("humidity_pct") is not None else None,
        is_breach=is_breach,
        breach_severity=severity if is_breach else None,
        recorded_by=current_user.id,
        notes=payload.get("notes"),
    )
    db.add(log)
    await db.flush()

    if is_breach:
        await log_audit(
            db,
            event_type="cold_chain_breach",
            severity=severity if severity == "critical" else "error" if severity == "major" else "warning",
            batch_id=batch_id,
            user_id=current_user.id,
            payload={"temperature_c": float(temp_dec), "severity": severity},
        )

    return {
        "id": log.id,
        "is_breach": is_breach,
        "severity": severity,
    }


@router.get("/cold-chain/breaches")
async def list_cold_chain_breaches(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    severity: Optional[str] = Query(None),
    days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    offset, limit = paginate_params(page, page_size)
    q = (
        select(
            ColdChainLog,
            Batch.batch_number.label("batch_number"),
            Item.item_code.label("item_code"),
            Item.name.label("item_name"),
        )
        .outerjoin(Batch, Batch.id == ColdChainLog.batch_id)
        .outerjoin(Item, Item.id == Batch.item_id)
        .where(ColdChainLog.is_breach == True, ColdChainLog.reading_at >= cutoff)  # noqa: E712
    )
    cq = select(func.count(ColdChainLog.id)).where(
        ColdChainLog.is_breach == True, ColdChainLog.reading_at >= cutoff,  # noqa: E712
    )
    if severity:
        q = q.where(ColdChainLog.breach_severity == severity)
        cq = cq.where(ColdChainLog.breach_severity == severity)

    total = (await db.execute(cq)).scalar() or 0
    res = await db.execute(q.offset(offset).limit(limit).order_by(ColdChainLog.reading_at.desc()))
    rows = []
    for r in res.all():
        log = r[0]
        rows.append({
            "id": log.id,
            "batch_id": log.batch_id,
            "batch_number": r.batch_number,
            "item_code": r.item_code,
            "item_name": r.item_name,
            "warehouse_id": log.warehouse_id,
            "reading_at": log.reading_at.isoformat() if log.reading_at else None,
            "temperature_c": float(log.temperature_c or 0),
            "humidity_pct": float(log.humidity_pct) if log.humidity_pct is not None else None,
            "severity": log.breach_severity,
            "notes": log.notes,
        })
    return build_paginated_response(rows, total, page, page_size)


# ─────────────────────────────────────────────────────────────────────
# Audits
# ─────────────────────────────────────────────────────────────────────

@router.get("/audits")
async def list_audits(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    severity: Optional[str] = Query(None),
    event_type: Optional[str] = Query(None),
    days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    offset, limit = paginate_params(page, page_size)
    q = select(ComplianceAudit).where(ComplianceAudit.created_at >= cutoff)
    cq = select(func.count(ComplianceAudit.id)).where(ComplianceAudit.created_at >= cutoff)
    if severity:
        q = q.where(ComplianceAudit.severity == severity)
        cq = cq.where(ComplianceAudit.severity == severity)
    if event_type:
        q = q.where(ComplianceAudit.event_type == event_type)
        cq = cq.where(ComplianceAudit.event_type == event_type)

    total = (await db.execute(cq)).scalar() or 0
    res = await db.execute(q.offset(offset).limit(limit).order_by(ComplianceAudit.created_at.desc()))
    rows = []
    for a in res.scalars().all():
        rows.append({
            "id": a.id,
            "event_type": a.event_type,
            "severity": a.severity,
            "vendor_id": a.vendor_id,
            "item_id": a.item_id,
            "batch_id": a.batch_id,
            "source_type": a.source_type,
            "source_id": a.source_id,
            "user_id": a.user_id,
            "payload": a.payload,
            "created_at": a.created_at.isoformat() if a.created_at else None,
        })
    return build_paginated_response(rows, total, page, page_size)


# ─────────────────────────────────────────────────────────────────────
# Restricted items (for UI helpers)
# ─────────────────────────────────────────────────────────────────────

@router.get("/items/restricted")
async def list_restricted_items(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return items that need prescriber capture or cold-chain — UI uses this
    to highlight rows in pickers.
    """
    res = await db.execute(
        select(Item).where(
            Item.is_active == True,  # noqa: E712
            or_(
                Item.is_schedule_h1 == True,
                Item.is_narcotic == True,
                Item.requires_prescription == True,
                Item.requires_cold_chain == True,
                Item.drug_schedule.in_(["H1", "X"]),
            ),
        )
    )
    items = res.scalars().all()
    return [
        {
            "id": i.id, "item_code": i.item_code, "name": i.name,
            "drug_schedule": i.drug_schedule,
            "is_schedule_h1": i.is_schedule_h1,
            "is_narcotic": i.is_narcotic,
            "requires_prescription": i.requires_prescription,
            "requires_cold_chain": i.requires_cold_chain,
            "min_storage_temp_c": float(i.min_storage_temp_c) if i.min_storage_temp_c is not None else None,
            "max_storage_temp_c": float(i.max_storage_temp_c) if i.max_storage_temp_c is not None else None,
        }
        for i in items
    ]
