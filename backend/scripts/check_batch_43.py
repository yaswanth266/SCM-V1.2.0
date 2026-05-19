import asyncio
from app.database import AsyncSessionLocal
from sqlalchemy import select
from app.models.warehouse import Batch

async def main():
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Batch).where(Batch.id == 43))
        batch = res.scalar_one_or_none()
        if batch:
            print(f"Found Batch 43: batch_number={batch.batch_number}, item_id={batch.item_id}")
        else:
            print("Batch 43 NOT FOUND")

if __name__ == "__main__":
    asyncio.run(main())
