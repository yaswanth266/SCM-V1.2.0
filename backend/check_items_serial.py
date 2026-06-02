import asyncio
from sqlalchemy import text

async def main():
    from app.config import settings
    from sqlalchemy.ext.asyncio import create_async_engine
    engine = create_async_engine(settings.DATABASE_URL, echo=False)
    async with engine.begin() as conn:
        # Show all item types
        r = await conn.execute(text("SELECT name FROM item_types ORDER BY name"))
        print("=== Item Types in DB ===")
        for row in r.fetchall():
            print(f"  - '{row[0]}'")

        # Show Dell XPS / laptop / asset items
        r2 = await conn.execute(text(
            "SELECT id, name, item_type, has_serial FROM items "
            "WHERE name ILIKE '%Dell%' OR name ILIKE '%XPS%' OR name ILIKE '%laptop%' LIMIT 20"
        ))
        print("\n=== Matching Items ===")
        for row in r2.fetchall():
            print(f"  id={row[0]}, name='{row[1]}', item_type='{row[2]}', has_serial={row[3]}")

        # Show all distinct item_type values in items table
        r3 = await conn.execute(text(
            "SELECT DISTINCT item_type, COUNT(*) as cnt FROM items GROUP BY item_type ORDER BY item_type"
        ))
        print("\n=== Item type distribution in items table ===")
        for row in r3.fetchall():
            print(f"  item_type='{row[0]}', count={row[1]}")
    await engine.dispose()

asyncio.run(main())
