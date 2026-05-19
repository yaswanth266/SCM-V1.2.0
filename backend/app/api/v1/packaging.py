from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List
from app.database import get_db
from app.schemas.packaging import ItemPackagingResponse, ItemPackagingUpsertRequest
from app.services.packaging_service import PackagingService
from app.models.master import ItemPackaging, PackagingLevel
from app.utils.schema_sync import ensure_packaging_schema

router = APIRouter(tags=["Item Packaging"])

@router.get("/items/{item_id}/packaging", response_model=List[ItemPackagingResponse])
async def get_packaging_hierarchy(item_id: int, db: AsyncSession = Depends(get_db)):
    await ensure_packaging_schema(db)
    pack_q = await db.execute(
        select(ItemPackaging)
        .join(PackagingLevel)
        .where(ItemPackaging.item_id == item_id)
        .order_by(PackagingLevel.level_order)
    )
    packagings = pack_q.scalars().all()
    
    # We might need to manually populate level for the response if relationship is not eager loaded
    levels_q = await db.execute(select(PackagingLevel))
    levels_map = {lvl.id: lvl for lvl in levels_q.scalars().all()}
    
    for p in packagings:
        p.level = levels_map.get(p.level_id)

    return packagings

@router.put("/items/{item_id}/packaging", response_model=List[ItemPackagingResponse])
async def update_packaging_hierarchy(item_id: int, payload: ItemPackagingUpsertRequest, db: AsyncSession = Depends(get_db)):
    await ensure_packaging_schema(db)
    service = PackagingService(db)
    updated_packagings = await service.upsert_packaging_hierarchy(item_id, payload)
    await db.commit()
    
    levels_q = await db.execute(select(PackagingLevel))
    levels_map = {lvl.id: lvl for lvl in levels_q.scalars().all()}
    
    for p in updated_packagings:
        p.level = levels_map.get(p.level_id)

    return updated_packagings

@router.get("/packaging-levels")
async def get_packaging_levels(db: AsyncSession = Depends(get_db)):
    await ensure_packaging_schema(db)
    levels_q = await db.execute(select(PackagingLevel).order_by(PackagingLevel.level_order))
    levels = levels_q.scalars().all()
    return [{"id": l.id, "level_name": l.level_name, "level_order": l.level_order} for l in levels]

@router.put("/items/{item_id}/trigger-packaging-cascade")
async def trigger_packaging_cascade(item_id: int, db: AsyncSession = Depends(get_db)):
    await ensure_packaging_schema(db)
    service = PackagingService(db)
    await service.update_item_cascade(item_id)
    await db.commit()
    return {"message": "Packaging cascade updated successfully"}
