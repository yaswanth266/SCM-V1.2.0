"""Rate contracts API — closes audit gap G-12.

The `rate_contracts` and `rate_contract_items` tables exist (Wave 7 healthcare
module) but have no public API. This module exposes CRUD + a lookup that
procurement uses when raising POs.
"""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.user import User
from app.models.master import Vendor, Item
from app.models.healthcare import RateContract, RateContractItem
from app.services.number_series import generate_number
from app.utils.dependencies import get_current_user, require_any_role
from app.utils.helpers import paginate_params, build_paginated_response


router = APIRouter()

ALLOWED_STATUSES = {"draft", "active", "expired", "cancelled"}
# Once a contract is active or beyond, certain fields freeze for audit.
FROZEN_FIELDS_AFTER_ACTIVATION = {"start_date", "end_date"}


# BUG-PRO-086 fix: typed Pydantic payload for create. The previous `payload: dict`
# allowed arbitrary keys to leak through and gave no per-field validation.
class RateContractItemCreate(BaseModel):
    item_id: int
    base_rate: Decimal = Field(..., gt=0)
    discount_pct: Decimal = Decimal("0")
    min_qty: Decimal = Decimal("0")
    max_qty: Decimal = Decimal("0")
    uom_id: Optional[int] = None

    @field_validator("discount_pct")
    @classmethod
    def _v_disc(cls, v):
        if v < 0 or v > 100:
            raise ValueError("discount_pct must be between 0 and 100")
        return v

    @field_validator("min_qty", "max_qty")
    @classmethod
    def _v_qty(cls, v):
        if v < 0:
            raise ValueError("min_qty/max_qty cannot be negative")
        return v


class RateContractCreate(BaseModel):
    vendor_id: int
    contract_number: Optional[str] = None
    start_date: date
    end_date: date
    status: str = "draft"
    min_order_value: Decimal = Decimal("0")
    payment_terms_days: int = 30
    remarks: Optional[str] = None
    items: List[RateContractItemCreate]

    @field_validator("items")
    @classmethod
    def _v_items(cls, v):
        if not v:
            raise ValueError("At least one rate-contract item is required")
        return v

    @field_validator("status")
    @classmethod
    def _v_status(cls, v):
        if v not in ALLOWED_STATUSES:
            raise ValueError(f"status must be one of {sorted(ALLOWED_STATUSES)}")
        return v


@router.get("")
async def list_rate_contracts(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    vendor_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    # BUG-PRO-077/078/079 fix: rate-contract endpoints expose negotiated pricing.
    # Restrict reads to procurement / store / accounts roles instead of any
    # authenticated user.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "purchase_manager", "purchase_officer",
        "warehouse_manager", "store_keeper", "accounts_manager",
    )),
):
    offset, limit = paginate_params(page, page_size)
    q = select(RateContract).options(selectinload(RateContract.items))
    cq = select(func.count(RateContract.id))
    if vendor_id:
        q = q.where(RateContract.vendor_id == vendor_id)
        cq = cq.where(RateContract.vendor_id == vendor_id)
    if status:
        q = q.where(RateContract.status == status)
        cq = cq.where(RateContract.status == status)
    total = (await db.execute(cq)).scalar() or 0
    rows = (await db.execute(q.offset(offset).limit(limit).order_by(RateContract.id.desc()))).scalars().all()

    # Resolve vendor names
    vendor_ids = {r.vendor_id for r in rows if r.vendor_id}
    v_map = {}
    if vendor_ids:
        v_rows = await db.execute(select(Vendor.id, Vendor.name, Vendor.vendor_code).where(Vendor.id.in_(vendor_ids)))
        v_map = {r.id: r for r in v_rows.all()}

    out = []
    for c in rows:
        v = v_map.get(c.vendor_id)
        today = date.today()
        is_expired = c.end_date and c.end_date < today
        is_active_now = (
            c.status == "active"
            and c.start_date and c.start_date <= today
            and not is_expired
        )
        # BUG-PRO-081 fix: surface days-until-expiry so the FE can flag
        # contracts approaching their end_date (e.g. <= 30 days).
        expiring_in_days = None
        if c.end_date and not is_expired:
            try:
                expiring_in_days = (c.end_date - today).days
            except Exception:
                expiring_in_days = None
        out.append({
            "id": c.id,
            "contract_number": c.contract_number,
            "vendor_id": c.vendor_id,
            "vendor_name": v.name if v else None,
            "vendor_code": v.vendor_code if v else None,
            "start_date": c.start_date.isoformat() if c.start_date else None,
            "end_date": c.end_date.isoformat() if c.end_date else None,
            "status": c.status,
            "is_active_now": is_active_now,
            "is_expired": is_expired,
            "expiring_in_days": expiring_in_days,
            "expiring_soon": (
                expiring_in_days is not None and 0 <= expiring_in_days <= 30
            ),
            "min_order_value": float(c.min_order_value or 0),
            "payment_terms_days": c.payment_terms_days,
            "remarks": c.remarks,
            "item_count": len(c.items or []),
            "created_at": c.created_at.isoformat() if c.created_at else None,
        })
    return build_paginated_response(out, total, page, page_size)


