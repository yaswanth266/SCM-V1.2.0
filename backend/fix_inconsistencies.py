import asyncio
import os
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app.database import AsyncSessionLocal
from sqlalchemy import select, and_, update
from app.models.stock import StockBalance
from app.models.master import Item

async def fix_inconsistencies():
    async with AsyncSessionLocal() as db:
        # Get items that have batch stock but has_batch=False
        query = select(Item.id).join(
            StockBalance, Item.id == StockBalance.item_id
        ).where(
            and_(
                StockBalance.batch_id.is_not(None),
                Item.has_batch == False
            )
        ).distinct()
        
        result = await db.execute(query)
        item_ids = [r[0] for r in result.all()]
        
        if not item_ids:
            print("No items to fix.")
            return
            
        print(f"Fixing {len(item_ids)} items to has_batch=True: {item_ids}")
        
        upd = update(Item).where(Item.id.in_(item_ids)).values(has_batch=True)
        await db.execute(upd)
        await db.commit()
        print("Done.")

if __name__ == "__main__":
    asyncio.run(fix_inconsistencies())
