import asyncio
import os
import sys
from decimal import Decimal
from datetime import datetime

# Add parent dir to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import select, delete
from app.database import AsyncSessionLocal
from app.models.indent import Indent, IndentItem
from app.models.user import User
from app.models.approval import ApprovalRequest
from app.api.v1.indent import get_indent, approve_indent, ApproveIndentPayload
from app.api.v1.approval import process_action, ApprovalActionRequest, ApprovalItemOverride, _fetch_document_detail
from app.services.indent_lifecycle import on_indent_approved

async def main():
    async with AsyncSessionLocal() as db:
        print("Starting test...")
        
        # Clean up any leftover ID 99999 first
        await db.execute(delete(IndentItem).where(IndentItem.id == 99999))
        await db.execute(delete(Indent).where(Indent.id == 99999))
        await db.execute(delete(ApprovalRequest).where(ApprovalRequest.id == 99999))
        from app.models.approval import ApprovalWorkflow
        await db.execute(delete(ApprovalWorkflow).where(ApprovalWorkflow.id == 99999))
        await db.commit()
        
        # Query existing Project, Warehouse, Item, UOM to satisfy FKs
        from app.models.user import Project
        from app.models.warehouse import Warehouse
        from app.models.inventory_master import Item, UOM
        
        proj_res = await db.execute(select(Project))
        proj = proj_res.scalars().first()
        if not proj:
            print("No Project found in database. Cannot run test.")
            return
            
        wh_res = await db.execute(select(Warehouse))
        wh = wh_res.scalars().first()
        if not wh:
            print("No Warehouse found in database. Cannot run test.")
            return
            
        item_res = await db.execute(select(Item))
        db_item = item_res.scalars().first()
        if not db_item:
            print("No Item found in database. Cannot run test.")
            return
            
        uom_res = await db.execute(select(UOM))
        uom = uom_res.scalars().first()
        if not uom:
            print("No UOM found in database. Cannot run test.")
            return

        # 1. Fetch an existing user
        user_res = await db.execute(select(User))
        user = user_res.scalars().first()
        if not user:
            print("No User found in database. Cannot run test.")
            return
        
        # 2. Create a mock indent in the database
        indent = Indent(
            id=99999,
            indent_number="IND-TEST-99999",
            project_id=proj.id,
            warehouse_id=wh.id,
            indent_date=datetime.now(),
            status="pending_approval",
            raised_by=user.id,
        )
        db.add(indent)
        
        item = IndentItem(
            id=99999,
            indent_id=99999,
            item_id=db_item.id,
            requested_qty=Decimal("10.0"),
            approved_qty=None,
            uom_id=uom.id,
        )
        db.add(item)
        
        # Fetch or create a workflow dynamically to satisfy FK
        from app.models.approval import ApprovalWorkflow
        wf_res = await db.execute(select(ApprovalWorkflow))
        wf = wf_res.scalars().first()
        created_wf = False
        if not wf:
            wf = ApprovalWorkflow(id=99999, name="Test Workflow", document_type="indent", is_active=True)
            db.add(wf)
            await db.flush()
            created_wf = True
        workflow_id = wf.id

        # Create an approval request for the indent
        ar = ApprovalRequest(
            id=99999,
            document_type="indent",
            document_id=99999,
            status="pending",
            workflow_id=workflow_id,
            current_level=1,
            requested_by=user.id,
        )
        db.add(ar)
        
        await db.commit()
        print("Indent and ApprovalRequest inserted successfully.")
        
        try:
            # 3. Simulate L1 approval with override of 8.0
            print("Simulating L1 approval override to 8.0...")
            payload = ApprovalActionRequest(
                action="approved",
                comments="Approved by L1",
                item_overrides=[
                    ApprovalItemOverride(item_id=99999, approved_qty=8.0)
                ]
            )
            
            # Call process_action to apply overrides and advance level
            # We bypass the dependency checks for this unit test
            from app.api.v1.approval import _apply_indent_qty_overrides, process_approval_action
            await _apply_indent_qty_overrides(db, 99999, payload.item_overrides)
            request = await process_approval_action(db, 99999, "approved", user.id, "L1 Approved")
            await db.commit()
            
            # Verify database has approved_qty = 8.0
            res = await db.execute(select(IndentItem).where(IndentItem.id == 99999))
            item_db = res.scalar_one()
            print(f"L1 approved_qty in DB: {item_db.approved_qty}")
            assert item_db.approved_qty == Decimal("8.0"), f"Expected 8.0, got {item_db.approved_qty}"
            
            # 4. Simulate fetching details for L2.
            # Verify _fetch_document_detail returns approved_qty = 8.0
            doc_detail = await _fetch_document_detail(db, "indent", 99999)
            print(f"Fetched details for next level: {doc_detail}")
            assert doc_detail is not None, "Expected doc details"
            assert doc_detail["items"][0]["approved_qty"] == 8.0, f"Expected L2 to see approved_qty 8.0, got {doc_detail['items'][0].get('approved_qty')}"
            
            # 5. Simulate L2 approval with override of 7.0
            print("Simulating L2 approval override to 7.0...")
            # We recreate the approval request as pending for level 2
            ar2_res = await db.execute(select(ApprovalRequest).where(ApprovalRequest.id == 99999))
            ar2 = ar2_res.scalar_one()
            ar2.status = "pending"
            ar2.current_level = 2
            await db.commit()
            
            payload2 = ApprovalActionRequest(
                action="approved",
                comments="Approved by L2",
                item_overrides=[
                    ApprovalItemOverride(item_id=99999, approved_qty=7.0)
                ]
            )
            await _apply_indent_qty_overrides(db, 99999, payload2.item_overrides)
            # Finish approval
            request = await process_approval_action(db, 99999, "approved", user.id, "L2 Approved")
            await db.commit()
            
            # Verify database has approved_qty = 7.0
            res = await db.execute(select(IndentItem).where(IndentItem.id == 99999))
            item_db = res.scalar_one()
            print(f"L2 approved_qty in DB: {item_db.approved_qty}")
            assert item_db.approved_qty == Decimal("7.0"), f"Expected 7.0, got {item_db.approved_qty}"
            
            # NOTE: on_indent_approved() is already called internally by process_approval_action
            # when the final workflow level approves. No need to call it again.
            # Verify approved_qty remains 7.0 (not reset to requested_qty=10.0)
            res = await db.execute(select(IndentItem).where(IndentItem.id == 99999))
            item_db = res.scalar_one()
            print(f"Final approved_qty in DB: {item_db.approved_qty}")
            assert item_db.approved_qty == Decimal("7.0"), f"Expected final approved_qty=7.0 (multi-level preserved), got {item_db.approved_qty}"
            
            # 7. Verify get_indent API response includes issue_remaining_qty as 7.0
            indent_res = await get_indent(indent_id=99999, db=db, current_user=user)
            items_res = indent_res.get("items", [])
            print(f"get_indent response items: {items_res}")
            assert len(items_res) > 0
            assert items_res[0]["issue_remaining_qty"] == 7.0, f"Expected remaining qty 7.0, got {items_res[0]['issue_remaining_qty']}"
            
            print("ALL VERIFICATIONS PASSED SUCCESSFULLY!")
            
        finally:
            # Clean up database
            print("Cleaning up database...")
            await db.execute(delete(IndentItem).where(IndentItem.id == 99999))
            await db.execute(delete(Indent).where(Indent.id == 99999))
            await db.execute(delete(ApprovalRequest).where(ApprovalRequest.id == 99999))
            if created_wf:
                await db.execute(delete(ApprovalWorkflow).where(ApprovalWorkflow.id == 99999))
            await db.commit()
            print("Database cleaned up.")

if __name__ == "__main__":
    asyncio.run(main())
