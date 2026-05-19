import asyncio
import os
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app.database import AsyncSessionLocal
from app.api.v1.inventory import get_stock_balances
from app.models.user import User

async def test_api():
    async with AsyncSessionLocal() as db:
        # Create a mock user
        user = User(id=1, username="admin")
        # We need to mock the is_managerial property or whatever is used
        user.is_active = True
        
        # Call the API function
        # warehouse_id=18 is CENTRAL
        # item_id="870" is LAPTOPS
        res = await get_stock_balances(
            page=1, page_size=20, item_id="870", warehouse_id=18,
            db=db, current_user=user
        )
        print("API Response Items:")
        for item in res.get("items", []):
            print(f"ID: {item.get('id')}")
            print(f"Item: {item.get('item_name')} ({item.get('item_id')})")
            print(f"Warehouse: {item.get('warehouse_name')} ({item.get('warehouse_id')})")
            print(f"Batch Number: {item.get('batch_number')}")
            print(f"Bin Code: {item.get('bin_code')}")
            print(f"Qty: {item.get('available_qty')}")
            print("-" * 20)

asyncio.run(test_api())
