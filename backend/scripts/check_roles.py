import asyncio
from app.database import AsyncSessionLocal
from app.utils.dependencies import get_user_role_codes
from app.models.user import User

async def main():
    async with AsyncSessionLocal() as db:
        roles = await get_user_role_codes(db, 24)
        print("User 24 roles:", roles)

if __name__ == "__main__":
    asyncio.run(main())
