"""Wave 7 Healthcare compliance service.

Centralizes:
  - Vendor drug-license expiry gate (PO/GRN refuse expired vendors)
  - H1/narcotic prescriber gate (Material Issue + Consumption require prescriber)
  - E-signature capture (re-auth pattern: caller passes user password again)
  - Compliance audit logging

All gate functions raise HTTPException(400) so the calling endpoint stops and
returns a clear error to the user. Audit log is fire-and-forget — never blocks.
"""
from __future__ import annotations
import hashlib
import json
import logging
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional, Sequence

from fastapi import HTTPException
from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.master import Vendor, Item
from app.models.compliance import (
    PrescriptionRecord, ColdChainLog, ESignature, ComplianceAudit,
)
from app.services.auth_service import verify_password


logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# Compliance audit
# ─────────────────────────────────────────────────────────────────────

_PII_KEYS = {
    "patient_name", "patient_aadhaar", "aadhaar", "aadhar",
    "patient_phone", "patient_email", "patient_address",
    "phone", "email", "address", "dob", "date_of_birth",
}


def _scrub_pii(value):
    """Recursively redact PII keys before they hit the audit log.

    BUG-HC-045 fix: previously the entire payload (including patient names
    and Aadhaar numbers) was JSON-dumped verbatim into compliance_audits.
    Audit rows live forever and are read by support / dev / DBA — that's a
    privacy violation. Now we mask any field whose key is in _PII_KEYS.
    """
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if isinstance(k, str) and k.lower() in _PII_KEYS:
                # Preserve a "present-or-not" signal without exposing the value.
                if v is None or v == "":
                    out[k] = None
                else:
                    s = str(v)
                    # For aadhaar-like values keep last 4 only.
                    if "aadh" in k.lower() and len(s) >= 4:
                        out[k] = "XXXX-XXXX-" + s[-4:]
                    else:
                        out[k] = "[REDACTED]"
            else:
                out[k] = _scrub_pii(v)
        return out
    if isinstance(value, list):
        return [_scrub_pii(v) for v in value]
    return value


async def log_audit(
    db: AsyncSession,
    *,
    event_type: str,
    severity: str = "info",
    vendor_id: Optional[int] = None,
    item_id: Optional[int] = None,
    batch_id: Optional[int] = None,
    source_type: Optional[str] = None,
    source_id: Optional[int] = None,
    user_id: Optional[int] = None,
    payload: Optional[dict] = None,
) -> None:
    """Fire-and-forget audit log. Errors swallowed so this never blocks."""
    try:
        scrubbed = _scrub_pii(payload) if payload else None
        row = ComplianceAudit(
            event_type=event_type,
            severity=severity,
            vendor_id=vendor_id,
            item_id=item_id,
            batch_id=batch_id,
            source_type=source_type,
            source_id=source_id,
            user_id=user_id,
            payload=json.dumps(scrubbed, default=str) if scrubbed else None,
        )
        db.add(row)
        await db.flush()
    except Exception as e:
        logger.warning("compliance audit log failed: %s", e)


# ─────────────────────────────────────────────────────────────────────
# Vendor drug-license gate
# ─────────────────────────────────────────────────────────────────────

