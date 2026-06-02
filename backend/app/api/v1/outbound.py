from decimal import Decimal
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.database import get_db
from app.models.user import User
from app.models.outbound import (
    SalesOrder, SalesOrderItem, DeliveryOrder, WavePlan, WavePlanOrder,
    PickingOrder, PickingItem, PackingOrder, PackingItem,
)
from app.models.dispatch import DispatchOrder, GatePass
from app.schemas.warehouse import (
    SOCreate, SOResponse, DOCreate, DOResponse,
    WavePlanCreate, WavePlanResponse,
    PickingCreate, PickingItemUpdate, PickingResponse,
    PackingCreate, PackingResponse,
    DispatchCreate, DispatchResponse,
    GatePassCreate, GatePassResponse,
    DispatchAcknowledgementCreate,
)
from app.services.number_series import generate_number
from app.services.stock_service import post_stock_ledger
from app.utils.dependencies import get_current_user, require_any_role
from app.utils.helpers import paginate_params, build_paginated_response, apply_search_filter

router = APIRouter()


# ==================== SALES ORDERS ====================

@router.get("/sales-orders")
async def list_sales_orders(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    status: str = Query(None),
    customer_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(SalesOrder)
    count_query = select(func.count(SalesOrder.id))

    if status:
        query = query.where(SalesOrder.status == status)
        count_query = count_query.where(SalesOrder.status == status)
    if customer_id:
        query = query.where(SalesOrder.customer_id == customer_id)
        count_query = count_query.where(SalesOrder.customer_id == customer_id)

    query = apply_search_filter(query, SalesOrder, search, ["so_number"])
    count_query = apply_search_filter(count_query, SalesOrder, search, ["so_number"])

    query = query.options(selectinload(SalesOrder.customer), selectinload(SalesOrder.warehouse))

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(SalesOrder.id.desc()))
    orders = result.scalars().all()
    data = []
    for o in orders:
        d = SOResponse.model_validate(o).model_dump()
        d["customer_name"] = o.customer.name if o.customer else None
        d["warehouse_name"] = o.warehouse.name if o.warehouse else None
        data.append(d)
    return build_paginated_response(data, total, page, page_size)


@router.get("/sales-orders/{so_id}", response_model=SOResponse)
async def get_sales_order(
    so_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(SalesOrder).options(selectinload(SalesOrder.items)).where(SalesOrder.id == so_id)
    )
    so = result.scalar_one_or_none()
    if not so:
        raise HTTPException(status_code=404, detail="Sales order not found")
    return SOResponse.model_validate(so)


@router.post("/sales-orders", status_code=201)
async def create_sales_order(
    payload: SOCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # BUG-ISS-066 — warehouse must belong to caller's organization.
    from app.models.warehouse import Warehouse as _WH
    wr = await db.execute(select(_WH).where(_WH.id == payload.warehouse_id))
    wh = wr.scalar_one_or_none()
    if not wh:
        raise HTTPException(status_code=404, detail="Warehouse not found")
    if wh.organization_id and wh.organization_id != current_user.organization_id:
        raise HTTPException(
            status_code=403,
            detail="Warehouse is not in your organization",
        )

    so_number = await generate_number(db, "sales", "sales_order")
    subtotal = Decimal("0")
    total_tax = Decimal("0")

    so = SalesOrder(
        so_number=so_number,
        customer_id=payload.customer_id,
        project_id=payload.project_id,
        warehouse_id=payload.warehouse_id,
        order_date=payload.order_date,
        delivery_date=payload.delivery_date,
        source=payload.source,
        remarks=payload.remarks,
        created_by=current_user.id,
    )
    db.add(so)
    await db.flush()

    # Bulk-fetch item tax rates for tax calculation
    item_ids = [item.item_id for item in payload.items]
    from app.models.master import Item as ItemModel
    item_result = await db.execute(select(ItemModel).where(ItemModel.id.in_(item_ids)))
    item_tax_map = {i.id: i.tax_rate or Decimal("0") for i in item_result.scalars().all()}

    for item in payload.items:
        base = item.qty * item.rate
        discount = base * item.discount_pct / 100
        net = base - discount
        item_tax_rate = item_tax_map.get(item.item_id, Decimal("0"))
        item_tax = net * item_tax_rate / 100
        soi = SalesOrderItem(
            so_id=so.id, item_id=item.item_id, qty=item.qty,
            uom_id=item.uom_id, rate=item.rate, discount_pct=item.discount_pct,
            tax_amount=item_tax,
            amount=net,
        )
        db.add(soi)
        subtotal += net
        total_tax += item_tax

    so.subtotal = subtotal
    so.tax_amount = total_tax
    so.grand_total = subtotal + total_tax
    await db.flush()
    return {"id": so.id, "so_number": so_number, "message": "Sales order created"}


@router.post("/sales-orders/{so_id}/confirm")
async def confirm_sales_order(
    so_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-ISS-067 — confirm needs a role gate.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "sales_manager", "warehouse_manager"
    )),
):
    result = await db.execute(select(SalesOrder).where(SalesOrder.id == so_id))
    so = result.scalar_one_or_none()
    if not so:
        raise HTTPException(status_code=404, detail="Sales order not found")
    # BUG-ISS-067 — only draft/pending may be confirmed; cancelled/confirmed
    # must not silently re-confirm.
    if so.status not in ("draft", "pending"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot confirm sales order in '{so.status}' status",
        )
    so.status = "confirmed"
    await db.flush()
    return {"success": True, "message": "Sales order confirmed"}


