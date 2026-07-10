import logging
from decimal import Decimal
from typing import Optional, List, Dict, Any
from fastapi import HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.procurement import (
    MaterialRequest,
    MaterialRequestItem,
    PurchaseOrder,
    PurchaseOrderItem,
)

logger = logging.getLogger(__name__)

async def validate_mr_allocation(
    db: AsyncSession,
    mr_id: int,
    items_to_allocate: List[Any],
    exclude_po_id: Optional[int] = None,
    is_amendment: bool = False,
) -> None:
    """Validate that the new allocation quantities do not exceed the remaining MR quantities,
    considering other active POs (draft, pending_approval, approved, accepted, received, closed)
    as allocations/reservations. Excludes cancelled or rejected POs.
    """
    if not mr_id:
        return

    # Lock MR item rows to prevent race conditions
    mr_items_res = await db.execute(
        select(MaterialRequestItem)
        .where(MaterialRequestItem.mr_id == mr_id)
        .with_for_update()
    )
    mr_items = mr_items_res.scalars().all()
    mr_items_map = {item.item_id: item for item in mr_items}

    # Query sum of qty from other active POs linked to this MR
    query = (
        select(
            PurchaseOrderItem.item_id,
            func.sum(PurchaseOrderItem.qty)
        )
        .join(PurchaseOrder, PurchaseOrderItem.po_id == PurchaseOrder.id)
        .where(
            PurchaseOrder.mr_id == mr_id,
            PurchaseOrder.is_current == True,
            PurchaseOrder.status.notin_(["cancelled", "rejected"])
        )
    )
    if exclude_po_id is not None:
        query = query.where(PurchaseOrder.id != exclude_po_id)
    query = query.group_by(PurchaseOrderItem.item_id)

    other_po_res = await db.execute(query)
    allocated_map = {row[0]: Decimal(str(row[1] or 0)) for row in other_po_res.all()}

    # Validate each item to allocate
    for it in items_to_allocate:
        item_id = getattr(it, "item_id", None) if not isinstance(it, dict) else it.get("item_id")
        qty = Decimal(str(getattr(it, "qty", 0) if not isinstance(it, dict) else it.get("qty", 0)))
        
        if not item_id:
            continue

        mr_item = mr_items_map.get(item_id)
        if not mr_item:
            if is_amendment:
                continue
            raise HTTPException(
                status_code=400,
                detail=f"Item {item_id} is not requested on the linked Material Request.",
            )

        # Skip remaining quantity validation check for PO amendments
        if not is_amendment:
            allocated = allocated_map.get(item_id, Decimal("0"))
            remaining = mr_item.qty - allocated
            if qty > remaining:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Requested PO quantity {qty} for item ID {item_id} exceeds the "
                        f"remaining MR quantity of {remaining} (requested: {mr_item.qty}, already allocated: {allocated})."
                    ),
                )


async def update_mr_ordered_qty_delta(
    db: AsyncSession,
    mr_id: int,
    item_qty_deltas: Dict[int, Decimal],
) -> None:
    """Incrementally update the ordered quantities on a Material Request based on PO events.
    Applies pessimistic row locking on the MR items and re-evaluates the MR status.
    """
    if not mr_id or not item_qty_deltas:
        return

    # Lock MR and MR items to prevent race conditions
    mr_res = await db.execute(
        select(MaterialRequest)
        .where(MaterialRequest.id == mr_id)
        .with_for_update()
    )
    mr = mr_res.scalar_one_or_none()
    if not mr:
        return

    mr_items_res = await db.execute(
        select(MaterialRequestItem)
        .where(MaterialRequestItem.mr_id == mr_id)
        .with_for_update()
    )
    mr_items = mr_items_res.scalars().all()
    mr_items_map = {item.item_id: item for item in mr_items}

    # Update quantities
    for item_id, delta in item_qty_deltas.items():
        mr_item = mr_items_map.get(item_id)
        if mr_item:
            mr_item.ordered_qty = max(Decimal("0"), mr_item.ordered_qty + delta)
            db.add(mr_item)

    # Re-evaluate MR status if it was previously approved/ordered/partially_ordered
    if mr.status in ("approved", "partially_ordered", "ordered"):
        all_ordered = True
        any_ordered = False
        for item in mr_items:
            if item.ordered_qty >= item.qty:
                any_ordered = True
            elif item.ordered_qty > 0:
                any_ordered = True
                all_ordered = False
            else:
                all_ordered = False

        if all_ordered:
            mr.status = "ordered"
        elif any_ordered:
            mr.status = "partially_ordered"
        else:
            mr.status = "approved"
        db.add(mr)

    await db.flush()


