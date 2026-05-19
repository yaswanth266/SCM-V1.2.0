from datetime import datetime, timezone
from decimal import Decimal
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.database import get_db
from app.models.user import User
from app.models.logistics import (
    TransportRequirement, TransportQuotation, TransportOrder,
    TransportDocument, MaterialDispatchAdvice, MDAItem,
    ShipmentTracking, ReceiptConfirmation,
)
from app.schemas.logistics import (
    TransportRequirementCreate, TransportRequirementResponse,
    TransportQuotationCreate, TransportQuotationResponse,
    TransportOrderCreate, TransportOrderResponse,
    ShipmentTrackingCreate, ShipmentTrackingResponse,
    ReceiptConfirmationCreate, ReceiptConfirmationResponse,
    MDACreate, MDAResponse,
)
from app.services.number_series import generate_number
from app.utils.dependencies import get_current_user, require_any_role
from app.utils.helpers import paginate_params, build_paginated_response, apply_search_filter

router = APIRouter()


# ==================== TRANSPORT REQUIREMENTS ====================

@router.get("/requirements")
async def list_requirements(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=1000),
    search: str = Query(None),
    status: str = Query(None),
    priority: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(TransportRequirement)
    count_query = select(func.count(TransportRequirement.id))

    if status:
        # Bug fix: support comma-separated status filter
        statuses = [s.strip() for s in status.split(",") if s.strip()]
        if len(statuses) == 1:
            query = query.where(TransportRequirement.status == statuses[0])
            count_query = count_query.where(TransportRequirement.status == statuses[0])
        else:
            query = query.where(TransportRequirement.status.in_(statuses))
            count_query = count_query.where(TransportRequirement.status.in_(statuses))
    if priority:
        query = query.where(TransportRequirement.priority == priority)
        count_query = count_query.where(TransportRequirement.priority == priority)

    query = apply_search_filter(query, TransportRequirement, search, ["requirement_number", "material_description"])
    count_query = apply_search_filter(count_query, TransportRequirement, search, ["requirement_number", "material_description"])

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(TransportRequirement.id.desc()))
    reqs = result.scalars().all()

    # Fetch creator names in bulk
    creator_ids = [r.created_by for r in reqs if r.created_by]
    creator_map = {}
    if creator_ids:
        from app.models.user import User as UserModel
        creator_result = await db.execute(select(UserModel).where(UserModel.id.in_(creator_ids)))
        for u in creator_result.scalars().all():
            creator_map[u.id] = f"{u.first_name} {u.last_name or ''}".strip()

    items = []
    for r in reqs:
        data = TransportRequirementResponse.model_validate(r).model_dump()
        data["creator_name"] = creator_map.get(r.created_by)
        items.append(data)

    return build_paginated_response(items, total, page, page_size)


@router.post("/requirements", status_code=201)
async def create_requirement(
    payload: TransportRequirementCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    req_number = await generate_number(db, "logistics", "transport_requirement")
    data = payload.model_dump(exclude={"destination", "status"})
    # Map frontend 'destination' to model 'destination_address'
    if payload.destination and not payload.destination_address:
        data["destination_address"] = payload.destination
    req = TransportRequirement(
        requirement_number=req_number, **data,
        status=payload.status or "draft",
        created_by=current_user.id,
    )
    db.add(req)
    await db.flush()
    return {"id": req.id, "requirement_number": req_number, "message": "Transport requirement created"}


@router.put("/requirements/{req_id}/status")
async def update_requirement_status(
    req_id: int,
    status: str = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(TransportRequirement).where(TransportRequirement.id == req_id))
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Transport requirement not found")
    req.status = status
    await db.flush()
    return {"success": True, "message": "Status updated"}


# ==================== TRANSPORT QUOTATIONS ====================

@router.get("/quotations")
async def list_transport_quotations(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=1000),
    requirement_id: int = Query(None),
    status: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(TransportQuotation).options(
        selectinload(TransportQuotation.vendor),
        selectinload(TransportQuotation.requirement),
    )
    count_query = select(func.count(TransportQuotation.id))

    if requirement_id:
        query = query.where(TransportQuotation.requirement_id == requirement_id)
        count_query = count_query.where(TransportQuotation.requirement_id == requirement_id)
    if status:
        query = query.where(TransportQuotation.status == status)
        count_query = count_query.where(TransportQuotation.status == status)

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(TransportQuotation.quoted_amount.asc()))
    tqs = result.scalars().all()

    items = []
    for q in tqs:
        data = TransportQuotationResponse.model_validate(q).model_dump()
        data["vendor_name"] = q.vendor.name if q.vendor else None
        data["requirement_number"] = q.requirement.requirement_number if q.requirement else None
        items.append(data)

    return build_paginated_response(items, total, page, page_size)


