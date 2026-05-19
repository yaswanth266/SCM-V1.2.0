"""Phase-1 masters routes (2026-04-24): brands, item attributes,
item attribute values, user groups, group members, group permissions.

Lightweight CRUD. Mounted under /api/v1/masters via router.py.
"""
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, func, or_, update as sql_update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User
from app.models.master import (
    Item, UOM, UOMCategory, ItemCategory,
    Brand, ItemType, ItemAttribute, ItemAttributeValue,
    SpecCategory, Spec, ItemSpec, ItemSpecValue,
    Feature, ItemFeature,
    UserGroup, UserGroupMember, UserGroupPermission,
)
from app.schemas.master import ItemTypeCreate, ItemTypeResponse, FeatureCreate
from .masters import _get_parent_category_ids
from app.utils.dependencies import get_current_user
from app.utils.helpers import paginate_params, build_paginated_response
from app.utils.schema_sync import ensure_feature_schema, ensure_item_attribute_uom_schema, ensure_specs_schema


router = APIRouter()


# ---------- Item Types ----------

async def _ensure_item_types_table(db: AsyncSession) -> None:
    """Create and backfill item_types for legacy DBs missing this table."""
    conn = await db.connection()
    await conn.run_sync(ItemType.__table__.create, checkfirst=True)

    existing_total = await db.scalar(select(func.count(ItemType.id)))
    if (existing_total or 0) > 0:
        return

    # Backfill distinct types from legacy items.item_type values.
    legacy_names = (
        await db.execute(
            select(Item.item_type).where(Item.item_type.is_not(None)).distinct()
        )
    ).scalars().all()
    seen = set()
    for raw in legacy_names:
        name = (raw or "").strip().lower()
        if not name or name in seen:
            continue
        seen.add(name)
        db.add(ItemType(name=name, is_active=True))
    if seen:
        await db.flush()


@router.get("/item-types")
async def list_item_types(
    search: Optional[str] = None,
    page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    try:
        await _ensure_item_types_table(db)
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=500, detail="Failed to initialize item types master table") from exc
    q = select(ItemType).order_by(ItemType.name)
    if search:
        like = f"%{search}%"
        q = q.where(ItemType.name.ilike(like))
    count_q = q.order_by(None).with_only_columns(func.count(ItemType.id))
    total = await db.scalar(count_q)
    offset, limit = paginate_params(page, page_size)
    rows = (await db.execute(q.offset(offset).limit(limit))).scalars().all()
    return build_paginated_response(
        [
            {"id": it.id, "name": it.name,
             "description": it.description, "is_active": it.is_active}
            for it in rows
        ],
        total or 0, page, page_size,
    )


@router.post("/item-types", status_code=201)
async def create_item_type(
    payload: ItemTypeCreate,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    try:
        await _ensure_item_types_table(db)
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=500, detail="Failed to initialize item types master table") from exc
    existing = await db.execute(
        select(ItemType).where(func.lower(ItemType.name) == payload.name.strip().lower())
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Item type '{payload.name}' already exists")
    it = ItemType(name=payload.name.strip().lower(), description=payload.description, is_active=payload.is_active)
    db.add(it)
    await db.flush()
    return {"id": it.id, "message": "Item type created"}


@router.put("/item-types/{item_type_id}")
async def update_item_type(
    item_type_id: int,
    payload: ItemTypeCreate,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    try:
        await _ensure_item_types_table(db)
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=500, detail="Failed to initialize item types master table") from exc
    result = await db.execute(select(ItemType).where(ItemType.id == item_type_id))
    it = result.scalar_one_or_none()
    if not it:
        raise HTTPException(status_code=404, detail="Item type not found")
    # Check for name collision (case-insensitive)
    dup = await db.execute(
        select(ItemType).where(
            func.lower(ItemType.name) == payload.name.strip().lower(),
            ItemType.id != item_type_id,
        )
    )
    if dup.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Item type '{payload.name}' already exists")
    old_name = it.name
    new_name = payload.name.strip().lower()
    it.name = new_name
    it.description = payload.description
    it.is_active = payload.is_active
    # If the name changed, update all items referencing the old name
    if old_name != new_name:
        await db.execute(sql_update(Item).where(Item.item_type == old_name).values(item_type=new_name))
    await db.flush()
    return {"success": True, "message": "Item type updated"}


@router.delete("/item-types/{item_type_id}")
async def delete_item_type(
    item_type_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    try:
        await _ensure_item_types_table(db)
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=500, detail="Failed to initialize item types master table") from exc
    result = await db.execute(select(ItemType).where(ItemType.id == item_type_id))
    it = result.scalar_one_or_none()
    if not it:
        raise HTTPException(status_code=404, detail="Item type not found")
    # Check if items reference this type
    item_count = (await db.execute(
        select(func.count(Item.id)).where(Item.item_type == it.name)
    )).scalar() or 0
    if item_count > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete item type referenced by {item_count} item(s). Move items first.",
        )
    it.is_active = False
    await db.flush()
    return {"success": True, "message": "Item type deactivated"}


# ---------- Features ----------

