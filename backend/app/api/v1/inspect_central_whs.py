import asyncio
import os
import sys

sys.path.append(r"c:\Users\User-4\Desktop\scm\bhspl_release v1.5 logistics\backend")

from app.database import AsyncSessionLocal
from app.models.warehouse import Warehouse
from sqlalchemy import select

async def inspect():
    async with AsyncSessionLocal() as db:
        wh_q = await db.execute(select(Warehouse).where(Warehouse.parent_id.is_(None)))
        central_whs = wh_q.scalars().all()
        print("Central Warehouses (parent_id is None):")
        for w in central_whs:
            print(f"  ID: {w.id}, Code: {w.code}, Name: {w.name}")

if __name__ == "__main__":
    asyncio.run(inspect())