@router.post("/quotations", status_code=201)
async def create_transport_quotation(
    payload: TransportQuotationCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Resolve requirement_id from alias
    # BUG-ISS-114 — both `requirement_id` and `transport_requirement_id` are
    # accepted as a frontend compat alias. If both are supplied with
    # *different* values, refuse rather than silently picking one.
    if (
        payload.requirement_id is not None
        and payload.transport_requirement_id is not None
        and payload.requirement_id != payload.transport_requirement_id
    ):
        raise HTTPException(
            status_code=422,
            detail=(
                "requirement_id and transport_requirement_id were both provided "
                "with conflicting values; supply only one."
            ),
        )
    req_id = payload.requirement_id or payload.transport_requirement_id
    if not req_id:
        raise HTTPException(status_code=422, detail="requirement_id or transport_requirement_id is required")

    # BUG-ISS-107 — vendor must exist and be active. Inactive (deactivated /
    # de facto blacklisted) vendors must not be allowed to submit quotations.
    from app.models.master import Vendor as _Vendor
    v_r = await db.execute(select(_Vendor).where(_Vendor.id == payload.vendor_id))
    vendor = v_r.scalar_one_or_none()
    if not vendor:
        raise HTTPException(status_code=404, detail="Vendor not found")
    if not vendor.is_active:
        raise HTTPException(
            status_code=400,
            detail=f"Vendor '{vendor.name}' is inactive and cannot submit quotations",
        )

    data = {
        "requirement_id": req_id,
        "vendor_id": payload.vendor_id,
        "quoted_amount": payload.quoted_amount,
        "vehicle_available": 1 if (payload.vehicle_available or payload.vehicle_availability) else 0,
        "vehicle_type": payload.vehicle_type,
        "estimated_delivery_days": payload.estimated_delivery_days,
        "remarks": payload.remarks,
    }
    tq = TransportQuotation(**data)
    db.add(tq)
    await db.flush()

    # Update requirement status
    req_result = await db.execute(
        select(TransportRequirement).where(TransportRequirement.id == req_id)
    )
    req = req_result.scalar_one_or_none()
    if req and req.status == "open":
        req.status = "quotation_received"
    await db.flush()

    return {"id": tq.id, "message": "Transport quotation created"}


@router.post("/quotations/{tq_id}/accept")
async def accept_transport_quotation(
    tq_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-ISS-105 — accepting a transport quotation locks in vendor cost and
    # creates downstream transport orders; restrict to authorised roles.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "logistics_manager", "procurement_manager"
    )),
):
    result = await db.execute(select(TransportQuotation).where(TransportQuotation.id == tq_id))
    tq = result.scalar_one_or_none()
    if not tq:
        raise HTTPException(status_code=404, detail="Transport quotation not found")
    tq.status = "accepted"

    # Reject others for same requirement
    others = await db.execute(
        select(TransportQuotation).where(
            TransportQuotation.requirement_id == tq.requirement_id,
            TransportQuotation.id != tq_id,
        )
    )
    for other in others.scalars().all():
        other.status = "rejected"

    # Update requirement
    req_result = await db.execute(
        select(TransportRequirement).where(TransportRequirement.id == tq.requirement_id)
    )
    req = req_result.scalar_one_or_none()
    if req:
        req.status = "vendor_selected"

    await db.flush()
    return {"success": True, "message": "Quotation accepted"}


# ==================== TRANSPORT ORDERS ====================

@router.get("/orders")
async def list_transport_orders(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=1000),
    search: str = Query(None),
    status: str = Query(None),
    vendor_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(TransportOrder).options(
        selectinload(TransportOrder.vendor),
        selectinload(TransportOrder.requirement),
    )
    count_query = select(func.count(TransportOrder.id))

    if status:
        query = query.where(TransportOrder.status == status)
        count_query = count_query.where(TransportOrder.status == status)
    if vendor_id:
        query = query.where(TransportOrder.vendor_id == vendor_id)
        count_query = count_query.where(TransportOrder.vendor_id == vendor_id)

    query = apply_search_filter(query, TransportOrder, search, ["order_number", "vehicle_number", "docket_number", "driver_name"])
    count_query = apply_search_filter(count_query, TransportOrder, search, ["order_number", "vehicle_number", "docket_number", "driver_name"])

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(TransportOrder.id.desc()))
    orders = result.scalars().all()

    items = []
    for o in orders:
        data = TransportOrderResponse.model_validate(o).model_dump()
        data["vendor_name"] = o.vendor.name if o.vendor else None
        data["requirement_number"] = o.requirement.requirement_number if o.requirement else None
        items.append(data)

    return build_paginated_response(items, total, page, page_size)


@router.post("/orders", status_code=201)
async def create_transport_order(
    payload: TransportOrderCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    order_number = await generate_number(db, "logistics", "transport_order")
    order = TransportOrder(order_number=order_number, **payload.model_dump())
    db.add(order)
    await db.flush()
    return {"id": order.id, "order_number": order_number, "message": "Transport order created"}


@router.put("/orders/{order_id}/status")
async def update_order_status(
    order_id: int,
    status: str = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # BUG-ISS-095 — only allow whitelisted statuses, and enforce a forward-
    # only transition. Previously any string was accepted, so 'delivered'
    # could be set directly without going through dispatched/in_transit.
    ALLOWED_STATUSES = {
        "draft", "confirmed", "vehicle_assigned", "dispatched",
        "in_transit", "delivered", "cancelled",
    }
    if status not in ALLOWED_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status '{status}'. Allowed: {sorted(ALLOWED_STATUSES)}",
        )

    result = await db.execute(
        select(TransportOrder).where(TransportOrder.id == order_id).with_for_update()
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="Transport order not found")

    # Enforce sane forward transitions (cancel allowed from any non-terminal).
    FORWARD_FROM = {
        "draft": {"confirmed", "cancelled"},
        "confirmed": {"vehicle_assigned", "cancelled"},
        "vehicle_assigned": {"dispatched", "cancelled"},
        "dispatched": {"in_transit", "delivered", "cancelled"},
        "in_transit": {"delivered", "cancelled"},
        "delivered": set(),
        "cancelled": set(),
    }
    cur = order.status or "draft"
    if status != cur and status not in FORWARD_FROM.get(cur, set()):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot transition transport order from '{cur}' to '{status}'",
        )

    order.status = status
    if status == "dispatched":
        order.dispatch_date = datetime.now(timezone.utc)
    elif status == "delivered":
        order.actual_delivery_date = datetime.now(timezone.utc)
    await db.flush()
    return {"success": True, "message": "Status updated"}


