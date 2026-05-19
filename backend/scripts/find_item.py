import asyncio
from app.database import AsyncSessionLocal
from sqlalchemy import select
from app.models.master import Item

async def main():
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Item).where(Item.name.like('%Paraceto%')))
        items = res.scalars().all()
        for i in items:
            print(f"ID: {i.id}, Name: {i.name}, has_batch: {getattr(i, 'has_batch', 'Not found')}")

if __name__ == "__main__":
    asyncio.run(main())
