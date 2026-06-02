from datetime import datetime, timezone
from decimal import Decimal
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.logistics import LogisticsMainDispatchOrder, LogisticsDispatchMaterial
from app.models.issue import MaterialIssue, MaterialIssueItem
from app.models.indent import Indent, IndentItem, IndentAcknowledgement, IndentAcknowledgementItem
from app.models.system import ActivityLog


async def auto_acknowledge_scm_dispatch(db: AsyncSession, mdo_id: int, current_user_id: int) -> None:
    """Automatically merges SCM Logistics status updates with Warehouse and Indent modules.
    Sets the linked Material Issue to 'acknowledged' and creates a completed IndentAcknowledgement.
    """
    try:
        # 1. Fetch Logistics Main Dispatch Order
        res_m = await db.execute(
            select(LogisticsMainDispatchOrder)
            .options(
                selectinload(LogisticsMainDispatchOrder.sdos).selectinload(
                    LogisticsMainDispatchOrder.sdos.property.mapper.class_.materials
                )
            )
            .where(LogisticsMainDispatchOrder.id == mdo_id)
        )
        mdo = res_m.scalar_one_or_none()
        if not mdo:
            print(f"[SCM Integration] MDO {mdo_id} not found.")
            return

        print(f"[SCM Integration] Beginning auto-acknowledgement for Dispatch Plan {mdo.mdo_number}")

        # 2. Acknowledge the linked Material Issue
        if mdo.material_issue_id:
            res_mi = await db.execute(
                select(MaterialIssue).where(MaterialIssue.id == mdo.material_issue_id)
            )
            mi = res_mi.scalar_one_or_none()
            if mi and mi.status not in ("acknowledged", "completed"):
                mi.status = "acknowledged"
                db.add(mi)
                print(f"[SCM Integration] Material Issue {mi.issue_number} set to status 'acknowledged'")

        # 3. Generate Indent Receipt Acknowledgement
        if mdo.indent_id:
            # Check if there is already an ack for this specific dispatch/MDO to avoid duplicates
            res_ack = await db.execute(
                select(IndentAcknowledgement)
                .where(IndentAcknowledgement.indent_id == mdo.indent_id)
                .where(IndentAcknowledgement.remarks.like(f"%{mdo.mdo_number}%"))
            )
            if res_ack.scalar_one_or_none() is not None:
                print(f"[SCM Integration] Indent {mdo.indent_id} already has an acknowledgement for MDO {mdo.mdo_number}.")
                return

            res_ind = await db.execute(
                select(Indent)
                .options(selectinload(Indent.items))
                .where(Indent.id == mdo.indent_id)
            )
            indent = res_ind.scalar_one_or_none()
            if not indent:
                print(f"[SCM Integration] Indent {mdo.indent_id} not found.")
                return

            # Extract dispatched quantities to auto-receive
            shipped_qtys = {}
            for sdo in mdo.sdos:
                for mat in sdo.materials:
                    shipped_qtys[mat.material_id] = shipped_qtys.get(mat.material_id, 0.0) + float(mat.quantity)

            # Fallback to Material Issue items if SDO materials list is empty
            if not shipped_qtys and mdo.material_issue_id:
                res_mi_items = await db.execute(
                    select(MaterialIssueItem).where(MaterialIssueItem.issue_id == mdo.material_issue_id)
                )
                for mi_item in res_mi_items.scalars().all():
                    shipped_qtys[mi_item.item_id] = shipped_qtys.get(mi_item.item_id, 0.0) + float(mi_item.qty)

            if not shipped_qtys:
                # Direct fallback to indent items approved quantities
                for ind_item in indent.items:
                    target_qty = float(ind_item.approved_qty or ind_item.requested_qty or 0)
                    shipped_qtys[ind_item.item_id] = target_qty

            total_received_qty = sum(shipped_qtys.values())

            # Create IndentAcknowledgement header
            ack = IndentAcknowledgement(
                indent_id=mdo.indent_id,
                acknowledged_by=current_user_id,
                acknowledged_at=datetime.now(timezone.utc),
                received_qty=Decimal(str(total_received_qty)),
                status="completed",
                remarks=f"Auto-acknowledged via SCM logistics dispatch delivery for {mdo.mdo_number}.",
                scan_timestamp=datetime.now(timezone.utc)
            )
            db.add(ack)
            await db.flush()

            # Create IndentAcknowledgementItem lines and determine parent indent fulfillment status
            from sqlalchemy import func
            all_items_fully_acknowledged = True
            
            for ind_item in indent.items:
                qty_to_ack = shipped_qtys.get(ind_item.item_id, 0.0)

                # Fetch past acknowledged quantity for this item in database to calculate total acknowledged qty
                from app.models.indent import IndentAcknowledgementItem as _IAI
                past_ack_res = await db.execute(
                    select(func.sum(_IAI.received_qty))
                    .where(_IAI.indent_item_id == ind_item.id)
                )
                past_ack = float(past_ack_res.scalar() or 0.0)
                
                approved_qty = float(ind_item.approved_qty if ind_item.approved_qty is not None else (ind_item.requested_qty or 0))
                total_acked_for_item = past_ack + qty_to_ack

                # Only add acknowledgement item line if we actually received some quantity in this event
                if qty_to_ack > 0:
                    ack_item = IndentAcknowledgementItem(
                        acknowledgement_id=ack.id,
                        indent_item_id=ind_item.id,
                        item_id=ind_item.item_id,
                        received_qty=Decimal(str(qty_to_ack)),
                        remarks="Auto-received from logistics dispatch."
                    )
                    db.add(ack_item)

                # Set individual line-level fulfillment status based on whether it is fully received
                if total_acked_for_item >= approved_qty:
                    ind_item.fulfillment_status = "acknowledged"
                else:
                    ind_item.fulfillment_status = "delivered"
                    all_items_fully_acknowledged = False
                db.add(ind_item)

            # Mark Parent Indent Status accordingly
            if all_items_fully_acknowledged:
                indent.status = "fulfilled"
                print(f"[SCM Integration] Indent {indent.indent_number} successfully set to status 'fulfilled'")
            else:
                indent.status = "partially_fulfilled"
                print(f"[SCM Integration] Indent {indent.indent_number} set to status 'partially_fulfilled'")
            db.add(indent)

            # 4. Log SCM Merge Event to Activity Logs
            db.add(
                ActivityLog(
                    user_id=current_user_id,
                    module="logistics",
                    action="auto_acknowledge",
                    entity_type="dispatch",
                    entity_id=mdo_id,
                    description=(
                        f"SCM auto-merge executed: Acknowledged Dispatch {mdo.mdo_number}, "
                        f"Material Issue {mdo.material_issue_id or 'N/A'}, and fulfilled Indent {indent.indent_number}."
                    )
                )
            )

    except Exception as e:
        # Safe catch to ensure core logistics operations are never blocked by secondary auto-merging
        import logging
        logging.getLogger(__name__).exception("Failed to execute SCM auto-acknowledgement merge.")
