import asyncio
from app.database import AsyncSessionLocal
from app.utils.dependencies import user_warehouse_ids
from app.models.user import User

async def main():
    async with AsyncSessionLocal() as db:
        whs = await user_warehouse_ids(db, 24)
        print("User 24 warehouses:", whs)

if __name__ == "__main__":
    asyncio.run(main())