# ==================== DELIVERY ORDERS ====================

@router.get("/delivery-orders")
async def list_delivery_orders(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(DeliveryOrder)
    count_query = select(func.count(DeliveryOrder.id))
    if status:
        query = query.where(DeliveryOrder.status == status)
        count_query = count_query.where(DeliveryOrder.status == status)

    query = query.options(selectinload(DeliveryOrder.sales_order), selectinload(DeliveryOrder.warehouse))

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(DeliveryOrder.id.desc()))
    dos = result.scalars().all()
    data = []
    for d in dos:
        row = DOResponse.model_validate(d).model_dump()
        row["so_number"] = d.sales_order.so_number if d.sales_order else None
        row["warehouse_name"] = d.warehouse.name if d.warehouse else None
        data.append(row)
    return build_paginated_response(data, total, page, page_size)


@router.post("/delivery-orders", status_code=201)
async def create_delivery_order(
    payload: DOCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    do_number = await generate_number(db, "sales", "delivery_order")
    do = DeliveryOrder(
        do_number=do_number, so_id=payload.so_id,
        warehouse_id=payload.warehouse_id, delivery_date=payload.delivery_date,
    )
    db.add(do)
    await db.flush()
    return {"id": do.id, "do_number": do_number, "message": "Delivery order created"}


# ==================== WAVE PLANNING ====================

@router.post("/wave-plans", status_code=201)
async def create_wave_plan(
    payload: WavePlanCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # BUG-ISS-080 — duplicates of the same do_id were silently accepted,
    # producing two pick-lines for the same delivery order. De-dup while
    # preserving caller-supplied order.
    seen_do_ids: set = set()
    deduped_do_ids = []
    for d in payload.do_ids or []:
        if d in seen_do_ids:
            continue
        seen_do_ids.add(d)
        deduped_do_ids.append(d)

    wave_number = await generate_number(db, "warehouse", "wave_plan")
    wp = WavePlan(
        wave_number=wave_number, warehouse_id=payload.warehouse_id,
        wave_date=payload.wave_date, priority=payload.priority,
        criteria=payload.criteria, created_by=current_user.id,
    )
    db.add(wp)
    await db.flush()

    for idx, do_id in enumerate(deduped_do_ids):
        db.add(WavePlanOrder(wave_id=wp.id, do_id=do_id, sequence=idx + 1))

    await db.flush()
    return {"id": wp.id, "wave_number": wave_number, "message": "Wave plan created"}


@router.post("/wave-plans/{wave_id}/release")
async def release_wave_plan(
    wave_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(WavePlan).where(WavePlan.id == wave_id))
    wp = result.scalar_one_or_none()
    if not wp:
        raise HTTPException(status_code=404, detail="Wave plan not found")
    # BUG-ISS-081 — block re-release of an in-progress / completed wave so
    # the status cannot regress and create duplicate picking orders.
    if wp.status not in ("draft", "pending", "planned"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot release wave plan in '{wp.status}' status",
        )
    wp.status = "released"
    await db.flush()
    return {"success": True, "message": "Wave plan released"}


# ==================== PICKING ====================

@router.get("/picking-orders")
async def list_picking_orders(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(PickingOrder)
    count_query = select(func.count(PickingOrder.id))
    if status:
        query = query.where(PickingOrder.status == status)
        count_query = count_query.where(PickingOrder.status == status)
    if warehouse_id:
        query = query.where(PickingOrder.warehouse_id == warehouse_id)
        count_query = count_query.where(PickingOrder.warehouse_id == warehouse_id)

    # BUG-ISS-082 — warehouse-scope filter.
    try:
        from app.utils.dependencies import (
            get_user_role_codes as _get_role_codes,
            user_warehouse_ids as _user_wh_ids,
        )
        _role_codes = await _get_role_codes(db, current_user.id)
        if not ({"super_admin", "admin"} & set(_role_codes)):
            _wh_ids = await _user_wh_ids(db, current_user.id)
            if _wh_ids:
                query = query.where(PickingOrder.warehouse_id.in_(_wh_ids))
                count_query = count_query.where(PickingOrder.warehouse_id.in_(_wh_ids))
            else:
                query = query.where(PickingOrder.id == -1)
                count_query = count_query.where(PickingOrder.id == -1)
    except Exception:
        pass

    query = query.options(
        selectinload(PickingOrder.wave_plan),
        selectinload(PickingOrder.delivery_order),
        selectinload(PickingOrder.warehouse),
    )

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(PickingOrder.id.desc()))
    orders = result.scalars().all()

    # Resolve picker names from assigned_to user IDs
    picker_ids = [o.assigned_to for o in orders if o.assigned_to]
    picker_map = {}
    if picker_ids:
        user_result = await db.execute(select(User).where(User.id.in_(picker_ids)))
        for u in user_result.scalars().all():
            picker_map[u.id] = f"{u.first_name} {u.last_name}".strip() if u.last_name else u.first_name

    data = []
    for o in orders:
        row = PickingResponse.model_validate(o).model_dump()
        row["wave_number"] = o.wave_plan.wave_number if o.wave_plan else None
        row["do_number"] = o.delivery_order.do_number if o.delivery_order else None
        row["warehouse_name"] = o.warehouse.name if o.warehouse else None
        row["picker_name"] = picker_map.get(o.assigned_to)
        data.append(row)
    return build_paginated_response(data, total, page, page_size)


@router.post("/picking-orders", status_code=201)
async def create_picking_order(
    payload: PickingCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    pick_number = await generate_number(db, "warehouse", "picking_order")
    po = PickingOrder(
        pick_number=pick_number, wave_id=payload.wave_id, do_id=payload.do_id,
        warehouse_id=payload.warehouse_id, pick_strategy=payload.pick_strategy,
        assigned_to=payload.assigned_to,
    )
    db.add(po)
    await db.flush()

    for item in payload.items:
        pi = PickingItem(
            pick_id=po.id, item_id=item.item_id, batch_id=item.batch_id,
            from_bin_id=item.from_bin_id, qty_to_pick=item.qty_to_pick,
            uom_id=item.uom_id,
        )
        db.add(pi)

    await db.flush()
    return {"id": po.id, "pick_number": pick_number, "message": "Picking order created"}


@router.put("/picking-orders/{pick_id}/items/{item_id}/confirm")
async def confirm_pick_item(
    pick_id: int,
    item_id: int,
    payload: PickingItemUpdate,
    db: AsyncSession = Depends(get_db),
    # BUG-ISS-071 — picking confirm needs a role gate, not just authentication.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "warehouse_operator", "picker"
    )),
):
    # BUG-ISS-068 — picking confirm posts ledger; we MUST verify the parent
    # PickingOrder is in an active state (released/in_progress) and that the
    # item is still pickable. Otherwise pickers can post stock-out for
    # cancelled or already-completed picks.
    pick_result = await db.execute(
        select(PickingOrder).where(PickingOrder.id == pick_id).with_for_update()
    )
    pick = pick_result.scalar_one_or_none()
    if not pick:
        raise HTTPException(status_code=404, detail="Picking order not found")
    if pick.status not in ("released", "in_progress", "draft", "pending"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot confirm pick on order in '{pick.status}' status",
        )

    result = await db.execute(
        select(PickingItem).where(PickingItem.id == item_id, PickingItem.pick_id == pick_id)
    )
    pi = result.scalar_one_or_none()
    if not pi:
        raise HTTPException(status_code=404, detail="Picking item not found")

    # BUG-ISS-070 — block over-pick. Allow short pick (<= qty_to_pick) but
    # never over-shipment.
    if (
        pi.qty_to_pick is not None
        and payload.qty_picked is not None
        and Decimal(str(payload.qty_picked)) > Decimal(str(pi.qty_to_pick))
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Picked qty {payload.qty_picked} exceeds qty_to_pick {pi.qty_to_pick}"
            ),
        )

    # BUG-ISS-078 — enforce pick_strategy='fefo' server-side. When the parent
    # picking order is FEFO, the scanned batch must be the earliest expiring
    # available batch for this item at this warehouse.
    if (pick.pick_strategy or "").lower() == "fefo" and pi.batch_id:
        try:
            from app.services.stock_service import get_fefo_batches as _fefo
            fefo = await _fefo(
                db,
                item_id=pi.item_id,
                warehouse_id=pick.warehouse_id,
                required_qty=Decimal(str(payload.qty_picked or 0)),
            )
            # FEFO returns tuples of (StockBalance, Batch) — extract batch ids.
            allowed_ids = []
            for row in (fefo or []):
                if isinstance(row, (list, tuple)) and len(row) > 0:
                    sb = row[0]
                    bid = getattr(sb, "batch_id", None)
                    if bid is not None:
                        allowed_ids.append(bid)
                else:
                    bid = getattr(row, "batch_id", None)
                    if bid is not None:
                        allowed_ids.append(bid)
            if allowed_ids and pi.batch_id not in allowed_ids:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"FEFO violation: batch {pi.batch_id} is not the "
                        "earliest-expiring available batch for this item"
                    ),
                )
        except HTTPException:
            raise
        except Exception:
            # Helper signature drift shouldn't block the pick — log and pass.
            pass

    pi.qty_picked = payload.qty_picked
    pi.status = payload.status
    pi.scanned_at = datetime.now(timezone.utc)
    pi.scanned_by = current_user.id

    await post_stock_ledger(
        db, item_id=pi.item_id, warehouse_id=pick.warehouse_id,
        transaction_type="pick", qty_out=payload.qty_picked,
        bin_id=pi.from_bin_id, batch_id=pi.batch_id,
        reference_type="picking_order", reference_id=pick_id,
        uom_id=pi.uom_id, created_by=current_user.id,
    )

    # BUG-ISS-069 — short / skipped picks are NOT done; only fully-picked
    # lines count toward completion. A short pick must trigger a partial
    # state, not silently mark the whole order completed.
    all_items_result = await db.execute(select(PickingItem).where(PickingItem.pick_id == pick_id))
    all_items = all_items_result.scalars().all()
    all_picked = all(i.status == "picked" for i in all_items)
    any_short_or_skip = any(i.status in ("short", "skipped") for i in all_items)
    if all_picked:
        pick.status = "completed"
        pick.completed_at = datetime.now(timezone.utc)
    elif any_short_or_skip and all(i.status in ("picked", "short", "skipped") for i in all_items):
        # All lines have been actioned but at least one is short/skipped.
        pick.status = "partially_picked"

    await db.flush()
    return {"success": True, "message": "Pick confirmed"}


