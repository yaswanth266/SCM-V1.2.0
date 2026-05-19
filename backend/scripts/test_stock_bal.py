import asyncio
from app.database import AsyncSessionLocal
from app.api.v1.inventory import get_stock_balances
from sqlalchemy import text

async def main():
    async with AsyncSessionLocal() as db:
        # Assuming warehouse_id = 1 (CENTRAL), item_id = 1005 (Paracetamol)
        print("Checking stock balance for item_id=1005...")
        balances = await get_stock_balances(db, warehouse_id=1, item_id=1005)
        for b in balances:
            print(f"Batch ID: {b.get('batch_id')}, Batch Number: {b.get('batch_number')}, Available: {b.get('available_qty')}")

if __name__ == "__main__":
    asyncio.run(main())