@router.get("/{contract_id}")
async def get_rate_contract(
    contract_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-PRO-077/078/079 fix: rate-contract endpoints expose negotiated pricing.
    # Restrict reads to procurement / store / accounts roles instead of any
    # authenticated user.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "purchase_manager", "purchase_officer",
        "warehouse_manager", "store_keeper", "accounts_manager",
    )),
):
    c = (await db.execute(
        select(RateContract).options(selectinload(RateContract.items))
        .where(RateContract.id == contract_id)
    )).scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="Rate contract not found")

    item_ids = [i.item_id for i in c.items]
    items_map = {}
    if item_ids:
        rows = await db.execute(select(Item.id, Item.item_code, Item.name).where(Item.id.in_(item_ids)))
        items_map = {r.id: r for r in rows.all()}

    items_out = []
    for it in c.items:
        meta = items_map.get(it.item_id)
        items_out.append({
            "id": it.id,
            "item_id": it.item_id,
            "item_code": meta.item_code if meta else None,
            "item_name": meta.name if meta else None,
            "base_rate": float(it.base_rate or 0),
            "discount_pct": float(it.discount_pct or 0),
            "effective_rate": float(it.effective_rate or 0),
            "min_qty": float(it.min_qty or 0),
            "max_qty": float(it.max_qty or 0),
            "uom_id": it.uom_id,
        })

    vendor_row = (await db.execute(select(Vendor).where(Vendor.id == c.vendor_id))).scalar_one_or_none()
    return {
        "id": c.id,
        "contract_number": c.contract_number,
        "vendor_id": c.vendor_id,
        "vendor_name": vendor_row.name if vendor_row else None,
        "start_date": c.start_date.isoformat() if c.start_date else None,
        "end_date": c.end_date.isoformat() if c.end_date else None,
        "status": c.status,
        "min_order_value": float(c.min_order_value or 0),
        "payment_terms_days": c.payment_terms_days,
        "remarks": c.remarks,
        "items": items_out,
    }


def _validate_item_lines(items: list) -> None:
    """Raises HTTPException(400) on any invalid line. Caller-side validation."""
    for idx, it in enumerate(items, start=1):
        if not it.get("item_id"):
            raise HTTPException(status_code=400, detail=f"Line {idx}: item_id is required")
        try:
            base_rate = Decimal(str(it.get("base_rate") or 0))
            disc = Decimal(str(it.get("discount_pct") or 0))
            min_qty = Decimal(str(it.get("min_qty") or 0))
            max_qty = Decimal(str(it.get("max_qty") or 0))
        except Exception:
            raise HTTPException(status_code=400, detail=f"Line {idx}: numeric fields must be numbers")
        if base_rate <= 0:
            raise HTTPException(status_code=400, detail=f"Line {idx}: base_rate must be > 0")
        if disc < 0 or disc > 100:
            raise HTTPException(status_code=400, detail=f"Line {idx}: discount_pct must be between 0 and 100")
        if min_qty < 0 or max_qty < 0:
            raise HTTPException(status_code=400, detail=f"Line {idx}: min_qty/max_qty cannot be negative")
        if max_qty > 0 and min_qty > max_qty:
            raise HTTPException(status_code=400, detail=f"Line {idx}: min_qty cannot exceed max_qty")


