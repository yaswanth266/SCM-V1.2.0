import asyncio
import os
import sys

# Add backend directory to path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from sqlalchemy import select, or_
from app.database import AsyncSessionLocal
from app.models.inventory_master import Item

async def main():
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Item).where(or_(
                Item.special_storage_condition == True,
                Item.special_transport_condition == True
            ))
        )
        items = result.scalars().all()
        print(f"Found {len(items)} items with special conditions:")
        for item in items:
            print(f"Item ID: {item.id}, Code: {item.item_code}, Name: {item.name}")
            print(f"  special_storage: {item.special_storage_condition}")
            print(f"  storage_min_temp: {item.storage_min_temp}")
            print(f"  storage_max_temp: {item.storage_max_temp}")
            print(f"  storage_min_moisture: {item.storage_min_moisture}")
            print(f"  storage_max_moisture: {item.storage_max_moisture}")
            print(f"  storage_breakable: {item.storage_breakable}")
            print(f"  special_transport: {item.special_transport_condition}")
            print(f"  transport_min_temp: {item.transport_min_temp}")
            print(f"  transport_max_temp: {item.transport_max_temp}")
            print(f"  transport_min_moisture: {item.transport_min_moisture}")
            print(f"  transport_max_moisture: {item.transport_max_moisture}")
            print(f"  transport_breakable: {item.transport_breakable}")
            print("-" * 40)

if __name__ == "__main__":
    asyncio.run(main())