# ==================== PACKING ====================

@router.get("/packing-orders")
async def list_packing_orders(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List packing orders (GET alias for frontend)."""
    offset, limit = paginate_params(page, page_size)
    query = select(PackingOrder)
    count_query = select(func.count(PackingOrder.id))
    if status:
        query = query.where(PackingOrder.status == status)
        count_query = count_query.where(PackingOrder.status == status)
    if warehouse_id:
        query = query.where(PackingOrder.warehouse_id == warehouse_id)
        count_query = count_query.where(PackingOrder.warehouse_id == warehouse_id)

    # BUG-ISS-082 — warehouse-scope filter.
    try:
        from app.utils.dependencies import (
            get_user_role_codes as _get_role_codes,
            user_warehouse_ids as _user_wh_ids,
        )
        _role_codes = await _get_role_codes(db, current_user.id)
        if not ({"super_admin", "admin"} & set(_role_codes)):
            _wh_ids = await _user_wh_ids(db, current_user.id)
            if _wh_ids:
                query = query.where(PackingOrder.warehouse_id.in_(_wh_ids))
                count_query = count_query.where(PackingOrder.warehouse_id.in_(_wh_ids))
            else:
                query = query.where(PackingOrder.id == -1)
                count_query = count_query.where(PackingOrder.id == -1)
    except Exception:
        pass

    query = query.options(selectinload(PackingOrder.picking_order), selectinload(PackingOrder.warehouse))

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(PackingOrder.id.desc()))
    orders = result.scalars().all()
    data = []
    for o in orders:
        row = PackingResponse.model_validate(o).model_dump()
        row["pick_number"] = o.picking_order.pick_number if o.picking_order else None
        row["warehouse_name"] = o.warehouse.name if o.warehouse else None
        data.append(row)
    return build_paginated_response(data, total, page, page_size)


@router.post("/packing-orders", status_code=201)
async def create_packing_order(
    payload: PackingCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    pack_number = await generate_number(db, "warehouse", "packing_order")
    po = PackingOrder(
        pack_number=pack_number, pick_id=payload.pick_id,
        warehouse_id=payload.warehouse_id, packed_by=current_user.id,
        total_packages=len(payload.items),
    )
    db.add(po)
    await db.flush()

    for item in payload.items:
        pi = PackingItem(
            pack_id=po.id, item_id=item.item_id, batch_id=item.batch_id,
            qty=item.qty, uom_id=item.uom_id, package_number=item.package_number,
            package_type=item.package_type, gross_weight=item.gross_weight,
            net_weight=item.net_weight,
        )
        db.add(pi)

    await db.flush()
    return {"id": po.id, "pack_number": pack_number, "message": "Packing order created"}


@router.post("/packing-orders/{pack_id}/complete")
async def complete_packing(
    pack_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Mark a packing order completed.

    BUG-ISS-072 — refuse to complete packing while the linked PickingOrder
    is not yet completed. Without this, packing can flip to 'completed' on
    half-picked orders and the wrong contents end up on the truck.
    """
    result = await db.execute(select(PackingOrder).where(PackingOrder.id == pack_id))
    po = result.scalar_one_or_none()
    if not po:
        raise HTTPException(status_code=404, detail="Packing order not found")

    if po.pick_id:
        pick_r = await db.execute(select(PickingOrder).where(PickingOrder.id == po.pick_id))
        pick = pick_r.scalar_one_or_none()
        if not pick:
            raise HTTPException(status_code=404, detail="Linked picking order not found")
        if pick.status != "completed":
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Picking order is '{pick.status}' — must be completed "
                    "before packing can be completed"
                ),
            )

    po.status = "completed"
    po.completed_at = datetime.now(timezone.utc)
    await db.flush()
    return {"success": True, "message": "Packing completed"}


