import asyncio
from app.database import AsyncSessionLocal
from sqlalchemy import select
from app.models.warehouse import Warehouse

async def main():
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Warehouse).where(Warehouse.id == 18))
        wh = res.scalar_one_or_none()
        print(f"Warehouse 18 type: {wh.type if wh else 'Not Found'}")

if __name__ == "__main__":
    asyncio.run(main())
