from datetime import datetime, timezone
from decimal import Decimal
import re
import asyncio
from urllib.parse import urljoin

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import delete, select, func, or_, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, selectinload
from app.config import settings
from app.database import get_db
from app.models.user import Role, User, UserRole
from app.models.master import (
    Item, ItemCategory, UOMCategory, UOM, UOMConversion, ItemUOMConversion,
    Vendor, VendorItem, VendorContract, VendorRating, VendorType, VendorCategory, VendorVendorType, VendorItemHistory,
    PriceList, PriceListItem,
    Brand, Feature, ItemFeature, ItemAttribute, ItemAttributeValue,
    UserGroup, UserGroupMember, UserGroupPermission,
    UserItemPermission, RoleItemPermission,
    Office, Position, Employee,
)
from app.models.warehouse import Warehouse, WarehouseLocation, WarehouseLine, WarehouseRack, WarehouseBin
from app.models.user import User as UserModel
from app.schemas.master import (
    ItemCreate, ItemUpdate, ItemResponse,
    CategoryCreate, CategoryResponse,
    UOMCategoryCreate, UOMCategoryResponse, UOMCreate, UOMResponse, UOMConversionCreate, ItemUOMConversionCreate,

    VendorCreate, VendorUpdate, VendorResponse, VendorTypeCreate, VendorTypeResponse, VendorCategoryCreate, VendorCategoryResponse,
    VendorItemCreate, VendorItemBulkMapCreate, UserItemBulkMapCreate, VendorContractCreate, VendorRatingCreate,
    WarehouseCreate, WarehouseUpdate, WarehouseResponse,
    LocationCreate, LineCreate, RackCreate, BinCreate,
    PriceListCreate, PriceListItemCreate, VALID_VENDOR_TYPES,
    ProjectMasterCreate, ProjectMasterResponse, OfficeCreate, OfficeResponse,
    PositionCreate, PositionResponse, EmployeeCreate, EmployeeResponse,
    EMAIL_PATTERN, PAN_PATTERN, PHONE_PATTERN,
)
from app.models.user import Organization, Project
from app.utils.dependencies import get_current_user, require_permission
from app.utils.helpers import paginate_params, build_paginated_response, apply_search_filter
from app.utils.schema_sync import ensure_feature_schema, ensure_uom_enterprise_schema, ensure_uom_category_schema, ensure_item_category_code_schema, ensure_vendor_type_schema, ensure_organization_structure_schema, ensure_user_item_permission_schema, ensure_item_uom_category_schema, ensure_supplier_portal_schema

router = APIRouter()

PRECISION_TOLERANCE = Decimal("0.000000001")


def _utcnow() -> datetime:
    return datetime.now()


def _as_decimal(value) -> Decimal:
    return Decimal(str(value))


def _factor_parts(payload) -> tuple[Decimal, Decimal, Decimal]:
    factor_den = _as_decimal(payload.factor_den if payload.factor_den is not None else 1)
    if payload.factor_num is not None:
        factor_num = _as_decimal(payload.factor_num)
        factor = factor_num / factor_den
    else:
        factor = _as_decimal(payload.conversion_factor)
        factor_num = factor
    if factor_num <= 0 or factor_den <= 0 or factor <= 0:
        raise HTTPException(status_code=422, detail="Conversion factors must be greater than 0")
    return factor_num, factor_den, factor


def _factors_match(left: Decimal, right: Decimal) -> bool:
    return abs(left - right) <= PRECISION_TOLERANCE


# ==================== UOM ====================

