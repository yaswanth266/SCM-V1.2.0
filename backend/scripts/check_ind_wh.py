import asyncio
from app.database import AsyncSessionLocal
from sqlalchemy import select
from app.models.indent import Indent

async def main():
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Indent).where(Indent.indent_number.like('%00133%')))
        ind = res.scalar_one_or_none()
        if ind:
            print(f"Indent warehouse_id: {ind.warehouse_id}")

if __name__ == "__main__":
    asyncio.run(main())
