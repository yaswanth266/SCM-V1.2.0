import asyncio
from app.database import AsyncSessionLocal
from sqlalchemy import select, func
from app.models.stock import StockBalance

async def main():
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(StockBalance).where(StockBalance.warehouse_id == 18, StockBalance.item_id == 1005))
        sb = res.scalars().all()
        print(f"Found {len(sb)} stock balance records for warehouse 18, item 1005")
        for s in sb:
            print(f"Batch ID: {s.batch_id}, Qty: {s.available_qty}")

if __name__ == "__main__":
    asyncio.run(main())
