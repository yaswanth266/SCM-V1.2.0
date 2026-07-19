import asyncio
from app.database import AsyncSessionLocal
from sqlalchemy import text

async def main():
    async with AsyncSessionLocal() as session:
        # Check current column details
        res = await session.execute(text("SHOW TRIGGERS;"))
        triggers = res.all()
        for trig in triggers:
            print(f"Trigger: {trig[0]} on Table: {trig[1]}, Event: {trig[2]}, Timing: {trig[3]}")

if __name__ == "__main__":
    asyncio.run(main())
