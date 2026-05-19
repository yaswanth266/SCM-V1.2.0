import asyncio
from app.database import AsyncSessionLocal
from sqlalchemy import select
from app.models.warehouse import Warehouse

async def main():
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Warehouse).where(Warehouse.name.like('%CENTRAL%')))
        whs = res.scalars().all()
        for w in whs:
            print(f"ID: {w.id}, Name: {w.name}")

if __name__ == "__main__":
    asyncio.run(main())