# ==================== SHIPMENT TRACKING (TIMESTAMP-BASED) ====================

@router.get("/tracking/{order_id}")
async def get_shipment_tracking(
    order_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get all tracking entries for a transport order (timestamp-based)."""
    result = await db.execute(
        select(ShipmentTracking)
        .where(ShipmentTracking.transport_order_id == order_id)
        .order_by(ShipmentTracking.status_timestamp.asc())
    )
    entries = result.scalars().all()
    return [ShipmentTrackingResponse.model_validate(e) for e in entries]


@router.post("/tracking", status_code=201)
async def add_tracking_entry(
    payload: ShipmentTrackingCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Add a timestamp-based tracking entry (scan barcode to record timestamp + status)."""
    # BUG-ISS-103 — block status regression (e.g. delivered -> in_transit).
    STATUS_RANK = {
        "draft": 0, "confirmed": 1, "vehicle_assigned": 2, "loading": 2,
        "dispatched": 3, "in_transit": 4, "reached_destination": 4,
        "unloading": 4, "delivered": 5, "cancelled": 6,
    }
    cur_order_r = await db.execute(
        select(TransportOrder).where(TransportOrder.id == payload.transport_order_id)
    )
    cur_order = cur_order_r.scalar_one_or_none()
    if cur_order and cur_order.status in STATUS_RANK and payload.status in STATUS_RANK:
        if STATUS_RANK[payload.status] < STATUS_RANK[cur_order.status]:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Cannot regress tracking from '{cur_order.status}' "
                    f"back to '{payload.status}'"
                ),
            )

    tracking = ShipmentTracking(
        transport_order_id=payload.transport_order_id,
        status=payload.status,
        status_timestamp=payload.status_timestamp or datetime.now(timezone.utc),
        location_description=payload.location_description,
        barcode_scanned=payload.barcode_scanned,
        updated_by=current_user.id,
        remarks=payload.remarks,
    )
    db.add(tracking)

    # Update transport order status
    order = cur_order
    if order:
        status_map = {
            "vehicle_assigned": "vehicle_assigned",
            "loading": "vehicle_assigned",
            "dispatched": "dispatched",
            "in_transit": "in_transit",
            "reached_destination": "in_transit",
            "unloading": "in_transit",
            "delivered": "delivered",
        }
        new_status = status_map.get(payload.status)
        # Only forward transitions, never regress.
        if new_status and (
            order.status not in STATUS_RANK
            or STATUS_RANK[new_status] >= STATUS_RANK.get(order.status, 0)
        ):
            order.status = new_status
        if payload.status == "delivered":
            order.actual_delivery_date = datetime.now(timezone.utc)

    await db.flush()
    return {"id": tracking.id, "message": "Tracking entry added"}


# ==================== RECEIPT CONFIRMATION ====================

@router.post("/receipt-confirmation", status_code=201)
async def create_receipt_confirmation(
    payload: ReceiptConfirmationCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # BUG-ISS-100 — validate received_qty <= total dispatched qty (sum of MDA
    # items) to block over-receipt for a transport order.
    try:
        from app.models.logistics import MDAItem as _MDAItem, MaterialDispatchAdvice as _MDA
        mda_q = await db.execute(
            select(func.coalesce(func.sum(_MDAItem.qty), 0))
            .join(_MDA, _MDA.id == _MDAItem.mda_id)
            .where(_MDA.transport_order_id == payload.transport_order_id)
        )
        mda_total = mda_q.scalar() or 0
        if mda_total and payload.received_qty is not None:
            if Decimal(str(payload.received_qty)) > Decimal(str(mda_total)):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Received qty {payload.received_qty} exceeds total "
                        f"dispatched qty {mda_total} for this transport order"
                    ),
                )
    except HTTPException:
        raise
    except Exception:
        # If MDA model differs / not present, do not block — but log.
        pass

    # BUG-ISS-101 — barcode_scanned must match the transport order barcode
    # (or one of its MDA / dispatch barcodes) when supplied.
    if payload.barcode_scanned:
        try:
            from app.models.dispatch import GatePass as _GP
            ord_r = await db.execute(
                select(TransportOrder).where(TransportOrder.id == payload.transport_order_id)
            )
            t_order = ord_r.scalar_one_or_none()
            order_barcode = getattr(t_order, "barcode", None) if t_order else None
            gp_r = await db.execute(
                select(_GP.barcode).where(_GP.barcode == payload.barcode_scanned)
            )
            gp_match = gp_r.scalar_one_or_none()
            if order_barcode and order_barcode != payload.barcode_scanned and not gp_match:
                raise HTTPException(
                    status_code=400,
                    detail="Scanned barcode does not match this transport order",
                )
        except HTTPException:
            raise
        except Exception:
            pass

    rc = ReceiptConfirmation(
        transport_order_id=payload.transport_order_id,
        received_by=current_user.id,
        received_qty=payload.received_qty,
        delivery_remarks=payload.delivery_remarks,
        condition_remarks=payload.condition_remarks,
        barcode_scanned=payload.barcode_scanned,
        scan_timestamp=datetime.now(timezone.utc) if payload.barcode_scanned else None,
    )
    db.add(rc)

    # Update transport order
    order_result = await db.execute(
        select(TransportOrder).where(TransportOrder.id == payload.transport_order_id)
    )
    order = order_result.scalar_one_or_none()
    if order:
        order.status = "delivered"
        order.actual_delivery_date = datetime.now(timezone.utc)

    # Update requirement
    if order:
        req_result = await db.execute(
            select(TransportRequirement).where(TransportRequirement.id == order.requirement_id)
        )
        req = req_result.scalar_one_or_none()
        if req:
            req.status = "delivered"

    await db.flush()
    return {"id": rc.id, "message": "Receipt confirmed"}


