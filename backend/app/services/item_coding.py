"""Item code generator using category hierarchy: L1L2L3-SEQ.

Example: Electronics(10) / Computers(10) / Laptops(10) item 1 -> 101010-001.
Each category segment is two digits in the 10-99 range and is stored on
item_categories.short_code. The complete path is stored on full_code.
"""
from __future__ import annotations
import re
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.master import Item, ItemCategory
from app.models.system import NumberSeries


_FORM_MAP = {
    "tablet": "T", "tab": "T", "tabs": "T",
    "capsule": "C", "cap": "C", "caps": "C",
    "syrup": "S", "syr": "S", "liquid": "S", "solution": "S",
    "injection": "I", "inj": "I", "ampoule": "I", "vial": "I",
    "ointment": "O", "cream": "O", "gel": "O",
    "powder": "P", "sachet": "P",
    "drops": "D",
    "spray": "Y",
    "kit": "K",
    "device": "V",
}

ORG_PREFIX_DEFAULT = "BHSPL"
ITEM_CODE_V2_PAD = 3
ITEM_CODE_V2_MAX = 999


def normalize_form_code(dosage_form: str | None) -> str:
    """Map free-text dosage_form to a 1-2 char code. Default 'X' (none)."""
    if not dosage_form:
        return "X"
    key = re.sub(r"[^a-z]", "", dosage_form.lower())
    if key in _FORM_MAP:
        return _FORM_MAP[key]
    # Try first word
    first = (dosage_form.split() or [""])[0].strip().lower()
    if first in _FORM_MAP:
        return _FORM_MAP[first]
    # Last-ditch: first letter uppercased
    return first[:1].upper() if first else "X"


async def _get_category_chain(db: AsyncSession, category_id: int | None) -> tuple[str, str]:
    """Returns (parent_prefix, child_prefix) for a category.

    Walk up the tree:
      - leaf level → child_prefix = its code_prefix
      - immediate parent → parent_prefix = its code_prefix
    If only one level exists, that becomes parent_prefix and child_prefix repeats.
    """
    if not category_id:
        return ("XX", "GEN")

    cat = (await db.execute(select(ItemCategory).where(ItemCategory.id == category_id))).scalar_one_or_none()
    if not cat:
        return ("XX", "GEN")

    leaf_prefix = (cat.code_prefix or cat.code or "GEN")[:5].upper()

    if cat.parent_id:
        parent = (await db.execute(select(ItemCategory).where(ItemCategory.id == cat.parent_id))).scalar_one_or_none()
        parent_prefix = ((parent.code_prefix or parent.code or "XX") if parent else "XX")[:3].upper()
    else:
        # No parent — flatten to (cat.code_prefix, cat.code_prefix). The expert format
        # really wants two segments; if only one is configured we duplicate.
        parent_prefix = leaf_prefix[:3].upper()

    return (parent_prefix, leaf_prefix)


async def get_item_category_code_prefix(db: AsyncSession, category_id: int | None) -> str:
    if not category_id:
        raise ValueError("Select a Level 3 category before generating an item code")
    category = (
        await db.execute(select(ItemCategory).where(ItemCategory.id == category_id))
    ).scalar_one_or_none()
    if not category:
        raise ValueError("Selected category was not found")
    if (category.level or 0) != 3 or not category.full_code or len(category.full_code) != 6:
        raise ValueError("Item codes require a complete Level 1 > Level 2 > Level 3 category selection")
    return category.full_code


async def _max_existing_sequence(db: AsyncSession, prefix: str) -> int:
    rows = (
        await db.execute(select(Item.item_code).where(Item.item_code.like(f"{prefix}-%")))
    ).scalars().all()
    max_seq = 0
    pattern = re.compile(rf"^{re.escape(prefix)}-(\d{{3}})$")
    for code in rows:
        match = pattern.match(code or "")
        if match:
            max_seq = max(max_seq, int(match.group(1)))
    return max_seq


