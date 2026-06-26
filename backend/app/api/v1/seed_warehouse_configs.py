import asyncio
import os
import sys

sys.path.append(r"c:\Users\User-4\Desktop\scm\bhspl_release v1.5 logistics\backend")

from app.database import AsyncSessionLocal
from app.models.warehouse import Warehouse, WarehouseConfig
from sqlalchemy import select

async def seed():
    async with AsyncSessionLocal() as db:
        # Get all warehouses
        wh_q = await db.execute(select(Warehouse))
        warehouses = wh_q.scalars().all()
        print(f"Found {len(warehouses)} warehouses in database.")
        
        # Check existing configs
        cfg_q = await db.execute(select(WarehouseConfig))
        existing_configs = {c.warehouse_id: c for c in cfg_q.scalars().all()}
        
        added_count = 0
        for w in warehouses:
            if w.id not in existing_configs:
                # If parent_id is None, it is central
                is_cen = w.parent_id is None
                new_cfg = WarehouseConfig(
                    warehouse_id=w.id,
                    is_central=is_cen
                )
                db.add(new_cfg)
                added_count += 1
        
        await db.commit()
        print(f"Created config rows for {added_count} warehouses.")

if __name__ == "__main__":
    asyncio.run(seed())