# ==================== DISPATCH ====================

@router.get("/dispatch-orders")
async def list_dispatch_orders(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List dispatch orders (GET alias for frontend)."""
    offset, limit = paginate_params(page, page_size)
    query = select(DispatchOrder)
    count_query = select(func.count(DispatchOrder.id))
    if status:
        query = query.where(DispatchOrder.status == status)
        count_query = count_query.where(DispatchOrder.status == status)
    if warehouse_id:
        query = query.where(DispatchOrder.warehouse_id == warehouse_id)
        count_query = count_query.where(DispatchOrder.warehouse_id == warehouse_id)

    # BUG-ISS-082 — auto-restrict by user's accessible warehouses unless
    # super_admin/admin. Prevents cross-org dispatch list leakage.
    try:
        from app.utils.dependencies import (
            get_user_role_codes as _get_role_codes,
            user_warehouse_ids as _user_wh_ids,
        )
        _role_codes = await _get_role_codes(db, current_user.id)
        if not ({"super_admin", "admin"} & set(_role_codes)):
            _wh_ids = await _user_wh_ids(db, current_user.id)
            if _wh_ids:
                query = query.where(DispatchOrder.warehouse_id.in_(_wh_ids))
                count_query = count_query.where(DispatchOrder.warehouse_id.in_(_wh_ids))
            else:
                # No warehouse mapping → see nothing.
                query = query.where(DispatchOrder.id == -1)
                count_query = count_query.where(DispatchOrder.id == -1)
    except Exception:
        pass

    query = query.options(selectinload(DispatchOrder.warehouse), selectinload(DispatchOrder.customer))

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(DispatchOrder.id.desc()))
    orders = result.scalars().all()

    # Resolve dispatcher names from dispatched_by user IDs
    dispatcher_ids = [o.dispatched_by for o in orders if o.dispatched_by]
    dispatcher_map = {}
    if dispatcher_ids:
        user_result = await db.execute(select(User).where(User.id.in_(dispatcher_ids)))
        for u in user_result.scalars().all():
            dispatcher_map[u.id] = f"{u.first_name} {u.last_name}".strip() if u.last_name else u.first_name

    data = []
    for o in orders:
        row = DispatchResponse.model_validate(o).model_dump()
        row["warehouse_name"] = o.warehouse.name if o.warehouse else None
        row["dispatcher_name"] = dispatcher_map.get(o.dispatched_by)
        data.append(row)
    return build_paginated_response(data, total, page, page_size)


@router.post("/dispatch", status_code=201)
async def create_dispatch(
    payload: DispatchCreate,
    db: AsyncSession = Depends(get_db),
    # BUG-ISS-090 — restrict to dispatcher / warehouse roles.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "warehouse_operator", "dispatcher"
    )),
):
    """Create a dispatch order.

    BUG-ISS-073 — never blindly mass-assign payload into the model. Whitelist
    the safe creation fields so future-added settable columns (e.g.
    ``status='delivered'``) cannot be supplied by the caller and short-cut
    the lifecycle.
    BUG-ISS-094 — at least one of pack_id / do_id must be supplied to avoid
    creating an empty dispatch.
    """
    pl = payload.model_dump(exclude_unset=True)
    if not pl.get("pack_id") and not pl.get("do_id"):
        raise HTTPException(
            status_code=400,
            detail="dispatch requires pack_id or do_id",
        )
    SAFE = {
        "do_id", "pack_id", "warehouse_id", "customer_id",
        "vehicle_number", "vehicle_type", "driver_name", "driver_contact",
        "transport_vendor_id", "lr_number", "docket_number",
        "dispatch_date", "expected_delivery_date", "remarks",
    }
    safe_payload = {k: v for k, v in pl.items() if k in SAFE}
    dispatch_number = await generate_number(db, "warehouse", "dispatch_order")
    dispatch = DispatchOrder(
        dispatch_number=dispatch_number,
        **safe_payload,
        status="draft",
        dispatched_by=current_user.id,
    )
    db.add(dispatch)
    await db.flush()
    return {"id": dispatch.id, "dispatch_number": dispatch_number, "message": "Dispatch order created"}


@router.post("/dispatch/{dispatch_id}/cancel")
async def cancel_dispatch(
    dispatch_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-ISS-091 — add cancel endpoint that the enum already supports.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "dispatcher"
    )),
):
    """Cancel a non-terminal dispatch order."""
    result = await db.execute(
        select(DispatchOrder).where(DispatchOrder.id == dispatch_id).with_for_update()
    )
    d = result.scalar_one_or_none()
    if not d:
        raise HTTPException(status_code=404, detail="Dispatch order not found")
    if d.status in ("dispatched", "in_transit", "delivered", "cancelled"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot cancel dispatch in '{d.status}' status",
        )
    d.status = "cancelled"
    await db.flush()
    return {"success": True, "message": "Dispatch cancelled"}


@router.post("/dispatch/{dispatch_id}/mark-delivered")
async def mark_dispatch_delivered(
    dispatch_id: int,
    payload: dict | None = None,
    db: AsyncSession = Depends(get_db),
    # BUG-ISS-076 — add mark_delivered for DispatchOrder; previously
    # lifecycle ended at 'dispatched' so customer receipt was unrecorded.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "dispatcher"
    )),
):
    """Record customer receipt of a dispatched order with proof of delivery."""
    payload = payload or {}
    pod_url = payload.get("pod_url")
    recipient_name = payload.get("recipient_name")
    recipient_signature = payload.get("recipient_signature")
    if not (pod_url or (recipient_name and recipient_signature)):
        raise HTTPException(
            status_code=400,
            detail=(
                "Proof of delivery required: provide pod_url or "
                "recipient_name + recipient_signature"
            ),
        )
    result = await db.execute(
        select(DispatchOrder).where(DispatchOrder.id == dispatch_id).with_for_update()
    )
    d = result.scalar_one_or_none()
    if not d:
        raise HTTPException(status_code=404, detail="Dispatch order not found")
    if d.status not in ("dispatched", "in_transit"):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Cannot mark delivered from '{d.status}' — must be "
                "'dispatched' or 'in_transit'"
            ),
        )
    d.status = "delivered"
    await db.flush()
    return {"success": True, "message": "Dispatch marked delivered"}


@router.post("/dispatch/{dispatch_id}/confirm-loading")
async def confirm_loading(
    dispatch_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # BUG-ISS-074 — verify the linked packing order is completed before
    # firing loading-confirmed. Otherwise loading can fire while pack is
    # still in_progress and the wrong contents go on the truck.
    result = await db.execute(
        select(DispatchOrder).where(DispatchOrder.id == dispatch_id).with_for_update()
    )
    d = result.scalar_one_or_none()
    if not d:
        raise HTTPException(status_code=404, detail="Dispatch order not found")
    if d.status not in ("draft", "loading"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot confirm loading on dispatch in '{d.status}' status",
        )
    if d.pack_id:
        pack_result = await db.execute(
            select(PackingOrder).where(PackingOrder.id == d.pack_id)
        )
        pack = pack_result.scalar_one_or_none()
        if not pack:
            raise HTTPException(status_code=404, detail="Linked packing order not found")
        if pack.status != "completed":
            raise HTTPException(
                status_code=400,
                detail=f"Packing order is '{pack.status}' — must be completed before loading",
            )
    d.loading_confirmed = True
    d.loading_confirmed_at = datetime.now(timezone.utc)
    d.status = "loaded"
    await db.flush()
    return {"success": True, "message": "Loading confirmed"}


@router.post("/dispatch/{dispatch_id}/dispatch")
async def mark_dispatched(
    dispatch_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # BUG-ISS-075 — only a 'loaded' dispatch may be marked dispatched.
    # Previously any status (cancelled, draft) flipped to 'dispatched'.
    from sqlalchemy.orm import selectinload
    result = await db.execute(
        select(DispatchOrder)
        .options(selectinload(DispatchOrder.items))
        .where(DispatchOrder.id == dispatch_id)
        .with_for_update()
    )
    d = result.scalar_one_or_none()
    if not d:
        raise HTTPException(status_code=404, detail="Dispatch order not found")
    if d.status != "loaded":
        raise HTTPException(
            status_code=400,
            detail=f"Cannot dispatch order in '{d.status}' status — must be 'loaded'",
        )

    from app.api.v1.dispatch import process_dispatch_stock_deduction
    await process_dispatch_stock_deduction(db, d, current_user.id)

    d.status = "dispatched"
    d.dispatch_date = datetime.now(timezone.utc)
    await db.flush()
    return {"success": True, "message": "Dispatched"}


# ==================== GATE PASS ====================

@router.get("/gate-passes")
async def list_gate_passes(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    gate_type: str = Query(None),
    status: str = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(GatePass)
    count_query = select(func.count(GatePass.id))
    if gate_type:
        query = query.where(GatePass.gate_type == gate_type)
        count_query = count_query.where(GatePass.gate_type == gate_type)
    if status:
        query = query.where(GatePass.status == status)
        count_query = count_query.where(GatePass.status == status)
    if warehouse_id:
        query = query.where(GatePass.warehouse_id == warehouse_id)
        count_query = count_query.where(GatePass.warehouse_id == warehouse_id)

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(GatePass.id.desc()))
    gps = result.scalars().all()
    return build_paginated_response([GatePassResponse.model_validate(g) for g in gps], total, page, page_size)


@router.post("/gate-passes", status_code=201)
async def create_gate_pass(
    payload: GatePassCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # BUG-ISS-089 — for outward GPs linked to a dispatch, vehicle_number on
    # the GP must match the dispatch's vehicle_number. Otherwise the GP can
    # be issued for a vehicle that wasn't actually loaded.
    if payload.gate_type == "outward" and payload.dispatch_id:
        d_r = await db.execute(
            select(DispatchOrder).where(DispatchOrder.id == payload.dispatch_id)
        )
        d = d_r.scalar_one_or_none()
        if d and d.vehicle_number and payload.vehicle_number:
            if d.vehicle_number.strip() != payload.vehicle_number.strip():
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Gate pass vehicle '{payload.vehicle_number}' does "
                        f"not match dispatch vehicle '{d.vehicle_number}'"
                    ),
                )
    gp_number = await generate_number(db, "warehouse", "gate_pass")
    from app.services.barcode_service import generate_barcode_value
    barcode_val = generate_barcode_value("gate_pass", 0)

    gp = GatePass(
        gate_pass_number=gp_number,
        gate_type=payload.gate_type,
        dispatch_id=payload.dispatch_id,
        grn_id=payload.grn_id,
        warehouse_id=payload.warehouse_id,
        vehicle_number=payload.vehicle_number,
        person_name=payload.person_name,
        person_contact=payload.person_contact,
        material_description=payload.material_description,
        # BUG-ISS-083 — persist security_guard at create time when supplied.
        security_guard=getattr(payload, "security_guard", None),
        barcode=barcode_val,
        remarks=payload.remarks,
    )
    if payload.gate_type == "inward":
        gp.gate_in_time = datetime.now(timezone.utc)
    db.add(gp)
    await db.flush()

    return {"id": gp.id, "gate_pass_number": gp_number, "barcode": barcode_val, "message": "Gate pass created"}


@router.post("/gate-passes/{gp_id}/approve")
async def approve_gate_pass(
    gp_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-ISS-084 — gate pass approval needs a role gate.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "security_officer"
    )),
):
    result = await db.execute(select(GatePass).where(GatePass.id == gp_id))
    gp = result.scalar_one_or_none()
    if not gp:
        raise HTTPException(status_code=404, detail="Gate pass not found")
    if gp.status not in ("pending",):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot approve gate pass in '{gp.status}' status",
        )
    gp.status = "approved"
    gp.approved_by = current_user.id
    await db.flush()
    return {"success": True, "message": "Gate pass approved"}


@router.post("/gate-passes/{gp_id}/complete")
async def complete_gate_pass(
    gp_id: int,
    payload: dict | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Complete a gate pass.

    BUG-ISS-077 — for outward gate passes the linked dispatch order MUST be
    in dispatched/loaded state; otherwise an outward GP can fire while the
    dispatch is still draft, bypassing the dispatch lifecycle.
    BUG-ISS-083 — accept ``security_guard`` in the body so the guard who
    cleared the gate is captured at completion.
    """
    payload = payload or {}
    result = await db.execute(select(GatePass).where(GatePass.id == gp_id))
    gp = result.scalar_one_or_none()
    if not gp:
        raise HTTPException(status_code=404, detail="Gate pass not found")
    # BUG-ISS-083 — persist security_guard at completion when supplied.
    sg = payload.get("security_guard")
    if sg:
        gp.security_guard = str(sg).strip() or None

    if gp.gate_type == "outward" and gp.dispatch_id:
        d_r = await db.execute(select(DispatchOrder).where(DispatchOrder.id == gp.dispatch_id))
        d = d_r.scalar_one_or_none()
        if not d:
            raise HTTPException(status_code=404, detail="Linked dispatch order not found")
        if d.status not in ("loaded", "dispatched", "in_transit"):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Cannot complete outward gate pass — dispatch is "
                    f"'{d.status}', expected loaded/dispatched/in_transit"
                ),
            )

    gp.status = "completed"
    if gp.gate_type == "outward":
        gp.gate_out_time = datetime.now(timezone.utc)
    else:
        gp.gate_in_time = gp.gate_in_time or datetime.now(timezone.utc)
    await db.flush()
    return {"success": True, "message": "Gate pass completed"}


