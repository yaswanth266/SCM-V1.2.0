import asyncio
import os
import sys
from datetime import datetime
from decimal import Decimal
import random

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app.database import AsyncSessionLocal
from app.models.issue import VehicleIssue, VehicleIssueItem, MaterialAcknowledgement, MaterialAcknowledgementItem
from app.models.stock import StockBalance, VehicleStockBalance, StockLedger, VehicleStockLedger
from app.models.user import User
from app.models.warehouse import Warehouse
from app.models.inventory_master import Item
from sqlalchemy.future import select

async def run_flow_test():
    print("Starting Vehicle Issue & Acknowledgement integration flow test...")
    
    unique_suffix = f"{datetime.now().strftime('%M%S')}_{random.randint(100, 999)}"
    test_vi_number = f"TEST-VI-{unique_suffix}"
    test_mack_number = f"TEST-MACK-{unique_suffix}"
    
    async with AsyncSessionLocal() as db:
        # 1. Setup/lookup a valid Warehouse, Item and user
        wh_result = await db.execute(select(Warehouse).limit(1))
        warehouse = wh_result.scalars().first()
        if not warehouse:
            print("No warehouses found in database. Cannot run test.")
            return

        item_result = await db.execute(select(Item).limit(1))
        item = item_result.scalars().first()
        if not item:
            print("No items found in database. Cannot run test.")
            return

        user_result = await db.execute(select(User).limit(1))
        user = user_result.scalars().first()
        if not user:
            print("No users found in database. Cannot run test.")
            return

        print(f"Using Warehouse: {warehouse.name} (ID: {warehouse.id})")
        print(f"Using Item: {item.name} (ID: {item.id})")
        print(f"Using User: {user.username} (ID: {user.id})")

        # Check or create StockBalance for the item in that warehouse
        sb_result = await db.execute(
            select(StockBalance).filter_by(warehouse_id=warehouse.id, item_id=item.id)
        )
        sb = sb_result.scalars().first()
        if not sb:
            print("Creating initial StockBalance...")
            sb = StockBalance(
                warehouse_id=warehouse.id,
                item_id=item.id,
                available_qty=Decimal("100.0"),
                reserved_qty=Decimal("0.0"),
                transit_qty=Decimal("0.0"),
                total_qty=Decimal("100.0"),
                valuation_rate=Decimal("10.0"),
                stock_value=Decimal("1000.0")
            )
            db.add(sb)
            await db.commit()
            await db.refresh(sb)
        else:
            # reset to ensure clean test
            sb.available_qty = Decimal("100.0")
            sb.reserved_qty = Decimal("0.0")
            sb.total_qty = Decimal("100.0")
            await db.commit()
            await db.refresh(sb)

        initial_available = Decimal(str(sb.available_qty))
        initial_reserved = Decimal(str(sb.reserved_qty))
        print(f"Initial Stock: Available={initial_available}, Reserved={initial_reserved}")

        # 2. Create VehicleIssue in Draft status
        issue = VehicleIssue(
            issue_number=test_vi_number,
            warehouse_id=warehouse.id,
            vehicle_code="V-TEST-001",
            vehicle_number="KA-01-XX-9999",
            status="draft",
            issue_date=datetime.now(),
            department="Testing",
            remarks="Integration testing of vehicle issue",
            issued_by=user.id,
        )
        db.add(issue)
        await db.commit()
        await db.refresh(issue)
        print(f"Created Vehicle Issue: {issue.issue_number} (ID: {issue.id})")

        issue_item = VehicleIssueItem(
            vehicle_issue_id=issue.id,
            item_id=item.id,
            qty=Decimal("10.0"),
            uom_id=item.primary_uom_id,
            rate=Decimal("10.0"),
            serial_numbers=["SN-TEST-1", "SN-TEST-2"],
        )
        db.add(issue_item)
        await db.commit()
        await db.refresh(issue_item)
        print(f"Added item to Vehicle Issue: Item ID {issue_item.item_id}, Qty={issue_item.qty}, Serials={issue_item.serial_numbers}")

        # 3. Confirm/Issue the VehicleIssue (No stock reservation)
        # Verify sufficient available quantity
        assert sb.available_qty >= issue_item.qty, "Insufficient stock for test!"
        
        issue.status = "issued"
        await db.commit()
        await db.refresh(sb)
        await db.refresh(issue)
        print(f"Stock status changed to issued. Stock: Available={sb.available_qty}, Reserved={sb.reserved_qty}")
        assert Decimal(str(sb.available_qty)) == initial_available
        assert Decimal(str(sb.reserved_qty)) == initial_reserved

        # 4. Create and Confirm Material Acknowledgement
        # Check starting vehicle stock balance
        vsb_result = await db.execute(
            select(VehicleStockBalance).filter_by(vehicle_code="V-TEST-001", item_id=item.id)
        )
        vsb = vsb_result.scalars().first()
        initial_vehicle_qty = Decimal(str(vsb.qty)) if vsb else Decimal("0.0")
        print(f"Initial Vehicle Stock Balance: Qty={initial_vehicle_qty}")

        # Create MaterialAcknowledgement
        ack = MaterialAcknowledgement(
            acknowledgement_number=test_mack_number,
            vehicle_issue_id=issue.id,
            acknowledged_by=user.id,
            employee_code="EMP-TEST",
            remarks="Acknowledged in test",
            acknowledged_at=datetime.utcnow()
        )
        db.add(ack)
        await db.commit()
        await db.refresh(ack)
        print(f"Created Material Acknowledgement: {ack.acknowledgement_number} (ID: {ack.id})")

        ack_item = MaterialAcknowledgementItem(
            acknowledgement_id=ack.id,
            item_id=item.id,
            received_qty=Decimal("10.0"),
            remarks="All received",
            serial_numbers=["SN-TEST-1", "SN-TEST-2"],
        )
        db.add(ack_item)
        await db.commit()
        await db.refresh(ack_item)
        print(f"Added item to Acknowledgement: Qty={ack_item.received_qty}, Serials={ack_item.serial_numbers}")

        # Process Acknowledgement:
        # Load fresh stock balance to avoid stale object states
        sb_result2 = await db.execute(
            select(StockBalance).filter_by(warehouse_id=warehouse.id, item_id=item.id)
        )
        sb2 = sb_result2.scalars().first()
        print(f"Before ack decrement, in DB Stock Balance has: Available={sb2.available_qty}, Reserved={sb2.reserved_qty}, Total={sb2.total_qty}")
        
        # B. Post to VehicleStockLedger via our new service function
        from app.services.stock_service import post_vehicle_stock_ledger
        vsb = await post_vehicle_stock_ledger(
            db,
            item_id=item.id,
            warehouse_id=warehouse.id,
            vehicle_code="V-TEST-001",
            vehicle_number="KA-01-XX-9999",
            qty=ack_item.received_qty,
            rate=Decimal("10.0"),
            bin_id=None,
            batch_id=None,
            reference_type="material_acknowledgement",
            reference_id=ack.id,
            uom_id=item.primary_uom_id,
            created_by=user.id,
        )

        # Update serial numbers
        existing_serials = vsb.serial_numbers or []
        new_serials = ack_item.serial_numbers or []
        vsb.serial_numbers = list(set(existing_serials + new_serials))
        vsb.last_updated = datetime.now()

        # D. Update issue status
        issue.status = "acknowledged"

        await db.commit()
        await db.refresh(sb2)
        await db.refresh(issue)
        if vsb.id is not None:
            await db.refresh(vsb)

        print("Acknowledgement processed successfully.")
        print(f"Final Warehouse Stock: Available={sb2.available_qty}, Reserved={sb2.reserved_qty}, Total={sb2.total_qty}")
        print(f"Final Vehicle Stock Balance: Qty={vsb.qty}")

        # Assert final correctness
        assert Decimal(str(sb2.reserved_qty)) == initial_reserved
        assert Decimal(str(sb2.total_qty)) == initial_available - Decimal("10.0")
        assert Decimal(str(vsb.qty)) == initial_vehicle_qty + Decimal("10.0")
        assert "SN-TEST-1" in vsb.serial_numbers
        assert "SN-TEST-2" in vsb.serial_numbers

        # Verify VehicleStockLedger records
        vsl_res = await db.execute(
            select(VehicleStockLedger).filter_by(reference_type="material_acknowledgement", reference_id=ack.id)
        )
        vsl_entries = vsl_res.scalars().all()
        assert len(vsl_entries) == 2, f"Expected 2 ledger entries, got {len(vsl_entries)}"
        wh_out = next(e for e in vsl_entries if e.transaction_type == "warehouse_out")
        veh_in = next(e for e in vsl_entries if e.transaction_type == "vehicle_in")
        assert wh_out.qty_out == Decimal("10.0")
        assert veh_in.qty_in == Decimal("10.0")

        # Verify main StockLedger record (Warehouse Outflow)
        sl_res = await db.execute(
            select(StockLedger).filter_by(reference_type="vehicle_issue", reference_id=issue.id)
        )
        sl_entries = sl_res.scalars().all()
        assert len(sl_entries) == 1, f"Expected 1 stock ledger entry, got {len(sl_entries)}"
        assert sl_entries[0].qty_out == Decimal("10.0")
        assert sl_entries[0].transaction_type == "material_issue"
        print("ALL VEHICLE LEDGER FLOW ASSERTIONS PASSED SUCCESSFULLY!")

        # Cleanup test data to prevent database clutter
        print("Cleaning up test records...")
        await db.delete(ack_item)
        await db.delete(ack)
        for entry in vsl_entries:
            await db.delete(entry)
        for entry in sl_entries:
            await db.delete(entry)
        await db.delete(issue_item)
        await db.delete(issue)
        # Restore stock balance
        sb2.available_qty = initial_available
        sb2.reserved_qty = initial_reserved
        sb2.total_qty = sb2.available_qty + sb2.reserved_qty
        if initial_vehicle_qty == Decimal("0.0"):
            await db.delete(vsb)
        else:
            vsb.qty = initial_vehicle_qty
            vsb.serial_numbers = []
        await db.commit()
        print("Cleanup completed successfully.")

if __name__ == "__main__":
    asyncio.run(run_flow_test())
