import asyncio
import os
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from sqlalchemy import select
from sqlalchemy.orm import selectinload
from app.database import AsyncSessionLocal
from app.models.stock import StockBalance
from app.models.warehouse import Batch, WarehouseBin

async def test():
    async with AsyncSessionLocal() as db:
        query = select(StockBalance).options(
            selectinload(StockBalance.batch),
            selectinload(StockBalance.bin)
        )
        result = await db.execute(query)
        rows = result.scalars().all()
        for r in rows:
            b_num = r.batch.batch_number if r.batch else None
            bin_code = r.bin.code if r.bin else None
            print(f"item={r.item_id}, wh={r.warehouse_id}, batch_id={r.batch_id}, batch_num={b_num}, bin_id={r.bin_id}, bin_code={bin_code}, qty={r.available_qty}")

asyncio.run(test())
