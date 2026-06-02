import asyncio
import sys
import os

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app.database import AsyncSessionLocal
from sqlalchemy import select
from app.models.logistics import LogisticsRfqMaster, LogisticsRfqVendor

async def main():
    async with AsyncSessionLocal() as session:
        # Get all RFQs
        res = await session.execute(select(LogisticsRfqMaster))
        rfqs = res.scalars().all()
        print(f"Total RFQs in database: {len(rfqs)}")
        for r in rfqs:
            print(f"RFQ ID: {r.id}, Number: {r.rfq_number}, Title: {r.title}")
            # Get invited vendors
            res_v = await session.execute(
                select(LogisticsRfqVendor).where(LogisticsRfqVendor.rfq_id == r.id)
            )
            invites = res_v.scalars().all()
            for iv in invites:
                print(f"  - Invited Vendor ID: {iv.vendor_id}, Status: {iv.response_status}")

if __name__ == '__main__':
    asyncio.run(main())
