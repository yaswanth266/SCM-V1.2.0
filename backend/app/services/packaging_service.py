from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, update
from typing import List
from app.models.master import Item, ItemPackaging, PackagingLevel, UOM
from app.schemas.packaging import ItemPackagingUpsertRequest
from fastapi import HTTPException

class PackagingService:
    def __init__(self, db: AsyncSession):
        self.db = db

    def generate_sku_name(self, base_item_name: str, base_uom: str, parent_sku_name: str | None, qty_per_parent: int, level_name: str, is_root: bool) -> str:
        if is_root:
            return f"{base_item_name} {base_uom} * {qty_per_parent} {level_name}"
        return f"{parent_sku_name} * {qty_per_parent} {level_name}"

    async def upsert_packaging_hierarchy(self, item_id: int, payload: ItemPackagingUpsertRequest) -> List[ItemPackaging]:
        # Lock the item and existing packagings for safe recalculation
        item_q = await self.db.execute(
            select(Item, UOM.name.label("uom_name"))
            .join(UOM, Item.primary_uom_id == UOM.id)
            .where(Item.id == item_id).with_for_update()
        )
        item_data = item_q.first()

        if not item_data:
            raise HTTPException(status_code=404, detail="Item not found")

        item, base_uom = item_data

        levels_q = await self.db.execute(select(PackagingLevel))
        levels = levels_q.scalars().all()
        level_map = {lvl.id: lvl for lvl in levels}

        # Clear existing hierarchy to replace with new state
        await self.db.execute(delete(ItemPackaging).where(ItemPackaging.item_id == item_id))
        await self.db.flush()
        
        db_packagings = []
        frontend_id_to_db_id = {}

        for pack in payload.packagings:
            actual_parent_id = frontend_id_to_db_id.get(pack.parent_id) if pack.parent_id else None
            is_root = actual_parent_id is None
            
            level_info = level_map.get(pack.level_id)
            if not level_info:
                raise HTTPException(status_code=400, detail=f"Invalid level_id: {pack.level_id}")

            if is_root:
                qty_per_parent = pack.qty_per_parent
                total_base_qty = qty_per_parent
                parent_sku_name = None
            else:
                qty_per_parent = pack.qty_per_parent
                parent_pack = next((p for p in db_packagings if p.id == actual_parent_id), None)
                if not parent_pack:
                     raise HTTPException(status_code=400, detail="Parent packaging not found")
                
                total_base_qty = parent_pack.total_base_qty * qty_per_parent
                parent_sku_name = parent_pack.sku_name

            sku_name = self.generate_sku_name(
                item.name, base_uom, parent_sku_name, qty_per_parent, level_info.level_name, is_root
            )

            new_pack = ItemPackaging(
                item_id=item_id,
                level_id=pack.level_id,
                parent_id=actual_parent_id,
                qty_per_parent=qty_per_parent,
                total_base_qty=total_base_qty,
                sku_code=pack.sku_code,
                sku_name=sku_name
            )
            
            self.db.add(new_pack)
            await self.db.flush()
            
            if pack.id is not None:
                frontend_id_to_db_id[pack.id] = new_pack.id
                
            db_packagings.append(new_pack)

        # No need to commit here if router commits, or we can just leave it to router
        # Since standard is usually flush in service, commit in router or Depends
        return db_packagings

    async def update_item_cascade(self, item_id: int):
        item_q = await self.db.execute(
            select(Item, UOM.name.label("uom_name"))
            .join(UOM, Item.primary_uom_id == UOM.id)
            .where(Item.id == item_id).with_for_update()
        )
        item_data = item_q.first()

        if not item_data:
            return

        item, base_uom = item_data

        # Fetch packagings ordered by level_order
        pack_q = await self.db.execute(
            select(ItemPackaging)
            .join(PackagingLevel)
            .where(ItemPackaging.item_id == item_id)
            .order_by(PackagingLevel.level_order)
            .with_for_update()
        )
        packagings = pack_q.scalars().all()

        if not packagings:
            return

        updates = []
        packaging_map = {p.id: p for p in packagings}
        
        for pack in packagings:
            is_root = pack.parent_id is None
            parent_sku_name = packaging_map[pack.parent_id].sku_name if not is_root and pack.parent_id in packaging_map else None
            
            lvl_name_q = await self.db.execute(select(PackagingLevel.level_name).where(PackagingLevel.id == pack.level_id))
            level_name = lvl_name_q.scalar()
                
            new_sku_name = self.generate_sku_name(
                item.name, base_uom, parent_sku_name, pack.qty_per_parent, level_name, is_root
            )
            
            pack.sku_name = new_sku_name 
            updates.append({"id": pack.id, "sku_name": new_sku_name})
            
        if updates:
            # bulk_update_mappings doesn't exist in async session perfectly, we can use update() natively or set attrs
            for u in updates:
                await self.db.execute(
                    update(ItemPackaging)
                    .where(ItemPackaging.id == u["id"])
                    .values(sku_name=u["sku_name"])
                )
