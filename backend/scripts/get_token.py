import asyncio
from app.database import AsyncSessionLocal
from sqlalchemy import select
from app.models.user import User
from app.api.v1.auth import create_access_token

async def main():
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(User).where(User.username == "scm.support"))
        user = res.scalar_one_or_none()
        if user:
            token = create_access_token({"sub": str(user.id), "username": user.username})
            print(f"Token: {token}")

if __name__ == "__main__":
    asyncio.run(main())
