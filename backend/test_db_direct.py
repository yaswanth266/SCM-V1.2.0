import asyncio
import os
import sys
from decimal import Decimal

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app.database import AsyncSessionLocal
from sqlalchemy import select
from sqlalchemy.orm import joinedload
from app.models.stock import StockBalance
from app.models.warehouse import Batch, WarehouseBin

async def test_db_directly():
    async with AsyncSessionLocal() as db:
        # Check if we can fetch joined data
        query = select(StockBalance).options(
            joinedload(StockBalance.batch),
            joinedload(StockBalance.bin)
        ).where(StockBalance.item_id == 870, StockBalance.warehouse_id == 18)
        
        result = await db.execute(query)
        balances = result.scalars().all()
        
        print(f"Found {len(balances)} rows")
        for b in balances:
            print(f"ID: {b.id}, Item: {b.item_id}, Wh: {b.warehouse_id}")
            print(f"Batch ID: {b.batch_id}, Batch: {b.batch.batch_number if b.batch else 'NONE'}")
            print(f"Bin ID: {b.bin_id}, Bin: {b.bin.code if b.bin else 'NONE'}")
            print(f"Qty: {b.available_qty}")
            print("-" * 20)

asyncio.run(test_db_directly())