@router.post("", status_code=201)
async def create_rate_contract(
    payload: RateContractCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "purchase_manager")),
):
    """Create a rate contract.

    BUG-PRO-086 fix: payload is now a typed Pydantic model (was `dict`).
    """
    if payload.end_date < payload.start_date:
        raise HTTPException(status_code=400, detail="end_date must be on or after start_date")

    for idx, it in enumerate(payload.items, start=1):
        if it.max_qty > 0 and it.min_qty > it.max_qty:
            raise HTTPException(
                status_code=400,
                detail=f"Line {idx}: min_qty cannot exceed max_qty",
            )

    vendor_exists = (await db.execute(
        select(Vendor.id).where(Vendor.id == payload.vendor_id)
    )).scalar_one_or_none()
    if not vendor_exists:
        raise HTTPException(status_code=404, detail=f"Vendor {payload.vendor_id} not found")

    contract_number = payload.contract_number
    if not contract_number:
        contract_number = await generate_number(db, "procurement", "rate_contract")

    rc = RateContract(
        contract_number=contract_number,
        vendor_id=payload.vendor_id,
        start_date=payload.start_date,
        end_date=payload.end_date,
        status=payload.status,
        min_order_value=payload.min_order_value,
        payment_terms_days=payload.payment_terms_days,
        remarks=payload.remarks,
        created_by=current_user.id,
    )
    db.add(rc)
    await db.flush()

    for it in payload.items:
        eff = it.base_rate - (it.base_rate * it.discount_pct / Decimal("100"))
        db.add(RateContractItem(
            contract_id=rc.id,
            item_id=it.item_id,
            base_rate=it.base_rate,
            discount_pct=it.discount_pct,
            effective_rate=eff,
            min_qty=it.min_qty,
            max_qty=it.max_qty,
            uom_id=it.uom_id,
        ))
    await db.flush()
    return {"id": rc.id, "contract_number": contract_number, "message": "Rate contract created"}


@router.put("/{contract_id}")
async def update_rate_contract(
    contract_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "purchase_manager")),
):
    """Update a rate contract.

    Once `status='active'`, the dates and rate items freeze for audit reasons —
    callers can still update min_order_value / payment_terms_days / remarks /
    transition status to expired/cancelled. To change pricing on an active
    contract, cancel it and create a new one.
    """
    rc = (await db.execute(select(RateContract).where(RateContract.id == contract_id))).scalar_one_or_none()
    if not rc:
        raise HTTPException(status_code=404, detail="Rate contract not found")

    # BUG-PRO-089 fix: cancelled (and expired) contracts are immutable. Previously
    # only the date columns were frozen — payment_terms_days / remarks / status
    # could still be flipped post-cancel which broke the audit trail (e.g., a
    # cancelled contract could be reopened to "active" with a quiet PUT).
    if rc.status in ("cancelled", "expired"):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Rate contract is in '{rc.status}' status — it is immutable. "
                f"Create a new contract if pricing/terms need to change."
            ),
        )

    is_locked = rc.status in ("active", "expired", "cancelled")
    for k in ("start_date", "end_date", "status", "min_order_value", "payment_terms_days", "remarks"):
        if k not in payload:
            continue
        if is_locked and k in FROZEN_FIELDS_AFTER_ACTIVATION:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot modify '{k}' on a {rc.status} contract; cancel and re-create instead",
            )
        v = payload[k]
        if k in ("start_date", "end_date") and isinstance(v, str):
            try:
                v = date.fromisoformat(v)
            except ValueError:
                raise HTTPException(status_code=400, detail=f"{k} must be ISO date (YYYY-MM-DD)")
        if k == "status" and v not in ALLOWED_STATUSES:
            raise HTTPException(status_code=400, detail=f"status must be one of {sorted(ALLOWED_STATUSES)}")
        setattr(rc, k, v)

    # Re-validate dates after potential changes.
    if rc.start_date and rc.end_date and rc.end_date < rc.start_date:
        raise HTTPException(status_code=400, detail="end_date must be on or after start_date")

    await db.flush()
    return {"success": True}


