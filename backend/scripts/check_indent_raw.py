
import asyncio
from sqlalchemy import select, text
from app.database import AsyncSessionLocal

async def check_indent():
    async with AsyncSessionLocal() as db:
        res = await db.execute(text("SELECT * FROM indent_items WHERE item_id = 1005"))
        rows = res.fetchall()
        print("Raw indent_items rows for item 1005:")
        for r in rows:
            print(r)

if __name__ == "__main__":
    asyncio.run(check_indent())