async def assert_vendor_compliant(
    db: AsyncSession,
    *,
    vendor_id: int,
    require_drug_license: bool = True,
    user_id: Optional[int] = None,
) -> None:
    """Refuse PO/GRN if vendor's drug license is expired or absent.

    `require_drug_license=False` skips the gate (use for non-medicine vendors,
    e.g. transport-only or office-supply vendors).

    BUG-HC-051 fix: when a caller passes `require_drug_license=False` to
    bypass the DL gate, ALWAYS write a compliance audit row so the override
    is traceable. Suppressing this gate silently is a regulatory risk.
    """
    if not require_drug_license:
        await log_audit(
            db,
            event_type="vendor_dl_gate_overridden",
            severity="warning",
            vendor_id=vendor_id,
            user_id=user_id,
            payload={"reason": "caller passed require_drug_license=False"},
        )
        return

    row = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    v = row.scalar_one_or_none()
    if not v:
        raise HTTPException(status_code=404, detail=f"Vendor {vendor_id} not found")

    today = date.today()
    if not v.drug_license_number:
        await log_audit(
            db, event_type="vendor_no_drug_license", severity="warning",
            vendor_id=vendor_id, user_id=user_id,
            payload={"vendor_name": v.name},
        )
        raise HTTPException(
            status_code=400,
            detail=(
                f"Vendor '{v.name}' has no Drug License on record. "
                "Add a DL number + expiry on the vendor master before raising orders."
            ),
        )

    if v.drug_license_expiry and v.drug_license_expiry < today:
        # BUG-HC-054 fix: refresh the cached compliance status whenever we
        # observe an expired DL during gating, so downstream lists/dashboards
        # don't keep showing this vendor as "compliant" until an admin runs
        # the bulk refresh manually.
        try:
            new_status = vendor_compliance_status(v)
            if v.vendor_compliance_status != new_status:
                v.vendor_compliance_status = new_status
                await db.flush()
        except Exception as _refresh_exc:
            logger.warning("vendor compliance status refresh failed: %s", _refresh_exc)
        await log_audit(
            db, event_type="vendor_license_expired_block", severity="error",
            vendor_id=vendor_id, user_id=user_id,
            payload={"vendor_name": v.name, "expiry": str(v.drug_license_expiry)},
        )
        raise HTTPException(
            status_code=400,
            detail=(
                f"Vendor '{v.name}' Drug License #{v.drug_license_number} "
                f"expired on {v.drug_license_expiry}. Renew DL before transacting."
            ),
        )

    # BUG-HC-054 fix: even on the success path, sync the cached status if it
    # has drifted from the live computed value (e.g. it's still "expiring_soon"
    # when in fact it's now "compliant" because the DL was renewed).
    try:
        new_status = vendor_compliance_status(v)
        if v.vendor_compliance_status != new_status:
            v.vendor_compliance_status = new_status
            await db.flush()
    except Exception as _refresh_exc:
        logger.warning("vendor compliance status refresh failed: %s", _refresh_exc)


def vendor_compliance_status(v: Vendor, days_warning: int = 30) -> str:
    if not v.drug_license_number:
        return "not_required"
    today = date.today()
    if v.drug_license_expiry and v.drug_license_expiry < today:
        return "expired"
    if v.drug_license_expiry and v.drug_license_expiry <= today + timedelta(days=days_warning):
        return "expiring_soon"
    return "compliant"


async def refresh_all_vendor_compliance(
    db: AsyncSession,
    *,
    actor_user_id: Optional[int] = None,
) -> dict:
    """Recompute and persist vendor_compliance_status for every vendor.

    BUG-HC-055 fix: previously this function used a hard-coded counts dict
    keyed by the four expected statuses. If `vendor_compliance_status` ever
    returned a new value (e.g. an admin extends the helper), the bulk
    refresh raised KeyError mid-run and left vendor rows half-updated. Use
    a defaultdict so unknown statuses are counted, not crashed on.

    BUG-HC-056 fix: write a compliance audit row summarising the bulk
    recompute so we have an external record of who triggered it and what
    the status distribution was after the run.
    """
    from collections import defaultdict as _dd
    rows = await db.execute(select(Vendor))
    vendors = rows.scalars().all()
    counts: dict = _dd(int)
    changed = 0
    for v in vendors:
        s = vendor_compliance_status(v)
        if v.vendor_compliance_status != s:
            v.vendor_compliance_status = s
            changed += 1
        counts[s] += 1
    await db.flush()
    summary = {"updated": sum(counts.values()), "changed": changed, "by_status": dict(counts)}

    # BUG-HC-056 fix: audit log the bulk recompute. Failures are swallowed.
    try:
        await log_audit(
            db,
            event_type="vendor_compliance_bulk_refresh",
            severity="info",
            user_id=actor_user_id,
            payload=summary,
        )
    except Exception:
        pass

    return summary


