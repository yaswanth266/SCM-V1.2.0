import asyncio
from sqlalchemy import select
from app.database import AsyncSessionLocal
from app.models.grn import GoodsReceiptNote, GRNItem

async def check_grns():
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(GoodsReceiptNote).order_by(GoodsReceiptNote.id.desc()).limit(5)
        )
        grns = result.scalars().all()
        for g in grns:
            print(f"GRN: {g.grn_number}, Status: {g.status}, Total Qty: {g.total_qty}, Accepted Qty: {g.accepted_qty}")
            res_items = await db.execute(
                select(GRNItem).where(GRNItem.grn_id == g.id)
            )
            items = res_items.scalars().all()
            for i in items:
                print(f"  Item ID: {i.item_id}, Received: {i.received_qty}, Accepted: {i.accepted_qty}")

if __name__ == "__main__":
    asyncio.run(check_grns())
