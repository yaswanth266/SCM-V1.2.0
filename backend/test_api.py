import asyncio
import os
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app.database import AsyncSessionLocal
from app.api.v1.inventory import get_stock_balances
from app.models.user import User

async def test_api():
    async with AsyncSessionLocal() as db:
        user = User(id=1, username="admin")
        res = await get_stock_balances(
            page=1, page_size=200, item_id=None, warehouse_id=None,
            batch_id=None, category=None, batch=None, show_zero_stock=False,
            db=db, current_user=user
        )
        for item in res.get("items", []):
            print(f"item_id={item.get('item_id')} available={item.get('available_qty')} batch_number={item.get('batch_number')} bin_code={item.get('bin_code')} batch_id={item.get('batch_id')} bin_id={item.get('bin_id')}")

asyncio.run(test_api())
