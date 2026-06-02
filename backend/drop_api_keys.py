import asyncio
from sqlalchemy import text
from app.database import engine

async def main():
    async with engine.begin() as conn:
        await conn.execute(text('DROP TABLE IF EXISTS api_keys'))

if __name__ == "__main__":
    asyncio.run(main())
