import asyncio
import sys
sys.path.append('.')
from app.database import AsyncSessionLocal
from sqlalchemy import text

async def check():
    async with AsyncSessionLocal() as db:
        r = await db.execute(text("SELECT id, indent_number FROM indents WHERE indent_number LIKE '%0000093%' LIMIT 5"))
        rows = r.all()
        for row in rows:
            print(f"indent: id={row[0]}, number={row[1]}")
            if rows:
                indent_id = rows[0][0]
                r2 = await db.execute(text(f"""
                    SELECT ii.id, ii.item_id, i.name, i.item_code, ii.requested_qty, ii.approved_qty, ii.issued_qty
                    FROM indent_items ii
                    JOIN items i ON i.id = ii.item_id
                    WHERE ii.indent_id = {indent_id}
                """))
                print("\nIndent items:")
                for item in r2.all():
                    print(f"  item_id={item[1]}, name={item[2]}, code={item[3]}, req={item[4]}, approved={item[5]}, issued={item[6]}")
                
                r3 = await db.execute(text(f"""
                    SELECT mi.id, mi.issue_number, mi.status, mii.item_id, i.name, mii.qty
                    FROM material_issues mi
                    JOIN material_issue_items mii ON mii.issue_id = mi.id
                    JOIN items i ON i.id = mii.item_id
                    WHERE mi.indent_id = {indent_id}
                """))
                print("\nMaterial issues:")
                for mi in r3.all():
                    print(f"  mi={mi[1]}, status={mi[2]}, item_id={mi[3]}, item={mi[4]}, qty={mi[5]}")
        return

asyncio.run(check())
