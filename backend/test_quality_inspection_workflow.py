import asyncio
import os
import sys
from decimal import Decimal

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from sqlalchemy import select
from sqlalchemy.orm import selectinload
from fastapi import HTTPException

from app.database import AsyncSessionLocal
from app.models.master import Item, UOM
from app.models.procurement_master import Vendor
from app.models.warehouse import Warehouse
from app.models.grn import GoodsReceiptNote, GRNItem, PutawayOrder, PutawayItem, QualityInspection, QualityInspectionItem
from app.api.v1.warehouse import create_grn, complete_quality_inspection, create_putaway_order, update_quality_inspection
from app.schemas.warehouse import GRNCreate, GRNItemCreate, QICreate, QIUpdate, QIItemCreate, PutawayCreate, PutawayItemCreate

class DummyUser:
    def __init__(self, id, username):
        self.id = id
        self.username = username

async def run_workflow_test():
    async with AsyncSessionLocal() as db:
        async with db.begin():
            # Query valid vendor, warehouse, and uom
            vendor_res = await db.execute(select(Vendor).limit(1))
            vendor = vendor_res.scalar_one_or_none()
            if not vendor:
                raise RuntimeError("No vendors found in DB to run integration tests!")
            vendor_id = vendor.id

            warehouse_res = await db.execute(select(Warehouse).limit(1))
            warehouse = warehouse_res.scalar_one_or_none()
            if not warehouse:
                raise RuntimeError("No warehouses found in DB to run integration tests!")
            warehouse_id = warehouse.id

            uom_res = await db.execute(select(UOM).limit(1))
            uom = uom_res.scalar_one_or_none()
            if not uom:
                raise RuntimeError("No UOMs found in DB to run integration tests!")
            uom_id = uom.id

            # 1. Fetch or create a test item that requires quality inspection
            item_qi_res = await db.execute(
                select(Item).where(Item.requires_quality_inspection == True).limit(1)
            )
            item_qi = item_qi_res.scalar_one_or_none()
            if not item_qi:
                # If none exist, fetch any active item and set requires_quality_inspection to True
                any_item_res = await db.execute(select(Item).limit(1))
                item_qi = any_item_res.scalar_one()
                item_qi.requires_quality_inspection = True
                await db.flush()

            # 2. Fetch or create a test item that does NOT require quality inspection
            item_non_qi_res = await db.execute(
                select(Item).where(Item.requires_quality_inspection == False).limit(1)
            )
            item_non_qi = item_non_qi_res.scalar_one_or_none()
            if not item_non_qi:
                # If none exist, create one or modify one
                any_item2_res = await db.execute(
                    select(Item).where(Item.id != item_qi.id).limit(1)
                )
                item_non_qi = any_item2_res.scalar_one()
                item_non_qi.requires_quality_inspection = False
                await db.flush()

            print(f"Test Item requiring QI: {item_qi.item_code} (requires_qi={item_qi.requires_quality_inspection})")
            print(f"Test Item not requiring QI: {item_non_qi.item_code} (requires_qi={item_non_qi.requires_quality_inspection})")

            # 3. Create a mixed GRN
            grn_payload = GRNCreate(
                inward_id=None,
                po_id=None,
                warehouse_id=warehouse_id,
                vendor_id=vendor_id,
                grn_date="2026-07-18",
                invoice_number="INV-QI-TEST-123",
                invoice_date="2026-07-18",
                gate_entry_number="GE-999",
                gate_entry_date="2026-07-18",
                received_by=1,
                remarks="QI testing",
                is_draft=False,
                items=[
                    GRNItemCreate(
                        item_id=item_qi.id,
                        ordered_qty=Decimal("10"),
                        received_qty=Decimal("10"),
                        accepted_qty=Decimal("0"),
                        rejected_qty=Decimal("0"),
                        uom_id=uom_id,
                        batch_number="B-QI-001",
                        manufacturing_date="2026-07-01",
                        expiry_date="2027-07-01",
                        rate=Decimal("100"),
                        remarks="Needs QI",
                    ),
                    GRNItemCreate(
                        item_id=item_non_qi.id,
                        ordered_qty=Decimal("20"),
                        received_qty=Decimal("20"),
                        accepted_qty=Decimal("0"),
                        rejected_qty=Decimal("0"),
                        uom_id=uom_id,
                        batch_number="B-NON-002",
                        manufacturing_date="2026-07-01",
                        expiry_date="2027-07-01",
                        rate=Decimal("50"),
                        remarks="Bypasses QI",
                    ),
                ]
            )

            current_user = DummyUser(id=1, username="test_user")
            
            # Run create_grn API handler
            res_grn = await create_grn(payload=grn_payload, db=db, current_user=current_user)
            grn_id = res_grn["id"]
            print(f"Created GRN ID: {grn_id}, Number: {res_grn['grn_number']}")

            # Load the created GRN from DB to verify statuses
            grn_db_res = await db.execute(
                select(GoodsReceiptNote)
                .options(selectinload(GoodsReceiptNote.items).selectinload(GRNItem.item))
                .where(GoodsReceiptNote.id == grn_id)
            )
            grn_db = grn_db_res.scalar_one()

            # Verify GRN Status is 'pending_qi' because it contains a QI item
            assert grn_db.status == "pending_qi", f"Expected GRN status 'pending_qi', got '{grn_db.status}'"
            print("Verified: Mixed GRN status is correctly 'pending_qi'")

            # Verify item-level status and quantities
            item_qi_grn = next(gi for gi in grn_db.items if gi.item_id == item_qi.id)
            item_non_qi_grn = next(gi for gi in grn_db.items if gi.item_id == item_non_qi.id)

            assert item_qi_grn.qi_status == "pending", f"Expected QI item status 'pending', got '{item_qi_grn.qi_status}'"
            assert item_qi_grn.accepted_qty == Decimal("0")
            print("Verified: QI-required item has initial qi_status='pending' and accepted_qty=0")

            assert item_non_qi_grn.qi_status == "accepted", f"Expected non-QI item status 'accepted', got '{item_non_qi_grn.qi_status}'"
            assert item_non_qi_grn.accepted_qty == Decimal("20")
            print("Verified: non-QI item has initial qi_status='accepted' and accepted_qty=20")

            # Check if PutawayOrder was auto-created and contains only the non-QI item
            pa_res = await db.execute(
                select(PutawayOrder)
                .options(selectinload(PutawayOrder.items))
                .where(PutawayOrder.grn_id == grn_id)
            )
            pa = pa_res.scalar_one_or_none()
            assert pa is not None, "Putaway order was not auto-created for non-QI items!"
            assert len(pa.items) == 1, f"Expected 1 item in PutawayOrder, got {len(pa.items)}"
            assert pa.items[0].item_id == item_non_qi.id, "Expected Putaway item to be the non-QI item"
            print("Verified: Putaway Order was auto-created containing only the non-QI item")

            # 4. Try to manually create a PutawayOrder for the QI item before it is accepted
            manual_pa_payload = PutawayCreate(
                grn_id=grn_id,
                warehouse_id=warehouse_id,
                putaway_type="manual",
                assigned_to=1,
                items=[
                    PutawayItemCreate(
                        grn_item_id=item_qi_grn.id,
                        item_id=item_qi.id,
                        qty=Decimal("10"),
                        uom_id=uom_id,
                        batch_id=item_qi_grn.batch_id,
                        suggested_bin_id=None,
                    )
                ]
            )
            try:
                async with db.begin_nested():
                    await create_putaway_order(payload=manual_pa_payload, db=db, current_user=current_user)
                assert False, "Should have raised HTTPException for unaccepted QI item!"
            except HTTPException as ex:
                assert ex.status_code == 400
                assert "requires quality inspection" in ex.detail
                print("Verified: Backend blocked manual Putaway Order creation for unaccepted QI item")

            # 5. Perform Quality Inspection for the QI item
            # Create a mock QualityInspection record
            qi = QualityInspection(
                qi_number="QI-TEST-999",
                grn_id=grn_id,
                inspection_type="sampling",
                inspection_date="2026-07-18",
                overall_result="pass",
                inspected_by=1,
                remarks="Mock inspection",
            )
            db.add(qi)
            await db.flush()

            qi_item = QualityInspectionItem(
                qi_id=qi.id,
                grn_item_id=item_qi_grn.id,
                item_id=item_qi.id,
                inspected_qty=Decimal("10"),
                accepted_qty=Decimal("10"),
                rejected_qty=Decimal("0"),
                hold_qty=Decimal("0"),
                result="accepted",
                rejection_reason="",
                remarks="Accepted",
            )
            db.add(qi_item)
            await db.flush()

            # 5.1 Test editing the Quality Inspection (PUT /quality-inspections/{id})
            from datetime import datetime, timezone
            update_payload = QIUpdate(
                grn_id=grn_id,
                inspection_type="full",
                inspection_date=datetime.now(timezone.utc),
                overall_result="pass",
                status="draft",
                remarks="Updated remarks via test",
                items=[
                    QIItemCreate(
                        grn_item_id=item_qi_grn.id,
                        item_id=item_qi.id,
                        inspected_qty=Decimal("10"),
                        accepted_qty=Decimal("8"),
                        rejected_qty=Decimal("2"),
                        hold_qty=Decimal("0"),
                        result="accepted",
                        rejection_reason="",
                        remarks="Updated line comments",
                    )
                ]
            )
            await update_quality_inspection(qi_id=qi.id, payload=update_payload, db=db, current_user=current_user)

            # Retrieve from DB and verify updates
            db_qi_res = await db.execute(
                select(QualityInspection)
                .options(selectinload(QualityInspection.items))
                .where(QualityInspection.id == qi.id)
            )
            db_qi = db_qi_res.scalar_one_or_none()
            await db.refresh(db_qi, ["items"])
            assert db_qi.remarks == "Updated remarks via test"
            assert db_qi.inspection_type == "full"
            assert len(db_qi.items) == 1
            assert db_qi.items[0].accepted_qty == Decimal("8")
            assert db_qi.items[0].rejected_qty == Decimal("2")
            print("Verified: Quality Inspection edit endpoint successfully updated headers and items")

            # 5.2 Test promoting to status="completed" via update
            complete_payload = QIUpdate(
                grn_id=grn_id,
                inspection_type="full",
                inspection_date=datetime.now(timezone.utc),
                overall_result="pass",
                status="completed",
                remarks="Updated remarks via test",
                items=[
                    QIItemCreate(
                        grn_item_id=item_qi_grn.id,
                        item_id=item_qi.id,
                        inspected_qty=Decimal("10"),
                        accepted_qty=Decimal("10"),
                        rejected_qty=Decimal("0"),
                        hold_qty=Decimal("0"),
                        result="accepted",
                        rejection_reason="",
                        remarks="Final comments",
                    )
                ]
            )
            await update_quality_inspection(qi_id=qi.id, payload=complete_payload, db=db, current_user=current_user)
            print("Verified: Quality Inspection edit endpoint with status='completed' auto-completed and triggered putaway generation")

            # Reload GRN and PutawayOrder
            await db.refresh(grn_db)
            await db.refresh(pa)
            
            # Verify GRN Status is now 'putaway_pending'
            assert grn_db.status == "putaway_pending", f"Expected GRN status 'putaway_pending', got '{grn_db.status}'"
            print("Verified: GRN status transitioned to 'putaway_pending' after QI completion")

            # Verify the Putaway Order now has the QI item appended
            pa_items_res = await db.execute(
                select(PutawayItem).where(PutawayItem.putaway_id == pa.id)
            )
            pa_items = pa_items_res.scalars().all()
            assert len(pa_items) == 2, f"Expected 2 items in PutawayOrder, got {len(pa_items)}"
            
            item_ids_in_pa = {pi.item_id for pi in pa_items}
            assert item_qi.id in item_ids_in_pa, "QI item was not appended to PutawayOrder"
            assert item_non_qi.id in item_ids_in_pa, "Non-QI item went missing from PutawayOrder"
            print("Verified: QI item was successfully appended to the existing Putaway Order")

            print("\n>>> ALL QUALITY INSPECTION WORKFLOW TESTS PASSED SUCCESSFULLY! <<<")
            
            # Rollback to keep database clean
            raise Exception("Force rollback to keep database clean")

if __name__ == "__main__":
    try:
        asyncio.run(run_workflow_test())
    except Exception as e:
        if "Force rollback" in str(e):
            print("\nDatabase transaction rolled back successfully. Database remains clean.")
        else:
            raise e
