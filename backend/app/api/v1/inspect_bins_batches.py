import asyncio
import os
import sys

sys.path.append(r"c:\Users\User-4\Desktop\scm\bhspl_release v1.5 logistics\backend")

from app.database import AsyncSessionLocal
from app.models.warehouse import Warehouse, SerialNumber, WarehouseBin, Batch
from app.models.stock import StockBalance
from sqlalchemy import select

async def inspect():
    async with AsyncSessionLocal() as db:
        # Get all non-central warehouses (parent_id is not None)
        wh_q = await db.execute(select(Warehouse).where(Warehouse.parent_id.is_not(None)))
        non_central_whs = wh_q.scalars().all()
        non_central_ids = {w.id for w in non_central_whs}
        print(f"Found {len(non_central_ids)} non-central warehouses.")
        
        # Check StockBalances in non-central warehouses with non-null bin_id or batch_id
        sb_q = await db.execute(
            select(StockBalance).where(StockBalance.warehouse_id.in_(non_central_ids))
        )
        balances = sb_q.scalars().all()
        print(f"Total StockBalances in non-central warehouses: {len(balances)}")
        
        bins_in_nc = [b for b in balances if b.bin_id is not None]
        batches_in_nc = [b for b in balances if b.batch_id is not None]
        print(f"  - Balances with non-null bin_id: {len(bins_in_nc)}")
        print(f"  - Balances with non-null batch_id: {len(batches_in_nc)}")
        
        # Check SerialNumbers in non-central warehouses with non-null bin_id or batch_id
        sn_q = await db.execute(
            select(SerialNumber).where(SerialNumber.warehouse_id.in_(non_central_ids))
        )
        serials = sn_q.scalars().all()
        print(f"Total SerialNumbers in non-central warehouses: {len(serials)}")
        
        sn_bins_in_nc = [s for s in serials if s.bin_id is not None]
        sn_batches_in_nc = [s for s in serials if s.batch_id is not None]
        print(f"  - Serials with non-null bin_id: {len(sn_bins_in_nc)}")
        print(f"  - Serials with non-null batch_id: {len(sn_batches_in_nc)}")

        if sn_bins_in_nc:
            print("\nExample serials in non-central warehouse with non-null bin_id:")
            for s in sn_bins_in_nc[:5]:
                print(f"  SN: {s.serial_number}, WH ID: {s.warehouse_id}, Bin ID: {s.bin_id}, Batch ID: {s.batch_id}, Status: {s.status}")

        if sn_batches_in_nc:
            print("\nExample serials in non-central warehouse with non-null batch_id:")
            for s in sn_batches_in_nc[:5]:
                print(f"  SN: {s.serial_number}, WH ID: {s.warehouse_id}, Bin ID: {s.bin_id}, Batch ID: {s.batch_id}, Status: {s.status}")

if __name__ == "__main__":
    asyncio.run(inspect())
