import asyncio
import os
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app.database import AsyncSessionLocal
from sqlalchemy import select
from app.models.master import Item

async def check():
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Item).where(Item.id == 870))
        item = res.scalar_one()
        print(f"Item ID: {item.id}, Has Batch: {getattr(item, 'has_batch', 'MISSING')}, Name: {getattr(item, 'name', 'N/A')}")

if __name__ == "__main__":
    asyncio.run(check())