async def update_mr_received_qty_delta(
    db: AsyncSession,
    mr_id: int,
    item_qty_deltas: Dict[int, Decimal],
) -> None:
    """Incrementally update the received quantities on a Material Request based on GRN events.
    """
    if not mr_id or not item_qty_deltas:
        return

    # Lock MR item rows
    mr_items_res = await db.execute(
        select(MaterialRequestItem)
        .where(MaterialRequestItem.mr_id == mr_id)
        .with_for_update()
    )
    mr_items = mr_items_res.scalars().all()
    mr_items_map = {item.item_id: item for item in mr_items}

    for item_id, delta in item_qty_deltas.items():
        mr_item = mr_items_map.get(item_id)
        if mr_item:
            mr_item.received_qty = max(Decimal("0"), mr_item.received_qty + delta)
            db.add(mr_item)

    await db.flush()


async def handle_po_approval_qtys(db: AsyncSession, po_id: int) -> None:
    """Calculate and apply the delta quantities when a PO is approved.
    Handles both normal POs and amendments by looking at the parent PO differences.
    """
    po_res = await db.execute(
        select(PurchaseOrder)
        .options(selectinload(PurchaseOrder.items))
        .where(PurchaseOrder.id == po_id)
    )
    po = po_res.scalar_one_or_none()
    if not po or not po.mr_id:
        return

    deltas = {}
    if po.parent_po_id:
        # Fetch parent PO items to calculate differences
        parent_res = await db.execute(
            select(PurchaseOrderItem)
            .where(PurchaseOrderItem.po_id == po.parent_po_id)
        )
        parent_items = parent_res.scalars().all()
        parent_qtys = {item.item_id: item.qty for item in parent_items}

        for item in po.items:
            parent_qty = parent_qtys.get(item.item_id, Decimal("0"))
            deltas[item.item_id] = item.qty - parent_qty
    else:
        # New PO: all items count fully
        for item in po.items:
            deltas[item.item_id] = item.qty

    if deltas:
        await update_mr_ordered_qty_delta(db, po.mr_id, deltas)


async def reconcile_mr_qtys(db: AsyncSession, mr_id: int) -> None:
    """Recalculate entire MR quantities from scratch as an admin/reconciliation tool to fix data drift.
    """
    mr_res = await db.execute(
        select(MaterialRequest)
        .where(MaterialRequest.id == mr_id)
        .with_for_update()
    )
    mr = mr_res.scalar_one_or_none()
    if not mr:
        return

    mr_items_res = await db.execute(
        select(MaterialRequestItem)
        .where(MaterialRequestItem.mr_id == mr_id)
        .with_for_update()
    )
    mr_items = mr_items_res.scalars().all()

    # Sum up all current, non-cancelled, non-rejected PO items
    po_items_res = await db.execute(
        select(
            PurchaseOrderItem.item_id,
            func.sum(PurchaseOrderItem.qty),
            func.sum(PurchaseOrderItem.received_qty)
        )
        .join(PurchaseOrder, PurchaseOrderItem.po_id == PurchaseOrder.id)
        .where(
            PurchaseOrder.mr_id == mr_id,
            PurchaseOrder.is_current == True,
            PurchaseOrder.status.in_(["approved", "accepted", "partially_received", "received", "closed"])
        )
        .group_by(PurchaseOrderItem.item_id)
    )

    po_qty_map = {}
    po_received_map = {}
    for row in po_items_res.all():
        item_id = row[0]
        po_qty_map[item_id] = Decimal(str(row[1] or 0))
        po_received_map[item_id] = Decimal(str(row[2] or 0))

    for item in mr_items:
        item.ordered_qty = po_qty_map.get(item.item_id, Decimal("0"))
        item.received_qty = po_received_map.get(item.item_id, Decimal("0"))
        db.add(item)

    # Reset status
    if mr.status in ("approved", "partially_ordered", "ordered"):
        all_ordered = True
        any_ordered = False
        for item in mr_items:
            if item.ordered_qty >= item.qty:
                any_ordered = True
            elif item.ordered_qty > 0:
                any_ordered = True
                all_ordered = False
            else:
                all_ordered = False

        if all_ordered:
            mr.status = "ordered"
        elif any_ordered:
            mr.status = "partially_ordered"
        else:
            mr.status = "approved"
        db.add(mr)

    await db.flush()
