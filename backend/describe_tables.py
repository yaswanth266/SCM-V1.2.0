import asyncio
from sqlalchemy import text
from app.config import settings
from sqlalchemy.ext.asyncio import create_async_engine

async def main():
    engine = create_async_engine(settings.DATABASE_URL, echo=False)
    async with engine.begin() as conn:
        for table in ["material_request_items"]:
            try:
                r = await conn.execute(text(f"DESCRIBE {table}"))
                print(f"=== {table} columns ===")
                for row in r.fetchall():
                    print(row)
                print()
            except Exception as e:
                print(f"Error describing {table}:", e)

    await engine.dispose()

asyncio.run(main())
