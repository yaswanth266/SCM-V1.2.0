import asyncio
from app.database import AsyncSessionLocal
from sqlalchemy import select
from app.models.user import User, UserWarehouse

async def main():
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(User).where(User.username == "scm.support"))
        user = res.scalar_one_or_none()
        if not user:
            print("User scm.support not found")
            return
        wh_res = await db.execute(select(UserWarehouse.warehouse_id).where(UserWarehouse.user_id == user.id))
        wh_ids = [r[0] for r in wh_res.all()]
        print(f"User {user.username} (ID {user.id}) has warehouses: {wh_ids}")

if __name__ == "__main__":
    asyncio.run(main())