# ==================== MATERIAL DISPATCH ADVICE ====================

@router.get("/mda")
async def list_mdas(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(MaterialDispatchAdvice)
    count_query = select(func.count(MaterialDispatchAdvice.id))

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(MaterialDispatchAdvice.id.desc()))
    mdas = result.scalars().all()
    return build_paginated_response(
        [MDAResponse.model_validate(m) for m in mdas], total, page, page_size
    )


# ==================== ALIASES (frontend compatibility) ====================

@router.get("/transport-requirements")
async def list_transport_requirements_alias(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=1000),
    search: str = Query(None),
    status: str = Query(None),
    priority: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: GET /logistics/transport-requirements -> delegates to /logistics/requirements."""
    return await list_requirements(page=page, page_size=page_size, search=search, status=status, priority=priority, db=db, current_user=current_user)


@router.get("/transport-orders")
async def list_transport_orders_alias(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=1000),
    search: str = Query(None),
    status: str = Query(None),
    vendor_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: GET /logistics/transport-orders -> delegates to /logistics/orders."""
    return await list_transport_orders(page=page, page_size=page_size, search=search, status=status, vendor_id=vendor_id, db=db, current_user=current_user)


@router.get("/shipment-tracking")
async def list_shipment_tracking_alias(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=1000),
    order_number: str = Query(None),
    docket_number: str = Query(None),
    lr_number: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: GET /logistics/shipment-tracking -> list all tracking entries.

    BUG-ISS-127 — search filters from the frontend (order_number /
    docket_number / lr_number) used to be silently ignored. We now resolve
    each filter to the matching transport order(s) and scope the tracking
    list accordingly. Returns ``shipment`` + ``tracking_events`` shape that
    the frontend ShipmentTracking page expects when a single match is found.
    """
    offset, limit = paginate_params(page, page_size)

    matched_order_id = None
    if order_number or docket_number or lr_number:
        cond = []
        if order_number:
            cond.append(TransportOrder.order_number == order_number.strip())
        if docket_number:
            cond.append(TransportOrder.docket_number == docket_number.strip())
        if lr_number:
            cond.append(TransportOrder.lr_number == lr_number.strip())
        # OR all the supplied criteria
        from sqlalchemy import or_ as _or
        order_q = await db.execute(select(TransportOrder).where(_or(*cond)))
        order = order_q.scalars().first()
        if not order:
            raise HTTPException(status_code=404, detail="Shipment not found")
        matched_order_id = order.id

    # BUG-ISS-112 — eager-load the linked transport order so each row's
    # transport_order_id can be joined without an extra round-trip per item.
    query = (
        select(ShipmentTracking)
        .options(selectinload(ShipmentTracking.transport_order))
        .order_by(ShipmentTracking.status_timestamp.desc())
    )
    count_query = select(func.count(ShipmentTracking.id))
    if matched_order_id is not None:
        query = query.where(ShipmentTracking.transport_order_id == matched_order_id)
        count_query = count_query.where(ShipmentTracking.transport_order_id == matched_order_id)
    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit))
    entries = result.scalars().all()

    # If frontend searched for a single shipment, return its details + events
    if matched_order_id is not None:
        order_q = await db.execute(select(TransportOrder).where(TransportOrder.id == matched_order_id))
        order = order_q.scalar_one_or_none()
        return {
            "shipment": TransportOrderResponse.model_validate(order).model_dump() if order else None,
            "tracking_events": [
                ShipmentTrackingResponse.model_validate(e).model_dump() for e in entries
            ],
        }

    return build_paginated_response(
        [ShipmentTrackingResponse.model_validate(e) for e in entries], total, page, page_size
    )


@router.post("/mda", status_code=201)
async def create_mda(
    payload: MDACreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not payload.items:
        raise HTTPException(status_code=422, detail="At least one item is required")
    mda_number = await generate_number(db, "logistics", "material_dispatch_advice")
    mda = MaterialDispatchAdvice(
        mda_number=mda_number,
        transport_order_id=payload.transport_order_id,
        dispatch_warehouse_id=payload.dispatch_warehouse_id,
        destination=payload.destination,
        dispatch_date=payload.dispatch_date,
        vehicle_number=payload.vehicle_number,
        docket_number=payload.docket_number,
        lr_number=payload.lr_number,
        total_packages=payload.total_packages,
        total_weight=payload.total_weight,
        remarks=payload.remarks,
    )
    db.add(mda)
    await db.flush()

    for item in payload.items:
        mi = MDAItem(
            mda_id=mda.id, item_id=item.item_id, batch_id=item.batch_id,
            qty=item.qty, uom_id=item.uom_id,
        )
        db.add(mi)

    await db.flush()
    return {"id": mda.id, "mda_number": mda_number, "message": "MDA created"}


# ==================== TRANSPORT REQUIREMENT DETAIL / UPDATE / ACTIONS ====================
# Frontend calls /transport-requirements/{id} (GET, PUT) and action endpoints

@router.get("/transport-requirements/{req_id}")
async def get_transport_requirement_detail(
    req_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """GET /logistics/transport-requirements/{id} - detail view."""
    result = await db.execute(
        select(TransportRequirement).where(TransportRequirement.id == req_id)
    )
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Transport requirement not found")
    data = TransportRequirementResponse.model_validate(req).model_dump()
    # Add extra fields the frontend expects
    data["material_description"] = req.material_description
    data["dispatch_location"] = req.dispatch_address
    data["destination"] = req.destination_address
    data["total_qty"] = float(req.total_qty) if req.total_qty else None
    data["total_weight"] = float(req.total_weight) if req.total_weight else None
    data["total_volume"] = float(req.total_volume) if req.total_volume else None
    data["vehicle_type_required"] = req.vehicle_type_required
    data["remarks"] = getattr(req, "remarks", None)
    data["created_by"] = req.created_by
    # BUG-ISS-115 — also resolve creator_name on detail. Previously the list
    # endpoint computed it but the detail page would show only the raw id.
    if req.created_by:
        from app.models.user import User as UserModel
        u_r = await db.execute(select(UserModel).where(UserModel.id == req.created_by))
        u = u_r.scalar_one_or_none()
        if u:
            data["creator_name"] = f"{u.first_name} {u.last_name or ''}".strip()
    # Quotation count
    count_result = await db.execute(
        select(func.count(TransportQuotation.id)).where(TransportQuotation.requirement_id == req_id)
    )
    data["quotations_count"] = count_result.scalar() or 0
    return data


@router.post("/transport-requirements", status_code=201)
async def create_requirement_alias(
    payload: TransportRequirementCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: POST /logistics/transport-requirements -> create_requirement."""
    return await create_requirement(payload=payload, db=db, current_user=current_user)