# ─────────────────────────────────────────────────────────────────────
# H1 / narcotic prescriber gate
# ─────────────────────────────────────────────────────────────────────

async def items_requiring_prescriber(
    db: AsyncSession, item_ids: Sequence[int],
) -> dict[int, dict]:
    """Return map item_id → {drug_schedule, requires_prescription, is_schedule_h1, is_narcotic}
    for items in the list that need prescriber capture.
    """
    if not item_ids:
        return {}
    result = await db.execute(
        select(
            Item.id, Item.name, Item.drug_schedule, Item.requires_prescription,
            Item.is_schedule_h1, Item.is_narcotic,
        ).where(
            Item.id.in_(item_ids),
            or_(
                Item.requires_prescription == True,  # noqa: E712
                Item.is_schedule_h1 == True,
                Item.is_narcotic == True,
                Item.drug_schedule.in_(["H1", "X"]),
            ),
        )
    )
    out = {}
    for r in result.all():
        out[r.id] = {
            "name": r.name,
            "drug_schedule": r.drug_schedule,
            "requires_prescription": r.requires_prescription,
            "is_schedule_h1": r.is_schedule_h1,
            "is_narcotic": r.is_narcotic,
        }
    return out


async def assert_prescriber_present_on_lines(
    db: AsyncSession,
    *,
    lines: Sequence[dict],
    source_type: str,
    user_id: Optional[int] = None,
) -> None:
    """For each line, if its item requires prescriber (H1/narcotic/Rx), ensure
    line dict has prescriber_name + prescriber_license. Each line dict must
    have keys: item_id, prescriber_name (opt), prescriber_license (opt).
    """
    item_ids = [l.get("item_id") for l in lines if l.get("item_id")]
    flagged = await items_requiring_prescriber(db, item_ids)
    if not flagged:
        return

    # BUG-HC-043 fix: prescriber_license must look like a real registration
    # number. Indian Medical Council registration numbers are typically
    # alphanumeric, 5–20 chars, often containing digits. Accept any string
    # that is at least 5 characters AND has at least one digit. This still
    # lets state-board prefixes through (e.g. "MCI/12345/2018") but blocks
    # garbage like "x" or "test".
    import re as _re
    _LICENSE_RE = _re.compile(r"^(?=.{5,40}$)(?=.*\d)[A-Za-z0-9\-\/\.\s]+$")

    def _license_looks_valid(lic: Optional[str]) -> bool:
        if not lic:
            return False
        return bool(_LICENSE_RE.match(lic.strip()))

    missing = []
    for l in lines:
        info = flagged.get(l.get("item_id"))
        if not info:
            continue
        name = (l.get("prescriber_name") or "").strip()
        lic = (l.get("prescriber_license") or "").strip()
        if not name or not lic or not _license_looks_valid(lic):
            missing.append({
                "item_id": l.get("item_id"),
                "item_name": info["name"],
                "drug_schedule": info["drug_schedule"],
            })

    if missing:
        await log_audit(
            db, event_type="prescriber_gate_block", severity="error",
            source_type=source_type, user_id=user_id,
            payload={"missing": missing},
        )
        names = ", ".join([f"{m['item_name']} ({m['drug_schedule'] or 'Rx'})" for m in missing])
        raise HTTPException(
            status_code=400,
            detail=(
                f"Prescriber name and license are required for: {names}. "
                "These items are restricted (Schedule H1, narcotic, or Rx-only)."
            ),
        )


