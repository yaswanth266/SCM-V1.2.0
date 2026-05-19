import asyncio
from app.database import AsyncSessionLocal
from app.api.v1.inventory import get_stock_balance_alias
from app.models.user import User

async def main():
    async with AsyncSessionLocal() as db:
        user = User(id=24, username="scm.support")
        try:
            # We must mock get_current_user dependencies, but get_stock_balance_alias just takes current_user
            res = await get_stock_balance_alias(
                page=1, page_size=200, item_id="1005", warehouse_id=18, batch_id=None, db=db, current_user=user
            )
            print("Response:", res)
        except Exception as e:
            print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(main())
