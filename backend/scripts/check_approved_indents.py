import asyncio
import sys
sys.path.append('.')
from app.database import AsyncSessionLocal
from sqlalchemy import text

async def check():
    async with AsyncSessionLocal() as db:
        sql = """
            SELECT i.id, i.indent_number, i.status, 
                   ii.id as iid, ii.item_id, ii.requested_qty, ii.approved_qty, ii.issued_qty
            FROM indents i
            JOIN indent_items ii ON ii.indent_id = i.id
            WHERE i.status IN ('approved', 'partially_fulfilled')
            ORDER BY i.id DESC
            LIMIT 20
        """
        r = await db.execute(text(sql))
        print('Approved/PartialFulfilled indent items:')
        for row in r.all():
            approved = row[6]
            issued = row[7]
            remaining = (float(approved or 0) - float(issued or 0))
            print(f'  indent={row[1]}, status={row[2]}, item_id={row[4]}, req={row[5]}, approved={approved}, issued={issued}, remaining={remaining}')

asyncio.run(check())
