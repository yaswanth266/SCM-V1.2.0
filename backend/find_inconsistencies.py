import asyncio
import os
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app.database import AsyncSessionLocal
from sqlalchemy import select, and_
from app.models.stock import StockBalance
from app.models.master import Item

async def find_inconsistencies():
    async with AsyncSessionLocal() as db:
        # Find stock balances that have a batch_id but the item has has_batch = False
        query = select(StockBalance.item_id, StockBalance.batch_id, Item.name, Item.has_batch).join(
            Item, Item.id == StockBalance.item_id
        ).where(
            and_(
                StockBalance.batch_id.is_not(None),
                Item.has_batch == False
            )
        )
        
        result = await db.execute(query)
        rows = result.all()
        
        if not rows:
            print("No inconsistencies found.")
            return
            
        print(f"Found {len(rows)} inconsistent stock rows:")
        for row in rows:
            print(f"Item ID: {row.item_id}, Name: {row.name}, Batch ID: {row.batch_id}, Item.has_batch: {row.has_batch}")

if __name__ == "__main__":
    asyncio.run(find_inconsistencies())
