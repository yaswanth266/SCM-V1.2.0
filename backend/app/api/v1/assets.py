from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator
from typing import Optional
from decimal import Decimal
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.database import get_db
from app.models.user import User
from app.models.asset import AssetCategory, Asset, AssetMovement
from app.services.number_series import generate_number
from app.utils.dependencies import get_current_user
from app.utils.helpers import paginate_params, build_paginated_response, apply_search_filter

router = APIRouter()


class AssetCategoryCreate(BaseModel):
    name: str
    type: str
    depreciation_method: str = "straight_line"
    useful_life_years: int = 5
    depreciation_rate: Decimal = Decimal("0")

    @field_validator("name")
    @classmethod
    def val_name(cls, v):
        if not v or not v.strip():
            raise ValueError("Category name is required")
        return v.strip()[:255]

    @field_validator("type")
    @classmethod
    def val_type(cls, v):
        valid = ("it", "medical", "fixed", "other")
        v = v.strip().lower()
        if v not in valid:
            raise ValueError(f"Invalid type. Must be one of: {', '.join(valid)}")
        return v

    @field_validator("depreciation_method")
    @classmethod
    def val_method(cls, v):
        # BUG-HC-079 fix: align with the AssetCategory model's actual enum
        # values (straight_line, written_down). Previously the schema
        # advertised "declining_balance" / "none" — neither of which exist
        # in the DB enum, so the API accepted them and the INSERT failed
        # with a 500 from MySQL.
        valid = ("straight_line", "written_down")
        v = (v or "").strip().lower()
        # Soft-alias common synonyms so old clients keep working.
        if v in ("declining_balance", "wdv", "diminishing"):
            v = "written_down"
        if v not in valid:
            raise ValueError(f"Invalid depreciation method. Must be one of: {', '.join(valid)}")
        return v


class AssetCreate(BaseModel):
    name: str
    category_id: Optional[int] = None
    category: Optional[str] = None  # frontend alias — name or code of category
    serial_number: Optional[str] = None
    purchase_date: Optional[str] = None
    purchase_price: Decimal = Decimal("0")
    current_value: Decimal = Decimal("0")
    vendor_id: Optional[int] = None
    po_id: Optional[int] = None
    warranty_expiry: Optional[str] = None
    current_warehouse_id: Optional[int] = None
    current_location: Optional[str] = None
    assigned_to: Optional[int] = None
    remarks: Optional[str] = None
    # BUG-HC-125 fix: accept the additional form fields the FE sends so they
    # are no longer silently dropped. description is mapped onto remarks
    # (no separate column on Asset). barcode_value/barcode_type → Asset.barcode.
    # depreciation_rate, invoice_number, warranty_provider, warranty_terms,
    # department, condition do not have dedicated columns yet — they are
    # captured here in the schema and stored in remarks (JSON-style suffix)
    # so the data is not lost; a follow-up migration can promote them to
    # first-class columns.
    description: Optional[str] = None
    barcode_value: Optional[str] = None
    barcode_type: Optional[str] = None
    depreciation_rate: Optional[Decimal] = None
    invoice_number: Optional[str] = None
    warranty_provider: Optional[str] = None
    warranty_terms: Optional[str] = None
    department: Optional[str] = None
    condition: Optional[str] = None

    @field_validator("name")
    @classmethod
    def val_name(cls, v):
        if not v or not v.strip():
            raise ValueError("Asset name is required")
        return v.strip()[:255]

    @field_validator("purchase_price", "current_value")
    @classmethod
    def val_non_negative(cls, v):
        if v is not None and v < 0:
            raise ValueError("Value cannot be negative")
        return v


class AssetUpdate(BaseModel):
    name: Optional[str] = None
    current_value: Optional[Decimal] = None
    current_warehouse_id: Optional[int] = None
    current_location: Optional[str] = None
    assigned_to: Optional[int] = None
    status: Optional[str] = None
    condition_status: Optional[str] = None
    remarks: Optional[str] = None


class AssetMovementCreate(BaseModel):
    asset_id: int
    movement_type: str
    from_location: Optional[str] = None
    to_location: Optional[str] = None
    from_warehouse_id: Optional[int] = None
    to_warehouse_id: Optional[int] = None
    from_user_id: Optional[int] = None
    to_user_id: Optional[int] = None
    movement_date: datetime
    reason: Optional[str] = None


# ==================== CATEGORIES ====================