async def preview_hierarchy_item_code(db: AsyncSession, category_id: int | None) -> dict:
    prefix = await get_item_category_code_prefix(db, category_id)
    series_key = f"item_code_v2:{prefix}"
    cur = (
        await db.execute(
            select(NumberSeries.current_number).where(
                NumberSeries.module == "master",
                NumberSeries.document_type == series_key,
            )
        )
    ).scalar()
    
    # BUG-FIX: Always check actual items table to ensure we don't collide.
    # The NumberSeries might be lagging behind if items were manually added or imported.
    max_db = await _max_existing_sequence(db, prefix)
    current = max(cur if cur is not None else 0, max_db)
    
    next_num = current + 1
    if next_num > ITEM_CODE_V2_MAX:
        raise ValueError(f"Item sequence exhausted for category code {prefix}. Maximum is {ITEM_CODE_V2_MAX}.")
    return {
        "preview": f"{prefix}-{str(next_num).zfill(ITEM_CODE_V2_PAD)}",
        "category_code": prefix,
        "next_seq": next_num,
    }


async def generate_item_code(
    db: AsyncSession, *,
    category_id: int | None,
    dosage_form: str | None,
    org_prefix: str = ORG_PREFIX_DEFAULT,
) -> str:
    """Compose and reserve a hierarchy item code. Race-safe via NumberSeries lock."""
    prefix = await get_item_category_code_prefix(db, category_id)
    series_key = f"item_code_v2:{prefix}"

    result = await db.execute(
        select(NumberSeries).where(
            NumberSeries.module == "master",
            NumberSeries.document_type == series_key,
        ).with_for_update()
    )
    series = result.scalar_one_or_none()

    if not series:
        max_existing = await _max_existing_sequence(db, prefix)
        series = NumberSeries(
            prefix=prefix,
            module="master",
            document_type=series_key,
            current_number=max_existing,
            pad_length=ITEM_CODE_V2_PAD,
            org_prefix=org_prefix,
        )
        db.add(series)
        try:
            async with db.begin_nested():
                await db.flush()
        except IntegrityError:
            db.expunge(series)
            result = await db.execute(
                select(NumberSeries).where(
                    NumberSeries.module == "master",
                    NumberSeries.document_type == series_key,
                ).with_for_update()
            )
            series = result.scalar_one()
    else:
        # BUG-FIX: Even if series exists, ensure it hasn't drifted from reality.
        max_db = await _max_existing_sequence(db, prefix)
        if (series.current_number or 0) < max_db:
            series.current_number = max_db

    next_num = (series.current_number or 0) + 1
    if next_num > ITEM_CODE_V2_MAX:
        raise ValueError(f"Item sequence exhausted for category code {prefix}. Maximum is {ITEM_CODE_V2_MAX}.")
    series.current_number = next_num
    await db.flush()

    seq = str(next_num).zfill(series.pad_length or ITEM_CODE_V2_PAD)
    return f"{prefix}-{seq}"


async def assign_code_if_missing(
    db: AsyncSession, *, item: Item, force: bool = False,
) -> str:
    """If item already has a non-legacy code, return it. Otherwise generate."""
    if item.item_code and not force and item.coding_status == "auto":
        return item.item_code
    code = await generate_item_code(
        db,
        category_id=item.category_id,
        dosage_form=item.dosage_form,
    )
    item.item_code = code
    item.dosage_form_code = normalize_form_code(item.dosage_form)
    item.coding_status = "auto"
    await db.flush()
    return code


async def backfill_codes(db: AsyncSession, *, dry_run: bool = False) -> dict:
    """Assign auto-codes to items currently in 'legacy' status.

    Returns counts; items with manual codes are left alone.
    """
    rows = await db.execute(
        select(Item).where(
            (Item.coding_status == "legacy") | (Item.coding_status.is_(None))
        )
    )
    items = rows.scalars().all()
    updated = 0
    for it in items:
        # If user-entered code looks structured (contains 4+ dashes), preserve as 'manual'
        if it.item_code and it.item_code.count("-") >= 4:
            it.coding_status = "manual"
            updated += 1
            continue
        if dry_run:
            continue
        await assign_code_if_missing(db, item=it, force=True)
        updated += 1
    if not dry_run:
        await db.flush()
    return {"total_legacy": len(items), "updated": updated, "dry_run": dry_run}
