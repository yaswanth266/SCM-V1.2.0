import asyncio
import os
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from sqlalchemy import select
from sqlalchemy.orm import selectinload
from app.database import AsyncSessionLocal
from app.models.stock import StockBalance
from app.models.master import Item
from app.models.warehouse import Warehouse

async def test():
    async with AsyncSessionLocal() as db:
        # Get Central warehouse id
        wh_q = select(Warehouse).where(Warehouse.name == "CENTRAL")
        wh_res = await db.execute(wh_q)
        wh = wh_res.scalars().first()
        print(f"CENTRAL wh id = {wh.id if wh else None}")

        # Get LAPTOPS item id
        it_q = select(Item).where(Item.name.ilike('%laptop%'))
        it_res = await db.execute(it_q)
        items = it_res.scalars().all()
        for it in items:
            print(f"LAPTOP item id = {it.id}, name={it.name}")
        
        # Get Stock Balance for CENTRAL
        query = select(StockBalance).where(StockBalance.warehouse_id == (wh.id if wh else 1))
        result = await db.execute(query)
        rows = result.scalars().all()
        for r in rows:
            print(f"wh=1 item={r.item_id}, batch_id={r.batch_id}, bin_id={r.bin_id}, qty={r.available_qty}")

asyncio.run(test())