@router.get("/features")
async def list_features(
    search: Optional[str] = None,
    category_id: Optional[int] = None,
    include_inactive: bool = Query(False),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_feature_schema(db)
    q = select(Feature).order_by(Feature.name)
    if category_id is not None:
        cat_ids = await _get_parent_category_ids(db, category_id)
        q = q.where(Feature.category_id.in_(cat_ids))
    if not include_inactive:
        q = q.where(Feature.is_active == True)  # noqa: E712
    if search:
        q = q.where(Feature.name.ilike(f"%{search}%"))
    count_q = q.order_by(None).with_only_columns(func.count(Feature.id))
    total = await db.scalar(count_q)
    offset, limit = paginate_params(page, page_size)
    rows = (await db.execute(q.offset(offset).limit(limit))).scalars().all()
    cat_ids = list({r.category_id for r in rows})
    category_map = {}
    if cat_ids:
        cats = (
            await db.execute(select(ItemCategory.id, ItemCategory.name).where(ItemCategory.id.in_(cat_ids)))
        ).all()
        category_map = {cid: cname for cid, cname in cats}
    return build_paginated_response(
        [
            {
                "id": f.id,
                "name": f.name,
                "category_id": f.category_id,
                "category_name": category_map.get(f.category_id),
                "is_active": f.is_active,
            }
            for f in rows
        ],
        total or 0,
        page,
        page_size,
    )


@router.post("/features", status_code=201)
async def create_feature(
    payload: FeatureCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_feature_schema(db)
    category = (await db.execute(select(ItemCategory).where(ItemCategory.id == payload.category_id))).scalar_one_or_none()
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")
    name = payload.name.strip()
    dup = await db.execute(
        select(Feature).where(
            Feature.category_id == payload.category_id,
            func.lower(func.trim(Feature.name)) == name.lower(),
        )
    )
    if dup.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Feature '{name}' already exists for this category")
    row = Feature(category_id=payload.category_id, name=name, is_active=payload.is_active)
    db.add(row)
    await db.flush()
    return {"id": row.id, "message": "Feature created"}


@router.put("/features/{feature_id}")
async def update_feature(
    feature_id: int,
    payload: FeatureCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_feature_schema(db)
    row = (await db.execute(select(Feature).where(Feature.id == feature_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Feature not found")
    category = (await db.execute(select(ItemCategory).where(ItemCategory.id == payload.category_id))).scalar_one_or_none()
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")
    name = payload.name.strip()
    dup = await db.execute(
        select(Feature).where(
            Feature.category_id == payload.category_id,
            func.lower(func.trim(Feature.name)) == name.lower(),
            Feature.id != feature_id,
        )
    )
    if dup.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Feature '{name}' already exists for this category")
    row.category_id = payload.category_id
    row.name = name
    row.is_active = payload.is_active
    await db.flush()
    return {"id": row.id, "message": "Feature updated"}


@router.delete("/features/{feature_id}")
async def delete_feature(
    feature_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_feature_schema(db)
    row = (await db.execute(select(Feature).where(Feature.id == feature_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Feature not found")
    active_items = (await db.execute(
        select(func.count(func.distinct(Item.id)))
        .select_from(Item)
        .outerjoin(ItemFeature, ItemFeature.item_id == Item.id)
        .where(
            Item.is_active == True,  # noqa: E712
            or_(Item.feature_id == feature_id, ItemFeature.feature_id == feature_id),
        )
    )).scalar() or 0
    if active_items > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot deactivate feature referenced by {active_items} active item(s).",
        )
    row.is_active = False
    await db.flush()
    return {"success": True, "message": "Feature deactivated"}


# ---------- Brands ----------

class BrandPayload(BaseModel):
    code: str = Field(..., min_length=1, max_length=50)
    name: str = Field(..., min_length=1, max_length=255)
    manufacturer_id: Optional[int] = None
    description: Optional[str] = None
    is_active: bool = True


@router.get("/brands")
async def list_brands(
    search: Optional[str] = None,
    page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    q = select(Brand).order_by(Brand.id.desc())
    if search:
        like = f"%{search}%"
        q = q.where((Brand.code.ilike(like)) | (Brand.name.ilike(like)))
    # BUG-FE-030: strip order_by from the count query — preserving it forces
    # Postgres to perform an unnecessary sort under the COUNT(*) wrap.
    count_q = q.order_by(None).with_only_columns(func.count(Brand.id))
    total = await db.scalar(count_q)
    offset, limit = paginate_params(page, page_size)
    rows = (await db.execute(q.offset(offset).limit(limit))).scalars().all()
    return build_paginated_response(
        [
            {"id": b.id, "code": b.code, "name": b.name,
             "manufacturer_id": b.manufacturer_id,
             "description": b.description, "is_active": b.is_active}
            for b in rows
        ],
        total or 0, page, page_size,
    )


@router.post("/brands", status_code=201)
async def create_brand(
    payload: BrandPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    # BUG-FE-023: case-insensitive uniqueness so "ACME" and "acme" can't coexist
    code_val = (payload.code or "").strip()
    dup = await db.execute(
        select(Brand).where(func.lower(Brand.code) == code_val.lower())
    )
    if dup.scalar_one_or_none():
        raise HTTPException(409, f"Brand with code '{code_val}' already exists")
    # BUG-FE-024: case-insensitive trimmed name duplicate check so 'Dolo' and
    # 'Dolo ' can't coexist as separate brands.
    name_val = (payload.name or "").strip()
    name_dup = await db.execute(
        select(Brand).where(func.lower(func.trim(Brand.name)) == name_val.lower())
    )
    if name_dup.scalar_one_or_none():
        raise HTTPException(409, f"Brand with name '{name_val}' already exists")
    data = payload.model_dump()
    data["code"] = code_val.upper()
    data["name"] = name_val
    b = Brand(**data)
    db.add(b)
    await db.flush()
    return {"id": b.id, "message": "Brand created"}


@router.put("/brands/{brand_id}")
async def update_brand(
    brand_id: int, payload: BrandPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    b = (await db.execute(select(Brand).where(Brand.id == brand_id))).scalar_one_or_none()
    if not b:
        raise HTTPException(404, "Brand not found")
    # BUG-FE-026: re-check duplicate code on PUT (case-insensitive)
    code_val = (payload.code or "").strip()
    if code_val:
        dup = await db.execute(
            select(Brand).where(
                func.lower(Brand.code) == code_val.lower(),
                Brand.id != brand_id,
            )
        )
        if dup.scalar_one_or_none():
            raise HTTPException(409, f"Brand with code '{code_val}' already exists")
    # BUG-FE-024: re-check duplicate name on PUT
    name_val = (payload.name or "").strip()
    if name_val:
        name_dup = await db.execute(
            select(Brand).where(
                func.lower(func.trim(Brand.name)) == name_val.lower(),
                Brand.id != brand_id,
            )
        )
        if name_dup.scalar_one_or_none():
            raise HTTPException(409, f"Brand with name '{name_val}' already exists")
    data = payload.model_dump()
    if code_val:
        data["code"] = code_val.upper()
    if name_val:
        data["name"] = name_val
    for k, v in data.items():
        setattr(b, k, v)
    await db.flush()
    return {"id": b.id, "message": "Brand updated"}


@router.delete("/brands/{brand_id}")
async def delete_brand(
    brand_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    b = (await db.execute(select(Brand).where(Brand.id == brand_id))).scalar_one_or_none()
    if not b:
        raise HTTPException(404, "Brand not found")
    b.is_active = False
    await db.flush()
    return {"message": "Brand deactivated"}


# ---------- Item Attributes ----------

class AttributePayload(BaseModel):
    category_id: Optional[int] = None
    code: str = Field(..., min_length=1, max_length=50)
    name: str = Field(..., min_length=1, max_length=255)
    # BUG-FE-033: previously `str` with manual validation. Pydantic Literal
    # rejects unknown values at parse time with proper 422 details.
    data_type: Literal["text", "number", "boolean", "enum"] = "text"
    uom_category_id: Optional[int] = None
    uom_id: Optional[int] = None
    allowed_values: Optional[str] = None
    is_required: bool = False
    sort_order: int = 0
    is_active: bool = True


class AttributeCategoryMappingPayload(BaseModel):
    attribute_id: int
    category_ids: List[int] = Field(..., min_length=1)


async def _normalize_uom_links(
    db: AsyncSession,
    uom_category_id: Optional[int],
    uom_id: Optional[int],
) -> tuple[Optional[int], Optional[int]]:
    if uom_category_id:
        category = (
            await db.execute(
                select(UOMCategory).where(
                    UOMCategory.id == uom_category_id,
                    UOMCategory.is_active == True,  # noqa: E712
                )
            )
        ).scalar_one_or_none()
        if not category:
            raise HTTPException(422, "UOM category does not exist or is inactive")

    if not uom_id:
        return uom_category_id, None

    uom = (
        await db.execute(
            select(UOM).where(
                UOM.id == uom_id,
                UOM.is_active == True,  # noqa: E712
            )
        )
    ).scalar_one_or_none()
    if not uom:
        raise HTTPException(422, "UOM does not exist or is inactive")
    if uom_category_id and uom.category_id != uom_category_id:
        raise HTTPException(422, "Selected UOM does not belong to the selected UOM category")
    return uom_category_id or uom.category_id, uom_id


def _attr_row(a: ItemAttribute) -> dict:
    return {
        "id": a.id, "category_id": a.category_id,
        "code": a.code, "name": a.name,
        "data_type": a.data_type, "uom_category_id": a.uom_category_id,
        "uom_id": a.uom_id,
        "allowed_values": a.allowed_values,
        "is_required": a.is_required, "sort_order": a.sort_order,
        "is_active": a.is_active,
    }


async def _get_descendant_category_ids(db: AsyncSession, category_ids: list[int]) -> list[int]:
    """Return selected item category IDs plus every active descendant at any depth."""
    ordered = list(dict.fromkeys(category_ids or []))
    if not ordered:
        return []

    rows = (
        await db.execute(
            select(ItemCategory.id, ItemCategory.parent_id).where(ItemCategory.is_active == True)  # noqa: E712
        )
    ).all()
    children_by_parent: dict[int, list[int]] = {}
    active_ids = set()
    for cid, parent_id in rows:
        active_ids.add(cid)
        if parent_id is not None:
            children_by_parent.setdefault(parent_id, []).append(cid)

    missing = [cid for cid in ordered if cid not in active_ids]
    if missing:
        raise HTTPException(422, f"Unknown or inactive category id(s): {', '.join(map(str, missing))}")

    result = []
    seen = set()
    stack = list(reversed(ordered))
    while stack:
        cid = stack.pop()
        if cid in seen:
            continue
        seen.add(cid)
        result.append(cid)
        for child_id in reversed(children_by_parent.get(cid, [])):
            stack.append(child_id)
    return result


async def _clone_attribute_to_descendants(db: AsyncSession, source: ItemAttribute) -> tuple[list[int], list[int], list[int]]:
    if not source.category_id:
        return [], [], []
    category_ids = await _get_descendant_category_ids(db, [source.category_id])
    mapped, reactivated, skipped = [], [], []
    for category_id in category_ids:
        if category_id == source.category_id:
            continue
        existing = (
            await db.execute(
                select(ItemAttribute).where(
                    ItemAttribute.category_id == category_id,
                    func.lower(func.trim(ItemAttribute.code)) == source.code.strip().lower(),
                )
            )
        ).scalar_one_or_none()
        if existing:
            existing.name = source.name
            existing.data_type = source.data_type
            existing.uom_category_id = source.uom_category_id
            existing.uom_id = source.uom_id
            existing.allowed_values = source.allowed_values
            existing.is_required = source.is_required
            existing.sort_order = source.sort_order
            if existing.is_active is False:
                existing.is_active = True
                reactivated.append(existing.id)
            else:
                skipped.append(existing.id)
            continue
        clone = ItemAttribute(
            category_id=category_id,
            code=source.code,
            name=source.name,
            data_type=source.data_type,
            uom_category_id=source.uom_category_id,
            uom_id=source.uom_id,
            allowed_values=source.allowed_values,
            is_required=source.is_required,
            sort_order=source.sort_order,
            is_active=True,
        )
        db.add(clone)
        await db.flush()
        mapped.append(clone.id)
    return mapped, reactivated, skipped


@router.get("/item-attributes")
async def list_attributes(
    category_id: Optional[int] = None,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_item_attribute_uom_schema(db)
    q = select(ItemAttribute)
    if category_id is not None:
        cat_ids = await _get_parent_category_ids(db, category_id)
        q = q.where(ItemAttribute.category_id.in_(cat_ids))
    q = q.order_by(ItemAttribute.sort_order, ItemAttribute.id)
    rows = (await db.execute(q)).scalars().all()
    if category_id is not None:
        priority = {cid: idx for idx, cid in enumerate(await _get_parent_category_ids(db, category_id))}
        rows = sorted(rows, key=lambda a: (priority.get(a.category_id, 999), a.sort_order or 0, a.id))
        nearest_by_code = {}
        for attr in rows:
            code_key = (attr.code or "").strip().lower()
            nearest_by_code.setdefault(code_key, attr)
        rows = list(nearest_by_code.values())
    return [_attr_row(a) for a in rows]


@router.post("/item-attributes", status_code=201)
async def create_attribute(
    payload: AttributePayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_item_attribute_uom_schema(db)
    if payload.data_type not in ("text", "number", "boolean", "enum"):
        raise HTTPException(422, "data_type must be text, number, boolean, or enum")
    data = payload.model_dump()
    data["uom_category_id"], data["uom_id"] = await _normalize_uom_links(
        db, data.get("uom_category_id"), data.get("uom_id")
    )
    a = ItemAttribute(**data)
    db.add(a)
    try:
        await db.flush()
    except Exception as e:
        raise HTTPException(
            409,
            f"Attribute code '{payload.code}' already exists for this category",
        ) from e
    mapped, reactivated, skipped = await _clone_attribute_to_descendants(db, a)
    await db.flush()
    return {
        "id": a.id,
        "message": "Attribute created",
        "descendant_mapped": len(mapped),
        "descendant_reactivated": len(reactivated),
        "descendant_updated": len(skipped),
    }


@router.put("/item-attributes/{attr_id}")
async def update_attribute(
    attr_id: int, payload: AttributePayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_item_attribute_uom_schema(db)
    a = (await db.execute(select(ItemAttribute).where(ItemAttribute.id == attr_id))).scalar_one_or_none()
    if not a:
        raise HTTPException(404, "Attribute not found")
    if payload.data_type not in ("text", "number", "boolean", "enum"):
        raise HTTPException(422, "data_type must be text, number, boolean, or enum")
    data = payload.model_dump()
    # BUG-FE-034: when data_type changes, scrub fields that no longer apply so
    # we don't carry stale allowed_values on a redefined attribute.
    if data.get("data_type") != "enum":
        data["allowed_values"] = None
    data["uom_category_id"], data["uom_id"] = await _normalize_uom_links(
        db, data.get("uom_category_id"), data.get("uom_id")
    )
    for k, v in data.items():
        setattr(a, k, v)
    mapped, reactivated, skipped = await _clone_attribute_to_descendants(db, a)
    await db.flush()
    return {
        "id": a.id,
        "message": "Attribute updated",
        "descendant_mapped": len(mapped),
        "descendant_reactivated": len(reactivated),
        "descendant_updated": len(skipped),
    }


@router.post("/item-attribute-category-mappings", status_code=201)
async def map_attribute_to_categories(
    payload: AttributeCategoryMappingPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_item_attribute_uom_schema(db)
    source = (
        await db.execute(select(ItemAttribute).where(ItemAttribute.id == payload.attribute_id))
    ).scalar_one_or_none()
    if not source:
        raise HTTPException(404, "Attribute not found")

    category_ids = await _get_descendant_category_ids(db, list(dict.fromkeys(payload.category_ids or [])))

    mapped = []
    reactivated = []
    skipped = []
    for category_id in category_ids:
        existing = (
            await db.execute(
                select(ItemAttribute).where(
                    ItemAttribute.category_id == category_id,
                    func.lower(func.trim(ItemAttribute.code)) == source.code.strip().lower(),
                )
            )
        ).scalar_one_or_none()
        if existing:
            if existing.is_active is False:
                existing.is_active = True
                reactivated.append(existing.id)
            else:
                skipped.append(existing.id)
            continue
        clone = ItemAttribute(
            category_id=category_id,
            code=source.code,
            name=source.name,
            data_type=source.data_type,
            uom_category_id=source.uom_category_id,
            uom_id=source.uom_id,
            allowed_values=source.allowed_values,
            is_required=source.is_required,
            sort_order=source.sort_order,
            is_active=True,
        )
        db.add(clone)
        await db.flush()
        mapped.append(clone.id)

    await db.flush()
    return {
        "message": "Attribute category mapping saved",
        "mapped": len(mapped),
        "reactivated": len(reactivated),
        "skipped": len(skipped),
        "mapped_ids": mapped,
        "reactivated_ids": reactivated,
        "skipped_ids": skipped,
    }


@router.delete("/item-attributes/{attr_id}")
async def delete_attribute(
    attr_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_item_attribute_uom_schema(db)
    a = (await db.execute(select(ItemAttribute).where(ItemAttribute.id == attr_id))).scalar_one_or_none()
    if not a:
        raise HTTPException(404, "Attribute not found")
    target_attrs = [a]
    if a.category_id:
        descendant_ids = await _get_descendant_category_ids(db, [a.category_id])
        child_attrs = (
            await db.execute(
                select(ItemAttribute).where(
                    ItemAttribute.category_id.in_(descendant_ids),
                    func.lower(func.trim(ItemAttribute.code)) == a.code.strip().lower(),
                    ItemAttribute.id != a.id,
                )
            )
        ).scalars().all()
        target_attrs.extend(child_attrs)
    for attr in target_attrs:
        attr.is_active = False
    # BUG-FE-032: cascade — drop dependent per-item values so they don't dangle
    # against an inactive attribute (where Items.jsx would otherwise still show
    # them in the form).
    values = (
        await db.execute(
            select(ItemAttributeValue).where(ItemAttributeValue.attribute_id.in_([attr.id for attr in target_attrs]))
        )
    ).scalars().all()
    deleted_values = 0
    for v in values:
        await db.delete(v)
        deleted_values += 1
    await db.flush()
    return {"message": "Attribute deactivated", "attributes_deactivated": len(target_attrs), "values_deleted": deleted_values}


# ---------- Per-item attribute values ----------

class AttributeValuePayload(BaseModel):
    attribute_id: int
    value: Optional[str] = None
    uom_category_id: Optional[int] = None
    uom_id: Optional[int] = None


@router.get("/items/{item_id}/attribute-values")
async def list_item_attribute_values(
    item_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_item_attribute_uom_schema(db)
    rows = (
        await db.execute(select(ItemAttributeValue).where(ItemAttributeValue.item_id == item_id))
    ).scalars().all()
    return [
        {
            "id": v.id,
            "attribute_id": v.attribute_id,
            "value": v.value,
            "uom_category_id": v.uom_category_id,
            "uom_id": v.uom_id,
        }
        for v in rows
    ]


@router.put("/items/{item_id}/attribute-values")
async def replace_item_attribute_values(
    item_id: int, payload: List[AttributeValuePayload],
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_item_attribute_uom_schema(db)
    # BUG-FE-040: lock the parent item row to serialize concurrent writers so
    # delete-then-insert can't race and double-insert / drop values.
    item = (
        await db.execute(
            select(Item).where(Item.id == item_id).with_for_update()
        )
    ).scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Item not found")

    # BUG-FE-016: pre-fetch attribute definitions once and validate enum values
    # against allowed_values. Fail fast before deleting existing rows.
    attr_ids = list({row.attribute_id for row in payload})
    attrs_by_id: dict = {}
    if attr_ids:
        rows = (
            await db.execute(
                select(ItemAttribute).where(ItemAttribute.id.in_(attr_ids))
            )
        ).scalars().all()
        attrs_by_id = {a.id: a for a in rows}
    normalized_rows = []
    for row in payload:
        a = attrs_by_id.get(row.attribute_id)
        if not a:
            raise HTTPException(422, f"Unknown attribute_id {row.attribute_id}")
        if a.data_type == "enum" and row.value not in (None, ""):
            allowed_raw = a.allowed_values or ""
            allowed = [s.strip() for s in allowed_raw.split(",") if s.strip()]
            if allowed and row.value not in allowed:
                raise HTTPException(
                    422,
                    f"Value '{row.value}' for attribute '{a.code}' is not in allowed_values "
                    f"({', '.join(allowed)})",
                )
        if a.data_type == "boolean" and row.value not in (None, "", "true", "false"):
            raise HTTPException(
                422,
                f"Value for boolean attribute '{a.code}' must be 'true' or 'false'",
            )
        if a.data_type == "number" and row.value not in (None, ""):
            try:
                float(row.value)
            except (TypeError, ValueError):
                raise HTTPException(
                    422, f"Value for number attribute '{a.code}' must be numeric"
                )
        uom_category_id = row.uom_category_id or a.uom_category_id
        uom_id = row.uom_id or a.uom_id
        uom_category_id, uom_id = await _normalize_uom_links(db, uom_category_id, uom_id)
        normalized_rows.append((row, uom_category_id, uom_id))

    existing = (
        await db.execute(select(ItemAttributeValue).where(ItemAttributeValue.item_id == item_id))
    ).scalars().all()
    for v in existing:
        await db.delete(v)
    for row, uom_category_id, uom_id in normalized_rows:
        db.add(
            ItemAttributeValue(
                item_id=item_id, attribute_id=row.attribute_id,
                value=row.value, uom_category_id=uom_category_id, uom_id=uom_id,
            )
        )
    await db.flush()
    return {"message": "Attribute values saved", "count": len(payload)}


# ---------- Specs master ----------

class SpecCategoryPayload(BaseModel):
    code: str = Field(..., min_length=1, max_length=30)
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = None
    base_uom_id: Optional[int] = None
    sort_order: int = 0
    is_active: bool = True


class SpecPayload(BaseModel):
    category_id: int
    code: str = Field(..., min_length=1, max_length=50)
    name: str = Field(..., min_length=1, max_length=100)
    data_type: Literal["text", "number", "boolean", "enum", "range"] = "text"
    uom_id: Optional[int] = None
    uom_category_id: Optional[int] = None
    allowed_values: Optional[str] = None
    is_required: bool = False
    sort_order: int = 0
    is_active: bool = True


class ItemSpecPayload(BaseModel):
    item_category_ids: List[int] = Field(..., min_length=1)
    spec_id: int
    default_value: Optional[str] = None
    uom_id: Optional[int] = None
    is_required: bool = False
    sort_order: int = 0


class ItemSpecUpdatePayload(BaseModel):
    default_value: Optional[str] = None
    uom_id: Optional[int] = None
    is_required: bool = False
    sort_order: int = 0
    is_active: bool = True


class ItemSpecValuePayload(BaseModel):
    spec_id: int
    value: Optional[str] = None
    min_value: Optional[str] = None
    max_value: Optional[str] = None
    uom_id: Optional[int] = None


def _clean_code(value: str) -> str:
    return (value or "").strip().upper()


async def _ensure_uom_exists(db: AsyncSession, uom_id: Optional[int]) -> None:
    if not uom_id:
        return
    exists = (
        await db.execute(select(UOM.id).where(UOM.id == uom_id, UOM.is_active == True))  # noqa: E712
    ).scalar_one_or_none()
    if not exists:
        raise HTTPException(422, "UOM does not exist or is inactive")


def _spec_category_row(row: SpecCategory, uom_map: dict[int, UOM] | None = None) -> dict:
    uom = (uom_map or {}).get(row.base_uom_id)
    return {
        "id": row.id,
        "code": row.code,
        "name": row.name,
        "description": row.description,
        "base_uom_id": row.base_uom_id,
        "base_uom_name": uom.name if uom else None,
        "base_uom_abbreviation": uom.abbreviation if uom else None,
        "sort_order": row.sort_order,
        "is_active": row.is_active,
    }


def _spec_row(row: Spec, category_map: dict[int, SpecCategory] | None = None) -> dict:
    category = (category_map or {}).get(row.category_id)
    return {
        "id": row.id,
        "category_id": row.category_id,
        "category_code": category.code if category else None,
        "category_name": category.name if category else None,
        "code": row.code,
        "name": row.name,
        "data_type": row.data_type,
        "uom_id": row.uom_id,
        "uom_category_id": row.uom_category_id,
        "allowed_values": row.allowed_values,
        "is_required": row.is_required,
        "sort_order": row.sort_order,
        "is_active": row.is_active,
    }


@router.get("/spec-categories")
async def list_spec_categories(
    include_inactive: bool = Query(False),
    search: Optional[str] = None,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    q = select(SpecCategory).order_by(SpecCategory.sort_order, SpecCategory.name)
    if not include_inactive:
        q = q.where(SpecCategory.is_active == True)  # noqa: E712
    if search:
        like = f"%{search}%"
        q = q.where((SpecCategory.code.ilike(like)) | (SpecCategory.name.ilike(like)))
    rows = (await db.execute(q)).scalars().all()
    uom_ids = [r.base_uom_id for r in rows if r.base_uom_id]
    uom_map = {}
    if uom_ids:
        uoms = (await db.execute(select(UOM).where(UOM.id.in_(uom_ids)))).scalars().all()
        uom_map = {u.id: u for u in uoms}
    return [_spec_category_row(r, uom_map) for r in rows]


@router.post("/spec-categories", status_code=201)
async def create_spec_category(
    payload: SpecCategoryPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    await _ensure_uom_exists(db, payload.base_uom_id)
    code = _clean_code(payload.code)
    dup = await db.execute(select(SpecCategory).where(func.lower(SpecCategory.code) == code.lower()))
    if dup.scalar_one_or_none():
        raise HTTPException(409, f"Spec category '{code}' already exists")
    row = SpecCategory(
        code=code,
        name=payload.name.strip(),
        description=payload.description,
        base_uom_id=payload.base_uom_id,
        sort_order=payload.sort_order,
        is_active=payload.is_active,
    )
    db.add(row)
    await db.flush()
    return {"id": row.id, "message": "Spec category created"}


@router.put("/spec-categories/{category_id}")
async def update_spec_category(
    category_id: int, payload: SpecCategoryPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    await _ensure_uom_exists(db, payload.base_uom_id)
    row = (await db.execute(select(SpecCategory).where(SpecCategory.id == category_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Spec category not found")
    code = _clean_code(payload.code)
    dup = await db.execute(
        select(SpecCategory).where(func.lower(SpecCategory.code) == code.lower(), SpecCategory.id != category_id)
    )
    if dup.scalar_one_or_none():
        raise HTTPException(409, f"Spec category '{code}' already exists")
    row.code = code
    row.name = payload.name.strip()
    row.description = payload.description
    row.base_uom_id = payload.base_uom_id
    row.sort_order = payload.sort_order
    row.is_active = payload.is_active
    await db.flush()
    return {"id": row.id, "message": "Spec category updated"}


@router.delete("/spec-categories/{category_id}")
async def delete_spec_category(
    category_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    row = (await db.execute(select(SpecCategory).where(SpecCategory.id == category_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Spec category not found")
    row.is_active = False
    await db.flush()
    return {"message": "Spec category deactivated"}


@router.get("/specs")
async def list_specs(
    category_id: Optional[int] = None,
    include_inactive: bool = Query(False),
    search: Optional[str] = None,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    q = select(Spec).order_by(Spec.sort_order, Spec.name)
    if category_id:
        q = q.where(Spec.category_id == category_id)
    if not include_inactive:
        q = q.where(Spec.is_active == True)  # noqa: E712
    if search:
        like = f"%{search}%"
        q = q.where((Spec.code.ilike(like)) | (Spec.name.ilike(like)))
    rows = (await db.execute(q)).scalars().all()
    cat_ids = [r.category_id for r in rows]
    category_map = {}
    if cat_ids:
        cats = (await db.execute(select(SpecCategory).where(SpecCategory.id.in_(cat_ids)))).scalars().all()
        category_map = {c.id: c for c in cats}
    return [_spec_row(r, category_map) for r in rows]


@router.post("/specs", status_code=201)
async def create_spec(
    payload: SpecPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    category = (await db.execute(select(SpecCategory).where(SpecCategory.id == payload.category_id))).scalar_one_or_none()
    if not category:
        raise HTTPException(404, "Spec category not found")
    uom_category_id, uom_id = await _normalize_uom_links(db, payload.uom_category_id, payload.uom_id)
    code = _clean_code(payload.code)
    dup = await db.execute(select(Spec).where(func.lower(Spec.code) == code.lower()))
    if dup.scalar_one_or_none():
        raise HTTPException(409, f"Spec '{code}' already exists")
    row = Spec(
        category_id=payload.category_id,
        code=code,
        name=payload.name.strip(),
        data_type=payload.data_type,
        uom_id=uom_id,
        uom_category_id=uom_category_id,
        allowed_values=payload.allowed_values if payload.data_type == "enum" else None,
        is_required=payload.is_required,
        sort_order=payload.sort_order,
        is_active=payload.is_active,
    )
    db.add(row)
    await db.flush()
    return {"id": row.id, "message": "Spec created"}


@router.put("/specs/{spec_id}")
async def update_spec(
    spec_id: int, payload: SpecPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    row = (await db.execute(select(Spec).where(Spec.id == spec_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Spec not found")
    category = (await db.execute(select(SpecCategory).where(SpecCategory.id == payload.category_id))).scalar_one_or_none()
    if not category:
        raise HTTPException(404, "Spec category not found")
    uom_category_id, uom_id = await _normalize_uom_links(db, payload.uom_category_id, payload.uom_id)
    code = _clean_code(payload.code)
    dup = await db.execute(select(Spec).where(func.lower(Spec.code) == code.lower(), Spec.id != spec_id))
    if dup.scalar_one_or_none():
        raise HTTPException(409, f"Spec '{code}' already exists")
    row.category_id = payload.category_id
    row.code = code
    row.name = payload.name.strip()
    row.data_type = payload.data_type
    row.uom_id = uom_id
    row.uom_category_id = uom_category_id
    row.allowed_values = payload.allowed_values if payload.data_type == "enum" else None
    row.is_required = payload.is_required
    row.sort_order = payload.sort_order
    row.is_active = payload.is_active
    await db.flush()
    return {"id": row.id, "message": "Spec updated"}


@router.delete("/specs/{spec_id}")
async def delete_spec(
    spec_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    row = (await db.execute(select(Spec).where(Spec.id == spec_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Spec not found")
    row.is_active = False
    await db.flush()
    return {"message": "Spec deactivated"}


@router.get("/item-specs")
async def list_item_specs(
    item_category_id: Optional[int] = None,
    include_inactive: bool = Query(False),
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    q = select(ItemSpec, ItemCategory, Spec).join(ItemCategory, ItemCategory.id == ItemSpec.item_category_id).join(Spec, Spec.id == ItemSpec.spec_id)
    if item_category_id:
        cat_ids = await _get_parent_category_ids(db, item_category_id)
        q = q.where(ItemSpec.item_category_id.in_(cat_ids))
    if not include_inactive:
        q = q.where(ItemSpec.is_active == True)  # noqa: E712
    q = q.order_by(ItemCategory.name, ItemSpec.sort_order, Spec.name)
    rows = (await db.execute(q)).all()
    if item_category_id:
        priority = {cid: idx for idx, cid in enumerate(await _get_parent_category_ids(db, item_category_id))}
        rows = sorted(rows, key=lambda r: (priority.get(r[0].item_category_id, 999), r[0].sort_order or 0, r[2].name))
        nearest_by_spec = {}
        for mapping, cat, spec in rows:
            nearest_by_spec.setdefault(mapping.spec_id, (mapping, cat, spec))
        rows = list(nearest_by_spec.values())
    return [
        {
            "id": m.id,
            "item_category_id": m.item_category_id,
            "item_category_code": cat.code,
            "item_category_name": cat.name,
            "spec_id": m.spec_id,
            "spec_code": spec.code,
            "spec_name": spec.name,
            "spec_data_type": spec.data_type,
            "spec_allowed_values": spec.allowed_values,
            "spec_uom_category_id": spec.uom_category_id,
            "spec_uom_id": spec.uom_id,
            "default_value": m.default_value,
            "uom_id": m.uom_id,
            "is_required": m.is_required,
            "sort_order": m.sort_order,
            "is_active": m.is_active,
        }
        for m, cat, spec in rows
    ]


@router.post("/item-specs", status_code=201)
async def create_item_specs(
    payload: ItemSpecPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    spec = (await db.execute(select(Spec).where(Spec.id == payload.spec_id))).scalar_one_or_none()
    if not spec:
        raise HTTPException(404, "Spec not found")
    await _ensure_uom_exists(db, payload.uom_id)
    category_ids = await _get_descendant_category_ids(db, list(dict.fromkeys(payload.item_category_ids or [])))
    mapped, reactivated, skipped = [], [], []
    for category_id in category_ids:
        existing = (
            await db.execute(
                select(ItemSpec).where(ItemSpec.item_category_id == category_id, ItemSpec.spec_id == payload.spec_id)
            )
        ).scalar_one_or_none()
        if existing:
            existing.default_value = payload.default_value
            existing.uom_id = payload.uom_id
            existing.is_required = payload.is_required
            existing.sort_order = payload.sort_order
            if existing.is_active is False:
                existing.is_active = True
                reactivated.append(existing.id)
            else:
                skipped.append(existing.id)
            continue
        row = ItemSpec(
            item_category_id=category_id,
            spec_id=payload.spec_id,
            default_value=payload.default_value,
            uom_id=payload.uom_id,
            is_required=payload.is_required,
            sort_order=payload.sort_order,
            is_active=True,
        )
        db.add(row)
        await db.flush()
        mapped.append(row.id)
    await db.flush()
    return {"message": "Item spec mapping saved", "mapped": len(mapped), "reactivated": len(reactivated), "skipped": len(skipped)}


@router.put("/item-specs/{mapping_id}")
async def update_item_spec(
    mapping_id: int, payload: ItemSpecUpdatePayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    await _ensure_uom_exists(db, payload.uom_id)
    row = (await db.execute(select(ItemSpec).where(ItemSpec.id == mapping_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Item spec mapping not found")
    row.default_value = payload.default_value
    row.uom_id = payload.uom_id
    row.is_required = payload.is_required
    row.sort_order = payload.sort_order
    row.is_active = payload.is_active
    if row.item_category_id:
        category_ids = await _get_descendant_category_ids(db, [row.item_category_id])
        child_rows = (
            await db.execute(
                select(ItemSpec).where(
                    ItemSpec.item_category_id.in_(category_ids),
                    ItemSpec.spec_id == row.spec_id,
                    ItemSpec.id != row.id,
                )
            )
        ).scalars().all()
        for child in child_rows:
            child.default_value = payload.default_value
            child.uom_id = payload.uom_id
            child.is_required = payload.is_required
            child.sort_order = payload.sort_order
            child.is_active = payload.is_active
    await db.flush()
    return {"id": row.id, "message": "Item spec mapping updated", "descendants_updated": len(child_rows) if row.item_category_id else 0}


@router.delete("/item-specs/{mapping_id}")
async def delete_item_spec(
    mapping_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    row = (await db.execute(select(ItemSpec).where(ItemSpec.id == mapping_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Item spec mapping not found")
    target_rows = [row]
    if row.item_category_id:
        category_ids = await _get_descendant_category_ids(db, [row.item_category_id])
        child_rows = (
            await db.execute(
                select(ItemSpec).where(
                    ItemSpec.item_category_id.in_(category_ids),
                    ItemSpec.spec_id == row.spec_id,
                    ItemSpec.id != row.id,
                )
            )
        ).scalars().all()
        target_rows.extend(child_rows)
    for target in target_rows:
        target.is_active = False
    await db.flush()
    return {"message": "Item spec mapping deactivated", "mappings_deactivated": len(target_rows)}


@router.get("/items/{item_id}/spec-values")
async def list_item_spec_values(
    item_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    rows = (await db.execute(select(ItemSpecValue).where(ItemSpecValue.item_id == item_id))).scalars().all()
    return [
        {"id": r.id, "spec_id": r.spec_id, "value": r.value, "min_value": r.min_value, "max_value": r.max_value, "uom_id": r.uom_id}
        for r in rows
    ]


@router.put("/items/{item_id}/spec-values")
async def replace_item_spec_values(
    item_id: int, payload: List[ItemSpecValuePayload],
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    await ensure_specs_schema(db)
    item = (await db.execute(select(Item).where(Item.id == item_id).with_for_update())).scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Item not found")
    spec_ids = list({row.spec_id for row in payload})
    specs = {}
    if spec_ids:
        spec_rows = (await db.execute(select(Spec).where(Spec.id.in_(spec_ids)))).scalars().all()
        specs = {s.id: s for s in spec_rows}
    for row in payload:
        spec = specs.get(row.spec_id)
        if not spec:
            raise HTTPException(422, f"Unknown spec_id {row.spec_id}")
        if spec.data_type == "number" and row.value not in (None, ""):
            try:
                float(row.value)
            except (TypeError, ValueError):
                raise HTTPException(422, f"Value for spec '{spec.code}' must be numeric")
        if spec.data_type == "range":
            for field_name, field_value in (("min_value", row.min_value), ("max_value", row.max_value)):
                if field_value not in (None, ""):
                    try:
                        float(field_value)
                    except (TypeError, ValueError):
                        raise HTTPException(422, f"{field_name} for spec '{spec.code}' must be numeric")
        await _ensure_uom_exists(db, row.uom_id)
    existing = (await db.execute(select(ItemSpecValue).where(ItemSpecValue.item_id == item_id))).scalars().all()
    for row in existing:
        await db.delete(row)
    for row in payload:
        db.add(ItemSpecValue(item_id=item_id, spec_id=row.spec_id, value=row.value, min_value=row.min_value, max_value=row.max_value, uom_id=row.uom_id))
    await db.flush()
    return {"message": "Spec values saved", "count": len(payload)}


# ---------- User Groups ----------

class UserGroupPayload(BaseModel):
    code: str = Field(..., min_length=1, max_length=50)
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    is_active: bool = True


@router.get("/user-groups")
async def list_user_groups(
    search: Optional[str] = None,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    q = select(UserGroup).order_by(UserGroup.id.desc())
    if search:
        like = f"%{search}%"
        q = q.where((UserGroup.code.ilike(like)) | (UserGroup.name.ilike(like)))
    rows = (await db.execute(q)).scalars().all()
    return [
        {"id": g.id, "code": g.code, "name": g.name,
         "description": g.description, "is_active": g.is_active}
        for g in rows
    ]


@router.post("/user-groups", status_code=201)
async def create_user_group(
    payload: UserGroupPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    dup = await db.execute(select(UserGroup).where(UserGroup.code == payload.code))
    if dup.scalar_one_or_none():
        raise HTTPException(409, f"Group '{payload.code}' already exists")
    g = UserGroup(**payload.model_dump())
    db.add(g)
    await db.flush()
    return {"id": g.id, "message": "Group created"}


@router.put("/user-groups/{group_id}")
async def update_user_group(
    group_id: int, payload: UserGroupPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    g = (await db.execute(select(UserGroup).where(UserGroup.id == group_id))).scalar_one_or_none()
    if not g:
        raise HTTPException(404, "Group not found")
    for k, v in payload.model_dump().items():
        setattr(g, k, v)
    await db.flush()
    return {"id": g.id, "message": "Group updated"}


@router.delete("/user-groups/{group_id}")
async def delete_user_group(
    group_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    g = (await db.execute(select(UserGroup).where(UserGroup.id == group_id))).scalar_one_or_none()
    if not g:
        raise HTTPException(404, "Group not found")
    g.is_active = False
    # BUG-FE-074: cascade — drop members and permissions so they don't leak
    # access via a "soft-deleted" group still referenced by permission checks.
    members = (
        await db.execute(select(UserGroupMember).where(UserGroupMember.group_id == group_id))
    ).scalars().all()
    affected_user_ids = []
    for m in members:
        affected_user_ids.append(m.user_id)
        await db.delete(m)
    perms = (
        await db.execute(select(UserGroupPermission).where(UserGroupPermission.group_id == group_id))
    ).scalars().all()
    for p in perms:
        await db.delete(p)
    # BUG-FE-076-adjacent: revoke active sessions for ex-members so cached
    # permission claims don't survive the group deletion.
    if affected_user_ids:
        try:
            from app.models.auth import UserSession  # type: ignore
            sessions = (
                await db.execute(
                    select(UserSession).where(UserSession.user_id.in_(affected_user_ids))
                )
            ).scalars().all()
            for s in sessions:
                if hasattr(s, "is_active"):
                    s.is_active = False
                else:
                    await db.delete(s)
        except Exception:
            pass
    await db.flush()
    return {
        "message": "Group deactivated",
        "members_removed": len(members),
        "permissions_removed": len(perms),
    }


# ---------- Group members ----------

class GroupMemberPayload(BaseModel):
    user_ids: List[int]


@router.get("/user-groups/{group_id}/members")
async def list_group_members(
    group_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    rows = (
        await db.execute(
            select(UserGroupMember, User)
            .join(User, User.id == UserGroupMember.user_id)
            .where(UserGroupMember.group_id == group_id)
        )
    ).all()
    return [
        {
            "id": m.id, "user_id": u.id, "username": u.username,
            "email": u.email,
            "added_at": m.added_at.isoformat() if m.added_at else None,
        }
        for m, u in rows
    ]


@router.put("/user-groups/{group_id}/members")
async def set_group_members(
    group_id: int, payload: GroupMemberPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    # BUG-FE-075: lock the group row so concurrent calls serialize. Combined
    # with the single db.flush() at the end, this gives delete+insert atomicity.
    g = (
        await db.execute(
            select(UserGroup).where(UserGroup.id == group_id).with_for_update()
        )
    ).scalar_one_or_none()
    if not g:
        raise HTTPException(404, "Group not found")
    new_ids = set(payload.user_ids or [])
    existing = (
        await db.execute(select(UserGroupMember).where(UserGroupMember.group_id == group_id))
    ).scalars().all()
    existing_ids = {m.user_id for m in existing}
    removed_ids = existing_ids - new_ids
    for m in existing:
        await db.delete(m)
    for uid in new_ids:
        db.add(UserGroupMember(group_id=group_id, user_id=uid))
    # BUG-FE-076: revoke active sessions for users removed from the group so
    # stale permission claims don't survive the membership change.
    if removed_ids:
        try:
            from app.models.auth import UserSession  # type: ignore
            sessions = (
                await db.execute(
                    select(UserSession).where(UserSession.user_id.in_(list(removed_ids)))
                )
            ).scalars().all()
            for s in sessions:
                if hasattr(s, "is_active"):
                    s.is_active = False
                else:
                    await db.delete(s)
        except Exception:
            pass
    await db.flush()
    return {
        "message": "Members updated",
        "count": len(new_ids),
        "removed": len(removed_ids),
    }


# ---------- Group permissions ----------

class GroupPermissionPayload(BaseModel):
    entity_type: str
    entity_id: Optional[int] = None
    action: str = "view"


@router.get("/user-groups/{group_id}/permissions")
async def list_group_permissions(
    group_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    rows = (
        await db.execute(
            select(UserGroupPermission)
            .where(UserGroupPermission.group_id == group_id)
            .order_by(UserGroupPermission.id)
        )
    ).scalars().all()
    return [
        {"id": p.id, "entity_type": p.entity_type,
         "entity_id": p.entity_id, "action": p.action}
        for p in rows
    ]


_VALID_PERM_ENTITY_TYPES = {
    "warehouse", "location", "bin", "category", "item",
    "vendor", "brand", "project", "department", "module",
    "price_list", "uom", "attribute",
}
_VALID_PERM_ACTIONS = {"view", "create", "update", "delete", "approve", "*"}


@router.put("/user-groups/{group_id}/permissions")
async def set_group_permissions(
    group_id: int, payload: List[GroupPermissionPayload],
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    g = (await db.execute(select(UserGroup).where(UserGroup.id == group_id))).scalar_one_or_none()
    if not g:
        raise HTTPException(404, "Group not found")
    # BUG-FE-077: validate entity_type against the supported set so callers
    # can't write arbitrary strings into the permission table.
    for row in payload:
        et = (row.entity_type or "").strip().lower()
        if et not in _VALID_PERM_ENTITY_TYPES:
            raise HTTPException(
                422,
                f"Invalid entity_type '{row.entity_type}'. "
                f"Allowed: {', '.join(sorted(_VALID_PERM_ENTITY_TYPES))}",
            )
        action = (row.action or "view").strip().lower()
        if action not in _VALID_PERM_ACTIONS:
            raise HTTPException(
                422,
                f"Invalid action '{row.action}'. "
                f"Allowed: {', '.join(sorted(_VALID_PERM_ACTIONS))}",
            )
    existing = (
        await db.execute(
            select(UserGroupPermission).where(UserGroupPermission.group_id == group_id)
        )
    ).scalars().all()
    for p in existing:
        await db.delete(p)
    for row in payload:
        db.add(
            UserGroupPermission(
                group_id=group_id,
                entity_type=(row.entity_type or "").strip().lower(),
                entity_id=row.entity_id,
                action=(row.action or "view").strip().lower(),
            )
        )
    await db.flush()
    return {"message": "Permissions updated", "count": len(payload)}