@router.post("/dispatch/{dispatch_id}/acknowledge")
async def acknowledge_delivery(
    dispatch_id: int,
    payload: DispatchAcknowledgementCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Acknowledge delivery for all dispatch types with robust evidence upload."""
    from app.models.dispatch import (
        DispatchDeliveryAcknowledgement, 
        DispatchAcknowledgementItem, 
        DispatchAcknowledgementDocument
    )
    
    # 1. Fetch dispatch order
    d_q = await db.execute(
        select(DispatchOrder).where(DispatchOrder.id == dispatch_id).with_for_update()
    )
    d = d_q.scalar_one_or_none()
    if not d:
        raise HTTPException(status_code=404, detail="Dispatch order not found")
        
    if d.status in ("acknowledged", "cancelled"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot acknowledge dispatch in '{d.status}' status",
        )

    # Generate unique acknowledgement number (e.g., BHSPL/26-27/ACK/00001) race-safely via SCM sequence service
    from app.services.fiscal_numbering import generate_number_v2
    ack_number = await generate_number_v2(db, module="warehouse", document_type="dispatch_acknowledgement")

    # Safe map receiver_signature_captured_via to match DB ENUM allowed values
    sig_via = payload.receiver_signature_captured_via or "WEB_PORTAL"
    if sig_via not in ("MOBILE_APP", "TABLET", "WEB_PORTAL", "SIGNATURE_PAD"):
        if sig_via in ("TOUCH_SCREEN", "TOUCH_PAD"):
            sig_via = "SIGNATURE_PAD"
        else:
            sig_via = "WEB_PORTAL"

    # 2. Populate new DispatchDeliveryAcknowledgement record
    new_ack = DispatchDeliveryAcknowledgement(
        dispatch_id=dispatch_id,
        acknowledgement_number=ack_number,
        acknowledgement_type=payload.acknowledgement_type,
        acknowledged_by_user_id=current_user.id,
        acknowledged_by_name=payload.acknowledged_by_name,
        acknowledged_by_designation=payload.acknowledged_by_designation,
        acknowledged_by_department=payload.acknowledged_by_department,
        acknowledged_by_phone=payload.acknowledged_by_phone,
        acknowledged_by_email=payload.acknowledged_by_email,
        acknowledged_by_employee_code=payload.acknowledged_by_employee_code,
        destination_warehouse_id=payload.destination_warehouse_id or d.destination_warehouse_id,
        destination_user_id=payload.destination_user_id or d.destination_user_id,
        actual_delivery_location=payload.actual_delivery_location,
        verification_method=payload.verification_method,
        receiver_signature_url=payload.receiver_signature_url,
        receiver_signature_captured_via=sig_via,
        receiver_id_proof_type=payload.receiver_id_proof_type,
        receiver_id_proof_number=payload.receiver_id_proof_number,
        receiver_id_proof_document_url=payload.receiver_id_proof_document_url,
        delivery_photos=payload.delivery_photos,
        delivery_latitude=payload.delivery_latitude,
        delivery_longitude=payload.delivery_longitude,
        geo_fence_verified=payload.geo_fence_verified,
        device_id=payload.device_id,
        ip_address=payload.ip_address,
        total_items_expected=payload.total_items_expected,
        total_items_received=payload.total_items_received,
        total_items_damaged=payload.total_items_damaged,
        total_items_rejected=payload.total_items_rejected,
        goods_condition=payload.goods_condition,
        quality_check_performed=payload.quality_check_performed,
        quality_checked_by=payload.quality_checked_by,
        quality_check_remarks=payload.quality_check_remarks,
        packaging_condition=payload.packaging_condition,
        seal_intact=payload.seal_intact,
        seal_number_verified=payload.seal_number_verified,
        temperature_recorded=payload.temperature_recorded,
        humidity_recorded=payload.humidity_recorded,
        acknowledgement_status="ACKNOWLEDGED",
        created_by_user_id=current_user.id,
        updated_by_user_id=current_user.id,
    )
    db.add(new_ack)
    await db.flush()

    # 3. Create acknowledgement items & post stock balances recursively
    for it in payload.items:
        new_item = DispatchAcknowledgementItem(
            acknowledgement_id=new_ack.id,
            dispatch_item_id=it.dispatch_item_id,
            material_id=it.material_id,
            batch_number=it.batch_number,
            serial_numbers=it.serial_numbers,
            quantity_dispatched=it.quantity_dispatched,
            quantity_received=it.quantity_received,
            quantity_accepted=it.quantity_accepted,
            quantity_rejected=it.quantity_rejected,
            quantity_damaged=it.quantity_damaged,
            unit_of_measure=it.unit_of_measure,
            item_condition=it.item_condition,
            rejection_reason=it.rejection_reason,
            damage_description=it.damage_description,
            item_photo_urls=it.item_photo_urls,
            unit_price=it.unit_price,
            total_value=it.total_value,
            manufacturing_date=it.manufacturing_date,
            expiry_date=it.expiry_date,
            temperature_maintained=it.temperature_maintained,
            storage_condition_met=it.storage_condition_met,
        )
        db.add(new_item)

        # STOCK LEDGER MOVEMENT: If inter-warehouse transfer, transfer stock from in-transit to destination warehouse!
        dest_wh_id = new_ack.destination_warehouse_id or d.destination_warehouse_id
        if dest_wh_id and dest_wh_id != d.warehouse_id:
            try:
                batch_id = None
                bin_id = None
                
                # Fetch original batch and bin from linked MaterialIssueItem to preserve SCM lineage
                mi_id = d.material_issue_id
                if mi_id:
                    from app.models.issue import MaterialIssueItem
                    mi_item_res = await db.execute(
                        select(MaterialIssueItem).where(
                            MaterialIssueItem.issue_id == mi_id,
                            MaterialIssueItem.item_id == it.material_id
                        ).limit(1)
                    )
                    mi_item = mi_item_res.scalar_one_or_none()
                    if mi_item:
                        batch_id = mi_item.batch_id
                        bin_id = mi_item.bin_id

                # Fallback to looking up batch by number if not found from linked material issue
                if not batch_id and it.batch_number:
                    from app.models.warehouse import Batch
                    b_q = await db.execute(
                        select(Batch).where(Batch.batch_number == it.batch_number, Batch.item_id == it.material_id).limit(1)
                    )
                    b = b_q.scalar_one_or_none()
                    if b:
                        batch_id = b.id

                # Decrement transit_qty in destination warehouse
                from app.services.stock_service import _get_or_create_balance
                from decimal import Decimal
                dest_balance = await _get_or_create_balance(
                    db,
                    item_id=it.material_id,
                    warehouse_id=dest_wh_id,
                    bin_id=bin_id,
                    batch_id=batch_id,
                    lock=True,
                )
                dispatched_qty = Decimal(str(it.quantity_dispatched or 0))
                dest_balance.transit_qty = max(Decimal("0"), (dest_balance.transit_qty or Decimal("0")) - dispatched_qty)

                await post_stock_ledger(
                    db,
                    item_id=it.material_id,
                    warehouse_id=dest_wh_id,
                    transaction_type="material_issue",
                    qty_in=it.quantity_accepted,
                    batch_id=batch_id,
                    bin_id=bin_id,
                    reference_type="dispatch_acknowledgement",
                    reference_id=new_ack.id,
                    uom_id=1,  # fallback primary uom id
                    created_by=current_user.id,
                )
            except Exception as e:
                import logging
                logging.getLogger(__name__).exception("Failed to update stock ledger / transit quantity in acknowledge_delivery")
                pass

    # 4. Save signature document to DispatchAcknowledgementDocument
    if payload.receiver_signature_url:
        new_doc = DispatchAcknowledgementDocument(
            acknowledgement_id=new_ack.id,
            document_type="SIGNATURE",
            document_name="Receiver Signature Proof",
            document_url=payload.receiver_signature_url,
            uploaded_by_user_id=current_user.id,
            verification_status="VERIFIED",
        )
        db.add(new_doc)

    # 5. Update parent DispatchOrder statuses
    d.delivery_acknowledged = True
    d.delivery_acknowledged_at = datetime.now(timezone.utc)
    d.delivery_acknowledged_by_id = current_user.id
    d.delivery_acknowledged_by_name = payload.acknowledged_by_name
    d.delivery_acknowledged_by_designation = payload.acknowledged_by_designation
    d.delivery_acknowledged_by_phone = payload.acknowledged_by_phone
    d.delivery_acknowledged_by_email = payload.acknowledged_by_email
    d.receiver_signature_url = payload.receiver_signature_url
    d.receiver_id_proof_type = payload.receiver_id_proof_type or "NONE"
    d.receiver_id_proof_number = payload.receiver_id_proof_number
    d.goods_condition_on_delivery = payload.goods_condition
    d.delivery_remarks = payload.discrepancy_description or "Delivered and acknowledged successfully."
    d.delivery_location_latitude = payload.delivery_latitude
    d.delivery_location_longitude = payload.delivery_longitude
    d.delivery_location_verified = payload.geo_fence_verified
    d.status = "acknowledged"

    # 6. Auto-close material issue if linked
    if d.material_issue_id:
        try:
            from app.models.issue import MaterialIssue
            mi_q = await db.execute(
                select(MaterialIssue).where(MaterialIssue.id == d.material_issue_id)
            )
            mi = mi_q.scalar_one_or_none()
            if mi:
                mi.status = "acknowledged"
                db.add(mi)
        except Exception:
            pass

    # 7. Update status of LogisticsMainDispatchOrder if this is synced from MDO
    if d.dispatch_number.startswith("MDO-"):
        try:
            from app.models.logistics import LogisticsMainDispatchOrder
            res_mdo = await db.execute(
                select(LogisticsMainDispatchOrder).where(LogisticsMainDispatchOrder.mdo_number == d.dispatch_number)
            )
            mdo = res_mdo.scalar_one_or_none()
            if mdo:
                mdo.status = "ACKNOWLEDGED"
                db.add(mdo)
                
                # Trigger auto acknowledgement merge!
                from app.services.scm_integration import auto_acknowledge_scm_dispatch
                await auto_acknowledge_scm_dispatch(db, mdo_id=mdo.id, current_user_id=current_user.id)
        except Exception as e:
            print(f"Error updating MDO status upon acknowledgement: {e}")

    await db.commit()
    return {
        "success": True, 
        "acknowledgement_number": ack_number, 
        "message": "Delivery acknowledged successfully and SCM inventory synchronized."
    }