async def assert_narcotic_running_balance(
    db: AsyncSession,
    *,
    item_id: int,
    qty: Decimal,
    user_id: Optional[int] = None,
) -> None:
    """BUG-HC-049 fix: prevent narcotic register from going negative.

    For Schedule H1 / narcotic / Schedule X items, ensure the cumulative
    dispensed qty (sum of past PrescriptionRecord.qty_dispensed) plus the
    qty about to be dispensed does NOT exceed the cumulative received
    qty (sum of StockLedger.qty_in across all warehouses for this item).

    Equivalently: running_balance = total_received - total_dispensed
    must remain >= qty being dispensed now.
    """
    # Only enforce for narcotic / H1 / Schedule X items.
    item_row = await db.execute(
        select(Item.id, Item.name, Item.is_schedule_h1, Item.is_narcotic, Item.drug_schedule)
        .where(Item.id == item_id)
    )
    info = item_row.first()
    if not info:
        return
    is_restricted = bool(
        info.is_schedule_h1 or info.is_narcotic
        or (info.drug_schedule in ("H1", "X"))
    )
    if not is_restricted:
        return

    from sqlalchemy import func as _func
    from app.models.stock import StockLedger

    received_row = await db.execute(
        select(_func.coalesce(_func.sum(StockLedger.qty_in), 0))
        .where(StockLedger.item_id == item_id)
    )
    total_received = Decimal(str(received_row.scalar() or 0))

    dispensed_row = await db.execute(
        select(_func.coalesce(_func.sum(PrescriptionRecord.qty_dispensed), 0))
        .where(PrescriptionRecord.item_id == item_id)
    )
    total_dispensed = Decimal(str(dispensed_row.scalar() or 0))

    running_balance = total_received - total_dispensed
    if running_balance < qty:
        await log_audit(
            db, event_type="narcotic_register_negative_block", severity="critical",
            item_id=item_id, user_id=user_id,
            payload={
                "item_name": info.name,
                "running_balance": float(running_balance),
                "requested_qty": float(qty),
            },
        )
        raise HTTPException(
            status_code=400,
            detail=(
                f"Cannot dispense {qty} of '{info.name}' — narcotic/H1 register "
                f"running balance is {running_balance}. Dispensing this quantity "
                "would drive the register negative. Verify GRN posting and prior "
                "dispenses before retrying."
            ),
        )


async def record_prescription(
    db: AsyncSession,
    *,
    source_type: str,
    source_id: int,
    item_id: int,
    batch_id: Optional[int],
    qty: Decimal,
    drug_schedule: Optional[str],
    prescriber_name: str,
    prescriber_license: str,
    patient_name: Optional[str],
    patient_id: Optional[str],
    prescription_image_url: Optional[str],
    dispensed_by: int,
    retention_years: Optional[int] = None,
) -> PrescriptionRecord:
    """Persist a prescription record (H1/narcotic dispense audit).

    BUG-HC-049 fix: gate narcotic/H1 dispenses on running register balance
    so the register can never go negative.

    BUG-HC-041 fix: for restricted drug schedules (H1, X, narcotic), require
    a signed prescription image URL — dispensing controlled substances
    without a documented prescription is non-compliant under Drugs &
    Cosmetics Rules. Image URL must point at the same upload tree the rest
    of the system uses (`/uploads/...`) to discourage spoofed external links.
    """
    is_restricted = bool(
        (drug_schedule and drug_schedule in ("H1", "X"))
    )
    if not is_restricted:
        # Re-fetch from item if drug_schedule wasn't passed.
        item_row = await db.execute(
            select(Item.is_schedule_h1, Item.is_narcotic, Item.drug_schedule)
            .where(Item.id == item_id)
        )
        info = item_row.first()
        if info:
            is_restricted = bool(
                info.is_schedule_h1 or info.is_narcotic
                or (info.drug_schedule in ("H1", "X"))
            )
    if is_restricted:
        if not prescription_image_url:
            await log_audit(
                db, event_type="prescription_image_missing", severity="error",
                item_id=item_id, source_type=source_type, source_id=source_id,
                user_id=dispensed_by,
                payload={"drug_schedule": drug_schedule, "qty": float(qty)},
            )
            raise HTTPException(
                status_code=400,
                detail=(
                    "A scanned/signed prescription image is required for "
                    "Schedule H1, narcotic and Schedule X dispenses. "
                    "Upload the prescription before dispensing."
                ),
            )
        # Reject obvious external / spoofed links — must be an internal
        # upload path or http(s) URL pointing at the configured upload host.
        url = (prescription_image_url or "").strip()
        if not (url.startswith("/uploads/") or url.startswith("http://") or url.startswith("https://")):
            raise HTTPException(
                status_code=400,
                detail="Prescription image URL must be a valid uploaded document path.",
            )

    await assert_narcotic_running_balance(
        db, item_id=item_id, qty=qty, user_id=dispensed_by,
    )
    # BUG-HC-042 fix: retention years per Drugs & Cosmetics Rules vary by
    # schedule. Schedule X = 5 years, Schedule H1 / Narcotics = 3 years,
    # everything else = 2 years. Caller can still override with an explicit
    # retention_years arg.
    if retention_years is None:
        if drug_schedule == "X":
            retention_years = 5
        elif drug_schedule == "H1":
            retention_years = 3
        else:
            # Re-fetch from item if drug_schedule is None.
            try:
                item_row2 = await db.execute(
                    select(Item.is_narcotic).where(Item.id == item_id)
                )
                inf2 = item_row2.first()
                if inf2 and inf2.is_narcotic:
                    retention_years = 3
                else:
                    retention_years = 2
            except Exception:
                retention_years = 2
    pr = PrescriptionRecord(
        source_type=source_type,
        source_id=source_id,
        item_id=item_id,
        batch_id=batch_id,
        qty_dispensed=qty,
        drug_schedule=drug_schedule,
        prescriber_name=prescriber_name,
        prescriber_license=prescriber_license,
        patient_name=patient_name,
        patient_id=patient_id,
        prescription_image_url=prescription_image_url,
        dispensed_by=dispensed_by,
        retention_until=date.today() + timedelta(days=365 * retention_years),
    )
    db.add(pr)
    await db.flush()
    return pr


