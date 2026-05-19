import asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

async def check():
    engine = create_async_engine("mysql+aiomysql://root:rolex@localhost/bhspl_scm")
    async with engine.connect() as conn:
        res = await conn.execute(text("SHOW INDEX FROM items"))
        for row in res:
            print(row)
    await engine.dispose()

if __name__ == "__main__":
    asyncio.run(check())