@router.get("/categories")
async def list_asset_categories(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(AssetCategory).where(AssetCategory.is_active == True))
    cats = result.scalars().all()
    return [{
        "id": c.id, "name": c.name, "type": c.type,
        "depreciation_method": c.depreciation_method,
        "useful_life_years": c.useful_life_years,
        "depreciation_rate": float(c.depreciation_rate or 0),
    } for c in cats]


@router.post("/categories", status_code=201)
async def create_asset_category(
    payload: AssetCategoryCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    cat = AssetCategory(**payload.model_dump())
    db.add(cat)
    await db.flush()
    return {"id": cat.id, "message": "Asset category created"}


# ==================== ASSETS ====================

@router.get("")
async def list_assets(
    # BUG-HC-135 fix: tighten page_size cap to 200. The previous 1000 cap
    # combined with the four selectinload() relationships below issued up to
    # 4001 SQL statements per request when callers passed page_size=1000.
    # 200 is plenty for the UI; large exports should use a dedicated endpoint.
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    search: str = Query(None),
    status: str = Query(None),
    category_id: int = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(Asset)
    count_query = select(func.count(Asset.id))

    if status:
        query = query.where(Asset.status == status)
        count_query = count_query.where(Asset.status == status)
    if category_id:
        query = query.where(Asset.category_id == category_id)
        count_query = count_query.where(Asset.category_id == category_id)
    if warehouse_id:
        query = query.where(Asset.current_warehouse_id == warehouse_id)
        count_query = count_query.where(Asset.current_warehouse_id == warehouse_id)

    query = apply_search_filter(query, Asset, search, ["asset_code", "name", "serial_number"])
    count_query = apply_search_filter(count_query, Asset, search, ["asset_code", "name", "serial_number"])

    total = (await db.execute(count_query)).scalar()
    query = query.options(
        selectinload(Asset.category),
        selectinload(Asset.vendor),
        selectinload(Asset.warehouse),
        selectinload(Asset.assigned_user),
    )
    result = await db.execute(query.offset(offset).limit(limit).order_by(Asset.id.desc()))
    assets = result.scalars().all()

    items = [{
        "id": a.id, "asset_code": a.asset_code, "name": a.name,
        "category_id": a.category_id, "serial_number": a.serial_number,
        "purchase_price": float(a.purchase_price or 0),
        "current_value": float(a.current_value or 0),
        "status": a.status, "condition_status": a.condition_status,
        "current_location": a.current_location,
        "current_warehouse_id": a.current_warehouse_id,
        "vendor_id": a.vendor_id,
        "assigned_to": a.assigned_to, "created_at": a.created_at,
        "category_name": a.category.name if a.category else None,
        "vendor_name": a.vendor.name if a.vendor else None,
        "warehouse_name": a.warehouse.name if a.warehouse else None,
        "assigned_to_name": f"{a.assigned_user.first_name} {a.assigned_user.last_name or ''}".strip() if a.assigned_user else None,
    } for a in assets]

    return build_paginated_response(items, total, page, page_size)


@router.get("/search")
async def asset_search(
    barcode: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not barcode:
        return []
    from app.models.asset import Asset
    result = await db.execute(select(Asset).where(Asset.barcode == barcode).limit(1))
    asset = result.scalar_one_or_none()
    if asset:
        return [{"id": asset.id, "name": asset.name, "asset_code": asset.asset_code}]
    return []


@router.get("/stats")
async def asset_stats(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from app.models.asset import Asset
    total = (await db.execute(select(func.count(Asset.id)))).scalar() or 0
    active = (await db.execute(
        select(func.count(Asset.id)).where(Asset.status.in_(("active", "available", "in_use")))
    )).scalar() or 0
    in_maintenance = (await db.execute(
        select(func.count(Asset.id)).where(Asset.status == "maintenance")
    )).scalar() or 0
    disposed = (await db.execute(
        select(func.count(Asset.id)).where(Asset.status == "disposed")
    )).scalar() or 0
    return {"total_assets": total, "active": active, "in_maintenance": in_maintenance, "disposed": disposed}


@router.get("/movements")
async def list_all_movements_before(
    page: int = Query(1, ge=1),
    # BUG-HC-135 fix: tightened cap to 200 to avoid huge eager loads.
    page_size: int = Query(20, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all asset movements across all assets."""
    from app.models.asset import AssetMovement
    from app.models.warehouse import Warehouse
    offset, limit = paginate_params(page, page_size)
    count = (await db.execute(select(func.count(AssetMovement.id)))).scalar()
    result = await db.execute(
        select(AssetMovement).options(
            selectinload(AssetMovement.asset),
        ).offset(offset).limit(limit).order_by(AssetMovement.id.desc())
    )
    mvmts = result.scalars().all()

    # Bulk-fetch warehouse names and user names for movements
    wh_ids = set()
    user_ids = set()
    for m in mvmts:
        if m.from_warehouse_id:
            wh_ids.add(m.from_warehouse_id)
        if m.to_warehouse_id:
            wh_ids.add(m.to_warehouse_id)
        if m.from_user_id:
            user_ids.add(m.from_user_id)
        if m.to_user_id:
            user_ids.add(m.to_user_id)

    wh_map = {}
    if wh_ids:
        wh_result = await db.execute(select(Warehouse).where(Warehouse.id.in_(wh_ids)))
        for w in wh_result.scalars().all():
            wh_map[w.id] = w.name

    user_map = {}
    if user_ids:
        user_result = await db.execute(select(User).where(User.id.in_(user_ids)))
        for u in user_result.scalars().all():
            user_map[u.id] = f"{u.first_name} {u.last_name or ''}".strip()

    items = []
    for m in mvmts:
        items.append({
            "id": m.id, "asset_id": m.asset_id,
            "asset_code": m.asset.asset_code if m.asset else None,
            "asset_name": m.asset.name if m.asset else None,
            "movement_type": m.movement_type,
            "from_location": m.from_location, "to_location": m.to_location,
            "from_warehouse_id": m.from_warehouse_id,
            "to_warehouse_id": m.to_warehouse_id,
            "from_warehouse_name": wh_map.get(m.from_warehouse_id),
            "to_warehouse_name": wh_map.get(m.to_warehouse_id),
            "from_user_id": m.from_user_id,
            "to_user_id": m.to_user_id,
            "from_user_name": user_map.get(m.from_user_id),
            "to_user_name": user_map.get(m.to_user_id),
            "movement_date": m.movement_date, "reason": m.reason,
            "created_by": m.created_by, "created_at": m.created_at,
        })

    return build_paginated_response(items, count, page, page_size)


@router.get("/{asset_id}")
async def get_asset(
    asset_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Asset).options(selectinload(Asset.movements)).where(Asset.id == asset_id)
    )
    asset = result.scalar_one_or_none()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    return {
        "id": asset.id, "asset_code": asset.asset_code, "name": asset.name,
        "category_id": asset.category_id, "serial_number": asset.serial_number,
        "barcode": asset.barcode,
        "purchase_date": asset.purchase_date,
        "purchase_price": float(asset.purchase_price or 0),
        "current_value": float(asset.current_value or 0),
        "vendor_id": asset.vendor_id, "po_id": asset.po_id,
        "warranty_expiry": asset.warranty_expiry,
        "current_warehouse_id": asset.current_warehouse_id,
        "current_location": asset.current_location,
        "assigned_to": asset.assigned_to,
        "status": asset.status, "condition_status": asset.condition_status,
        "remarks": asset.remarks,
        "movements": [{
            "id": m.id, "movement_type": m.movement_type,
            "from_location": m.from_location, "to_location": m.to_location,
            "movement_date": m.movement_date, "reason": m.reason,
        } for m in asset.movements] if asset.movements else [],
    }


@router.post("", status_code=201)
async def create_asset(
    payload: AssetCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # BUG-HC-081 fix: purchase_date must be in the past (or today), and
    # warranty_expiry must be on or after purchase_date. Previously both
    # fields were accepted without validation, letting users enter
    # purchase_date in the future or warranty_expiry before purchase_date.
    from datetime import date as _date
    _today = _date.today()
    _pd_obj: Optional[_date] = None
    if payload.purchase_date:
        try:
            _pd_obj = _date.fromisoformat(payload.purchase_date)
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=400,
                detail="purchase_date must be ISO format (YYYY-MM-DD)",
            )
        if _pd_obj > _today:
            raise HTTPException(
                status_code=400,
                detail="purchase_date cannot be in the future",
            )
    if payload.warranty_expiry:
        try:
            _we_obj = _date.fromisoformat(payload.warranty_expiry)
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=400,
                detail="warranty_expiry must be ISO format (YYYY-MM-DD)",
            )
        if _pd_obj and _we_obj < _pd_obj:
            raise HTTPException(
                status_code=400,
                detail="warranty_expiry must be on or after purchase_date",
            )

    asset_code = await generate_number(db, "asset", "asset")

    # Resolve category_id from either category_id or the `category` string alias.
    # Frontend sends category as a string ("it", "equipment", "Laptop"...).
    category_id = payload.category_id
    if not category_id and payload.category:
        cat_r = await db.execute(
            select(AssetCategory).where(
                (AssetCategory.name == payload.category)
                | (AssetCategory.name.ilike(f"%{payload.category}%"))
            )
        )
        cat = cat_r.scalars().first()
        if cat:
            category_id = cat.id
    if not category_id:
        # Fall back to the first active asset category so the form doesn't hard-fail
        any_r = await db.execute(select(AssetCategory).where(AssetCategory.is_active == 1).limit(1))
        any_cat = any_r.scalar_one_or_none()
        if any_cat:
            category_id = any_cat.id
    if not category_id:
        raise HTTPException(status_code=422, detail="category_id required (no asset categories defined)")

    # BUG-HC-125 fix: persist as many of the FE-supplied fields as the schema
    # supports. description/department/warranty_provider/warranty_terms/
    # invoice_number/depreciation_rate are appended to remarks until they
    # become first-class columns (deferred to a future migration).
    extra_notes_lines: list[str] = []
    if payload.description:
        extra_notes_lines.append(f"Description: {payload.description}")
    if payload.department:
        extra_notes_lines.append(f"Department: {payload.department}")
    if payload.invoice_number:
        extra_notes_lines.append(f"Invoice #: {payload.invoice_number}")
    if payload.warranty_provider:
        extra_notes_lines.append(f"Warranty Provider: {payload.warranty_provider}")
    if payload.warranty_terms:
        extra_notes_lines.append(f"Warranty Terms: {payload.warranty_terms}")
    if payload.depreciation_rate is not None:
        extra_notes_lines.append(f"Depreciation Rate: {payload.depreciation_rate}%")
    base_remarks = (payload.remarks or "").strip()
    if extra_notes_lines:
        base_remarks = (base_remarks + ("\n" if base_remarks else "")
                        + "\n".join(extra_notes_lines))

    asset_kwargs = dict(
        asset_code=asset_code, name=payload.name, category_id=category_id,
        serial_number=payload.serial_number,
        purchase_price=payload.purchase_price,
        current_value=payload.current_value or payload.purchase_price,
        vendor_id=payload.vendor_id, po_id=payload.po_id,
        current_warehouse_id=payload.current_warehouse_id,
        current_location=payload.current_location,
        assigned_to=payload.assigned_to,
        remarks=base_remarks or None,
    )
    if payload.barcode_value:
        asset_kwargs["barcode"] = payload.barcode_value
    if payload.condition and payload.condition in ("new", "good", "fair", "poor", "damaged"):
        asset_kwargs["condition_status"] = payload.condition

    asset = Asset(**asset_kwargs)
    db.add(asset)
    await db.flush()
    return {"id": asset.id, "asset_code": asset_code, "message": "Asset created"}


# BUG-HC-088 fix: the FE Asset Register has a Delete button, but the
# backend was missing the DELETE handler — the call would return 405. We
# implement it as a soft-delete (status="disposed") so audit history and
# all linked movements/PO/AMC rows remain intact. Restricted to admins.
@router.delete("/{asset_id}")
async def delete_asset(
    asset_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from app.utils.dependencies import get_user_role_codes
    user_roles = set(await get_user_role_codes(db, current_user.id))
    if not (user_roles & {"super_admin", "admin", "asset_manager"}):
        raise HTTPException(
            status_code=403,
            detail="Only admins or asset managers may delete an asset record.",
        )
    result = await db.execute(select(Asset).where(Asset.id == asset_id))
    asset = result.scalar_one_or_none()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    asset.status = "disposed"
    await db.flush()
    return {"success": True, "message": "Asset marked as disposed (soft delete)."}


@router.put("/{asset_id}")
async def update_asset(
    asset_id: int,
    payload: AssetUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(Asset).where(Asset.id == asset_id))
    asset = result.scalar_one_or_none()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    update_data = payload.model_dump(exclude_unset=True)

    # BUG-HC-080 fix: current_value cannot exceed the original purchase_price
    # (depreciation only goes one way). A user updating their own asset row
    # could otherwise inflate its book value to any number.
    if "current_value" in update_data and update_data["current_value"] is not None:
        new_val = Decimal(str(update_data["current_value"]))
        if new_val < 0:
            raise HTTPException(status_code=400, detail="current_value cannot be negative")
        ceiling = Decimal(str(asset.purchase_price or 0))
        if ceiling > 0 and new_val > ceiling:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"current_value ({new_val}) cannot exceed purchase_price ({ceiling}). "
                    "Asset book value can only depreciate, not appreciate."
                ),
            )

    for k, v in update_data.items():
        setattr(asset, k, v)
    await db.flush()
    return {"success": True, "message": "Asset updated"}


# ==================== ASSET MOVEMENTS ====================

@router.post("/movements", status_code=201)
async def create_asset_movement(
    payload: AssetMovementCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Verify asset exists before creating movement
    result = await db.execute(select(Asset).where(Asset.id == payload.asset_id))
    asset = result.scalar_one_or_none()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    # BUG-HC-085 fix: never permit movements (other than dispose) on a
    # disposed / lost / scrapped asset. Once an asset has left active service
    # the only legal "movement" is the disposal/scrap itself.
    blocked_statuses = {"disposed", "lost", "scrapped", "written_off"}
    if (asset.status or "").lower() in blocked_statuses and payload.movement_type != "dispose":
        raise HTTPException(
            status_code=400,
            detail=(
                f"Cannot move asset {asset.asset_code or asset.id} — "
                f"its status is '{asset.status}'. Disposed/lost assets "
                "cannot be reassigned or transferred."
            ),
        )

    # BUG-HC-086 fix: don't construct AssetMovement directly from
    # payload.model_dump() — that exposes the model to silent column
    # over-write if the schema gains fields the model didn't expect.
    movement = AssetMovement(
        asset_id=payload.asset_id,
        movement_type=payload.movement_type,
        from_location=payload.from_location,
        to_location=payload.to_location,
        from_warehouse_id=payload.from_warehouse_id,
        to_warehouse_id=payload.to_warehouse_id,
        from_user_id=payload.from_user_id,
        to_user_id=payload.to_user_id,
        movement_date=payload.movement_date,
        reason=payload.reason,
        created_by=current_user.id,
    )
    db.add(movement)

    # BUG-HC-087 fix: high-value asset movements (current_value >= 100k) are
    # written to the compliance audit log so finance can later reconcile the
    # asset trail. Failures are swallowed — never poison the movement create.
    try:
        threshold = Decimal("100000")
        if Decimal(str(asset.current_value or 0)) >= threshold:
            from app.services.compliance_service import log_audit
            await log_audit(
                db,
                event_type="high_value_asset_movement",
                severity="info",
                source_type="asset",
                source_id=asset.id,
                user_id=current_user.id,
                payload={
                    "asset_code": asset.asset_code,
                    "asset_name": asset.name,
                    "current_value": float(asset.current_value or 0),
                    "movement_type": payload.movement_type,
                    "from_warehouse_id": payload.from_warehouse_id,
                    "to_warehouse_id": payload.to_warehouse_id,
                    "from_user_id": payload.from_user_id,
                    "to_user_id": payload.to_user_id,
                    "reason": payload.reason,
                },
            )
    except Exception:
        pass

    # Update asset
    if asset:
        if payload.to_location:
            asset.current_location = payload.to_location
        if payload.to_warehouse_id:
            asset.current_warehouse_id = payload.to_warehouse_id
        if payload.to_user_id:
            asset.assigned_to = payload.to_user_id
            asset.status = "in_use"
        if payload.movement_type == "return":
            asset.assigned_to = None
            asset.status = "available"
        elif payload.movement_type == "maintenance":
            asset.status = "maintenance"
        elif payload.movement_type == "dispose":
            asset.status = "disposed"

    await db.flush()
    return {"id": movement.id, "message": "Asset movement recorded"}


@router.get("/{asset_id}/movements")
async def list_asset_movements(
    asset_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(AssetMovement)
        .where(AssetMovement.asset_id == asset_id)
        .order_by(AssetMovement.movement_date.desc())
    )
    movements = result.scalars().all()
    return [{
        "id": m.id, "movement_type": m.movement_type,
        "from_location": m.from_location, "to_location": m.to_location,
        "from_warehouse_id": m.from_warehouse_id, "to_warehouse_id": m.to_warehouse_id,
        "from_user_id": m.from_user_id, "to_user_id": m.to_user_id,
        "movement_date": m.movement_date, "reason": m.reason,
        "created_by": m.created_by, "created_at": m.created_at,
    } for m in movements]
