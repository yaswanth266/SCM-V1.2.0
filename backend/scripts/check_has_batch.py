import asyncio
from app.database import AsyncSessionLocal
from sqlalchemy import select, text
from app.models.master import Item

async def main():
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Item).where(Item.id == 1005))
        item = res.scalar_one_or_none()
        print(f"Item 1005: {item.name}, has_batch: {getattr(item, 'has_batch', 'Not Found')}")

if __name__ == "__main__":
    asyncio.run(main())
