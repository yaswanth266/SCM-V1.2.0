import asyncio
import sys
import os

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app.database import AsyncSessionLocal
from sqlalchemy import select
from app.models.logistics import LogisticsRfqMaster, LogisticsRfqResponse
from app.schemas.logistics import AwardRfqQuote
from app.api.v1.logistics import select_winning_quotation

async def main():
    async with AsyncSessionLocal() as session:
        # Check what quotes exist
        res = await session.execute(select(LogisticsRfqResponse))
        quotes = res.scalars().all()
        print(f"Total Quotes: {len(quotes)}")
        for q in quotes:
            print(f"Quote ID: {q.id}, RFQ ID: {q.rfq_id}, Number: {q.response_number}, Vendor ID: {q.vendor_id}")
        
        if quotes:
            q = quotes[0]
            payload = AwardRfqQuote(
                rfqId=q.rfq_id,
                responseId=q.id,
                remarks="Awarded via programmatic diagnostic test"
            )
            print(f"Attempting to award Quote ID: {q.id} on RFQ ID: {q.rfq_id}...")
            try:
                # We mock current_user as a dummy User with id=1
                from app.models.user import User
                dummy_user = User(id=1)
                
                res_award = await select_winning_quotation(
                    id=q.rfq_id,
                    payload=payload,
                    db=session,
                    current_user=dummy_user
                )
                print("AWARD SUCCESS:", res_award)
            except Exception as e:
                import traceback
                print("EXCEPTION OCCURRED IN AWARD:")
                traceback.print_exc()

if __name__ == '__main__':
    asyncio.run(main())