@router.get("/uom-categories")
async def list_uom_categories(
    include_inactive: bool = Query(False),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    q = select(UOMCategory).order_by(UOMCategory.name)
    if not include_inactive:
        q = q.where(UOMCategory.is_active == True)  # noqa: E712
    if search:
        like = f"%{search}%"
        q = q.where(UOMCategory.name.ilike(like))
    result = await db.execute(q)
    items = result.scalars().all()
    base_ids = {i.base_uom_id for i in items if i.base_uom_id}
    base_map = {}
    if base_ids:
        rows = (await db.execute(select(UOM).where(UOM.id.in_(base_ids)))).scalars().all()
        base_map = {row.id: row for row in rows}
    return [
        {
            "id": i.id,
            "name": i.name,
            "description": i.description,
            "base_uom_id": i.base_uom_id,
            "base_uom_name": base_map.get(i.base_uom_id).name if i.base_uom_id in base_map else None,
            "base_uom_abbreviation": base_map.get(i.base_uom_id).abbreviation if i.base_uom_id in base_map else None,
            "is_active": i.is_active,
            "status": "active" if i.is_active else "inactive",
        }
        for i in items
    ]


@router.post("/uom-categories", status_code=201)
async def create_uom_category(
    payload: UOMCategoryCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    name = payload.name.strip()
    existing = await db.execute(
        select(UOMCategory).where(func.lower(func.trim(UOMCategory.name)) == name.lower())
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"UOM category '{name}' already exists")
    if payload.base_uom_id:
        base_uom = (
            await db.execute(
                select(UOM).where(
                    UOM.id == payload.base_uom_id,
                    UOM.is_active == True,  # noqa: E712
                )
            )
        ).scalar_one_or_none()
        if not base_uom:
            raise HTTPException(status_code=422, detail="Base UOM does not exist or is inactive")
    category = UOMCategory(
        name=name,
        description=payload.description,
        base_uom_id=payload.base_uom_id,
        is_active=True if payload.is_active is None else bool(payload.is_active),
    )
    db.add(category)
    await db.flush()
    return {"id": category.id, "message": "UOM category created"}


@router.put("/uom-categories/{category_id}")
async def update_uom_category(
    category_id: int,
    payload: UOMCategoryCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    category = (await db.execute(select(UOMCategory).where(UOMCategory.id == category_id))).scalar_one_or_none()
    if not category:
        raise HTTPException(status_code=404, detail="UOM category not found")
    name = payload.name.strip()
    dup = await db.execute(
        select(UOMCategory).where(
            func.lower(func.trim(UOMCategory.name)) == name.lower(),
            UOMCategory.id != category_id,
        )
    )
    if dup.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"UOM category '{name}' already exists")
    category.name = name
    category.description = payload.description
    if payload.base_uom_id:
        base_uom = (
            await db.execute(
                select(UOM).where(
                    UOM.id == payload.base_uom_id,
                    UOM.is_active == True,  # noqa: E712
                )
            )
        ).scalar_one_or_none()
        if not base_uom:
            raise HTTPException(status_code=422, detail="Base UOM does not exist or is inactive")
        if base_uom.category_id and base_uom.category_id != category.id:
            raise HTTPException(status_code=422, detail="Base UOM must belong to this category")
    category.base_uom_id = payload.base_uom_id
    if payload.is_active is not None:
        category.is_active = bool(payload.is_active)
    await db.flush()
    return {"id": category.id, "message": "UOM category updated"}


@router.delete("/uom-categories/{category_id}")
async def delete_uom_category(
    category_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    category = (await db.execute(select(UOMCategory).where(UOMCategory.id == category_id))).scalar_one_or_none()
    if not category:
        raise HTTPException(status_code=404, detail="UOM category not found")
    uom_count = await db.scalar(
        select(func.count(UOM.id)).where(UOM.category_id == category_id, UOM.is_active == True)  # noqa: E712
    )
    attr_count = await db.scalar(
        select(func.count(ItemAttribute.id)).where(ItemAttribute.uom_category_id == category_id)
    )
    value_count = await db.scalar(
        select(func.count(ItemAttributeValue.id)).where(ItemAttributeValue.uom_category_id == category_id)
    )
    in_use = int(uom_count or 0) + int(attr_count or 0) + int(value_count or 0)
    if in_use:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot deactivate category referenced by {in_use} UOM/attribute record(s).",
        )
    category.is_active = False
    await db.flush()
    return {"message": "UOM category deactivated"}


@router.get("/uom")
async def list_uom(
    include_inactive: bool = Query(False),
    category_id: int = Query(None),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    # By default return only active UOMs. When include_inactive=True (e.g.
    # admin lookup or label resolution for old docs) return all rows.
    # BUG-FE-086 / BUG-FE-170: previously include_inactive was ignored.
    q = select(UOM).order_by(UOM.name)
    if not include_inactive:
        q = q.where(UOM.is_active == True)  # noqa: E712
    if category_id is not None:
        q = q.where(UOM.category_id == category_id)
    if search:
        like = f"%{search}%"
        q = q.where((UOM.name.ilike(like)) | (UOM.abbreviation.ilike(like)))
    result = await db.execute(q)
    items = result.scalars().all()
    category_ids = {i.category_id for i in items if i.category_id}
    category_map = {}
    if category_ids:
        rows = await db.execute(select(UOMCategory.id, UOMCategory.name).where(UOMCategory.id.in_(category_ids)))
        category_map = {row.id: row.name for row in rows}
    return [
        {
            "id": i.id,
            "category_id": i.category_id,
            "category_name": category_map.get(i.category_id),
            "name": i.name,
            "abbreviation": i.abbreviation,
            "is_active": i.is_active,
            "status": "active" if i.is_active else "inactive",
        }
        for i in items
    ]


@router.post("/uom", status_code=201)
async def create_uom(
    payload: UOMCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    # Case-insensitive duplicate check
    existing = await db.execute(
        select(UOM).where(func.lower(UOM.name) == payload.name.lower())
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"UOM with name '{payload.name}' already exists")
    if payload.category_id:
        category = (
            await db.execute(
                select(UOMCategory).where(
                    UOMCategory.id == payload.category_id,
                    UOMCategory.is_active == True,  # noqa: E712
                )
            )
        ).scalar_one_or_none()
        if not category:
            raise HTTPException(status_code=422, detail="UOM category does not exist or is inactive")
    uom = UOM(name=payload.name, abbreviation=payload.abbreviation, category_id=payload.category_id)
    # BUG-FE-085: persist optional is_active flag from the form
    if payload.is_active is not None:
        uom.is_active = bool(payload.is_active)
    db.add(uom)
    await db.flush()
    return {"id": uom.id, "message": "UOM created"}


async def _uom_in_use(db: AsyncSession, uom_id: int) -> int:
    """Count items / attributes / values referencing this UOM."""
    from app.models.master import Item, ItemAttribute, ItemAttributeValue
    q1 = await db.scalar(
        select(func.count(Item.id)).where(
            (Item.primary_uom_id == uom_id) | (Item.secondary_uom_id == uom_id)
        )
    )
    q2 = await db.scalar(
        select(func.count(ItemAttribute.id)).where(ItemAttribute.uom_id == uom_id)
    )
    q3 = await db.scalar(
        select(func.count(ItemAttributeValue.id)).where(ItemAttributeValue.uom_id == uom_id)
    )
    return int(q1 or 0) + int(q2 or 0) + int(q3 or 0)


@router.put("/uom/{uom_id}")
async def update_uom(
    uom_id: int,
    payload: UOMCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    result = await db.execute(select(UOM).where(UOM.id == uom_id))
    uom = result.scalar_one_or_none()
    if not uom:
        raise HTTPException(status_code=404, detail="UOM not found")
    # UOM name/abbreviation are locked once in use, but category tagging is
    # metadata and can be changed without invalidating existing quantities.
    in_use = await _uom_in_use(db, uom_id)
    identity_changed = (
        uom.name.strip().lower() != payload.name.strip().lower()
        or uom.abbreviation.strip().lower() != payload.abbreviation.strip().lower()
    )
    if in_use and identity_changed:
        raise HTTPException(
            status_code=409,
            detail=f"UOM is referenced by {in_use} record(s) and cannot be edited. Create a new UOM instead.",
        )
    if payload.category_id:
        category = (
            await db.execute(
                select(UOMCategory).where(
                    UOMCategory.id == payload.category_id,
                    UOMCategory.is_active == True,  # noqa: E712
                )
            )
        ).scalar_one_or_none()
        if not category:
            raise HTTPException(status_code=422, detail="UOM category does not exist or is inactive")
    uom.category_id = payload.category_id
    uom.name = payload.name
    uom.abbreviation = payload.abbreviation
    # BUG-FE-085: also accept is_active updates from the UI
    if payload.is_active is not None:
        uom.is_active = bool(payload.is_active)
    await db.flush()
    return {"id": uom.id, "message": "UOM updated"}


@router.delete("/uom/{uom_id}")
async def delete_uom(
    uom_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    result = await db.execute(select(UOM).where(UOM.id == uom_id))
    uom = result.scalar_one_or_none()
    if not uom:
        raise HTTPException(status_code=404, detail="UOM not found")
    in_use = await _uom_in_use(db, uom_id)
    if in_use:
        raise HTTPException(
            status_code=409,
            detail=f"UOM is referenced by {in_use} record(s) and cannot be deleted.",
        )
    uom.is_active = False
    await db.flush()
    # BUG-FE-084: this is a soft-deactivate, not a hard delete. Return the
    # accurate message so callers don't think the row is gone.
    return {"message": "UOM deactivated"}


@router.get("/uom-conversions")
async def list_uom_conversions(
    include_history: bool = Query(False),
    category_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    as_of = _utcnow()
    q = select(UOMConversion).order_by(UOMConversion.category_id, UOMConversion.from_uom_id, UOMConversion.to_uom_id)
    if not include_history:
        q = q.where(UOMConversion.valid_from <= as_of, or_(UOMConversion.valid_to.is_(None), UOMConversion.valid_to > as_of))
    if category_id is not None:
        q = q.where(UOMConversion.category_id == category_id)
    result = await db.execute(
        q
    )
    conversions = result.scalars().all()
    uom_ids = {c.from_uom_id for c in conversions} | {c.to_uom_id for c in conversions}
    uom_map = {}
    if uom_ids:
        rows = (await db.execute(select(UOM).where(UOM.id.in_(uom_ids)))).scalars().all()
        uom_map = {row.id: row for row in rows}
    items = []
    for conv in conversions:
        from_uom = uom_map.get(conv.from_uom_id)
        to_uom = uom_map.get(conv.to_uom_id)
        items.append({
            "id": conv.id,
            "category_id": conv.category_id,
            "from_uom_id": conv.from_uom_id,
            "to_uom_id": conv.to_uom_id,
            "from_uom": {"id": from_uom.id, "name": from_uom.name, "abbreviation": from_uom.abbreviation} if from_uom else None,
            "to_uom": {"id": to_uom.id, "name": to_uom.name, "abbreviation": to_uom.abbreviation} if to_uom else None,
            "from_uom_name": from_uom.name if from_uom else None,
            "to_uom_name": to_uom.name if to_uom else None,
            "factor_num": str(conv.factor_num),
            "factor_den": str(conv.factor_den),
            "conversion_factor": str(conv.conversion_factor),
            "valid_from": conv.valid_from,
            "valid_to": conv.valid_to,
            "is_system": bool(conv.is_system),
        })
    return items


def _validate_uom_conversion(payload: UOMConversionCreate) -> None:
    # BUG-FE-087: forbid self-conversion (kg→kg = 5.0 used to be accepted).
    if payload.from_uom_id == payload.to_uom_id:
        raise HTTPException(
            status_code=422,
            detail="from_uom and to_uom must be different",
        )
    _factor_parts(payload)


async def _load_uom_pair(db: AsyncSession, from_uom_id: int, to_uom_id: int) -> tuple[UOM, UOM]:
    rows = (await db.execute(select(UOM).where(UOM.id.in_([from_uom_id, to_uom_id])))).scalars().all()
    uoms = {row.id: row for row in rows}
    from_uom = uoms.get(from_uom_id)
    to_uom = uoms.get(to_uom_id)
    if not from_uom or not to_uom:
        raise HTTPException(status_code=422, detail="Both UOMs must exist")
    if not from_uom.is_active or not to_uom.is_active:
        raise HTTPException(status_code=422, detail="Both UOMs must be active")
    return from_uom, to_uom


async def _active_global_conversion(
    db: AsyncSession,
    from_uom_id: int,
    to_uom_id: int,
    as_of: datetime | None = None,
) -> UOMConversion | None:
    as_of = as_of or _utcnow()
    return (
        await db.execute(
            select(UOMConversion).where(
                UOMConversion.from_uom_id == from_uom_id,
                UOMConversion.to_uom_id == to_uom_id,
                UOMConversion.valid_from <= as_of,
                or_(UOMConversion.valid_to.is_(None), UOMConversion.valid_to > as_of),
            )
        )
    ).scalar_one_or_none()


async def _conversion_edges(db: AsyncSession, item_id: int | None, as_of: datetime) -> dict[int, list[tuple[int, Decimal, str]]]:
    edges: dict[int, list[tuple[int, Decimal, str]]] = {}
    global_rows = (
        await db.execute(
            select(UOMConversion).where(
                UOMConversion.valid_from <= as_of,
                or_(UOMConversion.valid_to.is_(None), UOMConversion.valid_to > as_of),
            )
        )
    ).scalars().all()
    for row in global_rows:
        factor = _as_decimal(row.conversion_factor)
        edges.setdefault(row.from_uom_id, []).append((row.to_uom_id, factor, "global"))
        edges.setdefault(row.to_uom_id, []).append((row.from_uom_id, Decimal("1") / factor, "global-reciprocal"))
    if item_id:
        item_rows = (
            await db.execute(
                select(ItemUOMConversion).where(
                    ItemUOMConversion.item_id == item_id,
                    ItemUOMConversion.is_active == True,  # noqa: E712
                    ItemUOMConversion.valid_from <= as_of,
                    or_(ItemUOMConversion.valid_to.is_(None), ItemUOMConversion.valid_to > as_of),
                )
            )
        ).scalars().all()
        for row in item_rows:
            factor = _as_decimal(row.conversion_factor)
            edges.setdefault(row.from_uom_id, []).append((row.to_uom_id, factor, row.conversion_type or "item"))
            edges.setdefault(row.to_uom_id, []).append((row.from_uom_id, Decimal("1") / factor, row.conversion_type or "item-reciprocal"))
    return edges


async def _find_conversion_factor(
    db: AsyncSession,
    from_uom_id: int,
    to_uom_id: int,
    item_id: int | None = None,
    as_of: datetime | None = None,
    ignored_pair: tuple[int, int] | None = None,
) -> tuple[Decimal | None, list[int]]:
    as_of = as_of or _utcnow()
    edges = await _conversion_edges(db, item_id, as_of)
    if ignored_pair:
        a, b = ignored_pair
        edges[a] = [(n, f, s) for n, f, s in edges.get(a, []) if n != b]
        edges[b] = [(n, f, s) for n, f, s in edges.get(b, []) if n != a]
    queue = [(from_uom_id, Decimal("1"), [from_uom_id])]
    visited = {from_uom_id}
    while queue:
        node, factor, path = queue.pop(0)
        if node == to_uom_id:
            return factor, path
        for neighbor, edge_factor, _source in edges.get(node, []):
            if neighbor in visited:
                continue
            visited.add(neighbor)
            queue.append((neighbor, factor * edge_factor, [*path, neighbor]))
    return None, []


async def _validate_global_conversion_business_rules(
    db: AsyncSession,
    payload: UOMConversionCreate,
    exclude_pair: tuple[int, int] | None = None,
) -> tuple[UOM, UOM, int, Decimal, Decimal, Decimal]:
    _validate_uom_conversion(payload)
    factor_num, factor_den, factor = _factor_parts(payload)
    from_uom, to_uom = await _load_uom_pair(db, payload.from_uom_id, payload.to_uom_id)
    if not from_uom.category_id or not to_uom.category_id:
        raise HTTPException(status_code=422, detail="Both UOMs must belong to a UOM category before conversion")
    if from_uom.category_id != to_uom.category_id:
        raise HTTPException(status_code=422, detail="Global UOM conversions cannot cross categories. Use item UOM conversions for density/yield/width bridges.")
    category_id = payload.category_id or from_uom.category_id
    if category_id != from_uom.category_id:
        raise HTTPException(status_code=422, detail="Conversion category must match the selected UOMs")
    implied, path = await _find_conversion_factor(
        db,
        payload.from_uom_id,
        payload.to_uom_id,
        as_of=payload.valid_from or _utcnow(),
        ignored_pair=exclude_pair,
    )
    if implied is not None and not _factors_match(implied, factor):
        raise HTTPException(
            status_code=409,
            detail=f"Math inconsistency. Existing route {path} implies 1 from UOM = {implied} to UOM, but entered {factor}.",
        )
    return from_uom, to_uom, category_id, factor_num, factor_den, factor


@router.post("/uom-conversions", status_code=201)
async def create_uom_conversion(
    payload: UOMConversionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    _from_uom, _to_uom, category_id, factor_num, factor_den, factor = await _validate_global_conversion_business_rules(db, payload)
    existing = await _active_global_conversion(db, payload.from_uom_id, payload.to_uom_id, payload.valid_from)
    if existing:
        raise HTTPException(
            status_code=409,
            detail="Conversion for this UOM pair already exists"
        )
    inverse = await _active_global_conversion(db, payload.to_uom_id, payload.from_uom_id, payload.valid_from)
    if inverse:
        inverse_factor = Decimal("1") / _as_decimal(inverse.conversion_factor)
        if not _factors_match(inverse_factor, factor):
            raise HTTPException(
                status_code=409,
                detail=f"Math inconsistency. Existing inverse implies factor {inverse_factor}, but entered {factor}.",
            )
        return {
            "id": inverse.id,
            "message": "Inverse conversion already exists. Record not duplicated.",
            "notice": "Conversion stored through the reciprocal record.",
        }
    valid_from = payload.valid_from or _utcnow()
    conv = UOMConversion(
        category_id=category_id,
        from_uom_id=payload.from_uom_id,
        to_uom_id=payload.to_uom_id,
        factor_num=factor_num,
        factor_den=factor_den,
        conversion_factor=factor,
        valid_from=valid_from,
        valid_to=payload.valid_to,
        is_system=bool(payload.is_system),
    )
    reciprocal = UOMConversion(
        category_id=category_id,
        from_uom_id=payload.to_uom_id,
        to_uom_id=payload.from_uom_id,
        factor_num=factor_den,
        factor_den=factor_num,
        conversion_factor=Decimal("1") / factor,
        valid_from=valid_from,
        valid_to=payload.valid_to,
        is_system=bool(payload.is_system),
    )
    db.add(conv)
    db.add(reciprocal)
    await db.flush()
    return {"id": conv.id, "reciprocal_id": reciprocal.id, "message": "UOM conversion created"}


@router.put("/uom-conversions/{conv_id}")
async def update_uom_conversion(
    conv_id: int,
    payload: UOMConversionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    _from_uom, _to_uom, category_id, factor_num, factor_den, factor = await _validate_global_conversion_business_rules(
        db,
        payload,
        exclude_pair=(payload.from_uom_id, payload.to_uom_id),
    )
    result = await db.execute(select(UOMConversion).where(UOMConversion.id == conv_id))
    conv = result.scalar_one_or_none()
    if not conv:
        raise HTTPException(status_code=404, detail="UOM conversion not found")

    active_dup = await _active_global_conversion(db, payload.from_uom_id, payload.to_uom_id, payload.valid_from)
    if active_dup and active_dup.id != conv_id:
        raise HTTPException(status_code=409, detail="Another active conversion for this UOM pair already exists")
    now = _utcnow()
    conv.valid_to = now
    db.add(UOMConversion(
        category_id=category_id,
        from_uom_id=payload.from_uom_id,
        to_uom_id=payload.to_uom_id,
        factor_num=factor_num,
        factor_den=factor_den,
        conversion_factor=factor,
        valid_from=payload.valid_from or now,
        valid_to=payload.valid_to,
        is_system=bool(payload.is_system),
    ))
    await db.flush()
    return {"id": conv.id, "message": "UOM conversion superseded with a new effective-dated row"}


@router.delete("/uom-conversions/{conv_id}")
async def delete_uom_conversion(
    conv_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    result = await db.execute(select(UOMConversion).where(UOMConversion.id == conv_id))
    conv = result.scalar_one_or_none()
    if not conv:
        raise HTTPException(status_code=404, detail="UOM conversion not found")
    if conv.is_system:
        raise HTTPException(status_code=409, detail="System conversion cannot be deleted")
    conv.valid_to = _utcnow()
    await db.flush()
    return {"message": "UOM conversion expired"}


@router.get("/uom-conversions/convert")
async def convert_uom_quantity(
    from_uom_id: int,
    to_uom_id: int,
    quantity: Decimal = Query(1),
    item_id: int = Query(None),
    as_of: datetime = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    if from_uom_id == to_uom_id:
        return {"quantity": str(quantity), "factor": "1", "path": [from_uom_id]}
    from_uom, to_uom = await _load_uom_pair(db, from_uom_id, to_uom_id)
    if from_uom.category_id != to_uom.category_id and not item_id:
        raise HTTPException(status_code=422, detail="Cross-category conversion requires item_id")
    factor, path = await _find_conversion_factor(db, from_uom_id, to_uom_id, item_id=item_id, as_of=as_of or _utcnow())
    if factor is None:
        raise HTTPException(status_code=404, detail="No conversion route found")
    return {
        "quantity": str(quantity * factor),
        "factor": str(factor),
        "path": path,
        "item_id": item_id,
    }


@router.get("/item-uom-conversions")
async def list_item_uom_conversions(
    item_id: int = Query(None),
    include_history: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    as_of = _utcnow()
    q = select(ItemUOMConversion).order_by(ItemUOMConversion.item_id, ItemUOMConversion.from_uom_id)
    if item_id is not None:
        q = q.where(ItemUOMConversion.item_id == item_id)
    if not include_history:
        q = q.where(
            ItemUOMConversion.is_active == True,  # noqa: E712
            ItemUOMConversion.valid_from <= as_of,
            or_(ItemUOMConversion.valid_to.is_(None), ItemUOMConversion.valid_to > as_of),
        )
    rows = (await db.execute(q)).scalars().all()
    uom_ids = {r.from_uom_id for r in rows} | {r.to_uom_id for r in rows}
    item_ids = {r.item_id for r in rows}
    uom_map = {}
    item_map = {}
    if uom_ids:
        uom_rows = (await db.execute(select(UOM).where(UOM.id.in_(uom_ids)))).scalars().all()
        uom_map = {row.id: row for row in uom_rows}
    if item_ids:
        item_rows = (await db.execute(select(Item.id, Item.name, Item.item_code).where(Item.id.in_(item_ids)))).all()
        item_map = {row.id: row for row in item_rows}
    return [
        {
            "id": row.id,
            "item_id": row.item_id,
            "item_name": item_map.get(row.item_id).name if row.item_id in item_map else None,
            "item_code": item_map.get(row.item_id).item_code if row.item_id in item_map else None,
            "from_uom_id": row.from_uom_id,
            "to_uom_id": row.to_uom_id,
            "from_uom_name": uom_map.get(row.from_uom_id).name if row.from_uom_id in uom_map else None,
            "to_uom_name": uom_map.get(row.to_uom_id).name if row.to_uom_id in uom_map else None,
            "conversion_type": row.conversion_type,
            "factor_num": str(row.factor_num),
            "factor_den": str(row.factor_den),
            "conversion_factor": str(row.conversion_factor),
            "valid_from": row.valid_from,
            "valid_to": row.valid_to,
            "is_active": row.is_active,
        }
        for row in rows
    ]


@router.post("/item-uom-conversions", status_code=201)
async def create_item_uom_conversion(
    payload: ItemUOMConversionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    item = (await db.execute(select(Item).where(Item.id == payload.item_id, Item.is_active == True))).scalar_one_or_none()  # noqa: E712
    if not item:
        raise HTTPException(status_code=422, detail="Item does not exist or is inactive")
    await _load_uom_pair(db, payload.from_uom_id, payload.to_uom_id)
    factor_num, factor_den, factor = _factor_parts(payload)
    active = (
        await db.execute(
            select(ItemUOMConversion).where(
                ItemUOMConversion.item_id == payload.item_id,
                ItemUOMConversion.from_uom_id == payload.from_uom_id,
                ItemUOMConversion.to_uom_id == payload.to_uom_id,
                ItemUOMConversion.is_active == True,  # noqa: E712
                or_(ItemUOMConversion.valid_to.is_(None), ItemUOMConversion.valid_to > (payload.valid_from or _utcnow())),
            )
        )
    ).scalar_one_or_none()
    if active:
        raise HTTPException(status_code=409, detail="Active item UOM conversion for this pair already exists")
    row = ItemUOMConversion(
        item_id=payload.item_id,
        from_uom_id=payload.from_uom_id,
        to_uom_id=payload.to_uom_id,
        conversion_type=payload.conversion_type,
        factor_num=factor_num,
        factor_den=factor_den,
        conversion_factor=factor,
        valid_from=payload.valid_from or _utcnow(),
        valid_to=payload.valid_to,
        is_active=True if payload.is_active is None else bool(payload.is_active),
    )
    db.add(row)
    await db.flush()
    return {"id": row.id, "message": "Item UOM conversion created"}


@router.put("/item-uom-conversions/{conv_id}")
async def update_item_uom_conversion(
    conv_id: int,
    payload: ItemUOMConversionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    row = (await db.execute(select(ItemUOMConversion).where(ItemUOMConversion.id == conv_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Item UOM conversion not found")
    factor_num, factor_den, factor = _factor_parts(payload)
    now = _utcnow()
    row.valid_to = now
    row.is_active = False
    db.add(ItemUOMConversion(
        item_id=payload.item_id,
        from_uom_id=payload.from_uom_id,
        to_uom_id=payload.to_uom_id,
        conversion_type=payload.conversion_type,
        factor_num=factor_num,
        factor_den=factor_den,
        conversion_factor=factor,
        valid_from=payload.valid_from or now,
        valid_to=payload.valid_to,
        is_active=True if payload.is_active is None else bool(payload.is_active),
    ))
    await db.flush()
    return {"id": conv_id, "message": "Item UOM conversion superseded with a new effective-dated row"}


@router.delete("/item-uom-conversions/{conv_id}")
async def delete_item_uom_conversion(
    conv_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_uom_enterprise_schema(db)
    row = (await db.execute(select(ItemUOMConversion).where(ItemUOMConversion.id == conv_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Item UOM conversion not found")
    row.is_active = False
    row.valid_to = _utcnow()
    await db.flush()
    return {"message": "Item UOM conversion expired"}


async def _get_parent_category_ids(db: AsyncSession, category_id: int) -> list[int]:
    """Return a list of category IDs including the given ID and all its parents."""
    ids = [category_id]
    current_id = category_id
    # Max depth safety to prevent infinite loops if circularity exists
    for _ in range(20):
        res = await db.execute(select(ItemCategory.parent_id).where(ItemCategory.id == current_id))
        pid = res.scalar_one_or_none()
        if pid and pid not in ids:
            ids.append(pid)
            current_id = pid
        else:
            break
    return ids


async def _get_descendant_category_ids(db: AsyncSession, category_id: int) -> list[int]:
    """Return a list of category IDs including the given ID and all its active descendants."""
    ids = [category_id]
    # Level 1 to 2
    res = await db.execute(
        select(ItemCategory.id)
        .where(ItemCategory.parent_id == category_id, ItemCategory.is_active == True)
    )
    level2_ids = [row[0] for row in res.all()]
    if level2_ids:
        ids.extend(level2_ids)
        # Level 2 to 3
        res3 = await db.execute(
            select(ItemCategory.id)
            .where(ItemCategory.parent_id.in_(level2_ids), ItemCategory.is_active == True)
        )
        level3_ids = [row[0] for row in res3.all()]
        if level3_ids:
            ids.extend(level3_ids)
    return ids



async def _category_level(db: AsyncSession, parent_id: int | None) -> int:
    if not parent_id:
        return 1
    parent = (await db.execute(select(ItemCategory).where(ItemCategory.id == parent_id))).scalar_one_or_none()
    if not parent:
        raise HTTPException(status_code=422, detail="Parent category not found")
    if (parent.level or 1) >= 3:
        raise HTTPException(status_code=422, detail="Only three category levels are allowed")
    return (parent.level or 1) + 1


async def _category_full_code(db: AsyncSession, short_code: str, parent_id: int | None) -> str:
    short_code = (short_code or "").strip()
    if not re.match(r"^[1-9][0-9]$", short_code):
        raise HTTPException(status_code=422, detail="Short code must be a two-digit number from 10 to 99")
    if not parent_id:
        return short_code
    parent = (await db.execute(select(ItemCategory).where(ItemCategory.id == parent_id))).scalar_one_or_none()
    if not parent:
        raise HTTPException(status_code=422, detail="Parent category not found")
    if not parent.full_code:
        raise HTTPException(status_code=422, detail="Parent category is missing full code")
    full_code = f"{parent.full_code}{short_code}"
    if len(full_code) > 6:
        raise HTTPException(status_code=422, detail="Only three category levels are allowed")
    return full_code


async def _refresh_descendant_full_codes(db: AsyncSession, category: ItemCategory) -> None:
    children = (
        await db.execute(select(ItemCategory).where(ItemCategory.parent_id == category.id))
    ).scalars().all()
    for child in children:
        child.level = (category.level or 1) + 1
        child.full_code = f"{category.full_code}{child.short_code}"
        if len(child.full_code or "") > 6:
            raise HTTPException(status_code=422, detail="Only three category levels are allowed")
        await _refresh_descendant_full_codes(db, child)


async def _generate_category_short_code(db: AsyncSession, parent_id: int | None) -> str:
    """Generate the next available two-digit short code (10-99) under the given parent."""
    res = await db.execute(
        select(ItemCategory.short_code)
        .where(ItemCategory.parent_id == parent_id)
    )
    existing_codes = {int(code) for (code,) in res if code and code.isdigit()}
    # Start from 10
    for code in range(10, 100):
        if code not in existing_codes:
            return f"{code:02d}"
    raise HTTPException(status_code=422, detail="No more short codes available under this parent (max 90 categories allowed)")


# ==================== ITEM CATEGORIES ====================

@router.get("/categories")
async def list_categories(
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_item_category_code_schema(db)
    query = select(ItemCategory).where(ItemCategory.is_active == True).order_by(ItemCategory.name)
    query = apply_search_filter(query, ItemCategory, search, ["name", "code"])
    result = await db.execute(query)
    items = result.scalars().all()
    return [CategoryResponse.model_validate(i) for i in items]


@router.post("/categories", status_code=201)
async def create_category(
    payload: CategoryCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_item_category_code_schema(db)
    data = payload.model_dump()
    
    # Auto-generate short_code if missing
    if not data.get("short_code"):
        data["short_code"] = await _generate_category_short_code(db, data.get("parent_id"))

    data["level"] = await _category_level(db, data.get("parent_id"))
    data["full_code"] = await _category_full_code(db, data["short_code"], data.get("parent_id"))
    
    dup_short = await db.execute(
        select(ItemCategory).where(
            ItemCategory.parent_id == data.get("parent_id"),
            ItemCategory.short_code == data["short_code"],
        )
    )
    if dup_short.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Short code '{data['short_code']}' already exists under this parent")
    
    dup_full = await db.execute(select(ItemCategory).where(ItemCategory.full_code == data["full_code"]))
    if dup_full.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Full code '{data['full_code']}' already exists")
    # Auto-generate code if not provided
    if not data.get("code"):
        import re, unicodedata
        # BUG-FE-042: strip diacritics so "Médi" → "MED" rather than "" (regex
        # would drop accented chars and yield an empty prefix).
        raw_name = data.get("name") or "CAT"
        normalized = unicodedata.normalize("NFKD", raw_name)
        ascii_name = normalized.encode("ascii", "ignore").decode("ascii")
        prefix = re.sub(r'[^A-Z0-9]', '', ascii_name[:3].upper()) or "CAT"
        count_result = await db.execute(select(func.count(ItemCategory.id)))
        count = count_result.scalar() or 0
        data["code"] = f"{prefix}-{count + 1:04d}"
    # BUG-FE-043: case-insensitive uniqueness check
    code_val = (data.get("code") or "").strip()
    existing = await db.execute(
        select(ItemCategory).where(func.lower(ItemCategory.code) == code_val.lower())
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Category with code '{code_val}' already exists")
    data["code"] = code_val.upper()
    cat = ItemCategory(**data)
    db.add(cat)
    await db.flush()
    return {"id": cat.id, "message": "Category created"}


@router.put("/categories/{category_id}")
async def update_category(
    category_id: int,
    payload: CategoryCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_item_category_code_schema(db)
    result = await db.execute(select(ItemCategory).where(ItemCategory.id == category_id))
    cat = result.scalar_one_or_none()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    update_data = payload.model_dump(exclude_unset=True)
    parent_id = update_data.get("parent_id", cat.parent_id)
    short_code = update_data.get("short_code", cat.short_code)
    if "parent_id" in update_data or "short_code" in update_data:
        update_data["level"] = await _category_level(db, parent_id)
        update_data["full_code"] = await _category_full_code(db, short_code, parent_id)
        dup_short = await db.execute(
            select(ItemCategory).where(
                ItemCategory.parent_id == parent_id,
                ItemCategory.short_code == short_code,
                ItemCategory.id != category_id,
            )
        )
        if dup_short.scalar_one_or_none():
            raise HTTPException(status_code=409, detail=f"Short code '{short_code}' already exists under this parent")
        dup_full = await db.execute(
            select(ItemCategory).where(ItemCategory.full_code == update_data["full_code"], ItemCategory.id != category_id)
        )
        if dup_full.scalar_one_or_none():
            raise HTTPException(status_code=409, detail=f"Full code '{update_data['full_code']}' already exists")
    # BUG-FE-046: never clear a NOT NULL column with empty string from PUT.
    if "code" in update_data:
        new_code = (update_data["code"] or "").strip()
        if not new_code:
            update_data.pop("code")
        else:
            # BUG-FE-043: case-insensitive duplicate check on rename
            dup = await db.execute(
                select(ItemCategory).where(
                    func.lower(ItemCategory.code) == new_code.lower(),
                    ItemCategory.id != category_id,
                )
            )
            if dup.scalar_one_or_none():
                raise HTTPException(status_code=409, detail=f"Category with code '{new_code}' already exists")
            update_data["code"] = new_code.upper()
    # BUG-FE-041: refuse silent deactivate via PUT when items still reference it
    if update_data.get("is_active") is False and cat.is_active is True:
        item_count = (await db.execute(
            select(func.count(Item.id)).where(Item.category_id == category_id, Item.is_active == True)
        )).scalar() or 0
        if item_count > 0:
            raise HTTPException(
                status_code=409,
                detail=f"Cannot deactivate category — {item_count} active item(s) still reference it. Use the dedicated delete endpoint with explicit confirmation.",
            )
    for k, v in update_data.items():
        setattr(cat, k, v)
    if "parent_id" in update_data or "short_code" in update_data:
        await _refresh_descendant_full_codes(db, cat)
    await db.flush()
    return {"success": True, "message": "Category updated"}


@router.delete("/categories/{category_id}")
async def delete_category(
    category_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(ItemCategory).where(ItemCategory.id == category_id))
    cat = result.scalar_one_or_none()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    # Check if items exist in this category
    item_count = (await db.execute(select(func.count(Item.id)).where(Item.category_id == category_id))).scalar()
    if item_count > 0:
        raise HTTPException(status_code=409, detail=f"Cannot delete category with {item_count} items. Move or delete items first.")
    # Check for child categories
    child_count = (await db.execute(select(func.count(ItemCategory.id)).where(ItemCategory.parent_id == category_id))).scalar()
    if child_count > 0:
        raise HTTPException(status_code=409, detail=f"Cannot delete category with {child_count} sub-categories. Delete sub-categories first.")
    cat.is_active = False
    await db.flush()
    return {"success": True, "message": "Category deactivated"}


# ==================== ITEMS ====================

async def _check_items_view_permission(db: AsyncSession, current_user: User) -> None:
    """BUG-FE-001: items expose price/MRP/HSN — gate to roles that legitimately
    need this. Mirrors vendor pattern in list_vendors."""
    from app.utils.dependencies import get_user_permissions, get_user_role_codes
    role_codes = await get_user_role_codes(db, current_user.id)
    if "super_admin" in role_codes or "admin" in role_codes:
        return
    perms = set(await get_user_permissions(db, current_user.id))
    allowed_modules = {
        "masters", "masters-items", "procurement", "procurement-purchase-orders",
        "procurement-material-requests", "procurement-quotations", "procurement-indents",
        "indent", "indent-indents", "consumption", "consumption-entry", "warehouse",
        "warehouse-grn", "warehouse-stock", "warehouse-bins", "inventory",
        "inventory-stock-balance", "inventory-stock-ledger", "accounts", "accounts-invoices",
        "sales", "sales-orders", "sales-invoices"
    }
    has_item_access = False
    for perm in perms:
        parts = perm.split('.')
        if len(parts) == 3:
            if parts[0] in allowed_modules:
                has_item_access = True
                break
    if not has_item_access:
        raise HTTPException(status_code=403, detail="Permission denied: masters.view.items")


def _normalize_feature_ids(values: list[int] | None) -> list[int]:
    if not values:
        return []
    out = []
    seen = set()
    for v in values:
        try:
            fid = int(v)
        except (TypeError, ValueError):
            continue
        if fid <= 0 or fid in seen:
            continue
        seen.add(fid)
        out.append(fid)
    return out


async def _validate_item_features(
    db: AsyncSession,
    category_id: int | None,
    feature_ids: list[int],
) -> list[int]:
    normalized = _normalize_feature_ids(feature_ids)
    if not normalized:
        return []
    if category_id is None:
        raise HTTPException(status_code=422, detail="Category is required when selecting features")
    
    # Hierarchical feature check: get all parent category IDs
    valid_category_ids = await _get_parent_category_ids(db, category_id)
    
    rows = (await db.execute(select(Feature).where(Feature.id.in_(normalized)))).scalars().all()
    found = {f.id: f for f in rows}
    for fid in normalized:
        feature = found.get(fid)
        if not feature or not feature.is_active:
            raise HTTPException(status_code=422, detail=f"Feature {fid} does not exist or is inactive")
        if feature.category_id not in valid_category_ids:
            raise HTTPException(
                status_code=422,
                detail=f"Feature {feature.name} does not belong to the selected category or its parents",
            )
    return normalized


async def _replace_item_features(db: AsyncSession, item_id: int, feature_ids: list[int]) -> None:
    existing = (await db.execute(select(ItemFeature).where(ItemFeature.item_id == item_id))).scalars().all()
    for row in existing:
        await db.delete(row)
    for fid in feature_ids:
        db.add(ItemFeature(item_id=item_id, feature_id=fid))


async def _item_feature_ids(db: AsyncSession, item_id: int) -> list[int]:
    rows = (await db.execute(
        select(ItemFeature.feature_id).where(ItemFeature.item_id == item_id).order_by(ItemFeature.id)
    )).all()
    return [int(r[0]) for r in rows]


def _feature_payload(feature: Feature | None) -> dict | None:
    if not feature:
        return None
    return {
        "id": int(feature.id),
        "name": feature.name,
        "category_id": int(feature.category_id) if feature.category_id is not None else None,
        "is_active": bool(feature.is_active),
    }


def _resolve_feature_ids_for_item(item: Item, item_feature_map: dict[int, list[int]]) -> list[int]:
    ids = list(item_feature_map.get(int(item.id), []))
    if not ids and item.feature_id:
        ids = [int(item.feature_id)]
    return ids


async def _load_feature_maps_for_items(
    db: AsyncSession,
    item_ids: list[int],
    fallback_feature_ids: list[int],
) -> tuple[dict[int, list[int]], dict[int, Feature]]:
    item_feature_map: dict[int, list[int]] = {}
    feature_ids: set[int] = {int(fid) for fid in fallback_feature_ids if fid}

    if item_ids:
        rows = (
            await db.execute(
                select(ItemFeature.item_id, ItemFeature.feature_id)
                .where(ItemFeature.item_id.in_(item_ids))
                .order_by(ItemFeature.id)
            )
        ).all()
        for item_id, feature_id in rows:
            iid = int(item_id)
            fid = int(feature_id)
            item_feature_map.setdefault(iid, []).append(fid)
            feature_ids.add(fid)

    feature_map: dict[int, Feature] = {}
    if feature_ids:
        features = (await db.execute(select(Feature).where(Feature.id.in_(feature_ids)))).scalars().all()
        feature_map = {int(f.id): f for f in features}
    return item_feature_map, feature_map


async def _normalize_item_uom_category(db: AsyncSession, data: dict) -> None:
    category_id = data.get("uom_category_id")
    primary_uom_id = data.get("primary_uom_id")
    if not primary_uom_id:
        return

    row = (await db.execute(select(UOM.id, UOM.category_id).where(UOM.id == primary_uom_id))).first()
    if not row:
        raise HTTPException(status_code=422, detail="Primary UOM not found")

    uom_category_id = row.category_id
    if category_id and uom_category_id and int(category_id) != int(uom_category_id):
        raise HTTPException(status_code=422, detail="Primary UOM must belong to the selected UOM Category")
    if not category_id:
        data["uom_category_id"] = uom_category_id


@router.get("/items")
async def list_items(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=10000),
    search: str = Query(None),
    category_id: int = Query(None),
    feature_id: int = Query(None),
    item_type: str = Query(None),
    is_active: bool = Query(None),
    transactable: bool = Query(False, description="Only items usable in indent/MR/PO/MI flows: active + has UOM + has code + has name"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_feature_schema(db)
    await ensure_item_uom_category_schema(db)
    await ensure_item_category_code_schema(db)
    await _check_items_view_permission(db, current_user)
    offset, limit = paginate_params(page, page_size)
    query = select(Item)
    count_query = select(func.count(Item.id))

    if transactable:
        # 2026-05-06 — guard transactional flows from items missing the
        # fields required to create a line: UOM, item_code, name. Active
        # check applies regardless of the is_active param when transactable
        # is on, because an inactive item can't transact.
        query = (
            query.where(Item.is_active == True)
                 .where(Item.primary_uom_id.is_not(None))
                 .where(Item.item_code.is_not(None)).where(Item.item_code != "")
                 .where(Item.name.is_not(None)).where(Item.name != "")
        )
        count_query = (
            count_query.where(Item.is_active == True)
                       .where(Item.primary_uom_id.is_not(None))
                       .where(Item.item_code.is_not(None)).where(Item.item_code != "")
                       .where(Item.name.is_not(None)).where(Item.name != "")
        )

    if category_id:
        descendant_ids = await _get_descendant_category_ids(db, category_id)
        query = query.where(Item.category_id.in_(descendant_ids))
        count_query = count_query.where(Item.category_id.in_(descendant_ids))
    if feature_id:
        feature_match = select(ItemFeature.id).where(
            ItemFeature.item_id == Item.id,
            ItemFeature.feature_id == feature_id,
        ).exists()
        query = query.where((Item.feature_id == feature_id) | feature_match)
        count_query = count_query.where((Item.feature_id == feature_id) | feature_match)
    if item_type:
        query = query.where(Item.item_type == item_type)
        count_query = count_query.where(Item.item_type == item_type)
    # BUG-FE-008: default to active-only listing unless caller explicitly passes
    # is_active=false (admin "show inactive" toggle). Without this default the
    # main grid silently surfaces deactivated items.
    if is_active is None:
        query = query.where(Item.is_active == True)
        count_query = count_query.where(Item.is_active == True)
    else:
        query = query.where(Item.is_active == is_active)
        count_query = count_query.where(Item.is_active == is_active)

    query = apply_search_filter(query, Item, search, ["item_code", "name", "sku", "hsn_code"])
    count_query = apply_search_filter(count_query, Item, search, ["item_code", "name", "sku", "hsn_code"])

    total = (await db.execute(count_query)).scalar()
    from sqlalchemy.orm import selectinload
    result = await db.execute(
        query.options(selectinload(Item.primary_uom), selectinload(Item.category), selectinload(Item.feature))
        .offset(offset).limit(limit).order_by(Item.id.desc())
    )
    items = result.scalars().all()
    item_ids = [int(i.id) for i in items]
    fallback_feature_ids = [int(i.feature_id) for i in items if i.feature_id]
    item_feature_map, feature_map = await _load_feature_maps_for_items(db, item_ids, fallback_feature_ids)

    # Enrich response with UOM and category names for frontend
    response_items = []
    for i in items:
        data = ItemResponse.model_validate(i).model_dump()
        feature_ids = _resolve_feature_ids_for_item(i, item_feature_map)
        feature_names = [feature_map[fid].name for fid in feature_ids if fid in feature_map]
        primary_feature = feature_map.get(feature_ids[0]) if feature_ids else i.feature
        data["primary_uom_name"] = i.primary_uom.name if i.primary_uom else None
        data["primary_uom"] = {"id": i.primary_uom.id, "name": i.primary_uom.name, "abbreviation": i.primary_uom.abbreviation, "category_id": i.primary_uom.category_id} if i.primary_uom else None
        data["category_name"] = i.category.name if i.category else None
        data["category"] = {"id": i.category.id, "name": i.category.name, "code": i.category.code} if i.category else None
        data["feature_id"] = feature_ids[0] if feature_ids else None
        data["feature_ids"] = feature_ids
        data["feature_names"] = feature_names
        data["feature_name"] = feature_names[0] if feature_names else (i.feature.name if i.feature else None)
        data["feature"] = _feature_payload(primary_feature)
        response_items.append(data)

    return build_paginated_response(response_items, total, page, page_size)


@router.get("/items/{item_id}", response_model=ItemResponse)
async def get_item(
    item_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_feature_schema(db)
    await ensure_item_uom_category_schema(db)
    await _check_items_view_permission(db, current_user)
    from sqlalchemy.orm import selectinload
    result = await db.execute(select(Item).options(selectinload(Item.primary_uom)).where(Item.id == item_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    item_feature_map, feature_map = await _load_feature_maps_for_items(
        db,
        [int(item.id)],
        [int(item.feature_id)] if item.feature_id else [],
    )
    feature_ids = _resolve_feature_ids_for_item(item, item_feature_map)
    feature_names = [feature_map[fid].name for fid in feature_ids if fid in feature_map]
    data = ItemResponse.model_validate(item).model_dump()
    if item.primary_uom:
        data["primary_uom_name"] = item.primary_uom.name
        data["primary_uom"] = {"id": item.primary_uom.id, "name": item.primary_uom.name, "abbreviation": item.primary_uom.abbreviation, "category_id": item.primary_uom.category_id}
    data["feature_id"] = feature_ids[0] if feature_ids else None
    data["feature_ids"] = feature_ids
    data["feature_names"] = feature_names
    return data


@router.post("/items", status_code=201)
async def create_item(
    payload: ItemCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "create", "items")),
):
    """Item code auto-generates as L1L2L3-SEQ, e.g. 101010-001,
    if the user leaves it blank or sends 'AUTO'. A user-supplied code is
    accepted as 'manual' (must still be unique).
    """
    from app.services.item_coding import (
        generate_item_code, normalize_form_code, ORG_PREFIX_DEFAULT,
    )

    await ensure_feature_schema(db)
    await ensure_item_uom_category_schema(db)
    data = payload.model_dump()
    requested_feature_ids = data.pop("feature_ids", None)
    if requested_feature_ids is None:
        requested_feature_ids = [data.get("feature_id")] if data.get("feature_id") is not None else []
    validated_feature_ids = await _validate_item_features(db, data.get("category_id"), requested_feature_ids)
    data["feature_id"] = validated_feature_ids[0] if validated_feature_ids else None
    await _normalize_item_uom_category(db, data)
    # Normalize optional text fields that users frequently paste with spaces.

    user_code = (data.get("item_code") or "").strip()

    # Auto-generate when blank or sentinel
    if not user_code or user_code.upper() == "AUTO":
        try:
            data["item_code"] = await generate_item_code(
                db,
                category_id=data.get("category_id"),
                dosage_form=data.get("dosage_form"),
                org_prefix=ORG_PREFIX_DEFAULT,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        data["coding_status"] = "auto"
    else:
        # Manual code — verify uniqueness (case-insensitive, BUG-FE-002)
        existing = await db.execute(
            select(Item).where(func.lower(Item.item_code) == user_code.lower())
        )
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=409, detail=f"Item with code '{user_code}' already exists. Please use a unique item code.")
        # Normalize to uppercase to keep new codes consistent with existing ones
        data["item_code"] = user_code.upper()
        data["coding_status"] = "manual"

    # Always populate the form code if dosage_form is set
    if data.get("dosage_form"):
        data["dosage_form_code"] = normalize_form_code(data["dosage_form"])

    # Automatically set has_serial = True for asset/equipment types
    item_type_lower = (data.get("item_type") or "").lower()
    asset_keywords = ['asset', 'equipment', 'laptop', 'computer', 'it', 'fixed']
    if any(kw in item_type_lower for kw in asset_keywords):
        data["has_serial"] = True

    item = Item(**data, created_by=current_user.id)
    if payload.item_type == "equipment" and not payload.dosage_form:
        item.dosage_form = "unit"
    if any(kw in item_type_lower for kw in asset_keywords):
        item.has_serial = True
    db.add(item)
    await db.flush()
    await _replace_item_features(db, int(item.id), validated_feature_ids)
    return {"id": item.id, "item_code": item.item_code, "message": "Item created"}


@router.post("/items/preview-code")
async def preview_item_code(
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_item_category_code_schema(db)
    """Returns what auto-generated code WOULD be for the given category,
    without consuming a sequence number. Useful for UI preview.
    """
    from app.services.item_coding import preview_hierarchy_item_code
    try:
        return await preview_hierarchy_item_code(db, payload.get("category_id"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# Wave 11A — bulk backfill endpoint for legacy items
@router.post("/items/backfill-codes")
async def backfill_item_codes(
    dry_run: bool = True,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "items")),
):
    from app.services.item_coding import backfill_codes
    return await backfill_codes(db, dry_run=dry_run)


@router.put("/items/{item_id}")
async def update_item(
    item_id: int,
    payload: ItemUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "items")),
):
    await ensure_feature_schema(db)
    await ensure_item_uom_category_schema(db)
    result = await db.execute(select(Item).where(Item.id == item_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    update_data = payload.model_dump(exclude_unset=True)
    update_data.pop("category_id", None)
    explicit_feature_update = "feature_ids" in payload.model_fields_set or "feature_id" in payload.model_fields_set
    incoming_feature_ids = update_data.pop("feature_ids", None) if "feature_ids" in update_data else None
    incoming_feature_id = update_data.get("feature_id") if "feature_id" in update_data else None

    effective_category_id = update_data.get("category_id", item.category_id)
    current_feature_ids = await _item_feature_ids(db, int(item.id))
    if not current_feature_ids and item.feature_id:
        current_feature_ids = [int(item.feature_id)]

    if explicit_feature_update:
        requested_feature_ids = (
            incoming_feature_ids
            if incoming_feature_ids is not None
            else ([incoming_feature_id] if incoming_feature_id is not None else [])
        )
        validated_feature_ids = await _validate_item_features(db, effective_category_id, requested_feature_ids)
    else:
        validated_feature_ids = list(current_feature_ids)
        if "category_id" in update_data and validated_feature_ids:
            rows = (await db.execute(select(Feature).where(Feature.id.in_(validated_feature_ids)))).scalars().all()
            by_id = {int(r.id): r for r in rows}
            validated_feature_ids = [
                fid for fid in validated_feature_ids
                if fid in by_id and by_id[fid].is_active and by_id[fid].category_id == effective_category_id
            ]

    update_data["feature_id"] = validated_feature_ids[0] if validated_feature_ids else None
    if "primary_uom_id" in update_data:
        await _normalize_item_uom_category(db, update_data)
    else:
        uom_validation_data = dict(update_data)
        uom_validation_data["primary_uom_id"] = item.primary_uom_id
        await _normalize_item_uom_category(db, uom_validation_data)

    min_q = update_data.get("min_order_qty")
    if min_q is None:
        min_q = item.min_order_qty
    max_q = update_data.get("max_order_qty")
    if max_q is None:
        max_q = item.max_order_qty

    if min_q is not None and max_q is not None and min_q > 0 and max_q > 0 and min_q >= max_q:
        raise HTTPException(status_code=422, detail="Min order qty must be less than max order qty")

    for k, v in update_data.items():
        setattr(item, k, v)
    # Auto-set dosage_form for equipment if not explicitly provided
    if item.item_type == "equipment" and not item.dosage_form:
        item.dosage_form = "unit"

    # Automatically set has_serial = True for asset/equipment types
    item_type_lower = (item.item_type or "").lower()
    asset_keywords = ['asset', 'equipment', 'laptop', 'computer', 'it', 'fixed']
    if any(kw in item_type_lower for kw in asset_keywords):
        item.has_serial = True

    await db.flush()
    await _replace_item_features(db, int(item.id), validated_feature_ids)
    return {"success": True, "message": "Item updated"}


# ---- Item detail tab stubs (BUG-FE-021) ----
# ItemForm.jsx fires GETs at items/{id}/{stock,vendors,prices,packing,transactions}
# on tab change. Without these, every tab silently 404s and shows Empty. Provide
# minimal real-data stubs (or empty paginated envelopes) so the UI renders.

@router.get("/items/{item_id}/stock")
async def get_item_stock(
    item_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        from app.models.stock import StockBalance  # type: ignore
    except Exception:
        return build_paginated_response([], 0, page, page_size)
    offset, limit = paginate_params(page, page_size)
    total = (await db.execute(
        select(func.count(StockBalance.id)).where(StockBalance.item_id == item_id)
    )).scalar() or 0
    rows = (await db.execute(
        select(StockBalance)
        .where(StockBalance.item_id == item_id)
        .order_by(StockBalance.id.desc())
        .offset(offset).limit(limit)
    )).scalars().all()
    items = []
    for sb in rows:
        items.append({
            "id": sb.id,
            "warehouse_id": getattr(sb, "warehouse_id", None),
            "warehouse_name": None,
            "location_name": None,
            "bin_code": getattr(sb, "bin_code", None) or getattr(sb, "bin_id", None),
            "batch_number": getattr(sb, "batch_number", None),
            "quantity": float(getattr(sb, "quantity", 0) or 0),
            "reserved_qty": float(getattr(sb, "reserved_qty", 0) or 0),
            "available_qty": float(getattr(sb, "available_qty", 0) or 0),
            "valuation_amount": float(getattr(sb, "valuation_amount", 0) or 0),
        })
    return build_paginated_response(items, total, page, page_size)


@router.get("/items/{item_id}/vendors")
async def get_item_vendors(
    item_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    total = (await db.execute(
        select(func.count(VendorItem.id)).where(VendorItem.item_id == item_id)
    )).scalar() or 0
    rows = (await db.execute(
        select(VendorItem, Vendor.vendor_code, Vendor.name)
        .join(Vendor, VendorItem.vendor_id == Vendor.id, isouter=True)
        .where(VendorItem.item_id == item_id)
        .order_by(VendorItem.id.desc())
        .offset(offset).limit(limit)
    )).all()
    items = []
    for vi, vendor_code, vendor_name in rows:
        items.append({
            "id": vi.id,
            "vendor_id": vi.vendor_id,
            "vendor_code": vendor_code,
            "vendor_name": vendor_name,
            "lead_time_days": vi.lead_time_days,
            "last_price": float(vi.rate) if vi.rate is not None else None,
            "last_supplied_date": None,
            "is_preferred": vi.is_preferred,
        })
    return build_paginated_response(items, total, page, page_size)


@router.get("/items/{item_id}/prices")
async def get_item_prices(
    item_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    total = (await db.execute(
        select(func.count(PriceListItem.id)).where(PriceListItem.item_id == item_id)
    )).scalar() or 0
    rows = (await db.execute(
        select(PriceListItem, PriceList.name, PriceList.type)
        .join(PriceList, PriceListItem.price_list_id == PriceList.id, isouter=True)
        .where(PriceListItem.item_id == item_id)
        .order_by(PriceListItem.id.desc())
        .offset(offset).limit(limit)
    )).all()
    items = []
    for pli, pl_name, pl_type in rows:
        items.append({
            "id": pli.id,
            "price_list_id": pli.price_list_id,
            "price_list_name": pl_name,
            "type": pl_type,
            "rate": float(pli.rate) if pli.rate is not None else None,
            "min_qty": float(pli.min_qty) if pli.min_qty is not None else None,
            "valid_from": pli.valid_from,
            "valid_to": pli.valid_to,
        })
    return build_paginated_response(items, total, page, page_size)




@router.get("/items/{item_id}/transactions")
async def get_item_transactions(
    item_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """BUG-FE-021: minimal transactions stub. Full implementation requires
    inventory/stock-movement tables — return empty list when those models
    are missing so the UI renders 'No data' instead of silently failing."""
    try:
        from app.models.stock import StockTransaction  # type: ignore
    except Exception:
        return build_paginated_response([], 0, page, page_size)
    offset, limit = paginate_params(page, page_size)
    total = (await db.execute(
        select(func.count(StockTransaction.id)).where(StockTransaction.item_id == item_id)
    )).scalar() or 0
    rows = (await db.execute(
        select(StockTransaction)
        .where(StockTransaction.item_id == item_id)
        .order_by(StockTransaction.id.desc())
        .offset(offset).limit(limit)
    )).scalars().all()
    items = []
    for t in rows:
        items.append({
            "id": t.id,
            "transaction_date": getattr(t, "transaction_date", None) or getattr(t, "created_at", None),
            "type": getattr(t, "transaction_type", None) or getattr(t, "type", None),
            "doc_number": getattr(t, "doc_number", None),
            "quantity": float(getattr(t, "quantity", 0) or 0),
            "warehouse_id": getattr(t, "warehouse_id", None),
        })
    return build_paginated_response(items, total, page, page_size)


@router.delete("/items/{item_id}")
async def deactivate_item(
    item_id: int,
    force: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "delete", "items")),
):
    """BUG-FE-005: refuse deactivation if active stock balances or vendor_items
    reference this item — would orphan rows. Pass ?force=true to override (admins
    only, when they have already cleaned up dependents)."""
    result = await db.execute(select(Item).where(Item.id == item_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    # FK guard: count live references in stock_balance and vendor_items
    refs = []
    try:
        from app.models.stock import StockBalance  # type: ignore
        sb_count = (await db.execute(
            select(func.count(StockBalance.id)).where(
                StockBalance.item_id == item_id,
                (StockBalance.total_qty != 0) | (StockBalance.reserved_qty != 0),
            )
        )).scalar() or 0
        if sb_count:
            refs.append(f"{sb_count} active stock balance(s)")
    except Exception as exc:
        print(f"Error in deactivate_item stock check: {exc}")
        pass
    vi_count = (await db.execute(
        select(func.count(VendorItem.id)).where(VendorItem.item_id == item_id)
    )).scalar() or 0
    if vi_count:
        refs.append(f"{vi_count} vendor-item link(s)")

    if refs and not force:
        has_stock = any("stock balance" in r for r in refs)
        if has_stock:
            detail_msg = "Cannot deactivate this item because there is still active stock in the warehouse. Please ensure the stock quantity is 0 before deactivating."
        else:
            detail_msg = "Cannot deactivate this item because it is currently linked to active vendors."
        raise HTTPException(
            status_code=409,
            detail=detail_msg,
        )

    item.is_active = False
    await db.flush()
    return {"success": True, "message": "Item deactivated"}


# ==================== VENDORS ====================

async def _vendor_type_maps(db: AsyncSession, vendor_ids: list[int]) -> tuple[dict[int, list[VendorType]], dict[int, VendorType]]:
    if not vendor_ids:
        return {}, {}
    rows = (
        await db.execute(
            select(VendorVendorType.vendor_id, VendorType)
            .join(VendorType, VendorVendorType.vendor_type_id == VendorType.id)
            .where(VendorVendorType.vendor_id.in_(vendor_ids))
            .order_by(VendorType.name)
        )
    ).all()
    type_map: dict[int, list[VendorType]] = {}
    for vendor_id, vendor_type in rows:
        type_map.setdefault(vendor_id, []).append(vendor_type)
    primary_rows = (
        await db.execute(
            select(Vendor.id, VendorType)
            .join(VendorType, Vendor.vendor_type_id == VendorType.id, isouter=True)
            .where(Vendor.id.in_(vendor_ids))
        )
    ).all()
    primary_map = {vendor_id: vendor_type for vendor_id, vendor_type in primary_rows if vendor_type}
    return type_map, primary_map


async def _vendor_category_map(db: AsyncSession, vendor_ids: list[int]) -> dict[int, VendorCategory]:
    if not vendor_ids:
        return {}
    rows = (
        await db.execute(
            select(Vendor.id, VendorCategory)
            .join(VendorCategory, Vendor.vendor_category_id == VendorCategory.id, isouter=True)
            .where(Vendor.id.in_(vendor_ids))
        )
    ).all()
    return {vendor_id: category for vendor_id, category in rows if category}


async def _validate_vendor_category(db: AsyncSession, vendor_category_id: int | None) -> None:
    if vendor_category_id is None:
        return
    category = (
        await db.execute(
            select(VendorCategory).where(
                VendorCategory.id == vendor_category_id,
                VendorCategory.is_active == True,  # noqa: E712
            )
        )
    ).scalar_one_or_none()
    if not category:
        raise HTTPException(status_code=422, detail="Vendor category does not exist or is inactive")


def _vendor_response_dict(
    vendor: Vendor,
    type_map: dict[int, list[VendorType]],
    primary_map: dict[int, VendorType],
    category_map: dict[int, VendorCategory] | None = None,
    login_vendor_ids: set[int] | None = None,
) -> dict:
    types = type_map.get(vendor.id, [])
    primary = primary_map.get(vendor.id) or (types[0] if types else None)
    category = (category_map or {}).get(vendor.id)
    return {
        "id": vendor.id,
        "vendor_code": vendor.vendor_code,
        "name": vendor.name,
        "contact_person": vendor.contact_person,
        "email": vendor.email,
        "phone": vendor.phone,
        "alt_phone": vendor.alt_phone,
        "address_line1": vendor.address_line1,
        "address_line2": vendor.address_line2,
        "city": vendor.city,
        "state": vendor.state,
        "pincode": vendor.pincode,
        "country": vendor.country,
        "gst_number": vendor.gst_number,
        "pan_number": vendor.pan_number,
        "bank_name": vendor.bank_name,
        "bank_account": vendor.bank_account,
        "bank_ifsc": vendor.bank_ifsc,
        "payment_terms_days": vendor.payment_terms_days,
        "credit_limit": vendor.credit_limit,
        "vendor_type": primary.code if primary else vendor.vendor_type,
        "vendor_type_id": vendor.vendor_type_id,
        "vendor_type_name": primary.name if primary else None,
        "vendor_type_ids": [t.id for t in types],
        "vendor_types": [VendorTypeResponse.model_validate(t) for t in types],
        "vendor_category_id": vendor.vendor_category_id,
        "vendor_category_code": category.code if category else None,
        "vendor_category_name": category.name if category else None,
        "vendor_category": VendorCategoryResponse.model_validate(category) if category else None,
        "rating": vendor.rating,
        "is_transport_vendor": vendor.is_transport_vendor,
        "drug_license_number": vendor.drug_license_number,
        "drug_license_state": vendor.drug_license_state,
        "drug_license_expiry": vendor.drug_license_expiry,
        "gst_certificate_url": vendor.gst_certificate_url,
        "license_doc_url": vendor.license_doc_url,
        "vendor_compliance_status": vendor.vendor_compliance_status,
        "is_active": vendor.is_active,
        "has_login": (login_vendor_ids is not None and vendor.id in login_vendor_ids),
        "status": "active" if vendor.is_active else "inactive",
        "created_at": vendor.created_at,
    }


async def _sync_vendor_type_links(db: AsyncSession, vendor: Vendor, vendor_type_ids: list[int] | None, vendor_type_id: int | None = None) -> None:
    raw_ids = list(vendor_type_ids or [])
    if vendor_type_id:
        raw_ids.insert(0, vendor_type_id)
    seen = []
    for type_id in raw_ids:
        if type_id and type_id not in seen:
            seen.append(type_id)
    if not seen and vendor.vendor_type:
        legacy = (
            await db.execute(select(VendorType).where(VendorType.code == vendor.vendor_type))
        ).scalar_one_or_none()
        if legacy:
            seen = [legacy.id]
    if seen:
        count = await db.scalar(
            select(func.count(VendorType.id)).where(
                VendorType.id.in_(seen),
                VendorType.is_active == True,  # noqa: E712
            )
        )
        if int(count or 0) != len(seen):
            raise HTTPException(status_code=422, detail="One or more vendor types do not exist or are inactive")
    await db.execute(text("DELETE FROM vendor_vendor_types WHERE vendor_id = :vendor_id"), {"vendor_id": vendor.id})
    for type_id in seen:
        db.add(VendorVendorType(vendor_id=vendor.id, vendor_type_id=type_id))
    vendor.vendor_type_id = seen[0] if seen else None
    if seen:
        primary = (await db.execute(select(VendorType).where(VendorType.id == seen[0]))).scalar_one()
        vendor.vendor_type = primary.code if primary.code in VALID_VENDOR_TYPES else "material"


@router.get("/vendor-categories")
async def list_vendor_categories(
    include_inactive: bool = Query(False),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_vendor_type_schema(db)
    q = select(VendorCategory).order_by(VendorCategory.name)
    if not include_inactive:
        q = q.where(VendorCategory.is_active == True)  # noqa: E712
    if search:
        like = f"%{search}%"
        q = q.where((VendorCategory.name.ilike(like)) | (VendorCategory.code.ilike(like)))
    rows = (await db.execute(q)).scalars().all()
    return [VendorCategoryResponse.model_validate(row) for row in rows]


@router.post("/vendor-categories", status_code=201)
async def create_vendor_category(
    payload: VendorCategoryCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "create", "vendors")),
):
    await ensure_vendor_type_schema(db)
    existing = (
        await db.execute(select(VendorCategory).where(func.lower(VendorCategory.code) == payload.code.lower()))
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail=f"Vendor category code '{payload.code}' already exists")
    row = VendorCategory(
        code=payload.code,
        name=payload.name,
        description=payload.description,
        is_active=True if payload.is_active is None else bool(payload.is_active),
    )
    db.add(row)
    await db.flush()
    return {"id": row.id, "message": "Vendor category created"}


@router.put("/vendor-categories/{vendor_category_id}")
async def update_vendor_category(
    vendor_category_id: int,
    payload: VendorCategoryCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "vendors")),
):
    await ensure_vendor_type_schema(db)
    row = (await db.execute(select(VendorCategory).where(VendorCategory.id == vendor_category_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Vendor category not found")
    dup = (
        await db.execute(
            select(VendorCategory).where(
                func.lower(VendorCategory.code) == payload.code.lower(),
                VendorCategory.id != vendor_category_id,
            )
        )
    ).scalar_one_or_none()
    if dup:
        raise HTTPException(status_code=409, detail=f"Vendor category code '{payload.code}' already exists")
    row.code = payload.code
    row.name = payload.name
    row.description = payload.description
    if payload.is_active is not None:
        row.is_active = bool(payload.is_active)
    await db.flush()
    return {"id": row.id, "message": "Vendor category updated"}


@router.delete("/vendor-categories/{vendor_category_id}")
async def delete_vendor_category(
    vendor_category_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "delete", "vendors")),
):
    await ensure_vendor_type_schema(db)
    row = (await db.execute(select(VendorCategory).where(VendorCategory.id == vendor_category_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Vendor category not found")
    in_use = await db.scalar(select(func.count(Vendor.id)).where(Vendor.vendor_category_id == vendor_category_id))
    if in_use:
        raise HTTPException(status_code=409, detail=f"Vendor category is linked to {int(in_use)} vendor(s)")
    row.is_active = False
    await db.flush()
    return {"message": "Vendor category deactivated"}


def _project_dict(row: Project) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "code": row.code,
        "description": row.description,
        "status": row.status,
    }


@router.get("/org-projects")
async def list_org_projects(
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_organization_structure_schema(db)
    offset, limit = paginate_params(page, page_size)
    q = select(Project).where(Project.organization_id == current_user.organization_id)
    count_q = select(func.count(Project.id)).where(Project.organization_id == current_user.organization_id)
    if search:
        like = f"%{search}%"
        q = q.where(or_(Project.name.ilike(like), Project.code.ilike(like)))
        count_q = count_q.where(or_(Project.name.ilike(like), Project.code.ilike(like)))
    total = (await db.execute(count_q)).scalar() or 0
    rows = (await db.execute(q.order_by(Project.name).offset(offset).limit(limit))).scalars().all()
    return build_paginated_response([_project_dict(row) for row in rows], total, page, page_size)


@router.post("/org-projects", status_code=201)
async def create_org_project(
    payload: ProjectMasterCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "create", "users")),
):
    await ensure_organization_structure_schema(db)
    existing = (await db.execute(select(Project).where(func.lower(Project.code) == payload.code.lower()))).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail=f"Project code '{payload.code}' already exists")
    row = Project(
        organization_id=current_user.organization_id,
        name=payload.name,
        code=payload.code,
        description=payload.description,
        status=payload.status or "active",
    )
    db.add(row)
    await db.flush()
    return {"id": row.id, "message": "Project created"}


@router.put("/org-projects/{project_id}")
async def update_org_project(
    project_id: int,
    payload: ProjectMasterCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "users")),
):
    await ensure_organization_structure_schema(db)
    row = (await db.execute(select(Project).where(Project.id == project_id, Project.organization_id == current_user.organization_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    duplicate = (await db.execute(select(Project).where(func.lower(Project.code) == payload.code.lower(), Project.id != project_id))).scalar_one_or_none()
    if duplicate:
        raise HTTPException(status_code=409, detail=f"Project code '{payload.code}' already exists")
    row.name = payload.name
    row.code = payload.code
    row.description = payload.description
    row.status = payload.status or row.status
    await db.flush()
    return {"id": row.id, "message": "Project updated"}


@router.delete("/org-projects/{project_id}")
async def delete_org_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "delete", "users")),
):
    await ensure_organization_structure_schema(db)
    row = (await db.execute(select(Project).where(Project.id == project_id, Project.organization_id == current_user.organization_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    row.status = "inactive"
    await db.flush()
    return {"message": "Project deactivated"}


@router.get("/offices")
async def list_offices(
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_organization_structure_schema(db)
    offset, limit = paginate_params(page, page_size)
    q = select(Office)
    count_q = select(func.count(Office.id))
    if search:
        like = f"%{search}%"
        condition = or_(Office.name.ilike(like), Office.state.ilike(like), Office.district.ilike(like), Office.cluster.ilike(like))
        q = q.where(condition)
        count_q = count_q.where(condition)
    total = (await db.execute(count_q)).scalar() or 0
    rows = (await db.execute(q.order_by(Office.name).offset(offset).limit(limit))).scalars().all()
    return build_paginated_response([OfficeResponse.model_validate(row).model_dump() for row in rows], total, page, page_size)


@router.post("/offices", status_code=201)
async def create_office(
    payload: OfficeCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "create", "users")),
):
    await ensure_organization_structure_schema(db)
    row = Office(**payload.model_dump())
    db.add(row)
    await db.flush()
    return {"id": row.id, "message": "Office created"}


@router.put("/offices/{office_id}")
async def update_office(
    office_id: int,
    payload: OfficeCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "users")),
):
    await ensure_organization_structure_schema(db)
    row = (await db.execute(select(Office).where(Office.id == office_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Office not found")
    for key, value in payload.model_dump().items():
        setattr(row, key, value)
    await db.flush()
    return {"id": row.id, "message": "Office updated"}


@router.delete("/offices/{office_id}")
async def delete_office(
    office_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "delete", "users")),
):
    await ensure_organization_structure_schema(db)
    row = (await db.execute(select(Office).where(Office.id == office_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Office not found")
    in_use = await db.scalar(select(func.count(Position.id)).where(Position.office_id == office_id))
    if in_use:
        raise HTTPException(status_code=409, detail=f"Office is linked to {int(in_use)} position(s)")
    await db.delete(row)
    await db.flush()
    return {"message": "Office deleted"}


def _position_payload(row: Position, project_name=None, office_name=None, parent_name=None, role_name=None, role_code=None) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "code": row.code,
        "role_id": row.role_id,
        "role_name": role_name or row.role_name,
        "role_code": role_code,
        "level_name": row.level_name,
        "level_rank": row.level_rank,
        "department": row.department,
        "section": row.section,
        "project_id": row.project_id,
        "office_id": row.office_id,
        "parent_position_id": row.parent_position_id,
        "project_name": project_name,
        "office_name": office_name,
        "parent_position_name": parent_name,
    }


@router.get("/positions")
async def list_positions(
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_organization_structure_schema(db)
    offset, limit = paginate_params(page, page_size)
    ParentPosition = aliased(Position)
    q = (
        select(Position, Project.name, Office.name, ParentPosition.name, Role.name, Role.code)
        .join(Project, Position.project_id == Project.id, isouter=True)
        .join(Office, Position.office_id == Office.id, isouter=True)
        .join(ParentPosition, Position.parent_position_id == ParentPosition.id, isouter=True)
        .join(Role, Position.role_id == Role.id, isouter=True)
    )
    count_q = select(func.count(Position.id))
    if search:
        like = f"%{search}%"
        condition = or_(Position.name.ilike(like), Position.code.ilike(like), Position.department.ilike(like), Position.role_name.ilike(like), Role.name.ilike(like), Role.code.ilike(like))
        q = q.where(condition)
        count_q = count_q.join(Role, Position.role_id == Role.id, isouter=True).where(condition)
    total = (await db.execute(count_q)).scalar() or 0
    rows = (await db.execute(q.order_by(Position.level_rank.asc(), Position.name.asc()).offset(offset).limit(limit))).all()
    items = [_position_payload(row, project_name, office_name, parent_name, role_name, role_code) for row, project_name, office_name, parent_name, role_name, role_code in rows]
    return build_paginated_response(items, total, page, page_size)


async def _validate_position_refs(db: AsyncSession, payload: PositionCreate, row_id: int | None = None) -> None:
    if payload.project_id:
        project = (await db.execute(select(Project.id).where(Project.id == payload.project_id))).scalar_one_or_none()
        if not project:
            raise HTTPException(status_code=422, detail="Project does not exist")
    if payload.office_id:
        office = (await db.execute(select(Office.id).where(Office.id == payload.office_id))).scalar_one_or_none()
        if not office:
            raise HTTPException(status_code=422, detail="Office does not exist")
    if payload.role_id:
        role = (await db.execute(select(Role).where(Role.id == payload.role_id, Role.is_active == True))).scalar_one_or_none()  # noqa: E712
        if not role:
            raise HTTPException(status_code=422, detail="Role does not exist or is inactive")
        payload.role_name = role.name
    if payload.parent_position_id:
        if payload.parent_position_id == row_id:
            raise HTTPException(status_code=422, detail="Position cannot be its own parent")
        parent = (await db.execute(select(Position.id).where(Position.id == payload.parent_position_id))).scalar_one_or_none()
        if not parent:
            raise HTTPException(status_code=422, detail="Parent position does not exist")


@router.post("/positions", status_code=201)
async def create_position(
    payload: PositionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "create", "users")),
):
    await ensure_organization_structure_schema(db)
    duplicate = (await db.execute(select(Position).where(func.lower(Position.code) == payload.code.lower()))).scalar_one_or_none()
    if duplicate:
        raise HTTPException(status_code=409, detail=f"Position code '{payload.code}' already exists")
    await _validate_position_refs(db, payload)
    row = Position(**payload.model_dump())
    db.add(row)
    await db.flush()
    return {"id": row.id, "message": "Position created"}


@router.put("/positions/{position_id}")
async def update_position(
    position_id: int,
    payload: PositionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "users")),
):
    await ensure_organization_structure_schema(db)
    row = (await db.execute(select(Position).where(Position.id == position_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Position not found")
    duplicate = (await db.execute(select(Position).where(func.lower(Position.code) == payload.code.lower(), Position.id != position_id))).scalar_one_or_none()
    if duplicate:
        raise HTTPException(status_code=409, detail=f"Position code '{payload.code}' already exists")
    await _validate_position_refs(db, payload, position_id)
    for key, value in payload.model_dump().items():
        setattr(row, key, value)
    await db.flush()
    return {"id": row.id, "message": "Position updated"}


@router.delete("/positions/{position_id}")
async def delete_position(
    position_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "delete", "users")),
):
    await ensure_organization_structure_schema(db)
    row = (await db.execute(select(Position).where(Position.id == position_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Position not found")
    in_use = await db.scalar(select(func.count(Employee.id)).where(Employee.position_id == position_id))
    if in_use:
        raise HTTPException(status_code=409, detail=f"Position is linked to {int(in_use)} employee(s)")
    await db.delete(row)
    await db.flush()
    return {"message": "Position deleted"}


@router.get("/employees")
async def list_employees(
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_organization_structure_schema(db)
    offset, limit = paginate_params(page, page_size)
    q = (
        select(Employee, Position.name, Position.code, User.id, User.username)
        .join(Position, Employee.position_id == Position.id, isouter=True)
        .join(User, User.employee_id == Employee.id, isouter=True)
    )
    count_q = select(func.count(Employee.id))
    if search:
        like = f"%{search}%"
        condition = or_(Employee.name.ilike(like), Employee.employee_code.ilike(like), Employee.email.ilike(like), Employee.phone.ilike(like))
        q = q.where(condition)
        count_q = count_q.where(condition)
    total = (await db.execute(count_q)).scalar() or 0
    rows = (await db.execute(q.order_by(Employee.name).offset(offset).limit(limit))).all()
    items = []
    for employee, position_name, position_code, user_id, username in rows:
        data = EmployeeResponse.model_validate(employee).model_dump()
        data["position_name"] = position_name
        data["position_code"] = position_code
        data["user_id"] = user_id
        data["username"] = username
        items.append(data)
    return build_paginated_response(items, total, page, page_size)


@router.post("/employees", status_code=201)
async def create_employee(
    payload: EmployeeCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "create", "users")),
):
    await ensure_organization_structure_schema(db)
    duplicate = (await db.execute(select(Employee).where(func.lower(Employee.employee_code) == payload.employee_code.lower()))).scalar_one_or_none()
    if duplicate:
        raise HTTPException(status_code=409, detail=f"Employee code '{payload.employee_code}' already exists")
    if payload.position_id:
        position = (await db.execute(select(Position.id).where(Position.id == payload.position_id))).scalar_one_or_none()
        if not position:
            raise HTTPException(status_code=422, detail="Position does not exist")
    row = Employee(**payload.model_dump())
    db.add(row)
    await db.flush()
    return {"id": row.id, "message": "Employee created"}


@router.put("/employees/{employee_id}")
async def update_employee(
    employee_id: int,
    payload: EmployeeCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "users")),
):
    await ensure_organization_structure_schema(db)
    row = (await db.execute(select(Employee).where(Employee.id == employee_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Employee not found")
    duplicate = (await db.execute(select(Employee).where(func.lower(Employee.employee_code) == payload.employee_code.lower(), Employee.id != employee_id))).scalar_one_or_none()
    if duplicate:
        raise HTTPException(status_code=409, detail=f"Employee code '{payload.employee_code}' already exists")
    if payload.position_id:
        position = (await db.execute(select(Position.id).where(Position.id == payload.position_id))).scalar_one_or_none()
        if not position:
            raise HTTPException(status_code=422, detail="Position does not exist")
    for key, value in payload.model_dump().items():
        setattr(row, key, value)
    await db.flush()
    return {"id": row.id, "message": "Employee updated"}


@router.delete("/employees/{employee_id}")
async def delete_employee(
    employee_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "delete", "users")),
):
    await ensure_organization_structure_schema(db)
    row = (await db.execute(select(Employee).where(Employee.id == employee_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Employee not found")
    await db.delete(row)
    await db.flush()
    return {"message": "Employee deleted"}


@router.post("/employees/{employee_id}/create-user", status_code=201)
async def create_user_from_employee(
    employee_id: int,
    payload: dict | None = Body(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "create", "users")),
):
    await ensure_organization_structure_schema(db)
    payload = payload or {}
    employee = (await db.execute(select(Employee).where(Employee.id == employee_id))).scalar_one_or_none()
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")
    existing_link = (await db.execute(select(User).where(User.employee_id == employee.id))).scalar_one_or_none()
    if existing_link:
        raise HTTPException(status_code=409, detail=f"Employee already linked to user '{existing_link.username}'")

    username = str(payload.get("username") or employee.employee_code or "").strip()
    username = re.sub(r"[^A-Za-z0-9_]+", "_", username).strip("_").lower()
    if len(username) < 3:
        username = f"emp_{employee.id}"
    email = str(payload.get("email") or employee.email or f"{username}@bavya-scm.local").strip()
    password = str(payload.get("password") or "").strip()
    if len(password) < 8:
        raise HTTPException(status_code=422, detail="Password is required and must be at least 8 characters")

    duplicate = (await db.execute(select(User).where(or_(User.username == username, User.email == email)))).scalar_one_or_none()
    if duplicate:
        raise HTTPException(status_code=409, detail="Username or email already exists")

    from app.services.auth_service import hash_password

    position = None
    if employee.position_id:
        position = (await db.execute(select(Position).where(Position.id == employee.position_id))).scalar_one_or_none()
    name_parts = (employee.name or employee.employee_code).split()
    first_name = str(payload.get("first_name") or (name_parts[0] if name_parts else employee.employee_code)).strip()[:100]
    last_name = str(payload.get("last_name") or (" ".join(name_parts[1:]) if len(name_parts) > 1 else "")).strip()[:100] or None
    user = User(
        organization_id=current_user.organization_id,
        employee_id=employee.id,
        employee_code=employee.employee_code,
        username=username,
        email=email,
        password_hash=hash_password(password),
        first_name=first_name,
        last_name=last_name,
        phone=employee.phone,
        user_type=str(payload.get("user_type") or "staff"),
        department=position.department if position else None,
        designation=position.name if position else None,
        is_active=True,
    )
    db.add(user)
    await db.flush()
    return {"id": user.id, "username": user.username, "message": "User created from employee"}


def _external_rows(payload) -> list[dict]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        for key in ("employees", "items", "data", "results"):
            rows = payload.get(key)
            if isinstance(rows, list):
                return [row for row in rows if isinstance(row, dict)]
        if payload.get("employee_code") or payload.get("code"):
            return [payload]
    return []


def _external_next_url(payload, current_url: str) -> str | None:
    if not isinstance(payload, dict):
        return None
    next_url = payload.get("next")
    if not next_url:
        return None
    return urljoin(current_url, str(next_url))


async def _fetch_external_employee_rows(max_pages: int) -> tuple[list[dict], int | None, int]:
    if not settings.HR_EMPLOYEE_API_URL:
        raise HTTPException(status_code=422, detail="Set HR_EMPLOYEE_API_URL in backend/.env")
    if not settings.HR_API_KEY:
        raise HTTPException(status_code=422, detail="Set HR_API_KEY in backend/.env")

    url = httpx.URL(settings.HR_EMPLOYEE_API_URL)
    if "page_size" not in url.params:
        url = url.copy_add_param("page_size", "500")

    rows: list[dict] = []
    api_total = None
    pages_fetched = 0
    seen_urls: set[str] = set()
    headers = {"X-Api-Key": settings.HR_API_KEY, "Accept": "application/json"}

    try:
        async with httpx.AsyncClient(timeout=settings.HR_API_TIMEOUT, follow_redirects=True) as client:
            next_url = str(url)
            while next_url and pages_fetched < max_pages:
                if next_url in seen_urls:
                    break
                seen_urls.add(next_url)
                try:
                    response = await client.get(next_url, headers=headers)
                    response.raise_for_status()
                    payload = response.json()
                    pages_fetched += 1
                    if isinstance(payload, dict) and isinstance(payload.get("count"), int):
                        api_total = int(payload["count"])
                    rows.extend(_external_rows(payload))
                    next_url = _external_next_url(payload, str(response.url))
                    await asyncio.sleep(0.05)
                except Exception as exc:
                    if rows:
                        print(f"Transient error fetching employee API on page {pages_fetched + 1}: {exc}. Returning successfully fetched {len(rows)} records.")
                        break
                    raise
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:500] if exc.response is not None else str(exc)
        raise HTTPException(status_code=502, detail=f"Employee API returned an error: {detail}")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Unable to fetch employee API: {exc}")

    return rows, api_total, pages_fetched


def _external_text(row: dict, *keys: str, max_len: int = 255) -> str | None:
    for key in keys:
        value = row
        for part in key.split("."):
            if not isinstance(value, dict):
                value = None
                break
            value = value.get(part)
        if value is not None and str(value).strip():
            return str(value).strip()[:max_len]
    return None


def _external_code(value: str | None, max_len: int = 100) -> str | None:
    if not value:
        return None
    code = re.sub(r"[^A-Za-z0-9]+", "-", value.strip()).strip("-").upper()
    return code[:max_len] or None


def _external_pattern_text(row: dict, keys: tuple[str, ...], pattern, max_len: int, upper: bool = False) -> str | None:
    value = _external_text(row, *keys, max_len=max_len)
    if not value:
        return None
    value = value.upper() if upper else value
    return value if pattern.match(value) else None


def _external_date(row: dict, *keys: str):
    raw = _external_text(row, *keys, max_len=30)
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).date()
    except ValueError:
        try:
            return datetime.strptime(raw[:10], "%Y-%m-%d").date()
        except ValueError:
            return None


async def _employee_unique_value(db: AsyncSession, column, value, employee_id: int | None):
    if not value:
        return None
    q = select(Employee.id).where(column == value)
    if employee_id:
        q = q.where(Employee.id != employee_id)
    exists = (await db.execute(q)).scalar_one_or_none()
    return None if exists else value


async def _project_id_from_external(db: AsyncSession, row: dict, stats: dict[str, int], organization_id: int | None) -> int | None:
    project_name = _external_text(row, "project.name", "project_name", "projectName", "project", max_len=255)
    project_code = _external_text(row, "project.code", "project_code", "projectCode", max_len=50) or _external_code(project_name, 50)
    if not project_code:
        return None
    project = (await db.execute(select(Project).where(func.lower(Project.code) == project_code.lower()))).scalar_one_or_none()
    if not project:
        if not organization_id:
            organization_id = (await db.execute(select(Organization.id).order_by(Organization.id.asc()).limit(1))).scalar_one_or_none()
        if not organization_id:
            raise HTTPException(status_code=422, detail="No organization exists for imported HR projects")
        project = Project(organization_id=organization_id, code=project_code, name=project_name or project_code, status="active")
        db.add(project)
        await db.flush()
        stats["projects_created"] += 1
    elif project_name and project.name != project_name:
        project.name = project_name
    return project.id


async def _office_id_from_external(db: AsyncSession, row: dict, stats: dict[str, int]) -> int | None:
    office_name = _external_text(row, "office.name", "office_name", "officeName", "office", "branch", "location", max_len=255)
    if not office_name:
        return None
    office = (await db.execute(select(Office).where(func.lower(Office.name) == office_name.lower()))).scalar_one_or_none()
    
    level = _external_text(row, "office.level", "office_level", "officeLevel", "level", max_len=50)
    country = _external_text(row, "office.geo_location.country", "office.geoLocation.country", "office.geo_location", "country", max_len=100)
    state = _external_text(row, "office.geo_location.state", "office.geoLocation.state", "state", max_len=100)
    district = _external_text(row, "office.geo_location.district", "office.geoLocation.district", "district", max_len=100)
    mandal = _external_text(row, "office.geo_location.mandal", "office.geoLocation.mandal", "mandal", max_len=100)
    cluster = _external_text(row, "office.geo_location.cluster", "office.geoLocation.cluster", "cluster", max_len=100)
    cluster_type = _external_text(row, "office.geo_location.cluster_type", "office.geo_location.clusterType", "office.geoLocation.clusterType", "cluster_type", "clusterType", max_len=50)
    specific_location = _external_text(row, "office.geo_location.specific_location", "office.geo_location.specificLocation", "office.geoLocation.specificLocation", "specific_location", "specificLocation", max_len=255)
    address = _external_text(row, "office.geo_location.address", "office.geoLocation.address", "address", max_len=5000)

    if not office:
        office = Office(
            name=office_name,
            level=level,
            country=country,
            state=state,
            district=district,
            mandal=mandal,
            cluster=cluster,
            cluster_type=cluster_type,
            specific_location=specific_location,
            address=address,
        )
        db.add(office)
        await db.flush()
        stats["offices_created"] += 1
    else:
        # Update empty fields on existing offices
        if level:
            office.level = level
        if country:
            office.country = country
        if state:
            office.state = state
        if district:
            office.district = district
        if mandal:
            office.mandal = mandal
        if cluster:
            office.cluster = cluster
        if cluster_type:
            office.cluster_type = cluster_type
        if specific_location:
            office.specific_location = specific_location
        if address:
            office.address = address
            
    return office.id


async def _role_id_from_external(db: AsyncSession, row: dict) -> int | None:
    role_code = _external_text(row, "position.role_code", "role_code", "roleCode", max_len=50)
    role_name = _external_text(row, "position.role_name", "role_name", "roleName", "role", max_len=100)
    if role_code:
        role = (await db.execute(select(Role).where(func.lower(Role.code) == role_code.lower(), Role.is_active == True))).scalar_one_or_none()  # noqa: E712
        if role:
            return role.id
    if role_name:
        role = (await db.execute(select(Role).where(func.lower(Role.name) == role_name.lower(), Role.is_active == True))).scalar_one_or_none()  # noqa: E712
        if role:
            return role.id
    return None


async def _position_id_from_external(db: AsyncSession, row: dict, stats: dict[str, int], organization_id: int | None):
    position_id = row.get("position_id")
    if position_id:
        exists = (await db.execute(select(Position.id).where(Position.id == position_id))).scalar_one_or_none()
        return exists
    position_name = _external_text(
        row,
        "position.name", "position_name", "positionName", "position", "designation", "designation_name", "designationName",
        "role_name", "roleName", "role",
        max_len=255,
    )
    position_code = _external_text(row, "position.code", "position_code", "positionCode", "designation_code", "designationCode", "role_code", "roleCode", max_len=100)
    position_code = position_code or _external_code(position_name, 100)
    if not position_code or not position_name:
        return None
    position = (await db.execute(select(Position).where(func.lower(Position.code) == position_code.lower()))).scalar_one_or_none()
    project_id = await _project_id_from_external(db, row, stats, organization_id)
    office_id = await _office_id_from_external(db, row, stats)
    role_id = await _role_id_from_external(db, row)
    if not position:
        position = Position(
            code=position_code,
            name=position_name,
            role_name=_external_text(row, "position.role_name", "role_name", "roleName", "role", max_len=100),
            role_id=role_id,
            level_name=_external_text(row, "position.level_name", "level_name", "levelName", "position_level", "positionLevel", max_len=50),
            department=_external_text(row, "position.department", "department", "department_name", "departmentName", max_len=100),
            section=_external_text(row, "position.section", "section", "section_name", "sectionName", max_len=100),
            project_id=project_id,
            office_id=office_id,
        )
        db.add(position)
        await db.flush()
        stats["positions_created"] += 1
    else:
        position.name = position_name or position.name
        position.role_name = _external_text(row, "position.role_name", "role_name", "roleName", "role", max_len=100) or position.role_name
        position.role_id = role_id or position.role_id
        position.level_name = _external_text(row, "position.level_name", "level_name", "levelName", "position_level", "positionLevel", max_len=50) or position.level_name
        position.department = _external_text(row, "position.department", "department", "department_name", "departmentName", max_len=100) or position.department
        position.section = _external_text(row, "position.section", "section", "section_name", "sectionName") or position.section
        position.project_id = project_id or position.project_id
        position.office_id = office_id or position.office_id
    return position.id


async def _upsert_external_employee(db: AsyncSession, row: dict, stats: dict[str, int], organization_id: int | None = None) -> tuple[bool, bool]:
    employee_code = _external_text(row, "employee.employee_code", "employee_code", "employeeCode", "code", "emp_code", "empCode", max_len=50)
    if not employee_code:
        return False, False
    employee = (
        await db.execute(select(Employee).where(Employee.employee_code == employee_code))
    ).scalar_one_or_none()
    created = employee is None
    if employee is None:
        employee = Employee(employee_code=employee_code, name="")
        db.add(employee)
        await db.flush()

    name = _external_text(row, "employee.name", "name", "employee_name", "employeeName", "full_name", "fullName", max_len=255)
    first_name = _external_text(row, "employee.first_name", "first_name", "firstName", max_len=100)
    last_name = _external_text(row, "employee.last_name", "last_name", "lastName", max_len=100)
    if not name and (first_name or last_name):
        name = f"{first_name or ''} {last_name or ''}".strip()

    employee.name = name or employee.name or employee_code
    employee.photo = _external_text(row, "employee.photo", "photo", "photo_url", "photoUrl", "avatar", max_len=255)
    employee.status = _external_text(row, "employee.status", "status", max_len=20) or employee.status or "Active"
    employee.dob = _external_date(row, "employee.dob", "dob", "date_of_birth", "dateOfBirth") or employee.dob
    employee.gender = _external_text(row, "employee.gender", "gender", max_len=20)
    phone = _external_pattern_text(row, ("employee.phone", "phone", "mobile", "mobile_number", "mobileNumber"), PHONE_PATTERN, 15)
    email = _external_pattern_text(row, ("employee.email", "email"), EMAIL_PATTERN, 100)
    pan_number = _external_pattern_text(row, ("employee.pan_number", "pan_number", "panNumber", "pan"), PAN_PATTERN, 10, upper=True)
    aadhaar_number = _external_pattern_text(
        row,
        ("employee.aadhaar_number", "aadhaar_number", "aadhaarNumber", "aadhaar"),
        re.compile(r"^[0-9]{12}$"),
        12,
    )
    employee.phone = phone or employee.phone
    employee.email = await _employee_unique_value(db, Employee.email, email, employee.id) if email else employee.email
    employee.pan_number = await _employee_unique_value(db, Employee.pan_number, pan_number, employee.id) if pan_number else employee.pan_number
    employee.aadhaar_number = await _employee_unique_value(db, Employee.aadhaar_number, aadhaar_number, employee.id) if aadhaar_number else employee.aadhaar_number
    employee.position_id = await _position_id_from_external(db, row, stats, organization_id) or employee.position_id
    return True, created


async def _link_users_to_employees(db: AsyncSession) -> int:
    await db.execute(text("""
        UPDATE users u
        JOIN employees e
          ON e.employee_code COLLATE utf8mb4_unicode_ci = u.employee_code COLLATE utf8mb4_unicode_ci
        SET u.employee_id = e.id
        WHERE u.employee_code IS NOT NULL
          AND u.employee_code <> ''
    """))
    linked = (await db.execute(text("""
        SELECT COUNT(*)
        FROM users
        WHERE employee_code IS NOT NULL
          AND employee_code <> ''
          AND employee_id IS NOT NULL
    """))).scalar() or 0
    return int(linked)


async def _apply_position_roles_to_linked_users(db: AsyncSession) -> int:
    rows = (await db.execute(
        select(User.id, Position.role_id)
        .join(Employee, User.employee_id == Employee.id)
        .join(Position, Employee.position_id == Position.id)
        .where(Position.role_id.is_not(None))
    )).all()
    applied = 0
    for user_id, role_id in rows:
        exists = (await db.execute(
            select(UserRole.id).where(UserRole.user_id == user_id, UserRole.role_id == role_id)
        )).scalar_one_or_none()
        if not exists:
            db.add(UserRole(user_id=user_id, role_id=role_id))
            applied += 1
        user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
        if user and not user.active_role_id:
            user.active_role_id = role_id
    await db.flush()
    return applied


@router.post("/employees/sync-api")
async def sync_employees_from_external_api(
    max_pages: int = Query(500, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "users")),
):
    await ensure_organization_structure_schema(db)
    rows, api_total, pages_fetched = await _fetch_external_employee_rows(max_pages=max_pages)
    if not rows:
        raise HTTPException(status_code=422, detail="Employee API response did not contain employee rows")

    created = 0
    updated = 0
    skipped = 0
    org_stats = {"projects_created": 0, "offices_created": 0, "positions_created": 0}
    for row in rows:
        processed, was_created = await _upsert_external_employee(db, row, org_stats, current_user.organization_id)
        if not processed:
            skipped += 1
        elif was_created:
            created += 1
        else:
            updated += 1
    await db.flush()
    linked_users = await _link_users_to_employees(db)
    role_links_applied = await _apply_position_roles_to_linked_users(db)
    return {
        "message": "Employee API sync completed",
        "fetched": len(rows),
        "api_total": api_total,
        "pages_fetched": pages_fetched,
        "created": created,
        "updated": updated,
        "skipped": skipped,
        **org_stats,
        "linked_users": linked_users,
        "role_links_applied": role_links_applied,
    }


@router.get("/vendor-types")
async def list_vendor_types(
    include_inactive: bool = Query(False),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_vendor_type_schema(db)
    q = select(VendorType).order_by(VendorType.name)
    if not include_inactive:
        q = q.where(VendorType.is_active == True)  # noqa: E712
    if search:
        like = f"%{search}%"
        q = q.where((VendorType.name.ilike(like)) | (VendorType.code.ilike(like)))
    rows = (await db.execute(q)).scalars().all()
    return [VendorTypeResponse.model_validate(row) for row in rows]


@router.post("/vendor-types", status_code=201)
async def create_vendor_type(
    payload: VendorTypeCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "create", "vendors")),
):
    await ensure_vendor_type_schema(db)
    existing = (
        await db.execute(select(VendorType).where(func.lower(VendorType.code) == payload.code.lower()))
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail=f"Vendor type code '{payload.code}' already exists")
    row = VendorType(
        code=payload.code,
        name=payload.name,
        description=payload.description,
        is_active=True if payload.is_active is None else bool(payload.is_active),
    )
    db.add(row)
    await db.flush()
    return {"id": row.id, "message": "Vendor type created"}


@router.put("/vendor-types/{vendor_type_id}")
async def update_vendor_type(
    vendor_type_id: int,
    payload: VendorTypeCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "vendors")),
):
    await ensure_vendor_type_schema(db)
    row = (await db.execute(select(VendorType).where(VendorType.id == vendor_type_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Vendor type not found")
    dup = (
        await db.execute(
            select(VendorType).where(
                func.lower(VendorType.code) == payload.code.lower(),
                VendorType.id != vendor_type_id,
            )
        )
    ).scalar_one_or_none()
    if dup:
        raise HTTPException(status_code=409, detail=f"Vendor type code '{payload.code}' already exists")
    row.code = payload.code
    row.name = payload.name
    row.description = payload.description
    if payload.is_active is not None:
        row.is_active = bool(payload.is_active)
    await db.flush()
    return {"id": row.id, "message": "Vendor type updated"}


@router.delete("/vendor-types/{vendor_type_id}")
async def delete_vendor_type(
    vendor_type_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "delete", "vendors")),
):
    await ensure_vendor_type_schema(db)
    row = (await db.execute(select(VendorType).where(VendorType.id == vendor_type_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Vendor type not found")
    in_use = await db.scalar(select(func.count(VendorVendorType.id)).where(VendorVendorType.vendor_type_id == vendor_type_id))
    if in_use:
        raise HTTPException(status_code=409, detail=f"Vendor type is linked to {int(in_use)} vendor(s)")
    row.is_active = False
    await db.flush()
    return {"message": "Vendor type deactivated"}

@router.get("/vendors")
async def list_vendors(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=1000),
    search: str = Query(None),
    vendor_type: str = Query(None),
    vendor_category_id: int = Query(None),
    is_active: bool = Query(None),
    status: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_vendor_type_schema(db)
    # R-001 (re-audit): vendors contain bank/GST/DL info — gate to roles that
    # actually need them. Procurement (PO+MR forms), warehouse (GRN), masters,
    # accounts (payments). Read fails for nurse/field_staff/etc.
    from app.utils.dependencies import get_user_permissions, get_user_role_codes
    role_codes = await get_user_role_codes(db, current_user.id)
    if "super_admin" not in role_codes and "admin" not in role_codes:
        perms = set(await get_user_permissions(db, current_user.id))
        if not (perms & {
            "masters.view.vendors", "procurement.view.purchase_orders",
            "procurement.view.material_requests", "procurement.view.quotations",
            "warehouse.view.grn", "accounts.view.payments", "accounts.view.invoices",
        }):
            raise HTTPException(status_code=403, detail="Permission denied: masters.view.vendors")
    offset, limit = paginate_params(page, page_size)
    query = select(Vendor)
    count_query = select(func.count(Vendor.id))

    if vendor_type:
        vendor_type_filters = [VendorType.code == vendor_type]
        if str(vendor_type).isdigit():
            vendor_type_filters.append(VendorType.id == int(vendor_type))
        vt = (
            await db.execute(
                select(VendorType).where(or_(*vendor_type_filters))
            )
        ).scalar_one_or_none()
        if vt:
            query = query.join(VendorVendorType, VendorVendorType.vendor_id == Vendor.id).where(VendorVendorType.vendor_type_id == vt.id)
            count_query = count_query.join(VendorVendorType, VendorVendorType.vendor_id == Vendor.id).where(VendorVendorType.vendor_type_id == vt.id)
        else:
            query = query.where(Vendor.vendor_type == vendor_type)
            count_query = count_query.where(Vendor.vendor_type == vendor_type)
    if vendor_category_id is not None:
        query = query.where(Vendor.vendor_category_id == vendor_category_id)
        count_query = count_query.where(Vendor.vendor_category_id == vendor_category_id)
    # Support both is_active (bool) and status ('active'/'inactive') params
    if is_active is not None:
        query = query.where(Vendor.is_active == is_active)
        count_query = count_query.where(Vendor.is_active == is_active)
    elif status is not None:
        active_val = status.lower() in ("active", "true", "1")
        query = query.where(Vendor.is_active == active_val)
        count_query = count_query.where(Vendor.is_active == active_val)

    query = apply_search_filter(query, Vendor, search, ["vendor_code", "name", "city", "gst_number"])
    count_query = apply_search_filter(count_query, Vendor, search, ["vendor_code", "name", "city", "gst_number"])

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.distinct().offset(offset).limit(limit).order_by(Vendor.id.desc()))
    vendors = result.scalars().all()
    type_map, primary_map = await _vendor_type_maps(db, [v.id for v in vendors])
    category_map = await _vendor_category_map(db, [v.id for v in vendors])

    # Fetch logins for these vendors to populate has_login
    from app.models.vendor_portal import VendorUser
    login_res = await db.execute(
        select(VendorUser.vendor_id).where(VendorUser.vendor_id.in_([v.id for v in vendors]))
    ) if vendors else None
    login_vendor_ids = set(login_res.scalars().all()) if login_res else set()

    return build_paginated_response(
        [_vendor_response_dict(v, type_map, primary_map, category_map, login_vendor_ids) for v in vendors], total, page, page_size
    )


@router.get("/vendors/{vendor_id}", response_model=VendorResponse)
async def get_vendor(
    vendor_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_vendor_type_schema(db)
    # BUG-FE-052: mirror the role guard from list_vendors — vendor records
    # contain bank/GST/DL/PII that must not leak to nurses/field_staff/etc.
    from app.utils.dependencies import get_user_permissions, get_user_role_codes
    role_codes = await get_user_role_codes(db, current_user.id)
    if "super_admin" not in role_codes and "admin" not in role_codes:
        perms = set(await get_user_permissions(db, current_user.id))
        if not (perms & {
            "masters.view.vendors", "procurement.view.purchase_orders",
            "procurement.view.material_requests", "procurement.view.quotations",
            "warehouse.view.grn", "accounts.view.payments", "accounts.view.invoices",
        }):
            raise HTTPException(status_code=403, detail="Permission denied: masters.view.vendors")
    result = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    vendor = result.scalar_one_or_none()
    if not vendor:
        raise HTTPException(status_code=404, detail="Vendor not found")
    type_map, primary_map = await _vendor_type_maps(db, [vendor.id])
    category_map = await _vendor_category_map(db, [vendor.id])
    from app.models.vendor_portal import VendorUser
    login_exists = await db.scalar(
        select(func.count(VendorUser.id)).where(VendorUser.vendor_id == vendor.id)
    )
    return _vendor_response_dict(vendor, type_map, primary_map, category_map, {vendor.id} if login_exists else set())


@router.post("/vendors", status_code=201)
async def create_vendor(
    payload: VendorCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "create", "vendors")),
):
    await ensure_vendor_type_schema(db)
    # BUG-FE-051: case-insensitive uniqueness so "ACME" and "acme" can't coexist
    code_val = (payload.vendor_code or "").strip()
    existing = await db.execute(
        select(Vendor).where(func.lower(Vendor.vendor_code) == code_val.lower())
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Vendor with code '{code_val}' already exists")
    # BUG-PRO-105 fix: refuse a second active vendor with the same GSTIN (when
    # one is supplied). The DB has no UNIQUE constraint on gst_number — adding
    # one is DEFERRED (migration); enforced at the application layer here.
    if payload.gst_number and payload.gst_number.strip():
        gst_dupe = await db.execute(
            select(Vendor.id, Vendor.vendor_code).where(
                Vendor.gst_number == payload.gst_number,
                Vendor.is_active == True,  # noqa: E712 — explicit boolean for SQL
            )
        )
        dupe = gst_dupe.first()
        if dupe:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"GSTIN '{payload.gst_number}' is already registered against "
                    f"vendor '{dupe.vendor_code}' (id={dupe.id})"
                ),
            )
    await _validate_vendor_category(db, payload.vendor_category_id)
    data = payload.model_dump(exclude={"vendor_type_ids"})
    data["vendor_code"] = code_val.upper()
    vendor = Vendor(**data, created_by=current_user.id)
    db.add(vendor)
    await db.flush()
    await _sync_vendor_type_links(db, vendor, payload.vendor_type_ids, payload.vendor_type_id)
    return {"id": vendor.id, "message": "Vendor created"}


@router.put("/vendors/{vendor_id}")
async def update_vendor(
    vendor_id: int,
    payload: VendorUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "vendors")),
):
    await ensure_vendor_type_schema(db)
    result = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    vendor = result.scalar_one_or_none()
    if not vendor:
        raise HTTPException(status_code=404, detail="Vendor not found")
    update_data = payload.model_dump(exclude_unset=True)
    vendor_type_ids = update_data.pop("vendor_type_ids", None)
    if "vendor_category_id" in update_data:
        await _validate_vendor_category(db, update_data.get("vendor_category_id"))
    # BUG-PRO-105 fix (mirror create): block GSTIN collision with another
    # active vendor when GSTIN is being changed.
    new_gst = update_data.get("gst_number")
    if new_gst and new_gst.strip() and new_gst != (vendor.gst_number or ""):
        gst_dupe = await db.execute(
            select(Vendor.id, Vendor.vendor_code).where(
                Vendor.gst_number == new_gst,
                Vendor.id != vendor_id,
                Vendor.is_active == True,  # noqa: E712
            )
        )
        dupe = gst_dupe.first()
        if dupe:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"GSTIN '{new_gst}' is already registered against vendor "
                    f"'{dupe.vendor_code}' (id={dupe.id})"
                ),
            )
    for k, v in update_data.items():
        setattr(vendor, k, v)
    if vendor_type_ids is not None or "vendor_type_id" in update_data:
        await _sync_vendor_type_links(db, vendor, vendor_type_ids, update_data.get("vendor_type_id"))
    await db.flush()
    return {"success": True, "message": "Vendor updated"}


@router.delete("/vendors/{vendor_id}")
async def deactivate_vendor(
    vendor_id: int,
    force: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "delete", "vendors")),
):
    """BUG-FE-050: refuse soft-delete if vendor has open POs or unpaid invoices.
    Pass ?force=true to override (admin-only escape hatch)."""
    result = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    vendor = result.scalar_one_or_none()
    if not vendor:
        raise HTTPException(status_code=404, detail="Vendor not found")

    refs = []
    # Open POs (status not in closed/cancelled)
    try:
        from app.models.procurement import PurchaseOrder  # type: ignore
        po_count = (await db.execute(
            select(func.count(PurchaseOrder.id)).where(
                PurchaseOrder.vendor_id == vendor_id,
                ~PurchaseOrder.status.in_(["closed", "cancelled", "rejected"]),
            )
        )).scalar() or 0
        if po_count:
            refs.append(f"{po_count} open purchase order(s)")
    except Exception:
        pass
    # Unpaid invoices
    try:
        from app.models.accounts import Invoice  # type: ignore
        inv_count = (await db.execute(
            select(func.count(Invoice.id)).where(
                Invoice.vendor_id == vendor_id,
                ~Invoice.status.in_(["paid", "cancelled"]),
            )
        )).scalar() or 0
        if inv_count:
            refs.append(f"{inv_count} unpaid invoice(s)")
    except Exception:
        pass

    if refs and not force:
        raise HTTPException(
            status_code=409,
            detail=(
                "Cannot deactivate vendor — has " + ", ".join(refs) +
                ". Close them first or pass ?force=true."
            ),
        )

    vendor.is_active = False
    await db.flush()
    return {"success": True, "message": "Vendor deactivated"}


# ---- Vendor detail GET stubs (BUG-FE-055) ----
# Vendors.jsx calls these for the detail tabs. Returning a paginated/list shape
# the frontend already accepts (`items` envelope or array).

@router.get("/vendors/{vendor_id}/items")
async def list_vendor_items(
    vendor_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    total = (await db.execute(
        select(func.count(VendorItem.id)).where(VendorItem.vendor_id == vendor_id)
    )).scalar() or 0
    rows = (await db.execute(
        select(VendorItem, Item.item_code, Item.name)
        .join(Item, VendorItem.item_id == Item.id, isouter=True)
        .where(VendorItem.vendor_id == vendor_id)
        .order_by(VendorItem.id.desc())
        .offset(offset).limit(limit)
    )).all()
    items = []
    for vi, item_code, item_name in rows:
        items.append({
            "id": vi.id,
            "vendor_id": vi.vendor_id,
            "item_id": vi.item_id,
            "item_code": item_code,
            "item_name": item_name,
            "vendor_item_code": vi.vendor_item_code,
            "lead_time_days": vi.lead_time_days,
            "min_order_qty": float(vi.min_order_qty) if vi.min_order_qty is not None else None,
            "last_price": float(vi.rate) if vi.rate is not None else None,
            "is_preferred": vi.is_preferred,
        })
    return build_paginated_response(items, total, page, page_size)


def _vendor_item_snapshot(vi: VendorItem | None) -> dict:
    if not vi:
        return {
            "vendor_item_code": None,
            "lead_time_days": None,
            "min_order_qty": None,
            "rate": None,
            "is_preferred": None,
        }
    return {
        "vendor_item_code": vi.vendor_item_code,
        "lead_time_days": vi.lead_time_days,
        "min_order_qty": vi.min_order_qty,
        "rate": vi.rate,
        "is_preferred": vi.is_preferred,
    }


def _add_vendor_item_history(
    db: AsyncSession,
    vi: VendorItem,
    action: str,
    current_user: User,
    old_values: dict | None = None,
) -> None:
    old_values = old_values or {}
    new_values = _vendor_item_snapshot(vi) if action != "delete" else {}
    db.add(VendorItemHistory(
        vendor_item_id=vi.id,
        vendor_id=vi.vendor_id,
        item_id=vi.item_id,
        action=action,
        old_vendor_item_code=old_values.get("vendor_item_code"),
        new_vendor_item_code=new_values.get("vendor_item_code"),
        old_lead_time_days=old_values.get("lead_time_days"),
        new_lead_time_days=new_values.get("lead_time_days"),
        old_min_order_qty=old_values.get("min_order_qty"),
        new_min_order_qty=new_values.get("min_order_qty"),
        old_rate=old_values.get("rate"),
        new_rate=new_values.get("rate"),
        old_is_preferred=old_values.get("is_preferred"),
        new_is_preferred=new_values.get("is_preferred"),
        changed_by_id=getattr(current_user, "id", None),
    ))


@router.get("/vendors/{vendor_id}/items/history")
async def list_vendor_item_history(
    vendor_id: int,
    item_id: int | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_vendor_type_schema(db)
    offset, limit = paginate_params(page, page_size)
    filters = [VendorItemHistory.vendor_id == vendor_id]
    if item_id:
        filters.append(VendorItemHistory.item_id == item_id)
    total = (await db.execute(select(func.count(VendorItemHistory.id)).where(*filters))).scalar() or 0
    rows = (await db.execute(
        select(
            VendorItemHistory,
            Item.item_code,
            Item.name,
            UserModel.username,
            UserModel.first_name,
            UserModel.last_name,
        )
        .join(Item, VendorItemHistory.item_id == Item.id, isouter=True)
        .join(UserModel, VendorItemHistory.changed_by_id == UserModel.id, isouter=True)
        .where(*filters)
        .order_by(VendorItemHistory.changed_at.desc(), VendorItemHistory.id.desc())
        .offset(offset).limit(limit)
    )).all()
    items = []
    for h, item_code, item_name, username, first_name, last_name in rows:
        changed_by_name = " ".join([p for p in [first_name, last_name] if p]) or username
        items.append({
            "id": h.id,
            "vendor_item_id": h.vendor_item_id,
            "vendor_id": h.vendor_id,
            "item_id": h.item_id,
            "item_code": item_code,
            "item_name": item_name,
            "action": h.action,
            "old_vendor_item_code": h.old_vendor_item_code,
            "new_vendor_item_code": h.new_vendor_item_code,
            "old_lead_time_days": h.old_lead_time_days,
            "new_lead_time_days": h.new_lead_time_days,
            "old_min_order_qty": float(h.old_min_order_qty) if h.old_min_order_qty is not None else None,
            "new_min_order_qty": float(h.new_min_order_qty) if h.new_min_order_qty is not None else None,
            "old_rate": float(h.old_rate) if h.old_rate is not None else None,
            "new_rate": float(h.new_rate) if h.new_rate is not None else None,
            "old_is_preferred": h.old_is_preferred,
            "new_is_preferred": h.new_is_preferred,
            "changed_by_id": h.changed_by_id,
            "changed_by_name": changed_by_name,
            "changed_at": h.changed_at,
        })
    return build_paginated_response(items, total, page, page_size)


@router.get("/vendors/{vendor_id}/contracts")
async def list_vendor_contracts(
    vendor_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    total = (await db.execute(
        select(func.count(VendorContract.id)).where(VendorContract.vendor_id == vendor_id)
    )).scalar() or 0
    rows = (await db.execute(
        select(VendorContract)
        .where(VendorContract.vendor_id == vendor_id)
        .order_by(VendorContract.id.desc())
        .offset(offset).limit(limit)
    )).scalars().all()
    items = [{
        "id": c.id,
        "vendor_id": c.vendor_id,
        "contract_number": c.contract_number,
        "title": c.title,
        "start_date": c.start_date,
        "end_date": c.end_date,
        "status": c.status,
        "document_url": c.document_url,
    } for c in rows]
    return build_paginated_response(items, total, page, page_size)


@router.get("/vendors/{vendor_id}/ratings")
async def list_vendor_ratings(
    vendor_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    total = (await db.execute(
        select(func.count(VendorRating.id)).where(VendorRating.vendor_id == vendor_id)
    )).scalar() or 0
    rows = (await db.execute(
        select(VendorRating)
        .where(VendorRating.vendor_id == vendor_id)
        .order_by(VendorRating.id.desc())
        .offset(offset).limit(limit)
    )).scalars().all()
    items = [{
        "id": r.id,
        "vendor_id": r.vendor_id,
        "period_from": r.period_from,
        "period_to": r.period_to,
        "delivery_timeliness": float(r.delivery_timeliness) if r.delivery_timeliness is not None else None,
        "cost_efficiency": float(r.cost_efficiency) if r.cost_efficiency is not None else None,
        "service_reliability": float(r.service_reliability) if r.service_reliability is not None else None,
        "delivery_accuracy": float(r.delivery_accuracy) if r.delivery_accuracy is not None else None,
        "overall_rating": float(r.overall_rating) if r.overall_rating is not None else None,
        "remarks": r.remarks,
        "created_at": r.created_at,
    } for r in rows]
    return build_paginated_response(items, total, page, page_size)


@router.get("/vendors/{vendor_id}/purchase-orders")
async def list_vendor_purchase_orders(
    vendor_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """BUG-FE-055: vendor PO history tab. Stub — returns empty list when the
    procurement model isn't importable so the FE can still render."""
    try:
        from app.models.procurement import PurchaseOrder  # type: ignore
    except Exception:
        return build_paginated_response([], 0, page, page_size)
    offset, limit = paginate_params(page, page_size)
    total = (await db.execute(
        select(func.count(PurchaseOrder.id)).where(PurchaseOrder.vendor_id == vendor_id)
    )).scalar() or 0
    rows = (await db.execute(
        select(PurchaseOrder)
        .where(PurchaseOrder.vendor_id == vendor_id)
        .order_by(PurchaseOrder.id.desc())
        .offset(offset).limit(limit)
    )).scalars().all()
    items = []
    for po in rows:
        items.append({
            "id": po.id,
            "po_number": getattr(po, "po_number", None) or getattr(po, "doc_number", None),
            "status": getattr(po, "status", None),
            "order_date": getattr(po, "order_date", None) or getattr(po, "po_date", None),
            "total_amount": float(getattr(po, "total_amount", 0) or 0),
        })
    return build_paginated_response(items, total, page, page_size)


@router.post("/vendors/{vendor_id}/items", status_code=201)
async def add_vendor_item(
    vendor_id: int,
    payload: VendorItemCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "vendors")),
):
    # BUG-FE-053: writes to vendor sub-records require masters.update.vendors
    vendor = (await db.execute(select(Vendor).where(Vendor.id == vendor_id))).scalar_one_or_none()
    if not vendor:
        raise HTTPException(status_code=404, detail="Vendor not found")
    item = (await db.execute(select(Item).where(Item.id == payload.item_id))).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=422, detail="Item not found")
    existing = (
        await db.execute(
            select(VendorItem).where(
                VendorItem.vendor_id == vendor_id,
                VendorItem.item_id == payload.item_id,
            )
        )
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="This item is already linked to the vendor")
    vi = VendorItem(**payload.model_dump())
    vi.vendor_id = vendor_id
    db.add(vi)
    await db.flush()
    _add_vendor_item_history(db, vi, "create", current_user)
    return {"id": vi.id, "message": "Vendor item added"}


@router.post("/vendor-item-mappings/bulk", status_code=201)
async def bulk_map_vendor_items(
    payload: VendorItemBulkMapCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "vendors")),
):
    vendor_ids = payload.vendor_ids
    item_ids = payload.item_ids
    vendors = (await db.execute(
        select(Vendor.id).where(Vendor.id.in_(vendor_ids), Vendor.is_active == True)  # noqa: E712
    )).all()
    valid_vendor_ids = {int(row[0]) for row in vendors}
    items = (await db.execute(
        select(Item.id).where(Item.id.in_(item_ids), Item.is_active == True)  # noqa: E712
    )).all()
    valid_item_ids = {int(row[0]) for row in items}
    missing_vendors = [vid for vid in vendor_ids if vid not in valid_vendor_ids]
    missing_items = [iid for iid in item_ids if iid not in valid_item_ids]
    if missing_vendors or missing_items:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Only active vendors and active items can be mapped",
                "missing_vendor_ids": missing_vendors,
                "missing_item_ids": missing_items,
            },
        )

    existing_rows = (await db.execute(
        select(VendorItem.vendor_id, VendorItem.item_id).where(
            VendorItem.vendor_id.in_(vendor_ids),
            VendorItem.item_id.in_(item_ids),
        )
    )).all()
    existing = {(int(vendor_id), int(item_id)) for vendor_id, item_id in existing_rows}
    created = 0
    skipped = 0
    for vendor_id in vendor_ids:
        for item_id in item_ids:
            if (vendor_id, item_id) in existing:
                skipped += 1
                continue
            vi = VendorItem(
                vendor_id=vendor_id,
                item_id=item_id,
                lead_time_days=payload.lead_time_days,
                min_order_qty=payload.min_order_qty,
                rate=payload.rate,
                is_preferred=payload.is_preferred,
            )
            db.add(vi)
            await db.flush()
            _add_vendor_item_history(db, vi, "create", current_user)
            created += 1
    return {
            "vendors": len(vendor_ids),
        "items": len(item_ids),
    }


@router.get("/user-material-mapping/tree")
async def get_user_material_mapping_tree(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "view", "users")),
):
    await ensure_organization_structure_schema(db)
    await ensure_user_item_permission_schema(db)
    role_rows = (await db.execute(
        select(Role.id, Role.code, Role.name)
        .where(Role.is_active == True)
        .order_by(Role.name)
    )).all()
    category_rows = (await db.execute(
        select(ItemCategory.id, ItemCategory.parent_id, ItemCategory.code, ItemCategory.full_code, ItemCategory.name)
        .order_by(ItemCategory.full_code, ItemCategory.name)
    )).all()
    item_rows = (await db.execute(
        select(Item.id, Item.item_code, Item.name, Item.category_id)
        .where(Item.is_active == True)  # noqa: E712
        .order_by(Item.item_code, Item.name)
    )).all()
    existing_rows = (await db.execute(
        select(RoleItemPermission.role_id, RoleItemPermission.entity_type, RoleItemPermission.entity_id, RoleItemPermission.action)
        .order_by(RoleItemPermission.role_id)
    )).all()
    return {
        "projects": [],
        "positions": [],
        "roles": [{"id": r.id, "code": r.code, "name": r.name} for r in role_rows],
        "direct_roles": [],
        "users": [],
        "categories": [
            {"id": r.id, "parent_id": r.parent_id, "code": r.code, "full_code": r.full_code, "name": r.name}
            for r in category_rows
        ],
        "items": [{"id": r.id, "item_code": r.item_code, "name": r.name, "category_id": r.category_id} for r in item_rows],
        "existing": [
            {"role_id": r.role_id, "entity_type": r.entity_type, "entity_id": r.entity_id, "action": r.action}
            for r in existing_rows
        ],
    }


@router.get("/user-material-mappings")
async def list_user_material_mappings(
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "view", "users")),
):
    await ensure_organization_structure_schema(db)
    await ensure_user_item_permission_schema(db)
    offset, limit = paginate_params(page, page_size)
    category_alias = aliased(ItemCategory)
    item_alias = aliased(Item)
    q = (
        select(
            RoleItemPermission,
            Role.code.label("role_code"),
            Role.name.label("role_name"),
            category_alias.name.label("category_name"),
            category_alias.full_code.label("category_code"),
            item_alias.item_code,
            item_alias.name.label("item_name"),
        )
        .join(Role, RoleItemPermission.role_id == Role.id)
        .join(category_alias, (RoleItemPermission.entity_type == "item_category") & (RoleItemPermission.entity_id == category_alias.id), isouter=True)
        .join(item_alias, (RoleItemPermission.entity_type == "item") & (RoleItemPermission.entity_id == item_alias.id), isouter=True)
    )
    count_q = select(func.count(RoleItemPermission.id)).join(Role, RoleItemPermission.role_id == Role.id)
    if search:
        like = f"%{search}%"
        condition = or_(
            Role.name.ilike(like),
            Role.code.ilike(like),
            category_alias.name.ilike(like),
            category_alias.full_code.ilike(like),
            item_alias.item_code.ilike(like),
            item_alias.name.ilike(like),
            RoleItemPermission.action.ilike(like),
        )
        q = q.where(condition)
        count_q = (
            count_q
            .join(category_alias, (RoleItemPermission.entity_type == "item_category") & (RoleItemPermission.entity_id == category_alias.id), isouter=True)
            .join(item_alias, (RoleItemPermission.entity_type == "item") & (RoleItemPermission.entity_id == item_alias.id), isouter=True)
            .where(condition)
        )
    total = (await db.execute(count_q)).scalar() or 0
    rows = (await db.execute(q.order_by(RoleItemPermission.created_at.desc(), RoleItemPermission.id.desc()).offset(offset).limit(limit))).all()
    items = []
    for permission, role_code, role_name, category_name, category_code, item_code, item_name in rows:
        target_name = category_name if permission.entity_type == "item_category" else item_name
        target_code = category_code if permission.entity_type == "item_category" else item_code
        items.append({
            "id": permission.id,
            "role_id": permission.role_id,
            "role_code": role_code,
            "role_name": role_name,
            "entity_type": permission.entity_type,
            "entity_id": permission.entity_id,
            "target_code": target_code,
            "target_name": target_name,
            "action": permission.action,
            "created_at": permission.created_at,
        })
    return build_paginated_response(items, total, page, page_size)


@router.post("/user-material-mappings/bulk", status_code=201)
async def bulk_map_user_materials(
    payload: UserItemBulkMapCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "users")),
):
    await ensure_organization_structure_schema(db)
    await ensure_user_item_permission_schema(db)
    role_ids = payload.role_ids
    category_ids = payload.category_ids
    item_ids = payload.item_ids
    valid_role_ids = {
        int(row[0])
        for row in (await db.execute(select(Role.id).where(Role.id.in_(role_ids), Role.is_active == True))).all()  # noqa: E712
    }
    valid_category_ids = set()
    if category_ids:
        valid_category_ids = {
            int(row[0])
            for row in (await db.execute(select(ItemCategory.id).where(ItemCategory.id.in_(category_ids)))).all()
        }
    valid_item_ids = set()
    if item_ids:
        valid_item_ids = {
            int(row[0])
            for row in (await db.execute(select(Item.id).where(Item.id.in_(item_ids), Item.is_active == True))).all()  # noqa: E712
        }
    missing_roles = [rid for rid in role_ids if rid not in valid_role_ids]
    missing_categories = [cid for cid in category_ids if cid not in valid_category_ids]
    missing_items = [iid for iid in item_ids if iid not in valid_item_ids]
    if missing_roles or missing_categories or missing_items:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Only active roles, valid categories, and active items can be mapped",
                "missing_role_ids": missing_roles,
                "missing_category_ids": missing_categories,
                "missing_item_ids": missing_items,
            },
        )
    if payload.replace_existing:
        await db.execute(
            delete(RoleItemPermission).where(
                RoleItemPermission.role_id.in_(role_ids),
                RoleItemPermission.action == payload.action,
            )
        )
    existing_rows = (await db.execute(
        select(RoleItemPermission.role_id, RoleItemPermission.entity_type, RoleItemPermission.entity_id).where(
            RoleItemPermission.role_id.in_(role_ids),
            RoleItemPermission.action == payload.action,
        )
    )).all()
    existing = {(int(rid), etype, int(eid) if eid is not None else None) for rid, etype, eid in existing_rows}
    targets = [("item_category", cid) for cid in category_ids] + [("item", iid) for iid in item_ids]
    created = 0
    skipped = 0
    for role_id in role_ids:
        for entity_type, entity_id in targets:
            key = (role_id, entity_type, entity_id)
            if key in existing:
                skipped += 1
                continue
            db.add(RoleItemPermission(role_id=role_id, entity_type=entity_type, entity_id=entity_id, action=payload.action))
            created += 1
    await db.flush()
    return {
        "success": True,
        "message": f"Mapped {created} role-material permission(s)",
        "created": created,
        "skipped_existing": skipped,
        "roles": len(role_ids),
        "categories": len(category_ids),
        "items": len(item_ids),
    }


@router.put("/vendors/{vendor_id}/items/{vendor_item_id}")
async def update_vendor_item(
    vendor_id: int,
    vendor_item_id: int,
    payload: VendorItemCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "vendors")),
):
    vi = (
        await db.execute(
            select(VendorItem).where(
                VendorItem.id == vendor_item_id,
                VendorItem.vendor_id == vendor_id,
            )
        )
    ).scalar_one_or_none()
    if not vi:
        raise HTTPException(status_code=404, detail="Vendor item mapping not found")
    duplicate = (
        await db.execute(
            select(VendorItem).where(
                VendorItem.vendor_id == vendor_id,
                VendorItem.item_id == payload.item_id,
                VendorItem.id != vendor_item_id,
            )
        )
    ).scalar_one_or_none()
    if duplicate:
        raise HTTPException(status_code=409, detail="This item is already linked to the vendor")
    old_values = _vendor_item_snapshot(vi)
    for key, value in payload.model_dump().items():
        setattr(vi, key, value)
    vi.vendor_id = vendor_id
    await db.flush()
    _add_vendor_item_history(db, vi, "update", current_user, old_values)
    return {"id": vi.id, "message": "Vendor item updated"}


@router.delete("/vendors/{vendor_id}/items/{vendor_item_id}")
async def delete_vendor_item(
    vendor_id: int,
    vendor_item_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "vendors")),
):
    vi = (
        await db.execute(
            select(VendorItem).where(
                VendorItem.id == vendor_item_id,
                VendorItem.vendor_id == vendor_id,
            )
        )
    ).scalar_one_or_none()
    if not vi:
        raise HTTPException(status_code=404, detail="Vendor item mapping not found")
    old_values = _vendor_item_snapshot(vi)
    _add_vendor_item_history(db, vi, "delete", current_user, old_values)
    await db.delete(vi)
    await db.flush()
    return {"message": "Vendor item mapping deleted"}


@router.post("/vendors/{vendor_id}/contracts", status_code=201)
async def add_vendor_contract(
    vendor_id: int,
    payload: VendorContractCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "vendors")),
):
    # BUG-FE-053
    vc = VendorContract(**payload.model_dump())
    vc.vendor_id = vendor_id
    db.add(vc)
    await db.flush()
    return {"id": vc.id, "message": "Contract created"}


@router.post("/vendors/{vendor_id}/ratings", status_code=201)
async def add_vendor_rating(
    vendor_id: int,
    payload: VendorRatingCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "vendors")),
):
    # BUG-FE-053: gate writes
    vr = VendorRating(**payload.model_dump(), rated_by=current_user.id)
    vr.vendor_id = vendor_id
    db.add(vr)
    await db.flush()

    # BUG-FE-054: aggregate by averaging across all ratings instead of
    # overwriting with the latest single rating.
    vendor_result = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    vendor = vendor_result.scalar_one_or_none()
    if vendor:
        avg = (await db.execute(
            select(func.avg(VendorRating.overall_rating)).where(
                VendorRating.vendor_id == vendor_id
            )
        )).scalar()
        if avg is not None:
            # Round to 1 decimal place to match Antd <Rate allowHalf>
            vendor.rating = round(float(avg) * 2) / 2
    await db.flush()

    return {"id": vr.id, "message": "Rating added"}


# ==================== WAREHOUSES ====================

async def _check_circular_warehouse(db: AsyncSession, warehouse_id: int, parent_id: int) -> bool:
    """Return True if assigning parent_id to warehouse_id would create a circular loop."""
    if warehouse_id == parent_id:
        return True
    current_parent = parent_id
    while current_parent is not None:
        result = await db.execute(
            select(Warehouse.parent_id).where(Warehouse.id == current_parent)
        )
        next_parent = result.scalar_one_or_none()
        if next_parent == warehouse_id:
            return True
        if next_parent == current_parent:
            break
        current_parent = next_parent
    return False


@router.get("/warehouses")
async def list_warehouses(
    search: str = Query(None),
    is_active: bool = Query(None),
    exclude_virtual: bool = Query(False, description="Hide virtual warehouses (vehicles/mobile units)"),
    type: str = Query(None, description="Filter to a specific warehouse type"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from app.utils.dependencies import user_is_managerial, user_warehouse_ids
    is_managerial = await user_is_managerial(db, current_user.id)

    query = select(Warehouse).options(selectinload(Warehouse.parent)).order_by(Warehouse.name)
    if is_active is not None:
        query = query.where(Warehouse.is_active == is_active)

    if is_managerial:
        # Managers see all non-virtual warehouses by default
        if exclude_virtual:
            query = query.where(Warehouse.type != "virtual")
        if type:
            query = query.where(Warehouse.type == type)
    else:
        # Non-managerial users only see warehouses assigned to them,
        # whether virtual or real. We do not exclude their assigned virtual ones.
        scoped_wh = await user_warehouse_ids(db, current_user.id)
        if not scoped_wh:
            return []
        query = query.where(Warehouse.id.in_(scoped_wh))

    query = apply_search_filter(query, Warehouse, search, ["code", "name", "city"])

    result = await db.execute(query)
    whs = result.scalars().all()
    return [WarehouseResponse.model_validate(w) for w in whs]


@router.get("/warehouses/{warehouse_id}", response_model=WarehouseResponse)
async def get_warehouse(
    warehouse_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(Warehouse).options(selectinload(Warehouse.parent)).where(Warehouse.id == warehouse_id))
    wh = result.scalar_one_or_none()
    if not wh:
        raise HTTPException(status_code=404, detail="Warehouse not found")
    return WarehouseResponse.model_validate(wh)


@router.post("/warehouses", status_code=201)
async def create_warehouse(
    payload: WarehouseCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "create", "warehouses")),
):
    data = payload.model_dump()
    # Map frontend field names to backend model columns
    if data.get("warehouse_type") and not data.get("type"):
        data["type"] = data["warehouse_type"]
    if data.get("contact_phone") and not data.get("phone"):
        data["phone"] = data["contact_phone"]
    if data.get("address") and not data.get("address_line1"):
        data["address_line1"] = data["address"]
    # Default organization_id
    if not data.get("organization_id"):
        data["organization_id"] = 1
        
    parent_id = data.get("parent_id")
    if parent_id is not None:
        parent_exists = (await db.execute(
            select(Warehouse.id).where(Warehouse.id == parent_id)
        )).scalar_one_or_none()
        if not parent_exists:
            raise HTTPException(status_code=400, detail="Parent warehouse not found")

    # Remove extra fields not in the model
    for key in ["warehouse_type", "contact_phone", "address", "description", "status"]:
        data.pop(key, None)
    # BUG-FE-062: enforce case-insensitive unique warehouse code
    code_val = (data.get("code") or "").strip()
    if code_val:
        dup = await db.execute(
            select(Warehouse).where(func.lower(Warehouse.code) == code_val.lower())
        )
        if dup.scalar_one_or_none():
            raise HTTPException(
                status_code=409,
                detail=f"Warehouse with code '{code_val}' already exists",
            )
        data["code"] = code_val.upper()
    wh = Warehouse(**data)
    db.add(wh)
    await db.flush()
    return {"id": wh.id, "message": "Warehouse created"}


@router.put("/warehouses/{warehouse_id}")
async def update_warehouse(
    warehouse_id: int,
    payload: WarehouseUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "warehouses")),
):
    # BUG-FE-063: gate edit behind masters.update.warehouses
    result = await db.execute(select(Warehouse).options(selectinload(Warehouse.parent)).where(Warehouse.id == warehouse_id))
    wh = result.scalar_one_or_none()
    if not wh:
        raise HTTPException(status_code=404, detail="Warehouse not found")
    update_data = payload.model_dump(exclude_unset=True)
    
    # If parent_id is being updated, validate it
    if "parent_id" in update_data:
        parent_id = update_data.get("parent_id")
        if parent_id is not None:
            if parent_id == warehouse_id:
                raise HTTPException(status_code=400, detail="A warehouse cannot be its own parent")
            parent_exists = (await db.execute(
                select(Warehouse.id).where(Warehouse.id == parent_id)
            )).scalar_one_or_none()
            if not parent_exists:
                raise HTTPException(status_code=400, detail="Parent warehouse not found")
            if await _check_circular_warehouse(db, warehouse_id, parent_id):
                raise HTTPException(status_code=400, detail="Circular hierarchy detected: parent warehouse cannot be itself or a child/descendant warehouse")

    # If the caller is changing the code, re-check uniqueness (case-insensitive)
    new_code = update_data.get("code")
    if new_code and new_code.strip():
        dup = await db.execute(
            select(Warehouse).where(
                func.lower(Warehouse.code) == new_code.strip().lower(),
                Warehouse.id != warehouse_id,
            )
        )
        if dup.scalar_one_or_none():
            raise HTTPException(
                status_code=409,
                detail=f"Warehouse with code '{new_code}' already exists",
            )
        update_data["code"] = new_code.strip().upper()
    for k, v in update_data.items():
        setattr(wh, k, v)
    await db.flush()
    return {"success": True, "message": "Warehouse updated"}


# ---- Warehouse Hierarchy ----

@router.get("/warehouses/{warehouse_id}/locations")
async def list_locations(
    warehouse_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(WarehouseLocation).where(WarehouseLocation.warehouse_id == warehouse_id)
    )
    return [{"id": l.id, "code": l.code, "name": l.name, "is_active": l.is_active} for l in result.scalars().all()]


@router.post("/warehouses/locations", status_code=201)
async def create_location(
    payload: LocationCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    data = payload.model_dump()
    # BUG-FE-065: verify warehouse exists
    wh = (await db.execute(
        select(Warehouse.id).where(Warehouse.id == data.get("warehouse_id"))
    )).scalar_one_or_none()
    if wh is None:
        raise HTTPException(status_code=404, detail="Warehouse not found")
    loc = WarehouseLocation(**data)
    db.add(loc)
    await db.flush()
    return {"id": loc.id, "message": "Location created"}


@router.get("/locations/{location_id}/lines")
async def list_lines(
    location_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(WarehouseLine).where(WarehouseLine.location_id == location_id)
    )
    return [{"id": l.id, "code": l.code, "name": l.name, "zone_type": l.zone_type, "is_active": l.is_active} for l in result.scalars().all()]


@router.post("/warehouses/lines", status_code=201)
async def create_line(
    payload: LineCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    data = payload.model_dump()
    # BUG-FE-065: verify location belongs to a real warehouse
    loc = (await db.execute(
        select(WarehouseLocation).where(WarehouseLocation.id == data.get("location_id"))
    )).scalar_one_or_none()
    if loc is None:
        raise HTTPException(status_code=404, detail="Location not found")
    line = WarehouseLine(**data)
    db.add(line)
    await db.flush()
    return {"id": line.id, "message": "Line created"}


@router.get("/lines/{line_id}/racks")
async def list_racks(
    line_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(WarehouseRack).where(WarehouseRack.line_id == line_id)
    )
    return [{"id": r.id, "code": r.code, "name": r.name, "levels": r.levels, "is_active": r.is_active} for r in result.scalars().all()]


@router.post("/warehouses/racks", status_code=201)
async def create_rack(
    payload: RackCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    data = payload.model_dump()
    # BUG-FE-065: verify line exists
    line = (await db.execute(
        select(WarehouseLine).where(WarehouseLine.id == data.get("line_id"))
    )).scalar_one_or_none()
    if line is None:
        raise HTTPException(status_code=404, detail="Line not found")
    rack = WarehouseRack(**data)
    db.add(rack)
    await db.flush()
    return {"id": rack.id, "message": "Rack created"}


@router.get("/racks/{rack_id}/bins")
async def list_bins(
    rack_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(WarehouseBin).where(WarehouseBin.rack_id == rack_id)
    )
    return [{"id": b.id, "code": b.code, "name": b.name, "bin_type": b.bin_type, "capacity": float(b.capacity or 0), "is_active": b.is_active} for b in result.scalars().all()]


@router.post("/warehouses/bins", status_code=201)
async def create_bin(
    payload: BinCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    data = payload.model_dump()
    # BUG-FE-065: verify rack→line→location chain exists. Without this, FE can
    # post `rack_id` referencing a different warehouse and silently nest the
    # bin under the wrong tree.
    rack = (await db.execute(
        select(WarehouseRack).where(WarehouseRack.id == data.get("rack_id"))
    )).scalar_one_or_none()
    if rack is None:
        raise HTTPException(status_code=404, detail="Rack not found")
    line = (await db.execute(
        select(WarehouseLine).where(WarehouseLine.id == rack.line_id)
    )).scalar_one_or_none()
    if line is None:
        raise HTTPException(status_code=404, detail="Rack has no parent line")
    loc = (await db.execute(
        select(WarehouseLocation).where(WarehouseLocation.id == line.location_id)
    )).scalar_one_or_none()
    if loc is None:
        raise HTTPException(status_code=404, detail="Line has no parent location")
    # BUG-INV-114: a bin cannot be BOTH a reserve bin and a pick bin — those
    # are mutually-exclusive roles in the replenishment model. Without this
    # check the FE form happily set both to True and replenishment rules picked
    # the wrong source.
    if data.get("is_reserve") and data.get("is_pick_bin"):
        raise HTTPException(
            status_code=422,
            detail="A bin cannot be both is_reserve and is_pick_bin — pick exactly one role",
        )
    bin_obj = WarehouseBin(**data)
    db.add(bin_obj)
    await db.flush()
    return {"id": bin_obj.id, "message": "Bin created"}


@router.get("/warehouses/{warehouse_id}/all-bins")
async def get_warehouse_bins(
    warehouse_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get all bins in a warehouse (traversing the hierarchy)."""
    result = await db.execute(
        select(WarehouseBin)
        .join(WarehouseRack, WarehouseBin.rack_id == WarehouseRack.id)
        .join(WarehouseLine, WarehouseRack.line_id == WarehouseLine.id)
        .join(WarehouseLocation, WarehouseLine.location_id == WarehouseLocation.id)
        .where(WarehouseLocation.warehouse_id == warehouse_id)
        .where(WarehouseBin.is_active == True)
    )
    bins = result.scalars().all()
    return [{"id": b.id, "code": b.code, "name": b.name, "bin_type": b.bin_type, "rack_id": b.rack_id} for b in bins]


@router.get("/warehouses/{warehouse_id}/structure")
async def get_warehouse_structure(
    warehouse_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """WH-1 fix: Return full warehouse hierarchy in a SINGLE query instead of
    N+1 sequential calls (was 81+ requests for a real warehouse).

    Returns: { locations: [{ ...loc, lines: [{ ...line, racks: [{ ...rack, bins: [...] }] }] }] }
    """
    from sqlalchemy.orm import selectinload as _sl

    result = await db.execute(
        select(WarehouseLocation)
        .options(
            _sl(WarehouseLocation.lines)
            .selectinload(WarehouseLine.racks)
            .selectinload(WarehouseRack.bins)
        )
        .where(WarehouseLocation.warehouse_id == warehouse_id)
        .order_by(WarehouseLocation.code)
    )
    locations = result.scalars().unique().all()

    tree = []
    for loc in locations:
        loc_data = {"id": loc.id, "code": loc.code, "name": loc.name, "is_active": loc.is_active, "lines": []}
        for line in sorted(loc.lines, key=lambda l: l.code):
            line_data = {"id": line.id, "code": line.code, "name": line.name, "zone_type": line.zone_type, "is_active": line.is_active, "racks": []}
            for rack in sorted(line.racks, key=lambda r: r.code):
                rack_data = {"id": rack.id, "code": rack.code, "name": rack.name, "levels": rack.levels, "is_active": rack.is_active, "bins": []}
                for bin_obj in sorted(rack.bins, key=lambda b: b.code):
                    rack_data["bins"].append({"id": bin_obj.id, "code": bin_obj.code, "name": bin_obj.name, "bin_type": bin_obj.bin_type, "is_active": bin_obj.is_active})
                line_data["racks"].append(rack_data)
            loc_data["lines"].append(line_data)
        tree.append(loc_data)

    return {"warehouse_id": warehouse_id, "locations": tree}


# ==================== PRICE LISTS ====================

@router.get("/price-lists")
async def list_price_lists(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(PriceList).where(PriceList.is_active == True))
    return [{"id": p.id, "name": p.name, "type": p.type, "currency": p.currency, "is_default": p.is_default} for p in result.scalars().all()]


@router.post("/price-lists", status_code=201)
async def create_price_list(
    payload: PriceListCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    pl = PriceList(**payload.model_dump())
    db.add(pl)
    await db.flush()
    return {"id": pl.id, "message": "Price list created"}


@router.post("/price-lists/items", status_code=201)
async def add_price_list_item(
    payload: PriceListItemCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    pli = PriceListItem(**payload.model_dump())
    db.add(pli)
    await db.flush()
    return {"id": pli.id, "message": "Price list item added"}


# ---- Price List Item CRUD scoped under price list (BUG-FE-177) ----
# Frontend expects /masters/price-lists/{id}/items (GET/POST/PUT/DELETE).

@router.get("/price-lists/{price_list_id}/items")
async def list_price_list_items(
    price_list_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(500, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Confirm parent price list exists
    pl = (await db.execute(select(PriceList).where(PriceList.id == price_list_id))).scalar_one_or_none()
    if not pl:
        raise HTTPException(status_code=404, detail="Price list not found")
    offset, limit = paginate_params(page, page_size)
    total = (await db.execute(
        select(func.count(PriceListItem.id)).where(PriceListItem.price_list_id == price_list_id)
    )).scalar() or 0
    result = await db.execute(
        select(PriceListItem, Item.code, Item.name)
        .join(Item, PriceListItem.item_id == Item.id, isouter=True)
        .where(PriceListItem.price_list_id == price_list_id)
        .order_by(PriceListItem.id.desc())
        .offset(offset).limit(limit)
    )
    rows = result.all()
    items = []
    for pli, item_code, item_name in rows:
        items.append({
            "id": pli.id,
            "price_list_id": pli.price_list_id,
            "item_id": pli.item_id,
            "item_code": item_code,
            "item_name": item_name,
            "rate": float(pli.rate) if pli.rate is not None else None,
            "min_qty": float(pli.min_qty) if pli.min_qty is not None else None,
            "valid_from": pli.valid_from,
            "valid_to": pli.valid_to,
        })
    return build_paginated_response(items, total, page, page_size)


@router.post("/price-lists/{price_list_id}/items", status_code=201)
async def add_price_list_item_scoped(
    price_list_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    pl = (await db.execute(select(PriceList).where(PriceList.id == price_list_id))).scalar_one_or_none()
    if not pl:
        raise HTTPException(status_code=404, detail="Price list not found")
    data = dict(payload or {})
    data["price_list_id"] = price_list_id
    if "item_id" not in data or data["item_id"] in (None, ""):
        raise HTTPException(status_code=400, detail="item_id is required")
    if "rate" not in data or data["rate"] in (None, ""):
        raise HTTPException(status_code=400, detail="rate is required")
    # Filter to model columns
    allowed = {"price_list_id", "item_id", "rate", "min_qty", "valid_from", "valid_to"}
    clean = {k: v for k, v in data.items() if k in allowed}
    pli = PriceListItem(**clean)
    db.add(pli)
    await db.flush()
    return {"id": pli.id, "message": "Price list item added"}


@router.put("/price-lists/{price_list_id}/items/{item_id}")
async def update_price_list_item(
    price_list_id: int,
    item_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(PriceListItem).where(
            PriceListItem.id == item_id,
            PriceListItem.price_list_id == price_list_id,
        )
    )
    pli = result.scalar_one_or_none()
    if not pli:
        raise HTTPException(status_code=404, detail="Price list item not found")
    allowed = {"item_id", "rate", "min_qty", "valid_from", "valid_to"}
    for k, v in (payload or {}).items():
        if k in allowed:
            setattr(pli, k, v)
    await db.flush()
    return {"success": True, "message": "Price list item updated"}


@router.delete("/price-lists/{price_list_id}/items/{item_id}")
async def delete_price_list_item(
    price_list_id: int,
    item_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(PriceListItem).where(
            PriceListItem.id == item_id,
            PriceListItem.price_list_id == price_list_id,
        )
    )
    pli = result.scalar_one_or_none()
    if not pli:
        raise HTTPException(status_code=404, detail="Price list item not found")
    # Hard delete: price_list_items has no is_active column.
    await db.delete(pli)
    await db.flush()
    return {"success": True, "message": "Price list item removed"}


# ==================== PROJECTS ====================

@router.get("/projects")
async def list_projects(
    search: str = Query(None),
    status: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List projects scoped to the calling user.

    Non-managerial users see only their `user_projects` set. Managerial roles
    (super_admin/admin/warehouse_manager/etc.) see everything. Without this
    scope the indent form's project dropdown leaked every project to every
    user, defeating the purpose of user_projects.
    """
    query = select(Project).order_by(Project.name)
    if status:
        query = query.where(Project.status == status)
    if search:
        query = query.where(Project.name.ilike(f"%{search}%") | Project.code.ilike(f"%{search}%"))

    from app.utils.dependencies import user_is_managerial
    if not await user_is_managerial(db, current_user.id):
        from app.models.user import UserProject
        rows = await db.execute(
            select(UserProject.project_id).where(UserProject.user_id == current_user.id)
        )
        proj_ids = [r[0] for r in rows.all()]
        if not proj_ids:
            return []
        query = query.where(Project.id.in_(proj_ids))

    result = await db.execute(query)
    projects = result.scalars().all()
    return [{
        "id": p.id, "name": p.name, "code": p.code,
        "description": p.description, "status": p.status,
        "start_date": p.start_date, "end_date": p.end_date,
        "organization_id": p.organization_id,
    } for p in projects]


# ==================== HIERARCHY ALIASES (frontend compatibility) ====================
# Frontend calls /masters/warehouses/{wh_id}/locations/{loc_id}/lines etc.
# but actual routes are /masters/locations/{loc_id}/lines etc.

@router.get("/warehouses/{warehouse_id}/locations/{location_id}/lines")
async def list_lines_alias(
    warehouse_id: int,
    location_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await list_lines(location_id=location_id, db=db, current_user=current_user)


@router.get("/warehouses/{warehouse_id}/lines/{line_id}/racks")
async def list_racks_alias(
    warehouse_id: int,
    line_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await list_racks(line_id=line_id, db=db, current_user=current_user)


@router.get("/warehouses/{warehouse_id}/racks/{rack_id}/bins")
async def list_bins_alias(
    warehouse_id: int,
    rack_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await list_bins(rack_id=rack_id, db=db, current_user=current_user)


# WarehouseTree component calls /masters/warehouses/{entity_id}/locations etc.
# When entity_id is a location/line/rack (not warehouse), we need aliases

@router.get("/warehouses/{entity_id}/lines")
async def list_lines_whtree(
    entity_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """WarehouseTree alias: treat entity_id as location_id.

    BUG-FE-064: verify entity_id is actually a WarehouseLocation, otherwise the
    alias silently returns lines for whatever id was passed (e.g. a warehouse id
    or rack id) — leaking cross-tenant rows on collisions.
    """
    loc = (await db.execute(
        select(WarehouseLocation.id).where(WarehouseLocation.id == entity_id)
    )).scalar_one_or_none()
    if loc is None:
        raise HTTPException(status_code=404, detail="Location not found")
    return await list_lines(location_id=entity_id, db=db, current_user=current_user)


@router.get("/warehouses/{entity_id}/racks")
async def list_racks_whtree(
    entity_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """WarehouseTree alias: treat entity_id as line_id (BUG-FE-064 verified)."""
    line = (await db.execute(
        select(WarehouseLine.id).where(WarehouseLine.id == entity_id)
    )).scalar_one_or_none()
    if line is None:
        raise HTTPException(status_code=404, detail="Line not found")
    return await list_racks(line_id=entity_id, db=db, current_user=current_user)


@router.get("/warehouses/{entity_id}/bins")
async def list_bins_whtree(
    entity_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """WarehouseTree alias: treat entity_id as rack_id (BUG-FE-064 verified)."""
    rack = (await db.execute(
        select(WarehouseRack.id).where(WarehouseRack.id == entity_id)
    )).scalar_one_or_none()
    if rack is None:
        raise HTTPException(status_code=404, detail="Rack not found")
    return await list_bins(rack_id=entity_id, db=db, current_user=current_user)


# ---- Warehouse hierarchy PUT/DELETE (BUG-FE-067, BUG-FE-068) ----
# UI calls /masters/warehouses/{wh_id}/{level}/{entity_id} for both PUT and DELETE.
# DELETE = soft delete (is_active=False) with FK guard preventing deletion of
# parents that still have active children. PUT = partial update of name/code/etc.

@router.put("/warehouses/{warehouse_id}/locations/{location_id}")
async def update_location(
    warehouse_id: int,
    location_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(WarehouseLocation).where(
            WarehouseLocation.id == location_id,
            WarehouseLocation.warehouse_id == warehouse_id,
        )
    )
    loc = result.scalar_one_or_none()
    if not loc:
        raise HTTPException(status_code=404, detail="Location not found")
    allowed = {"code", "name", "description", "is_active"}
    for k, v in (payload or {}).items():
        if k in allowed:
            setattr(loc, k, v)
    await db.flush()
    return {"success": True, "message": "Location updated"}


@router.delete("/warehouses/{warehouse_id}/locations/{location_id}")
async def delete_location(
    warehouse_id: int,
    location_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(WarehouseLocation).where(
            WarehouseLocation.id == location_id,
            WarehouseLocation.warehouse_id == warehouse_id,
        )
    )
    loc = result.scalar_one_or_none()
    if not loc:
        raise HTTPException(status_code=404, detail="Location not found")
    # FK guard: refuse if active children (lines) exist
    child_count = (await db.execute(
        select(func.count(WarehouseLine.id)).where(
            WarehouseLine.location_id == location_id,
            WarehouseLine.is_active == True,
        )
    )).scalar()
    if child_count and child_count > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete: location has {child_count} active line(s). Delete children first.",
        )
    loc.is_active = False
    await db.flush()
    return {"success": True, "message": "Location deactivated"}


@router.put("/warehouses/{warehouse_id}/lines/{line_id}")
async def update_line(
    warehouse_id: int,
    line_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(WarehouseLine).join(WarehouseLocation).where(
            WarehouseLine.id == line_id,
            WarehouseLocation.warehouse_id == warehouse_id,
        )
    )
    line = result.scalar_one_or_none()
    if not line:
        raise HTTPException(status_code=404, detail="Line not found")
    allowed = {"code", "name", "zone_type", "is_active"}
    for k, v in (payload or {}).items():
        if k in allowed:
            setattr(line, k, v)
    await db.flush()
    return {"success": True, "message": "Line updated"}


@router.delete("/warehouses/{warehouse_id}/lines/{line_id}")
async def delete_line(
    warehouse_id: int,
    line_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(WarehouseLine).join(WarehouseLocation).where(
            WarehouseLine.id == line_id,
            WarehouseLocation.warehouse_id == warehouse_id,
        )
    )
    line = result.scalar_one_or_none()
    if not line:
        raise HTTPException(status_code=404, detail="Line not found")
    child_count = (await db.execute(
        select(func.count(WarehouseRack.id)).where(
            WarehouseRack.line_id == line_id,
            WarehouseRack.is_active == True,
        )
    )).scalar()
    if child_count and child_count > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete: line has {child_count} active rack(s). Delete children first.",
        )
    line.is_active = False
    await db.flush()
    return {"success": True, "message": "Line deactivated"}


@router.put("/warehouses/{warehouse_id}/racks/{rack_id}")
async def update_rack(
    warehouse_id: int,
    rack_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(WarehouseRack)
        .join(WarehouseLine, WarehouseRack.line_id == WarehouseLine.id)
        .join(WarehouseLocation, WarehouseLine.location_id == WarehouseLocation.id)
        .where(
            WarehouseRack.id == rack_id,
            WarehouseLocation.warehouse_id == warehouse_id,
        )
    )
    rack = result.scalar_one_or_none()
    if not rack:
        raise HTTPException(status_code=404, detail="Rack not found")
    allowed = {"code", "name", "levels", "is_active"}
    for k, v in (payload or {}).items():
        if k in allowed:
            setattr(rack, k, v)
    await db.flush()
    return {"success": True, "message": "Rack updated"}


@router.delete("/warehouses/{warehouse_id}/racks/{rack_id}")
async def delete_rack(
    warehouse_id: int,
    rack_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(WarehouseRack)
        .join(WarehouseLine, WarehouseRack.line_id == WarehouseLine.id)
        .join(WarehouseLocation, WarehouseLine.location_id == WarehouseLocation.id)
        .where(
            WarehouseRack.id == rack_id,
            WarehouseLocation.warehouse_id == warehouse_id,
        )
    )
    rack = result.scalar_one_or_none()
    if not rack:
        raise HTTPException(status_code=404, detail="Rack not found")
    child_count = (await db.execute(
        select(func.count(WarehouseBin.id)).where(
            WarehouseBin.rack_id == rack_id,
            WarehouseBin.is_active == True,
        )
    )).scalar()
    if child_count and child_count > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete: rack has {child_count} active bin(s). Delete children first.",
        )
    rack.is_active = False
    await db.flush()
    return {"success": True, "message": "Rack deactivated"}


@router.put("/warehouses/{warehouse_id}/bins/{bin_id}")
async def update_bin(
    warehouse_id: int,
    bin_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(WarehouseBin)
        .join(WarehouseRack, WarehouseBin.rack_id == WarehouseRack.id)
        .join(WarehouseLine, WarehouseRack.line_id == WarehouseLine.id)
        .join(WarehouseLocation, WarehouseLine.location_id == WarehouseLocation.id)
        .where(
            WarehouseBin.id == bin_id,
            WarehouseLocation.warehouse_id == warehouse_id,
        )
    )
    bin_obj = result.scalar_one_or_none()
    if not bin_obj:
        raise HTTPException(status_code=404, detail="Bin not found")
    allowed = {"code", "name", "bin_type", "capacity", "capacity_uom",
               "is_reserve", "is_pick_bin", "barcode", "is_active"}
    for k, v in (payload or {}).items():
        if k in allowed:
            setattr(bin_obj, k, v)
    # BUG-INV-114: re-validate the mutually-exclusive flag pair after applying
    # updates — a payload that sets one flag while the other is already True
    # on the row would otherwise leave both True silently.
    if bin_obj.is_reserve and bin_obj.is_pick_bin:
        raise HTTPException(
            status_code=422,
            detail="A bin cannot be both is_reserve and is_pick_bin — pick exactly one role",
        )
    await db.flush()
    return {"success": True, "message": "Bin updated"}


@router.delete("/warehouses/{warehouse_id}/bins/{bin_id}")
async def delete_bin(
    warehouse_id: int,
    bin_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(WarehouseBin)
        .join(WarehouseRack, WarehouseBin.rack_id == WarehouseRack.id)
        .join(WarehouseLine, WarehouseRack.line_id == WarehouseLine.id)
        .join(WarehouseLocation, WarehouseLine.location_id == WarehouseLocation.id)
        .where(
            WarehouseBin.id == bin_id,
            WarehouseLocation.warehouse_id == warehouse_id,
        )
    )
    bin_obj = result.scalar_one_or_none()
    if not bin_obj:
        raise HTTPException(status_code=404, detail="Bin not found")
    bin_obj.is_active = False
    await db.flush()
    return {"success": True, "message": "Bin deactivated"}


# ==================== DEPARTMENTS (for MR form dropdown) ====================

@router.get("/departments")
async def list_departments(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return department list for dropdown. Uses distinct departments from material_requests table."""
    from app.models.procurement import MaterialRequest
    result = await db.execute(
        select(MaterialRequest.department).where(MaterialRequest.department.isnot(None)).distinct()
    )
    depts = [r[0] for r in result.all() if r[0]]
    # Always include common departments
    default_depts = [
        "Administration", "Finance", "HR", "IT", "Logistics",
        "Operations", "Procurement", "Production", "Quality", "Sales",
        "Warehouse", "Maintenance", "R&D", "Marketing",
    ]
    all_depts = sorted(set(default_depts + depts))
    # BUG-FE-171: previously id == name (string). Provide a numeric synthetic
    # id (1-based index) for grids/Selects that expect a key, while keeping
    # the original string in `code` for legacy callers.
    return [
        {"id": idx + 1, "name": d, "code": d, "value": d}
        for idx, d in enumerate(all_depts)
    ]


# =====================================================================
# SUPPLIER (material vendor) PORTAL LOGIN MANAGEMENT
# coordinator-side CRUD — mirrors carrier login endpoints in logistics.py
# =====================================================================

from app.services.auth_service import hash_password as _hash_password  # noqa: E402
from app.schemas.vendor_auth import VendorLoginCreate, VendorLoginUpdate  # noqa: E402


@router.get("/vendors/{vendor_id}/supplier-login")
async def get_supplier_login(
    vendor_id: int,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Return login status for this material supplier vendor."""
    await ensure_supplier_portal_schema(db)
    from app.models.vendor_portal import VendorUser
    res = await db.execute(select(VendorUser).where(VendorUser.vendor_id == vendor_id))
    vu = res.scalar_one_or_none()
    if not vu:
        return {"has_login": False}
    return {
        "has_login": True,
        "id": vu.id,
        "username": vu.username,
        "email": vu.email,
        "full_name": vu.full_name,
        "phone": vu.phone,
        "is_active": vu.is_active,
        "must_change_password": vu.must_change_password,
        "last_login": vu.last_login,
        "created_at": vu.created_at,
    }


@router.post("/vendors/{vendor_id}/supplier-login", status_code=201)
async def create_supplier_login(
    vendor_id: int,
    payload: VendorLoginCreate,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Provision a new portal login for a material supplier vendor."""
    await ensure_supplier_portal_schema(db)
    from app.models.vendor_portal import VendorUser
    # Validate vendor exists
    res = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    v = res.scalar_one_or_none()
    if not v:
        raise HTTPException(404, "Vendor not found")
    if not v.is_active:
        raise HTTPException(400, "Cannot create login for an inactive vendor")

    # One login per vendor
    res_existing = await db.execute(select(VendorUser).where(VendorUser.vendor_id == vendor_id))
    if res_existing.scalar_one_or_none():
        raise HTTPException(409, "This vendor already has a portal login. Use the update endpoint to reset password.")

    # Username uniqueness across all vendor users
    res_u = await db.execute(select(VendorUser).where(VendorUser.username == payload.username))
    if res_u.scalar_one_or_none():
        raise HTTPException(409, f"Username '{payload.username}' is already taken")

    vu = VendorUser(
        vendor_id=vendor_id,
        username=payload.username,
        email=str(payload.email),
        password_hash=_hash_password(payload.password),
        full_name=payload.full_name or v.contact_person,
        phone=payload.phone or v.phone,
        is_active=True,
        must_change_password=True,
        created_by=current_user.id,
    )
    db.add(vu)
    await db.commit()
    await db.refresh(vu)
    return {"id": vu.id, "username": vu.username, "message": "Supplier portal login created"}


@router.put("/vendors/{vendor_id}/supplier-login")
async def update_supplier_login(
    vendor_id: int,
    payload: VendorLoginUpdate,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Reset password or toggle active state of a supplier portal login."""
    await ensure_supplier_portal_schema(db)
    from app.models.vendor_portal import VendorUser
    res = await db.execute(select(VendorUser).where(VendorUser.vendor_id == vendor_id))
    vu = res.scalar_one_or_none()
    if not vu:
        raise HTTPException(404, "This vendor has no portal login")
    data = payload.model_dump(exclude_none=True)
    if "new_password" in data:
        vu.password_hash = _hash_password(data.pop("new_password"))
        vu.password_changed_at = datetime.now(timezone.utc)
        vu.must_change_password = True
        vu.failed_login_attempts = 0
        vu.locked_until = None
    for k, val in data.items():
        setattr(vu, k, val)
    await db.commit()
    return {"success": True, "message": "Supplier login updated"}


@router.delete("/vendors/{vendor_id}/supplier-login")
async def deactivate_supplier_login(
    vendor_id: int,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Deactivate (disable) a supplier portal login."""
    await ensure_supplier_portal_schema(db)
    from app.models.vendor_portal import VendorUser
    res = await db.execute(select(VendorUser).where(VendorUser.vendor_id == vendor_id))
    vu = res.scalar_one_or_none()
    if not vu:
        raise HTTPException(404, "This vendor has no portal login")
    vu.is_active = False
    await db.commit()
    return {"success": True, "message": "Supplier login deactivated"}


@router.get("/vendors/supplier-logins")
async def list_supplier_logins(
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """List all material vendor logins for the admin management table."""
    await ensure_supplier_portal_schema(db)
    from app.models.vendor_portal import VendorUser
    # All material (non-transport) vendors
    res_v = await db.execute(
        select(Vendor).where(
            (Vendor.is_transport_vendor == False) | (Vendor.is_transport_vendor.is_(None))  # noqa: E712
        ).order_by(Vendor.name.asc())
    )
    vendors = res_v.scalars().all()
    vendor_ids = [v.id for v in vendors]

    # Fetch all logins for these vendors
    login_map = {}
    if vendor_ids:
        res_lu = await db.execute(
            select(VendorUser).where(VendorUser.vendor_id.in_(vendor_ids))
        )
        for vu in res_lu.scalars().all():
            login_map[vu.vendor_id] = {
                "id": vu.id,
                "username": vu.username,
                "email": vu.email,
                "is_active": vu.is_active,
                "last_login": vu.last_login,
                "must_change_password": vu.must_change_password,
            }

    return [
        {
            "vendor_id": v.id,
            "vendor_code": v.vendor_code,
            "name": v.name,
            "contact_person": v.contact_person,
            "email": v.email,
            "phone": v.phone,
            "is_active": v.is_active,
            "login": login_map.get(v.id),
        }
        for v in vendors
    ]