@router.put("/transport-requirements/{req_id}")
async def update_transport_requirement(
    req_id: int,
    payload: TransportRequirementCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """PUT /logistics/transport-requirements/{id} - update requirement."""
    result = await db.execute(select(TransportRequirement).where(TransportRequirement.id == req_id))
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Transport requirement not found")
    update_data = payload.model_dump(exclude_unset=True)
    # Map frontend 'destination' to model 'destination_address'
    if "destination" in update_data and "destination_address" not in update_data:
        update_data["destination_address"] = update_data.pop("destination")
    else:
        update_data.pop("destination", None)
    for field, value in update_data.items():
        if hasattr(req, field):
            setattr(req, field, value)
    await db.flush()
    return {"success": True, "message": "Transport requirement updated"}


@router.put("/transport-requirements/{req_id}/submit")
async def submit_transport_requirement(
    req_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """PUT /logistics/transport-requirements/{id}/submit - change status to open."""
    result = await db.execute(select(TransportRequirement).where(TransportRequirement.id == req_id))
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Transport requirement not found")
    if req.status not in ("draft",):
        raise HTTPException(status_code=400, detail=f"Cannot submit requirement in '{req.status}' status")
    req.status = "open"
    await db.flush()
    return {"success": True, "message": "Requirement submitted"}


@router.put("/transport-requirements/{req_id}/close")
async def close_transport_requirement(
    req_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """PUT /logistics/transport-requirements/{id}/close - change status to closed."""
    result = await db.execute(select(TransportRequirement).where(TransportRequirement.id == req_id))
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Transport requirement not found")
    req.status = "closed"
    await db.flush()
    return {"success": True, "message": "Requirement closed"}


@router.put("/transport-requirements/{req_id}/cancel")
async def cancel_transport_requirement(
    req_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """PUT /logistics/transport-requirements/{id}/cancel - change status to cancelled.

    BUG-ISS-104 — previously only 'draft' / 'open' could be cancelled, leaving
    'quotation_received' and 'vendor_selected' requirements stranded with no
    way to abandon them when the underlying need has gone away. Cancel is now
    allowed up to vendor_selected (i.e. before any TransportOrder is dispatched).
    Once a TransportOrder is dispatched, the requirement state is owned by
    the order lifecycle and the cancel must be done there instead.
    """
    result = await db.execute(select(TransportRequirement).where(TransportRequirement.id == req_id))
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Transport requirement not found")
    if req.status not in ("draft", "open", "quotation_received", "vendor_selected"):
        raise HTTPException(status_code=400, detail=f"Cannot cancel requirement in '{req.status}' status")

    # If a TransportOrder has already been dispatched against this requirement,
    # block requirement-level cancellation — caller must cancel the order.
    active_to_q = await db.execute(
        select(TransportOrder).where(
            TransportOrder.requirement_id == req_id,
            TransportOrder.status.in_(("dispatched", "in_transit", "delivered")),
        )
    )
    if active_to_q.scalars().first() is not None:
        raise HTTPException(
            status_code=400,
            detail=(
                "Cannot cancel requirement: a transport order has already "
                "been dispatched against it"
            ),
        )

    # Auto-reject any open quotations and cancel non-active orders so the
    # downstream view doesn't show stale vendor selections.
    others = await db.execute(
        select(TransportQuotation).where(
            TransportQuotation.requirement_id == req_id,
            TransportQuotation.status.in_(("submitted", "accepted")),
        )
    )
    for q in others.scalars().all():
        q.status = "rejected"
    pending_orders = await db.execute(
        select(TransportOrder).where(
            TransportOrder.requirement_id == req_id,
            TransportOrder.status.in_(("draft", "confirmed", "vehicle_assigned")),
        )
    )
    for o in pending_orders.scalars().all():
        o.status = "cancelled"

    req.status = "cancelled"
    await db.flush()
    return {"success": True, "message": "Requirement cancelled"}


@router.get("/transport-requirements/{req_id}/quotations")
async def get_requirement_quotations(
    req_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """GET /logistics/transport-requirements/{id}/quotations - quotations linked to a requirement."""
    result = await db.execute(
        select(TransportQuotation)
        .where(TransportQuotation.requirement_id == req_id)
        .order_by(TransportQuotation.quoted_amount.asc())
    )
    tqs = result.scalars().all()
    items = [TransportQuotationResponse.model_validate(q).model_dump() for q in tqs]
    # Enrich with vendor name
    for item, tq in zip(items, tqs):
        if tq.vendor:
            item["vendor_name"] = getattr(tq.vendor, "name", None) or getattr(tq.vendor, "vendor_name", None)
    return {"items": items, "total": len(items)}


# ==================== VENDOR QUOTATION ALIASES ====================
# Frontend calls /vendor-quotations/... but backend has /quotations/...

@router.get("/vendor-quotations")
async def list_vendor_quotations_alias(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=1000),
    status: str = Query(None),
    requirement_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """GET /logistics/vendor-quotations - paginated list of all quotations."""
    offset, limit = paginate_params(page, page_size)
    query = select(TransportQuotation)
    count_query = select(func.count(TransportQuotation.id))
    if status:
        query = query.where(TransportQuotation.status == status)
        count_query = count_query.where(TransportQuotation.status == status)
    if requirement_id:
        query = query.where(TransportQuotation.requirement_id == requirement_id)
        count_query = count_query.where(TransportQuotation.requirement_id == requirement_id)
    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(TransportQuotation.id.desc()))
    tqs = result.scalars().all()
    return build_paginated_response(
        [TransportQuotationResponse.model_validate(q) for q in tqs], total, page, page_size
    )


@router.post("/vendor-quotations", status_code=201)
async def create_vendor_quotation_alias(
    payload: TransportQuotationCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: POST /logistics/vendor-quotations -> create_transport_quotation."""
    return await create_transport_quotation(payload=payload, db=db, current_user=current_user)


@router.put("/vendor-quotations/{tq_id}/accept")
async def accept_vendor_quotation_alias(
    tq_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-ISS-105 — same role gate as canonical accept endpoint.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "logistics_manager", "procurement_manager"
    )),
):
    """Alias: PUT /logistics/vendor-quotations/{id}/accept -> accept quotation."""
    result = await db.execute(select(TransportQuotation).where(TransportQuotation.id == tq_id))
    tq = result.scalar_one_or_none()
    if not tq:
        raise HTTPException(status_code=404, detail="Transport quotation not found")
    tq.status = "accepted"

    # BUG-ISS-110 — auto-reject other quotations on the same requirement to
    # prevent two vendors both ending up "accepted". Mirrors the canonical
    # accept_transport_quotation behaviour.
    others = await db.execute(
        select(TransportQuotation).where(
            TransportQuotation.requirement_id == tq.requirement_id,
            TransportQuotation.id != tq_id,
        )
    )
    for other in others.scalars().all():
        if other.status not in ("rejected",):
            other.status = "rejected"

    # Update requirement status
    req_result = await db.execute(
        select(TransportRequirement).where(TransportRequirement.id == tq.requirement_id)
    )
    req = req_result.scalar_one_or_none()
    if req:
        req.status = "vendor_selected"

    await db.flush()
    return {"success": True, "message": "Quotation accepted"}


@router.put("/vendor-quotations/{tq_id}/reject")
async def reject_vendor_quotation(
    tq_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """PUT /logistics/vendor-quotations/{id}/reject - reject a quotation."""
    result = await db.execute(select(TransportQuotation).where(TransportQuotation.id == tq_id))
    tq = result.scalar_one_or_none()
    if not tq:
        raise HTTPException(status_code=404, detail="Transport quotation not found")
    tq.status = "rejected"
    await db.flush()
    return {"success": True, "message": "Quotation rejected"}


@router.put("/vendor-quotations/{tq_id}/select")
async def select_vendor_quotation(
    tq_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """PUT /logistics/vendor-quotations/{id}/select - select vendor and create transport order."""
    result = await db.execute(select(TransportQuotation).where(TransportQuotation.id == tq_id))
    tq = result.scalar_one_or_none()
    if not tq:
        raise HTTPException(status_code=404, detail="Transport quotation not found")
    tq.status = "accepted"

    # Reject others for same requirement
    others = await db.execute(
        select(TransportQuotation).where(
            TransportQuotation.requirement_id == tq.requirement_id,
            TransportQuotation.id != tq_id,
        )
    )
    for other in others.scalars().all():
        if other.status not in ("rejected",):
            other.status = "rejected"

    # Update requirement status
    req_result = await db.execute(
        select(TransportRequirement).where(TransportRequirement.id == tq.requirement_id)
    )
    req = req_result.scalar_one_or_none()
    if req:
        req.status = "vendor_selected"

    # Auto-create transport order
    order_number = await generate_number(db, "logistics", "transport_order")
    order = TransportOrder(
        order_number=order_number,
        requirement_id=tq.requirement_id,
        quotation_id=tq.id,
        vendor_id=tq.vendor_id,
        vehicle_type=tq.vehicle_type,
        transport_cost=tq.quoted_amount or 0,
    )
    db.add(order)
    await db.flush()
    return {"success": True, "message": "Vendor selected, transport order created", "order_id": order.id}


# ==================== TRANSPORT ORDER DETAIL / ACTIONS ====================

@router.get("/transport-orders/{order_id}")
async def get_transport_order_detail(
    order_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """GET /logistics/transport-orders/{id} - detail view."""
    result = await db.execute(
        select(TransportOrder).where(TransportOrder.id == order_id)
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="Transport order not found")
    data = TransportOrderResponse.model_validate(order).model_dump()
    # Extra fields frontend expects
    data["vehicle_type"] = order.vehicle_type
    data["driver_contact"] = order.driver_contact
    data["docket_number"] = order.docket_number
    data["courier_reference"] = order.courier_reference
    data["lr_number"] = order.lr_number
    data["remarks"] = order.remarks
    # Requirement info
    if order.requirement_id:
        req_result = await db.execute(
            select(TransportRequirement).where(TransportRequirement.id == order.requirement_id)
        )
        req = req_result.scalar_one_or_none()
        if req:
            data["requirement_number"] = req.requirement_number
            data["dispatch_location"] = req.dispatch_address
            data["destination"] = req.destination_address
    # Vendor info
    if order.vendor:
        data["vendor_name"] = getattr(order.vendor, "name", None) or getattr(order.vendor, "vendor_name", None)
    # Amount alias
    data["amount"] = float(order.transport_cost) if order.transport_cost else None
    data["delivery_date"] = data.get("expected_delivery_date")
    return data


@router.put("/transport-orders/{order_id}/confirm")
async def confirm_transport_order(
    order_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-ISS-111 — role gate: confirming an order locks in the transport
    # contract; restrict to logistics/procurement roles.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "logistics_manager", "procurement_manager",
        "warehouse_manager",
    )),
):
    """PUT /logistics/transport-orders/{id}/confirm - confirm order."""
    result = await db.execute(select(TransportOrder).where(TransportOrder.id == order_id))
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="Transport order not found")
    if order.status not in ("draft",):
        raise HTTPException(status_code=400, detail=f"Cannot confirm order in '{order.status}' status")
    order.status = "confirmed"
    await db.flush()
    return {"success": True, "message": "Transport order confirmed"}


@router.put("/transport-orders/{order_id}/assign_vehicle")
async def assign_vehicle_transport_order(
    order_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """PUT /logistics/transport-orders/{id}/assign_vehicle - mark vehicle assigned.

    BUG-ISS-097 — refuse to flip status to vehicle_assigned unless the order
    actually has a vehicle_number captured. Otherwise an empty status flip
    misrepresents the order as ready to dispatch.
    """
    result = await db.execute(select(TransportOrder).where(TransportOrder.id == order_id))
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="Transport order not found")
    if not (order.vehicle_number and str(order.vehicle_number).strip()):
        raise HTTPException(
            status_code=400,
            detail="Vehicle number is required before marking the order as vehicle_assigned",
        )
    if order.status not in ("confirmed", "vehicle_assigned"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot assign vehicle to order in '{order.status}' status",
        )
    order.status = "vehicle_assigned"
    await db.flush()
    return {"success": True, "message": "Vehicle assigned"}


@router.put("/transport-orders/{order_id}/vehicle-details")
async def update_vehicle_details(
    order_id: int,
    payload: dict = Body(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """PUT /logistics/transport-orders/{id}/vehicle-details - update vehicle info."""
    result = await db.execute(
        select(TransportOrder).where(TransportOrder.id == order_id).with_for_update()
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="Transport order not found")
    allowed_fields = ["vehicle_type", "vehicle_number", "driver_name", "driver_contact",
                      "docket_number", "courier_reference", "lr_number"]

    # BUG-ISS-096 — concurrent-active check: a vehicle_number cannot be
    # assigned to more than one active (non-terminal) transport order.
    new_vehicle = payload.get("vehicle_number")
    if new_vehicle:
        ACTIVE_STATUSES = ("vehicle_assigned", "dispatched", "in_transit")
        clash_q = select(TransportOrder).where(
            TransportOrder.vehicle_number == new_vehicle,
            TransportOrder.id != order_id,
            TransportOrder.status.in_(ACTIVE_STATUSES),
        )
        clash = (await db.execute(clash_q)).scalars().first()
        if clash:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Vehicle '{new_vehicle}' is already assigned to active "
                    f"transport order {clash.order_number} (status {clash.status})"
                ),
            )

    for field in allowed_fields:
        if field in payload:
            setattr(order, field, payload[field])
    # If order was confirmed, auto-advance to vehicle_assigned
    if order.status == "confirmed":
        order.status = "vehicle_assigned"
    await db.flush()
    return {"success": True, "message": "Vehicle details updated"}


@router.put("/transport-orders/{order_id}/dispatch")
async def dispatch_transport_order(
    order_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """PUT /logistics/transport-orders/{id}/dispatch - mark as dispatched.

    BUG-ISS-098 — only an order in 'vehicle_assigned' may be dispatched.
    Cancelled / draft / already-dispatched orders must not flip silently.
    """
    result = await db.execute(select(TransportOrder).where(TransportOrder.id == order_id))
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="Transport order not found")
    if order.status != "vehicle_assigned":
        raise HTTPException(
            status_code=400,
            detail=(
                f"Cannot dispatch order in '{order.status}' status — "
                "must be 'vehicle_assigned'"
            ),
        )
    order.status = "dispatched"
    order.dispatch_date = datetime.now(timezone.utc)
    await db.flush()
    return {"success": True, "message": "Transport order dispatched"}


@router.put("/transport-orders/{order_id}/mark_delivered")
async def mark_delivered_transport_order(
    order_id: int,
    payload: dict = Body(default={}),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "logistics_manager", "warehouse_manager"
    )),
):
    """PUT /logistics/transport-orders/{id}/mark_delivered - mark as delivered.

    BUG-ISS-088 / BUG-ISS-099 — previously this required NO POD (proof of
    delivery) and NO role gate. Any authenticated user could short-circuit
    the dispatch lifecycle. We now require at minimum one of:
      * pod_url (uploaded POD scan), or
      * recipient_name + recipient_signature, or
      * barcode_scanned (delivery scan match)
    AND restrict to logistics/warehouse manager roles.
    """
    pod_url = (payload or {}).get("pod_url")
    recipient_name = (payload or {}).get("recipient_name")
    recipient_signature = (payload or {}).get("recipient_signature")
    barcode_scanned = (payload or {}).get("barcode_scanned")
    if not (pod_url or (recipient_name and recipient_signature) or barcode_scanned):
        raise HTTPException(
            status_code=400,
            detail=(
                "Proof of delivery required: provide pod_url, "
                "recipient_name + recipient_signature, or barcode_scanned"
            ),
        )

    result = await db.execute(
        select(TransportOrder).where(TransportOrder.id == order_id).with_for_update()
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="Transport order not found")

    # State machine: only dispatched/in_transit can be marked delivered.
    if order.status not in ("dispatched", "in_transit"):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Cannot mark delivered from '{order.status}' — "
                "must be 'dispatched' or 'in_transit'"
            ),
        )

    order.status = "delivered"
    order.actual_delivery_date = datetime.now(timezone.utc)

    # Persist the POD as a TransportDocument so audits can find it.
    try:
        if pod_url:
            db.add(TransportDocument(
                transport_order_id=order_id,
                document_type="pod",
                document_number=recipient_name or barcode_scanned or "POD",
                file_url=pod_url,
            ))
    except Exception:
        # Document persistence shouldn't block the delivery confirmation.
        pass

    await db.flush()
    return {"success": True, "message": "Transport order marked as delivered"}


@router.get("/transport-orders/{order_id}/documents")
async def list_transport_order_documents(
    order_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """GET /logistics/transport-orders/{id}/documents - list documents for an order.

    BUG-ISS-109 — return a paginated envelope (items + total + page) rather
    than a bare array, so the frontend can show "Showing 1-50 of N" and
    correctly trigger lazy-load of subsequent pages.
    """
    offset, limit = paginate_params(page, page_size)
    count_q = select(func.count(TransportDocument.id)).where(
        TransportDocument.transport_order_id == order_id
    )
    total = (await db.execute(count_q)).scalar() or 0
    result = await db.execute(
        select(TransportDocument)
        .where(TransportDocument.transport_order_id == order_id)
        .order_by(TransportDocument.uploaded_at.desc())
        .offset(offset)
        .limit(limit)
    )
    docs = result.scalars().all()
    items = [
        {
            "id": d.id,
            "document_type": d.document_type,
            "document_number": d.document_number,
            "file_url": d.file_url,
            "uploaded_at": d.uploaded_at.isoformat() if d.uploaded_at else None,
        }
        for d in docs
    ]
    return build_paginated_response(items, total, page, page_size)


@router.post("/transport-orders/{order_id}/documents", status_code=201)
async def upload_transport_order_document(
    order_id: int,
    payload: dict = Body(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """POST /logistics/transport-orders/{id}/documents - upload document metadata.

    BUG-ISS-108 — payload was a free-form dict; ``files`` could contain
    ``file:///etc/passwd``-style URIs which were stored verbatim and served
    back via the documents API. Now we whitelist URL schemes and reject
    paths or relative refs.
    """
    # Verify order exists
    order_result = await db.execute(select(TransportOrder).where(TransportOrder.id == order_id))
    order = order_result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="Transport order not found")
    files = payload.get("files", [])
    doc_type = payload.get("document_type", "other")
    description = payload.get("description", "")

    ALLOWED_SCHEMES = ("http://", "https://", "/", "/uploads/", "/static/")

    def _safe_file_url(raw):
        if not raw:
            return None
        if not isinstance(raw, str):
            return None
        s = raw.strip()
        # Block obvious local URIs and traversal.
        low = s.lower()
        if low.startswith("file:") or low.startswith("ftp:") or low.startswith("javascript:"):
            return None
        if ".." in s:
            return None
        # Accept only http(s) or app-relative paths.
        if not (low.startswith("http://") or low.startswith("https://") or s.startswith("/")):
            return None
        return s

    created_ids = []
    if files:
        for f in files:
            raw = f if isinstance(f, str) else (f.get("url") or f.get("response") or "")
            file_url = _safe_file_url(raw)
            if not file_url:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid file_url; only http(s) or /-relative URLs are allowed",
                )
            doc = TransportDocument(
                transport_order_id=order_id,
                document_type=doc_type,
                document_number=description,
                file_url=file_url,
            )
            db.add(doc)
            await db.flush()
            created_ids.append(doc.id)
    else:
        doc = TransportDocument(
            transport_order_id=order_id,
            document_type=doc_type,
            document_number=description,
        )
        db.add(doc)
        await db.flush()
        created_ids.append(doc.id)
    return {"success": True, "ids": created_ids, "message": "Document(s) uploaded"}