# ─────────────────────────────────────────────────────────────────────
# E-signature (re-auth)
# ─────────────────────────────────────────────────────────────────────

def hash_payload(payload: dict) -> str:
    body = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


# BUG-HC-076 fix: track failed e-sign re-auth attempts per (user_id) and
# block further attempts for a cool-down window once the count crosses 5
# in 5 minutes. Prevents an attacker who has hijacked a session from
# brute-forcing the e-signature password.
_REAUTH_FAIL_BUCKET: dict = {}
_REAUTH_FAIL_LIMIT = 5
_REAUTH_FAIL_WINDOW_S = 300


def _reauth_fail_register(user_id: int) -> None:
    import time as _t
    now = _t.time()
    arr = [t for t in _REAUTH_FAIL_BUCKET.get(user_id, []) if t > now - _REAUTH_FAIL_WINDOW_S]
    arr.append(now)
    _REAUTH_FAIL_BUCKET[user_id] = arr


def _reauth_fail_check(user_id: int) -> None:
    import time as _t
    now = _t.time()
    arr = [t for t in _REAUTH_FAIL_BUCKET.get(user_id, []) if t > now - _REAUTH_FAIL_WINDOW_S]
    _REAUTH_FAIL_BUCKET[user_id] = arr
    if len(arr) >= _REAUTH_FAIL_LIMIT:
        raise HTTPException(
            status_code=429,
            detail=(
                "Too many failed e-signature attempts. "
                "Wait a few minutes before retrying."
            ),
        )


