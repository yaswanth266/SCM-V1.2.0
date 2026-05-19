import asyncio
from app.database import AsyncSessionLocal
from app.api.v1.inventory import get_stock_balances
from app.models.user import User

async def main():
    async with AsyncSessionLocal() as db:
        # User 1 is probably super_admin
        user = User(id=1, username="admin")
        # Call the endpoint function directly
        res = await get_stock_balances(page=1, page_size=200, item_id="1005", warehouse_id=18, category=None, batch=None, db=db, current_user=user)
        print("Keys in first item:", res["items"][0].keys() if res["items"] else "No items")
        if res["items"]:
            print("batch_id:", res["items"][0].get("batch_id"))
            print("batch_number:", res["items"][0].get("batch_number"))

if __name__ == "__main__":
    asyncio.run(main())