@router.post("/{contract_id}/activate")
async def activate_rate_contract(
    contract_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin", "purchase_manager")),
):
    """Activate a draft rate contract. Preconditions: must have ≥1 item, end_date in the future,
    and currently be in 'draft' status."""
    rc = (await db.execute(
        select(RateContract).options(selectinload(RateContract.items))
        .where(RateContract.id == contract_id)
    )).scalar_one_or_none()
    if not rc:
        raise HTTPException(status_code=404, detail="Rate contract not found")
    if rc.status != "draft":
        raise HTTPException(status_code=400, detail=f"Only draft contracts can be activated (current: {rc.status})")
    if not rc.items:
        raise HTTPException(status_code=400, detail="Contract has no items — cannot activate")
    if rc.end_date and rc.end_date < date.today():
        raise HTTPException(status_code=400, detail="end_date is in the past — cannot activate an already-expired contract")
    # BUG-PRO-088 fix: refuse activation when start_date is in the future. An
    # "active" contract must be effective NOW (or already so). For a future
    # contract the operator should keep it draft and activate on the start day.
    if rc.start_date and rc.start_date > date.today():
        raise HTTPException(
            status_code=400,
            detail=(
                f"start_date {rc.start_date.isoformat()} is in the future — "
                f"cannot activate a contract that has not yet begun. "
                f"Activate on or after the start date."
            ),
        )

    # BUG-PRO-080 fix: refuse activation when another active rate contract for
    # the same vendor overlaps in date AND covers any of the same items.
    # Two simultaneously-active contracts for the same item produce ambiguous
    # pricing in lookup_active_rate and cap-enforcement.
    rc_item_ids = [it.item_id for it in (rc.items or [])]
    if rc_item_ids:
        overlap_rows = (await db.execute(
            select(RateContract.id, RateContract.contract_number, RateContractItem.item_id)
            .join(RateContractItem, RateContractItem.contract_id == RateContract.id)
            .where(
                RateContract.id != rc.id,
                RateContract.vendor_id == rc.vendor_id,
                RateContract.status == "active",
                RateContract.start_date <= rc.end_date,
                RateContract.end_date >= rc.start_date,
                RateContractItem.item_id.in_(rc_item_ids),
            )
        )).all()
        if overlap_rows:
            conflicts = sorted({(r.contract_number, r.item_id) for r in overlap_rows})
            raise HTTPException(
                status_code=409,
                detail=(
                    "Activation refused: another active contract for this vendor "
                    "overlaps in date and item. Conflicts: "
                    + "; ".join(f"{cn} (item_id={iid})" for cn, iid in conflicts[:10])
                ),
            )

    rc.status = "active"
    await db.flush()
    return {"success": True, "message": "Rate contract activated"}


@router.get("/lookup/active-rate")
async def lookup_active_rate(
    item_id: int = Query(...),
    vendor_id: Optional[int] = Query(None),
    qty: Optional[float] = Query(None, gt=0, description="Order qty — filters out contracts whose min_qty > qty or max_qty < qty"),
    db: AsyncSession = Depends(get_db),
    # BUG-PRO-077/078/079 fix: rate-contract endpoints expose negotiated pricing.
    # Restrict reads to procurement / store / accounts roles instead of any
    # authenticated user.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "purchase_manager", "purchase_officer",
        "warehouse_manager", "store_keeper", "accounts_manager",
    )),
):
    """Used by PO/Quotation forms to fetch contracted rate for an item.
    Returns the cheapest active contract rate for the item (optionally
    filtered to a specific vendor and order qty).
    """
    today = date.today()
    q = (
        select(RateContractItem, RateContract)
        .join(RateContract, RateContract.id == RateContractItem.contract_id)
        .where(
            RateContractItem.item_id == item_id,
            RateContract.status == "active",
            RateContract.start_date <= today,
            RateContract.end_date >= today,
        )
        .order_by(RateContractItem.effective_rate.asc())
    )
    if vendor_id:
        q = q.where(RateContract.vendor_id == vendor_id)
    if qty is not None:
        qty_d = Decimal(str(qty))
        # Apply qty bands: min_qty > 0 imposes a floor, max_qty > 0 imposes a ceiling.
        q = q.where(
            or_(RateContractItem.min_qty == 0, RateContractItem.min_qty <= qty_d)
        ).where(
            or_(RateContractItem.max_qty == 0, RateContractItem.max_qty >= qty_d)
        )

    rows = (await db.execute(q.limit(5))).all()
    if not rows:
        return {"found": False, "rates": []}
    out = []
    for r in rows:
        ci, rc = r
        out.append({
            "contract_id": rc.id,
            "contract_number": rc.contract_number,
            "vendor_id": rc.vendor_id,
            "base_rate": float(ci.base_rate or 0),
            "discount_pct": float(ci.discount_pct or 0),
            "effective_rate": float(ci.effective_rate or 0),
            "min_qty": float(ci.min_qty or 0),
            "max_qty": float(ci.max_qty or 0),
            "valid_until": rc.end_date.isoformat() if rc.end_date else None,
        })
    return {"found": True, "rates": out, "best_rate": out[0]}
