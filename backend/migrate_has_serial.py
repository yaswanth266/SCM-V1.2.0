"""
Migration script: Set has_serial = TRUE for all items in the database 
whose item_type is found in the item_types table AND matches asset-related types.

Also sets has_serial = TRUE specifically for item_type values that are 
asset-related (case-insensitive: 'asset', 'it asset', 'fixed asset', 'equipment', etc.)

Run from the backend/ directory:
    python migrate_has_serial.py
"""
import asyncio
from sqlalchemy import text


async def main():
    from app.config import settings
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(settings.DATABASE_URL, echo=False)

    async with engine.begin() as conn:
        # 1. Show all distinct item_type values currently in items table
        r = await conn.execute(text(
            "SELECT DISTINCT item_type, COUNT(*) as cnt "
            "FROM items GROUP BY item_type ORDER BY item_type"
        ))
        rows = r.fetchall()
        print("=== Current item_type distribution ===")
        for row in rows:
            print(f"  item_type='{row[0]}', count={row[1]}")

        # 2. Show item_types table (master list)
        r2 = await conn.execute(text("SELECT name, description FROM item_types ORDER BY name"))
        types = r2.fetchall()
        print("\n=== item_types master table ===")
        for t in types:
            print(f"  name='{t[0]}', desc='{t[1]}'")

        # 3. Show sample matching items (LIKE for MySQL)
        r3 = await conn.execute(text(
            "SELECT id, name, item_type, has_serial FROM items "
            "WHERE name LIKE '%Dell%' OR name LIKE '%XPS%' OR name LIKE '%laptop%' "
            "OR name LIKE '%Laptop%' LIMIT 20"
        ))
        items = r3.fetchall()
        print("\n=== Dell/XPS/Laptop items ===")
        for row in items:
            print(f"  id={row[0]}, name='{row[1]}', item_type='{row[2]}', has_serial={row[3]}")

        # 4. Ask which item_types should get has_serial=True
        # Asset-related keywords (case-insensitive match)
        asset_keywords = ['asset', 'equipment', 'laptop', 'computer', 'it', 'fixed']

        # Find matching item_type names from the master table
        asset_types = []
        for t in types:
            name_lower = (t[0] or '').lower()
            if any(kw in name_lower for kw in asset_keywords):
                asset_types.append(t[0])

        print(f"\n=== Detected asset-related item_types: {asset_types} ===")

        if not asset_types:
            print("No asset item types found automatically.")
            print("Will update all items that have has_serial=False to has_serial=True manually if needed.")
            # Fallback: update specifically Dell XPS items
            result = await conn.execute(text(
                "UPDATE items SET has_serial = 1 "
                "WHERE (name LIKE '%Dell%' OR name LIKE '%XPS%' OR name LIKE '%laptop%' "
                "OR name LIKE '%Laptop%') AND has_serial = 0"
            ))
            print(f"Updated {result.rowcount} items (Dell/XPS/Laptop) to has_serial=True")
        else:
            # Build placeholders for IN clause
            placeholders = ', '.join([f"'{t}'" for t in asset_types])
            update_sql = f"UPDATE items SET has_serial = 1 WHERE item_type IN ({placeholders}) AND has_serial = 0"
            print(f"\nExecuting: {update_sql}")
            result = await conn.execute(text(update_sql))
            print(f"Updated {result.rowcount} items to has_serial=TRUE for types: {asset_types}")

        # 5. Final verification
        r4 = await conn.execute(text(
            "SELECT id, name, item_type, has_serial FROM items "
            "WHERE name LIKE '%Dell%' OR name LIKE '%XPS%' OR name LIKE '%laptop%' "
            "OR name LIKE '%Laptop%' LIMIT 20"
        ))
        print("\n=== After update: Dell/XPS/Laptop items ===")
        for row in r4.fetchall():
            print(f"  id={row[0]}, name='{row[1]}', item_type='{row[2]}', has_serial={row[3]}")

    await engine.dispose()
    print("\nDone.")


asyncio.run(main())