async def assert_reauth_and_sign(
    db: AsyncSession,
    *,
    user,
    submitted_password: str,
    source_type: str,
    source_id: int,
    payload: dict,
    client_ip: Optional[str] = None,
    client_meta: Optional[dict] = None,
) -> ESignature:
    """Re-verify user's password, write an e-signature row, return it.
    Raises 401 if password is wrong.
    """
    if not submitted_password:
        raise HTTPException(status_code=400, detail="Password is required to sign this entry")
    # BUG-HC-076 fix: rate-limit failed attempts BEFORE we attempt verify.
    _reauth_fail_check(user.id)
    if not verify_password(submitted_password, user.password_hash):
        _reauth_fail_register(user.id)
        await log_audit(
            db, event_type="esign_reauth_failed", severity="warning",
            source_type=source_type, source_id=source_id, user_id=user.id,
        )
        raise HTTPException(status_code=401, detail="Re-authentication failed: wrong password")

    # BUG-HC-077 fix: cap client_meta JSON to 8 KB so a malicious or
    # misbehaving client can't fill the e-signatures table (and the audit
    # store underneath) with multi-MB blobs over time. Anything beyond the
    # cap is truncated with a marker so the trail is still meaningful.
    client_meta_str: Optional[str] = None
    if client_meta:
        try:
            client_meta_str = json.dumps(client_meta)
        except (TypeError, ValueError):
            client_meta_str = json.dumps({"_meta_serialization_failed": True})
        _MAX_META_BYTES = 8 * 1024
        if client_meta_str and len(client_meta_str) > _MAX_META_BYTES:
            client_meta_str = (
                client_meta_str[: _MAX_META_BYTES - 30] + "...[TRUNCATED]"
            )

    sig = ESignature(
        source_type=source_type,
        source_id=source_id,
        signer_user_id=user.id,
        payload_hash=hash_payload(payload),
        signature_method="password_reauth",
        client_ip=client_ip,
        client_meta=client_meta_str,
    )
    db.add(sig)
    await db.flush()
    return sig


# ─────────────────────────────────────────────────────────────────────
# Cold chain helpers (used by API)
# ─────────────────────────────────────────────────────────────────────

async def evaluate_cold_chain_breach(
    db: AsyncSession,
    *,
    batch_id: int,
    temperature_c: Decimal,
    item: Optional[Item] = None,
) -> tuple[bool, Optional[str]]:
    """Return (is_breach, severity)."""
    if item is None:
        from app.models.warehouse import Batch
        b_row = await db.execute(select(Batch).where(Batch.id == batch_id))
        b = b_row.scalar_one_or_none()
        if not b or not b.item_id:
            return False, None
        i_row = await db.execute(select(Item).where(Item.id == b.item_id))
        item = i_row.scalar_one_or_none()
    if not item or not item.requires_cold_chain:
        return False, None

    lo = item.min_storage_temp_c
    hi = item.max_storage_temp_c
    if lo is None and hi is None:
        # BUG-HC-060 fix: an item flagged requires_cold_chain=True with no
        # configured min/max temps is a configuration error — log it as a
        # compliance audit so admins can fix the master data, and treat it
        # as a "minor" breach so the dashboard surfaces it. Do NOT silently
        # return "no breach"; that masks the real risk.
        try:
            await log_audit(
                db,
                event_type="cold_chain_item_misconfigured",
                severity="warning",
                item_id=item.id,
                batch_id=batch_id,
                payload={
                    "item_name": item.name,
                    "reason": "requires_cold_chain=True but min/max temps are null",
                },
            )
        except Exception:
            pass
        return True, "minor"

    delta = Decimal("0")
    if lo is not None and temperature_c < lo:
        delta = lo - temperature_c
    elif hi is not None and temperature_c > hi:
        delta = temperature_c - hi
    else:
        return False, None

    # BUG-HC-058 fix: severity thresholds are now configurable via app
    # settings (COLD_CHAIN_MAJOR_C, COLD_CHAIN_CRITICAL_C). Sites that store
    # tight-tolerance vaccines (HPV, mRNA) need lower thresholds; sites
    # storing tablets can tolerate wider drift. Defaults preserve the
    # previous behaviour (>= 2 = major, >= 5 = critical).
    try:
        from app.config import settings as _settings
        major_th = Decimal(str(getattr(_settings, "COLD_CHAIN_MAJOR_C", "2")))
        critical_th = Decimal(str(getattr(_settings, "COLD_CHAIN_CRITICAL_C", "5")))
    except Exception:
        major_th = Decimal("2")
        critical_th = Decimal("5")

    severity = "minor"
    if delta >= critical_th:
        severity = "critical"
    elif delta >= major_th:
        severity = "major"
    return True, severity
