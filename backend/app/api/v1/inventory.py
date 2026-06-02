from decimal import Decimal
from typing import Optional
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.database import get_db
from app.models.user import User
from app.models.stock import StockBalance, StockLedger
from app.models.transfer import StockTransfer, StockTransferItem
from app.models.audit import StockAudit, StockAuditItem, BinReplenishmentRule
from app.schemas.inventory import (
    StockBalanceResponse, StockLedgerResponse,
    TransferCreate, TransferUpdate, TransferResponse,
    AuditCreate, AuditResponse,
    ReplenishmentRuleCreate, ReplenishmentRuleResponse,
)
from app.services.number_series import generate_number
from app.services.stock_service import post_stock_ledger
from app.services.approval_service import submit_for_approval
from app.utils.dependencies import get_current_user, require_any_role
from app.utils.helpers import paginate_params, build_paginated_response

router = APIRouter()


# ==================== STOCK BALANCE ====================

@router.get("/balance")
async def get_stock_balances(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    item_id: str = Query(None, description="Single ID or comma-separated IDs (e.g., '1,2,3')"),
    warehouse_id: int = Query(None),
    batch_id: int = Query(None),
    # BUG-INV-133: accept category filter (frontend was sending it but backend
    # silently dropped it).
    category: str = Query(None),
    # BUG-INV-134: accept the batch (string) param too — frontend sends a
    # batch_number string under "batch", not a batch_id integer.
    batch: str = Query(None),
    # BUG-INV-135: show items with zero qty if explicitly requested.
    show_zero_stock: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    from app.models.warehouse import WarehouseBin, WarehouseRack, WarehouseLine, WarehouseLocation
    from sqlalchemy.orm import joinedload
    query = select(StockBalance).options(
        joinedload(StockBalance.item),
        joinedload(StockBalance.warehouse),
        joinedload(StockBalance.batch),
        joinedload(StockBalance.bin).joinedload(WarehouseBin.rack).joinedload(WarehouseRack.line).joinedload(WarehouseLine.location),
    )
    count_query = select(func.count(StockBalance.id))

    from app.utils.dependencies import user_is_managerial, user_warehouse_ids
    is_managerial = await user_is_managerial(db, current_user.id)

    if is_managerial:
        # 2026-05-06: vehicle model — virtual warehouses (vehicles / mobile
        # units) never hold persistent inventory. Always exclude them from
        # stock balance queries to prevent confusing zero-rows for managers.
        from app.models.warehouse import Warehouse as _Wh
        real_wh_subq = select(_Wh.id).where(_Wh.type != "virtual").subquery()
        query = query.where(StockBalance.warehouse_id.in_(select(real_wh_subq)))
        count_query = count_query.where(StockBalance.warehouse_id.in_(select(real_wh_subq)))
    else:
        # R-005: warehouse-scope isolation. Non-managerial users only see stock
        # in warehouses assigned to them (including virtual ones). Specific
        # warehouse_id query param must also be in their assigned set.
        scoped_wh = await user_warehouse_ids(db, current_user.id)
        print(f"DEBUG: user_id={current_user.id}, warehouse_id={warehouse_id}, scoped_wh={scoped_wh}")
        if not scoped_wh:
            # No warehouses assigned → no stock visible
            return build_paginated_response([], 0, page, page_size)
        if warehouse_id is not None and warehouse_id not in scoped_wh:
            print(f"DEBUG: Authorization failed. {warehouse_id} not in {scoped_wh}")
            raise HTTPException(status_code=403, detail="Not authorized to view stock for this warehouse")
        query = query.where(StockBalance.warehouse_id.in_(scoped_wh))
        count_query = count_query.where(StockBalance.warehouse_id.in_(scoped_wh))

    # Handle single item_id or comma-separated list (e.g., "335,337,349")
    if item_id:
        try:
            item_ids = [int(x.strip()) for x in str(item_id).split(',') if x.strip()]
            if len(item_ids) == 1:
                query = query.where(StockBalance.item_id == item_ids[0])
                count_query = count_query.where(StockBalance.item_id == item_ids[0])
            elif len(item_ids) > 1:
                query = query.where(StockBalance.item_id.in_(item_ids))
                count_query = count_query.where(StockBalance.item_id.in_(item_ids))
        except ValueError:
            # Invalid item_id format, return empty result
            return build_paginated_response([], 0, page, page_size)
    if warehouse_id:
        query = query.where(StockBalance.warehouse_id == warehouse_id)
        count_query = count_query.where(StockBalance.warehouse_id == warehouse_id)
    if batch_id:
        query = query.where(StockBalance.batch_id == batch_id)
        count_query = count_query.where(StockBalance.batch_id == batch_id)
    # BUG-INV-134: support batch-number string filter (frontend sends "batch")
    if batch:
        from app.models.warehouse import Batch as _Batch
        b_q = select(_Batch.id).where(_Batch.batch_number.ilike(f"%{batch.strip()}%"))
        b_ids = [r[0] for r in (await db.execute(b_q)).all()]
        if b_ids:
            query = query.where(StockBalance.batch_id.in_(b_ids))
            count_query = count_query.where(StockBalance.batch_id.in_(b_ids))
        else:
            # No batches match the filter → return empty
            return build_paginated_response([], 0, page, page_size)
    # BUG-INV-133: filter by item_type when category supplied. The frontend
    # CATEGORY_OPTIONS values map to Item.item_type values (raw_material,
    # consumable, finished_good, etc.) — accept either match.
    if category:
        from app.models.master import Item as _ItemCat
        cat_subq = select(_ItemCat.id).where(
            (_ItemCat.item_type == category)
            | (_ItemCat.category_id == (int(category) if str(category).isdigit() else -1))
        )
        query = query.where(StockBalance.item_id.in_(cat_subq))
        count_query = count_query.where(StockBalance.item_id.in_(cat_subq))

    # BUG-INV-135: filter by quantity unless show_zero_stock is set.
    if not show_zero_stock:
        query = query.where(StockBalance.available_qty > 0)
        count_query = count_query.where(StockBalance.available_qty > 0)

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit))
    balances = result.scalars().all()

    # BUG-INV-122: enrich each row with is_low_stock / is_below_reorder /
    # is_expiring_soon flags so the frontend list view can render warning
    # rows without making an extra round-trip per row. Bulk-load batch
    # expiry dates in one query to avoid N+1.
    from datetime import date as _date, timedelta as _td
    today = _date.today()
    expiring_window = today + _td(days=30)
    batch_ids = [b.batch_id for b in balances if b.batch_id]
    batch_exp_map: dict = {}
    if batch_ids:
        from app.models.warehouse import Batch as _Batch
        b_rows = await db.execute(
            select(_Batch.id, _Batch.expiry_date).where(_Batch.id.in_(set(batch_ids)))
        )
        batch_exp_map = {r.id: r.expiry_date for r in b_rows.all()}

    # Gather balances with has_serial = True
    serial_tracked_keys = []
    for b in balances:
        if b.item and b.item.has_serial:
            serial_tracked_keys.append((b.item_id, b.warehouse_id, b.bin_id, b.batch_id))
    
    serials_map = {}
    if serial_tracked_keys:
        from sqlalchemy import and_, or_
        from app.models.warehouse import SerialNumber
        
        # Build composite filter
        conditions = []
        for (item_id, wh_id, bin_id, batch_id) in serial_tracked_keys:
            cond = and_(
                SerialNumber.item_id == item_id,
                SerialNumber.warehouse_id == wh_id,
                SerialNumber.status == "available"
            )
            cond = and_(
                cond,
                SerialNumber.bin_id == bin_id if bin_id is not None else SerialNumber.bin_id.is_(None),
                SerialNumber.batch_id == batch_id if batch_id is not None else SerialNumber.batch_id.is_(None)
            )
            conditions.append(cond)
            
        s_query = select(SerialNumber).where(or_(*conditions))
        s_result = await db.execute(s_query)
        serials = s_result.scalars().all()
        
        for s in serials:
            key = (s.item_id, s.warehouse_id, s.bin_id, s.batch_id)
            if key not in serials_map:
                serials_map[key] = []
            serials_map[key].append(s.serial_number)

    response_items = []
    for b in balances:
        # BUG-FIX: Manually construct dict to avoid Pydantic ValidationError 
        # caused by 'batch' and 'bin' model relationships colliding with 
        # schema field names.
        data = {
            "id": b.id,
            "item_id": b.item_id,
            "warehouse_id": b.warehouse_id,
            "bin_id": b.bin_id,
            "batch_id": b.batch_id,
            "available_qty": b.available_qty,
            "reserved_qty": b.reserved_qty,
            "transit_qty": b.transit_qty,
            "total_qty": b.total_qty,
            "valuation_rate": b.valuation_rate,
            "stock_value": b.stock_value,
            "last_updated": b.last_updated.isoformat() if b.last_updated else None,
            "serial_numbers": serials_map.get((b.item_id, b.warehouse_id, b.bin_id, b.batch_id), []),
        }
        if hasattr(b, 'item') and b.item:
            data["item_name"] = b.item.name
            data["item_code"] = b.item.item_code
            data["has_serial"] = bool(b.item.has_serial)
            # Include uom_id + uom_name so Stock Audit and Material Issue
            # forms can pre-fill UOM when auto-loading from stock.
            data["uom_id"] = b.item.primary_uom_id
            reorder_level = float(getattr(b.item, "reorder_level", 0) or 0)
            min_stock = float(getattr(b.item, "min_stock_level", 0) or 0)
            total_q = float(b.total_qty or 0)
            data["is_below_reorder"] = bool(reorder_level > 0 and total_q < reorder_level)
            data["is_low_stock"] = bool(min_stock > 0 and total_q <= min_stock)
        else:
            data["item_name"] = None
            data["item_code"] = None
            data["has_serial"] = False
            data["uom_id"] = None
            data["is_below_reorder"] = False
            data["is_low_stock"] = False
        data["warehouse_name"] = b.warehouse.name if b.warehouse else None
        # Include batch details (batch_number, expiry_date)
        if b.batch:
            data["batch_name"] = b.batch.batch_number
            data["batch_number"] = b.batch.batch_number
            data["expiry_date"] = b.batch.expiry_date.isoformat() if b.batch.expiry_date else None
            data["manufacturing_date"] = b.batch.manufacturing_date.isoformat() if b.batch.manufacturing_date else None
        else:
            # BUG-INV-112: if the batch record is missing but batch_id is present,
            # it might be a legacy record where batch_id stored the number, or
            # a data corruption. Return the ID as the number to allow the UI to
            # show something.
            data["batch_name"] = str(b.batch_id) if b.batch_id else None
            data["batch_number"] = data["batch_name"]
            data["expiry_date"] = None
            data["manufacturing_date"] = None

        # Include bin details (bin code, location hierarchy)
        if b.bin:
            data["bin_name"] = b.bin.name or b.bin.code
            data["bin_code"] = b.bin.code
            # Rack info
            if b.bin.rack:
                data["rack"] = b.bin.rack.name or b.bin.rack.code
                data["rack_id"] = b.bin.rack_id
                # Location/Line info
                if b.bin.rack.line and b.bin.rack.line.location:
                    data["location"] = b.bin.rack.line.location.name or b.bin.rack.line.location.code
        else:
            data["bin_name"] = None
            data["bin_code"] = None
            data["rack"] = None
            data["rack_id"] = None
            data["location"] = None
        # Expiring-soon flag: any batch within 30 days of expiry counts.
        exp = batch_exp_map.get(b.batch_id) if b.batch_id else None
        if exp is not None and hasattr(exp, "date"):
            exp = exp.date()
        data["is_expiring_soon"] = bool(exp is not None and today <= exp <= expiring_window)
        response_items.append(data)

    return build_paginated_response(response_items, total, page, page_size)


# ==================== STOCK LEDGER ====================

@router.get("/ledger")
async def get_stock_ledger(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    item_id: int = Query(None),
    warehouse_id: int = Query(None),
    transaction_type: str = Query(None),
    date_from: str = Query(None),
    date_to: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    # BUG-INV-124: pin a deterministic order on (posting_date desc, id desc)
    # as a tuple so that subsequent .where() rebinds keep ordering stable
    # under SQLAlchemy's clause-cloning. With only `id desc` the apparent order
    # could shift when posting_date jumps across page boundaries on a
    # back-dated insert. Always order by posting_date first, then id as the
    # tiebreaker so paging is reproducible.
    query = (
        select(StockLedger)
        .options(
            selectinload(StockLedger.item),
            selectinload(StockLedger.warehouse),
        )
        .order_by(StockLedger.posting_date.desc(), StockLedger.id.desc())
    )
    count_query = select(func.count(StockLedger.id))

    # R-005: warehouse-scope isolation
    from app.utils.dependencies import user_is_managerial, user_warehouse_ids
    if not await user_is_managerial(db, current_user.id):
        scoped_wh = await user_warehouse_ids(db, current_user.id)
        if not scoped_wh:
            return build_paginated_response([], 0, page, page_size)
        if warehouse_id is not None and warehouse_id not in scoped_wh:
            raise HTTPException(status_code=403, detail="Not authorized to view this warehouse's ledger")
        query = query.where(StockLedger.warehouse_id.in_(scoped_wh))
        count_query = count_query.where(StockLedger.warehouse_id.in_(scoped_wh))

    if item_id:
        query = query.where(StockLedger.item_id == item_id)
        count_query = count_query.where(StockLedger.item_id == item_id)
    if warehouse_id:
        query = query.where(StockLedger.warehouse_id == warehouse_id)
        count_query = count_query.where(StockLedger.warehouse_id == warehouse_id)
    if transaction_type:
        query = query.where(StockLedger.transaction_type == transaction_type)
        count_query = count_query.where(StockLedger.transaction_type == transaction_type)
    if date_from:
        # BUG-INV-120: validate date_from input — bad strings raised 500.
        try:
            from datetime import date as _d
            _ = _d.fromisoformat(date_from[:10])
        except Exception:
            raise HTTPException(status_code=400, detail=f"Invalid date_from: {date_from}")
        query = query.where(StockLedger.posting_date >= date_from)
        count_query = count_query.where(StockLedger.posting_date >= date_from)
    if date_to:
        # BUG-INV-117: posting_date is DateTime — `<= date_to` (a YYYY-MM-DD)
        # compares to midnight, excluding entries posted later that day.
        # Use exclusive < (date_to + 1 day) to capture the full boundary day.
        try:
            from datetime import date as _d, timedelta as _td
            d = _d.fromisoformat(date_to[:10])
            next_day = d + _td(days=1)
        except Exception:
            raise HTTPException(status_code=400, detail=f"Invalid date_to: {date_to}")
        query = query.where(StockLedger.posting_date < next_day.isoformat())
        count_query = count_query.where(StockLedger.posting_date < next_day.isoformat())

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit))
    entries = result.scalars().all()

    # Bulk lookup metadata for the page
    user_ids = {e.created_by for e in entries if e.created_by}
    mi_ids = {e.reference_id for e in entries if e.reference_type == "material_issue" and e.reference_id}
    do_ids = {e.reference_id for e in entries if e.reference_type == "dispatch_order" and e.reference_id}
    ack_ids = {e.reference_id for e in entries if e.reference_type == "dispatch_acknowledgement" and e.reference_id}
    po_ids = {e.reference_id for e in entries if e.reference_type == "putaway_order" and e.reference_id}

    users_map = {}
    if user_ids:
        u_rows = await db.execute(select(User).where(User.id.in_(list(user_ids))))
        for u in u_rows.scalars().all():
            name = f"{u.first_name} {u.last_name or ''}".strip() or u.username
            users_map[u.id] = name

    # Map dispatch orders to material issues
    do_to_mi = {}
    if do_ids:
        from app.models.dispatch import DispatchOrder
        do_rows = await db.execute(
            select(DispatchOrder.id, DispatchOrder.material_issue_id)
            .where(DispatchOrder.id.in_(list(do_ids)))
        )
        for r in do_rows.mappings().all():
            if r["material_issue_id"]:
                do_to_mi[r["id"]] = r["material_issue_id"]

    # Map dispatch acknowledgements to material issues
    ack_to_mi = {}
    if ack_ids:
        from app.models.dispatch import DispatchDeliveryAcknowledgement, DispatchOrder
        ack_rows = await db.execute(
            select(DispatchDeliveryAcknowledgement.id, DispatchOrder.material_issue_id)
            .join(DispatchOrder, DispatchDeliveryAcknowledgement.dispatch_id == DispatchOrder.id)
            .where(DispatchDeliveryAcknowledgement.id.in_(list(ack_ids)))
        )
        for r in ack_rows.mappings().all():
            if r["material_issue_id"]:
                ack_to_mi[r["id"]] = r["material_issue_id"]

    # Collect all material issue IDs (direct + resolved via dispatch/ack)
    all_mi_ids = set(mi_ids)
    all_mi_ids.update(do_to_mi.values())
    all_mi_ids.update(ack_to_mi.values())

    mi_map = {}
    if all_mi_ids:
        from app.models.issue import MaterialIssue
        m_rows = await db.execute(
            select(MaterialIssue.id, MaterialIssue.issue_number)
            .where(MaterialIssue.id.in_(list(all_mi_ids)))
        )
        for r in m_rows.mappings().all():
            mi_map[r["id"]] = r["issue_number"]

    po_map = {}
    if po_ids:
        from app.models.grn import PutawayOrder
        p_rows = await db.execute(
            select(PutawayOrder.id, PutawayOrder.putaway_number)
            .where(PutawayOrder.id.in_(list(po_ids)))
        )
        for r in p_rows.mappings().all():
            po_map[r["id"]] = r["putaway_number"]

    response_items = []
    for e in entries:
        data = StockLedgerResponse.model_validate(e).model_dump()
        data["item_name"] = e.item.name if hasattr(e, 'item') and e.item else None
        data["item_code"] = e.item.item_code if hasattr(e, 'item') and e.item else None
        data["warehouse_name"] = e.warehouse.name if hasattr(e, 'warehouse') and e.warehouse else None
        
        # Human-readable reference
        if e.reference_type == "material_issue":
            data["reference"] = mi_map.get(e.reference_id)
        elif e.reference_type == "dispatch_order":
            mi_id = do_to_mi.get(e.reference_id)
            data["reference"] = mi_map.get(mi_id) if mi_id else str(e.reference_id)
        elif e.reference_type == "dispatch_acknowledgement":
            mi_id = ack_to_mi.get(e.reference_id)
            data["reference"] = mi_map.get(mi_id) if mi_id else str(e.reference_id)
        elif e.reference_type == "putaway_order":
            data["reference"] = po_map.get(e.reference_id)
        else:
            data["reference"] = str(e.reference_id) if e.reference_id else None
            
        # Human-readable created_by
        data["created_by"] = users_map.get(e.created_by) if e.created_by else None
        
        response_items.append(data)

    return build_paginated_response(response_items, total, page, page_size)


# ==================== STOCK TRANSFER ====================

@router.get("/transfers")
async def list_transfers(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    source_warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(StockTransfer).options(
        selectinload(StockTransfer.items).selectinload(StockTransferItem.item),
        selectinload(StockTransfer.source_warehouse),
        selectinload(StockTransfer.destination_warehouse),
    )
    count_query = select(func.count(StockTransfer.id))

    if status:
        query = query.where(StockTransfer.status == status)
        count_query = count_query.where(StockTransfer.status == status)
    if source_warehouse_id:
        query = query.where(StockTransfer.source_warehouse_id == source_warehouse_id)
        count_query = count_query.where(StockTransfer.source_warehouse_id == source_warehouse_id)

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(StockTransfer.id.desc()))
    transfers = result.scalars().all()

    response_items = []
    for t in transfers:
        data = TransferResponse.model_validate(t).model_dump()
        data["source_warehouse_name"] = t.source_warehouse.name if t.source_warehouse else None
        data["destination_warehouse_name"] = t.destination_warehouse.name if t.destination_warehouse else None
        if data.get("items"):
            enriched_items = []
            for i, ti in enumerate(t.items):
                item_data = data["items"][i]
                item_data["item_name"] = ti.item.name if hasattr(ti, 'item') and ti.item else None
                item_data["item_code"] = ti.item.item_code if hasattr(ti, 'item') and ti.item else None
                enriched_items.append(item_data)
            data["items"] = enriched_items
        response_items.append(data)

    return build_paginated_response(response_items, total, page, page_size)


@router.get("/transfers/{transfer_id}", response_model=TransferResponse)
async def get_transfer(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(StockTransfer).options(
            selectinload(StockTransfer.items).selectinload(StockTransferItem.item)
        )
        .where(StockTransfer.id == transfer_id)
    )
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Transfer not found")

    data = TransferResponse.model_validate(t).model_dump()
    if data.get("items"):
        enriched_items = []
        for i, ti in enumerate(t.items):
            item_data = data["items"][i]
            item_data["item_name"] = ti.item.name if hasattr(ti, 'item') and ti.item else None
            item_data["item_code"] = ti.item.item_code if hasattr(ti, 'item') and ti.item else None
            enriched_items.append(item_data)
        data["items"] = enriched_items
    return data


@router.post("/transfers", status_code=201)
async def create_transfer(
    payload: TransferCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # BUG-INV-056: source_warehouse cannot equal destination_warehouse for
    # warehouse_to_warehouse / location_to_location transfers — creating a
    # transfer to itself is meaningless and produces a self-cancel ledger pair.
    # bin_to_bin is the legitimate exception (same warehouse, different bins).
    if (
        payload.source_warehouse_id == payload.destination_warehouse_id
        and getattr(payload, "transfer_type", None) != "bin_to_bin"
    ):
        raise HTTPException(
            status_code=400,
            detail="Source and destination warehouses must be different (except bin_to_bin)",
        )
    # BUG-INV-057: validate stock availability at the source warehouse before
    # accepting the transfer request. Optimized: Batch query for all items.
    item_ids = {it.item_id for it in payload.items if it.item_id}
    balance_map = {}
    if item_ids:
        bal_rows = await db.execute(
            select(StockBalance).where(
                StockBalance.warehouse_id == payload.source_warehouse_id,
                StockBalance.item_id.in_(item_ids)
            )
        )
        for b in bal_rows.scalars().all():
            balance_map[(b.item_id, b.batch_id, b.bin_id)] = b.available_qty

    for it in payload.items or []:
        avail = balance_map.get((it.item_id, it.batch_id, it.source_bin_id), Decimal("0"))
        if (it.qty or Decimal("0")) > avail:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Insufficient stock at source for item {it.item_id} "
                    f"(batch {it.batch_id}, bin {it.source_bin_id}): "
                    f"available={avail}, requested={it.qty}"
                ),
            )

    transfer_number = await generate_number(db, "warehouse", "stock_transfer")
    transfer = StockTransfer(
        transfer_number=transfer_number,
        source_warehouse_id=payload.source_warehouse_id,
        destination_warehouse_id=payload.destination_warehouse_id,
        transfer_date=payload.transfer_date,
        expected_date=payload.expected_date,
        transfer_type=payload.transfer_type,
        remarks=payload.remarks,
        requested_by=current_user.id,
    )
    db.add(transfer)
    await db.flush()

    for item in payload.items:
        ti = StockTransferItem(
            transfer_id=transfer.id, item_id=item.item_id, batch_id=item.batch_id,
            qty=item.qty, uom_id=item.uom_id, source_bin_id=item.source_bin_id,
            destination_bin_id=item.destination_bin_id,
        )
        db.add(ti)

    await db.flush()
    return {"id": transfer.id, "transfer_number": transfer_number, "message": "Transfer created"}


@router.post("/transfers/{transfer_id}/submit")
async def submit_transfer(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(StockTransfer).where(StockTransfer.id == transfer_id))
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Transfer not found")
    if t.status != "draft":
        raise HTTPException(status_code=400, detail="Only draft transfers can be submitted")
    t.status = "pending_approval"
    approval = await submit_for_approval(
        db, "inventory", "stock_transfer", t.id, t.transfer_number,
        current_user.id,
    )
    await db.flush()
    return {"success": True, "message": "Transfer submitted for approval", "approval_id": approval.id if approval else None}


@router.post("/transfers/{transfer_id}/approve")
async def approve_transfer(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("admin", "warehouse_manager", "approver")),
):
    result = await db.execute(
        select(StockTransfer).options(selectinload(StockTransfer.items))
        .where(StockTransfer.id == transfer_id)
    )
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Transfer not found")
    if t.status != "pending_approval":
        raise HTTPException(status_code=400, detail=f"Cannot approve transfer in '{t.status}' status. Must be 'pending_approval'.")

    # BUG-INV-063: re-verify stock at source between submit & approve.
    # Optimized: Batch query for all items.
    item_ids = {it.item_id for it in t.items if it.item_id}
    balance_map = {}
    if item_ids:
        bal_rows = await db.execute(
            select(StockBalance).where(
                StockBalance.warehouse_id == t.source_warehouse_id,
                StockBalance.item_id.in_(item_ids)
            )
        )
        for b in bal_rows.scalars().all():
            balance_map[(b.item_id, b.batch_id, b.bin_id)] = b.available_qty

    for it in t.items or []:
        avail = balance_map.get((it.item_id, it.batch_id, it.source_bin_id), Decimal("0"))
        if (it.qty or Decimal("0")) > avail:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Cannot approve — insufficient stock at source for item {it.item_id} "
                    f"(batch {it.batch_id}, bin {it.source_bin_id}): "
                    f"available={avail}, requested={it.qty}. "
                    "Resubmit the transfer with adjusted qty or rebalance source."
                ),
            )

    t.status = "approved"
    t.approved_by = current_user.id
    await db.flush()
    return {"success": True, "message": "Transfer approved"}


@router.post("/transfers/{transfer_id}/dispatch")
async def dispatch_transfer(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("admin", "warehouse_manager")),
):
    result = await db.execute(
        select(StockTransfer).options(selectinload(StockTransfer.items))
        .where(StockTransfer.id == transfer_id)
    )
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Transfer not found")
    if t.status != "approved":
        raise HTTPException(status_code=400, detail=f"Cannot dispatch transfer in '{t.status}' status. Must be 'approved'.")

    # BUG-INV-058: dispatch must be atomic across ALL lines. Without this,
    # a mid-loop InsufficientStockError leaves the source partially decremented
    # and the transfer status stuck on 'approved' — physical/system mismatch.
    # We use a SAVEPOINT so any failure rolls back every per-line change while
    # keeping the outer request transaction intact for error response.
    async with db.begin_nested():
        # Capture the moving-avg rate at source so we can credit destination
        # at the same valuation (BUG-INV-062 prep — store on the line).
        for item in t.items:
            ledger_row = await post_stock_ledger(
                db, item_id=item.item_id, warehouse_id=t.source_warehouse_id,
                transaction_type="transfer_out", qty_out=item.qty,
                bin_id=item.source_bin_id, batch_id=item.batch_id,
                reference_type="stock_transfer", reference_id=transfer_id,
                uom_id=item.uom_id, created_by=current_user.id,
            )
            item.status = "dispatched"
            # The ledger row's `rate` is the source-side weighted-average. We
            # don't have a dedicated column on StockTransferItem for it, but
            # /receive looks up the most recent transfer_out ledger row for
            # this transfer to read the rate back (BUG-INV-062).
            _ = ledger_row

        t.status = "in_transit"
    await db.flush()
    return {"success": True, "message": "Transfer dispatched"}


@router.post("/transfers/{transfer_id}/receive")
async def receive_transfer(
    transfer_id: int,
    payload: dict | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("admin", "warehouse_manager")),
):
    """Receive stock at destination.

    BUG-INV-061: support per-line received_qty in payload so partial receipts
    are possible (truck arrives short, damaged-in-transit, etc.). Body shape
    (optional): {items: [{transfer_item_id, received_qty, destination_bin_id?}]}.
    Falls back to received_qty=qty when not supplied.
    """
    result = await db.execute(
        select(StockTransfer).options(selectinload(StockTransfer.items))
        .where(StockTransfer.id == transfer_id)
    )
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Transfer not found")
    if t.status != "in_transit":
        raise HTTPException(status_code=400, detail=f"Cannot receive transfer in '{t.status}' status. Must be 'in_transit'.")

    # BUG-INV-067: enforce destination warehouse authorisation. The receiver
    # must be assigned to the destination warehouse (super_admin/admin bypass).
    from app.utils.dependencies import (
        get_user_role_codes as _get_role_codes,
        user_warehouse_ids as _user_wh_ids,
    )
    _role_codes = await _get_role_codes(db, current_user.id)
    if not ({"super_admin", "admin"} & set(_role_codes)):
        _wh_ids = await _user_wh_ids(db, current_user.id)
        if t.destination_warehouse_id not in _wh_ids:
            raise HTTPException(
                status_code=403,
                detail="You are not authorised to receive at the destination warehouse",
            )

    # BUG-INV-061: parse per-line received_qty from optional payload
    received_overrides: dict[int, Decimal] = {}
    bin_overrides: dict[int, int] = {}
    if isinstance(payload, dict) and isinstance(payload.get("items"), list):
        for entry in payload["items"]:
            try:
                tid = int(entry.get("transfer_item_id"))
                if "received_qty" in entry and entry["received_qty"] is not None:
                    received_overrides[tid] = Decimal(str(entry["received_qty"]))
                if entry.get("destination_bin_id") is not None:
                    bin_overrides[tid] = int(entry["destination_bin_id"])
            except (TypeError, ValueError):
                continue

    # BUG-INV-062: credit destination at the same rate as the source-side
    # transfer_out ledger row instead of defaulting to 0. Crediting at rate=0
    # diluted the destination warehouse valuation to zero on every transfer.
    for item in t.items:
        # BUG-INV-060: refuse to receive lines that were never dispatched. The
        # transfer-level status check above guards against bypassing dispatch
        # for the whole transfer, but a partial-dispatch flow could leave some
        # lines in 'pending' — they must not be receivable until dispatched.
        if item.status not in ("dispatched", "received"):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Cannot receive transfer_item {item.id}: line is in "
                    f"'{item.status}' state. Dispatch must complete first."
                ),
            )
        # BUG-INV-061: use override if provided, else default to dispatched qty
        recv_qty = received_overrides.get(item.id, item.qty)
        if recv_qty < 0:
            raise HTTPException(
                status_code=400,
                detail=f"received_qty cannot be negative for transfer_item {item.id}",
            )
        if recv_qty > (item.qty or Decimal("0")):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"received_qty {recv_qty} exceeds dispatched qty {item.qty} "
                    f"for transfer_item {item.id}"
                ),
            )
        # BUG-INV-059: if destination_bin_id is None on the line and a bin override
        # was provided, use it. Otherwise leave None and let stock sit at the
        # warehouse-level balance (caller can assign bin via a follow-up putaway).
        if item.id in bin_overrides:
            item.destination_bin_id = bin_overrides[item.id]
        item.received_qty = recv_qty
        item.status = "received"

        # Look up the matching source-side transfer_out row to recover rate.
        out_row = (await db.execute(
            select(StockLedger.rate)
            .where(
                StockLedger.reference_type == "stock_transfer",
                StockLedger.reference_id == transfer_id,
                StockLedger.transaction_type == "transfer_out",
                StockLedger.item_id == item.item_id,
                StockLedger.batch_id == item.batch_id if item.batch_id is not None else StockLedger.batch_id.is_(None),
            )
            .order_by(StockLedger.id.desc())
            .limit(1)
        )).first()
        recovered_rate = (out_row[0] if out_row and out_row[0] is not None else Decimal("0"))

        # BUG-INV-061: post the actual received qty (may be < dispatched).
        if recv_qty > 0:
            await post_stock_ledger(
                db, item_id=item.item_id, warehouse_id=t.destination_warehouse_id,
                transaction_type="transfer_in", qty_in=recv_qty,
                rate=recovered_rate,
                bin_id=item.destination_bin_id, batch_id=item.batch_id,
                reference_type="stock_transfer", reference_id=transfer_id,
                uom_id=item.uom_id, created_by=current_user.id,
            )

    # BUG-INV-061: if any line was short-received, leave at 'received' so it's
    # visible as not-yet-fully-completed; only flip to 'completed' on full receipt.
    short = any(
        (it.received_qty or Decimal("0")) < (it.qty or Decimal("0"))
        for it in t.items
    )
    t.status = "received" if short else "completed"
    await db.flush()
    return {"success": True, "message": "Transfer received"}


@router.post("/transfers/{transfer_id}/cancel")
async def cancel_transfer(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager",
    )),
):
    """BUG-INV-064: cancel a stock transfer.

    Allowed states:
    - draft / pending_approval / approved → just flip status to cancelled.
    - in_transit → reverse the source-side transfer_out ledger entries (so
      the source gets stock back) and flip the transfer to cancelled. Items
      already received at destination cannot be cancelled — issue a stock
      adjustment instead.
    - received / completed → refuse; create a fresh return-transfer instead.
    """
    result = await db.execute(
        select(StockTransfer).options(selectinload(StockTransfer.items))
        .where(StockTransfer.id == transfer_id)
        .with_for_update()
    )
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Transfer not found")
    if t.status in ("cancelled", "completed", "received"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot cancel transfer in '{t.status}' status",
        )

    if t.status == "in_transit":
        # Reverse the source-side transfer_out: push qty back IN at the same rate.
        for item in t.items:
            out_row = (await db.execute(
                select(StockLedger.rate)
                .where(
                    StockLedger.reference_type == "stock_transfer",
                    StockLedger.reference_id == transfer_id,
                    StockLedger.transaction_type == "transfer_out",
                    StockLedger.item_id == item.item_id,
                )
                .order_by(StockLedger.id.desc())
                .limit(1)
            )).first()
            recovered_rate = (out_row[0] if out_row and out_row[0] is not None else Decimal("0"))
            await post_stock_ledger(
                db,
                item_id=item.item_id,
                warehouse_id=t.source_warehouse_id,
                transaction_type="transfer_cancel",
                qty_in=item.qty,
                rate=recovered_rate,
                bin_id=item.source_bin_id,
                batch_id=item.batch_id,
                reference_type="stock_transfer_cancel",
                reference_id=transfer_id,
                uom_id=item.uom_id,
                created_by=current_user.id,
            )
            item.status = "pending"

    t.status = "cancelled"
    await db.flush()
    return {"success": True, "message": "Transfer cancelled"}


@router.post("/stock-transfers/{transfer_id}/cancel")
async def cancel_stock_transfer_alias(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager",
    )),
):
    """Alias: POST /inventory/stock-transfers/{id}/cancel."""
    return await cancel_transfer(transfer_id=transfer_id, db=db, current_user=current_user)


# ==================== STOCK AUDIT ====================

@router.get("/audits")
async def list_audits(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(StockAudit).options(
        selectinload(StockAudit.warehouse),
        selectinload(StockAudit.items).selectinload(StockAuditItem.item),
    )
    count_query = select(func.count(StockAudit.id))

    if status:
        query = query.where(StockAudit.status == status)
        count_query = count_query.where(StockAudit.status == status)
    if warehouse_id:
        query = query.where(StockAudit.warehouse_id == warehouse_id)
        count_query = count_query.where(StockAudit.warehouse_id == warehouse_id)

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(StockAudit.id.desc()))
    audits = result.scalars().all()

    items_list = []
    for a in audits:
        data = AuditResponse.model_validate(a).model_dump()
        data["warehouse_name"] = a.warehouse.name if a.warehouse else None
        # Add item names/codes to audit items
        if a.items and data.get("items"):
            for i, ai in enumerate(a.items):
                if i < len(data["items"]):
                    data["items"][i]["item_name"] = ai.item.name if ai.item else None
                    data["items"][i]["item_code"] = ai.item.item_code if ai.item else None
        items_list.append(data)

    return build_paginated_response(items_list, total, page, page_size)


@router.post("/audits", status_code=201)
async def create_audit(
    payload: AuditCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("admin", "warehouse_manager", "auditor")),
):
    audit_number = await generate_number(db, "warehouse", "stock_audit")
    variance_count = 0

    audit = StockAudit(
        audit_number=audit_number,
        warehouse_id=payload.warehouse_id,
        audit_date=payload.audit_date,
        audit_type=payload.audit_type,
        total_items=len(payload.items),
        conducted_by=current_user.id,
    )
    db.add(audit)
    await db.flush()

    for item in payload.items:
        variance = item.physical_qty - item.system_qty
        adj_type = "none"
        if variance > 0:
            adj_type = "increase"
            variance_count += 1
        elif variance < 0:
            adj_type = "decrease"
            variance_count += 1

        ai = StockAuditItem(
            audit_id=audit.id, item_id=item.item_id, bin_id=item.bin_id,
            batch_id=item.batch_id, system_qty=item.system_qty,
            physical_qty=item.physical_qty, variance_qty=variance,
            uom_id=item.uom_id, adjustment_type=adj_type, remarks=item.remarks,
        )
        db.add(ai)

    audit.variance_items = variance_count
    await db.flush()
    return {"id": audit.id, "audit_number": audit_number, "message": "Audit created"}


@router.post("/audits/{audit_id}/adjust")
async def adjust_audit(
    audit_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-INV-081: maker-checker — adjustments require a separate approver role
    # (not just the warehouse_manager who created the audit). super_admin/admin
    # bypass for emergency corrections.
    current_user: User = Depends(require_any_role("admin", "super_admin", "approver", "auditor")),
):
    """Apply stock adjustments based on audit findings.

    BUG-INV-080: refuses to re-post if audit already in 'completed' state, so
    the same audit cannot be replayed to double-credit stock.
    BUG-INV-081: caller must hold approver/auditor/admin role — the
    warehouse_manager who created the audit cannot self-approve adjustments
    (separation of duties).
    """
    result = await db.execute(
        select(StockAudit).options(selectinload(StockAudit.items))
        .where(StockAudit.id == audit_id)
    )
    audit = result.scalar_one_or_none()
    if not audit:
        raise HTTPException(status_code=404, detail="Audit not found")

    # BUG-INV-080: idempotency — only allow adjust on draft/pending_approval.
    if audit.status in ("completed", "cancelled", "rejected"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot adjust audit in '{audit.status}' status — already finalised.",
        )

    # BUG-INV-081: separation of duties — adjuster must not be the same person
    # who conducted the audit (super_admin bypass).
    if audit.conducted_by and audit.conducted_by == current_user.id:
        from app.utils.dependencies import get_user_role_codes as _gurc
        _codes = set(await _gurc(db, current_user.id))
        if "super_admin" not in _codes:
            raise HTTPException(
                status_code=403,
                detail=(
                    "You cannot approve an audit you conducted yourself. A different "
                    "user with approver/auditor/admin role must apply adjustments."
                ),
            )

    for item in audit.items:
        if item.adjustment_type != "none" and not item.adjusted:
            if item.adjustment_type == "increase":
                await post_stock_ledger(
                    db, item_id=item.item_id, warehouse_id=audit.warehouse_id,
                    transaction_type="adjustment", qty_in=abs(item.variance_qty),
                    bin_id=item.bin_id, batch_id=item.batch_id,
                    reference_type="stock_audit", reference_id=audit_id,
                    uom_id=item.uom_id, created_by=current_user.id,
                )
            else:
                await post_stock_ledger(
                    db, item_id=item.item_id, warehouse_id=audit.warehouse_id,
                    transaction_type="adjustment", qty_out=abs(item.variance_qty),
                    bin_id=item.bin_id, batch_id=item.batch_id,
                    reference_type="stock_audit", reference_id=audit_id,
                    uom_id=item.uom_id, created_by=current_user.id,
                )
            item.adjusted = True

    audit.status = "completed"
    audit.approved_by = current_user.id
    await db.flush()
    return {"success": True, "message": "Audit adjustments applied"}


# ==================== REPLENISHMENT RULES ====================

@router.get("/replenishment-rules")
async def list_replenishment_rules(
    item_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = select(BinReplenishmentRule).where(BinReplenishmentRule.is_active == True)
    if item_id:
        query = query.where(BinReplenishmentRule.item_id == item_id)
    result = await db.execute(query)
    rules = result.scalars().all()
    return [ReplenishmentRuleResponse.model_validate(r) for r in rules]


@router.post("/replenishment-rules", status_code=201)
async def create_replenishment_rule(
    payload: ReplenishmentRuleCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    rule = BinReplenishmentRule(**payload.model_dump())
    db.add(rule)
    await db.flush()
    return {"id": rule.id, "message": "Replenishment rule created"}


# ==================== MANUAL STOCK ENTRY ====================

class StockEntryItem(BaseModel):
    item_id: int
    warehouse_id: int
    qty: Decimal
    rate: Decimal = Decimal("0")
    uom_id: Optional[int] = None
    bin_id: Optional[int] = None
    batch_id: Optional[int] = None
    remarks: Optional[str] = None

class StockEntryCreate(BaseModel):
    entry_type: str = "opening"  # opening, adjustment_in, adjustment_out
    remarks: Optional[str] = None
    items: list[StockEntryItem]

from pydantic import BaseModel as BaseModel2

@router.post("/stock-entry", status_code=201)
async def manual_stock_entry(
    payload: StockEntryCreate,
    db: AsyncSession = Depends(get_db),
    # 2026-05-09 — manual stock entry is locked down to super_admin only
    # (data-fix bypass). The product flow forces all stock inbound through
    # GRN → QI → Putaway so batch/expiry/vendor traceability is preserved.
    current_user: User = Depends(require_any_role("super_admin")),
):
    """Manually add/adjust stock — opening stock, manual adjustments.

    BUG-INV-036: opening-balance entries must be one-shot per
    (item, warehouse, bin, batch). If a balance row already exists with any
    posted ledger entry, refuse a second 'opening' to prevent operators from
    silently double-counting starting stock.

    BUG-INV-038: rate=0 on opening or adjustment_in is rejected — without a
    cost figure the weighted-avg valuation gets diluted to zero on subsequent
    inbound moves. (adjustment_out is allowed at rate=0 since it doesn't
    affect valuation_rate calculation.)
    """
    from app.models.stock import StockLedger as _SL
    from app.models.warehouse import Batch as _Batch
    results = []
    for item in payload.items:
        tx_type = payload.entry_type or "opening"

        # BUG-INV-038: enforce non-zero rate on inbound posts
        if tx_type in ("opening", "adjustment_in"):
            if item.rate is None or Decimal(str(item.rate)) <= 0:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"rate > 0 is required for '{tx_type}' entries — a zero "
                        f"rate would corrupt weighted-average valuation."
                    ),
                )

        # BUG-INV-037: validate batch_id belongs to item_id. Without this,
        # a UI form bug or a typo'd batch_id can silently link a different
        # item's batch to this stock entry, contaminating the audit trail.
        if item.batch_id is not None:
            b_row = await db.execute(
                select(_Batch).where(_Batch.id == item.batch_id)
            )
            b_obj = b_row.scalar_one_or_none()
            if b_obj is None:
                raise HTTPException(
                    status_code=400,
                    detail=f"Batch {item.batch_id} not found",
                )
            if b_obj.item_id != item.item_id:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Batch {item.batch_id} (#{b_obj.batch_number}) belongs "
                        f"to item {b_obj.item_id}, not {item.item_id}"
                    ),
                )

        # BUG-INV-036: opening-balance lock — refuse a second 'opening' if any
        # ledger entry already exists for this (item, warehouse, bin, batch).
        if tx_type == "opening":
            conds = [
                _SL.item_id == item.item_id,
                _SL.warehouse_id == item.warehouse_id,
            ]
            if item.bin_id is not None:
                conds.append(_SL.bin_id == item.bin_id)
            else:
                conds.append(_SL.bin_id.is_(None))
            if item.batch_id is not None:
                conds.append(_SL.batch_id == item.batch_id)
            else:
                conds.append(_SL.batch_id.is_(None))
            existing_ledger = (await db.execute(
                select(func.count(_SL.id)).where(*conds)
            )).scalar() or 0
            if existing_ledger > 0:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Cannot post 'opening' — ledger already has {existing_ledger} "
                        f"entries for item {item.item_id} at warehouse {item.warehouse_id}. "
                        "Use 'adjustment_in' or 'adjustment_out' instead."
                    ),
                )

        if tx_type in ("opening", "adjustment_in"):
            qty_in = item.qty
            qty_out = Decimal("0")
        else:
            qty_in = Decimal("0")
            qty_out = item.qty

        ledger = await post_stock_ledger(
            db, item_id=item.item_id, warehouse_id=item.warehouse_id,
            transaction_type=tx_type, qty_in=qty_in, qty_out=qty_out,
            rate=item.rate, bin_id=item.bin_id, batch_id=item.batch_id,
            reference_type="manual_entry", uom_id=item.uom_id,
            created_by=current_user.id,
        )
        results.append({"item_id": item.item_id, "ledger_id": ledger.id, "balance_qty": float(ledger.balance_qty)})

    await db.flush()
    return {"success": True, "message": f"{len(results)} stock entries posted", "entries": results}


# ==================== ALIASES (frontend compatibility) ====================

@router.get("/stock-balance")
async def get_stock_balance_alias(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    item_id: str = Query(None),
    warehouse_id: int = Query(None),
    batch_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: GET /inventory/stock-balance -> delegates to /inventory/balance."""
    return await get_stock_balances(
        page=page, page_size=page_size, item_id=item_id,
        warehouse_id=warehouse_id, batch_id=batch_id,
        # BUG-INV-138: alias must pass category/batch as None, otherwise the
        # inner signature receives the raw Query(None) sentinel and crashes
        # on `batch.strip()`.
        category=None, batch=None,
        db=db, current_user=current_user,
    )


@router.get("/stock-ledger")
async def get_stock_ledger_alias(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    item_id: int = Query(None),
    warehouse_id: int = Query(None),
    transaction_type: str = Query(None),
    date_from: str = Query(None),
    date_to: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: GET /inventory/stock-ledger -> delegates to /inventory/ledger."""
    return await get_stock_ledger(page=page, page_size=page_size, item_id=item_id, warehouse_id=warehouse_id, transaction_type=transaction_type, date_from=date_from, date_to=date_to, db=db, current_user=current_user)


@router.get("/stock-transfers")
async def list_stock_transfers_alias(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    source_warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: GET /inventory/stock-transfers -> delegates to /inventory/transfers."""
    return await list_transfers(page=page, page_size=page_size, status=status, source_warehouse_id=source_warehouse_id, db=db, current_user=current_user)


@router.post("/stock-transfers", status_code=201)
async def create_stock_transfer_alias(
    payload: TransferCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: POST /inventory/stock-transfers -> delegates to /inventory/transfers."""
    return await create_transfer(payload=payload, db=db, current_user=current_user)


@router.get("/stock-transfers/{transfer_id}")
async def get_stock_transfer_alias(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: GET /inventory/stock-transfers/{id}."""
    return await get_transfer(transfer_id=transfer_id, db=db, current_user=current_user)


@router.post("/stock-transfers/{transfer_id}/submit")
async def submit_stock_transfer_alias(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: POST /inventory/stock-transfers/{id}/submit."""
    return await submit_transfer(transfer_id=transfer_id, db=db, current_user=current_user)


@router.post("/stock-transfers/{transfer_id}/approve")
async def approve_stock_transfer_alias(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("admin", "warehouse_manager", "approver")),
):
    """B1 fix: alias now enforces same role check as canonical route."""
    return await approve_transfer(transfer_id=transfer_id, db=db, current_user=current_user)


@router.post("/stock-transfers/{transfer_id}/dispatch")
async def dispatch_stock_transfer_alias(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("admin", "warehouse_manager")),
):
    """B1 fix: alias now enforces same role check as canonical route."""
    return await dispatch_transfer(transfer_id=transfer_id, db=db, current_user=current_user)


@router.post("/stock-transfers/{transfer_id}/receive")
async def receive_stock_transfer_alias(
    transfer_id: int,
    payload: dict | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("admin", "warehouse_manager")),
):
    """B1 fix: alias now enforces same role check as canonical route."""
    return await receive_transfer(transfer_id=transfer_id, payload=payload, db=db, current_user=current_user)


@router.get("/stock-audits")
async def list_stock_audits_alias(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: GET /inventory/stock-audits -> delegates to /inventory/audits."""
    return await list_audits(page=page, page_size=page_size, status=status, warehouse_id=warehouse_id, db=db, current_user=current_user)


@router.post("/stock-audits", status_code=201)
async def create_stock_audit_alias(
    payload: AuditCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("admin", "warehouse_manager", "auditor")),
):
    """Alias: POST /inventory/stock-audits -> delegates to /inventory/audits."""
    return await create_audit(payload=payload, db=db, current_user=current_user)


@router.put("/stock-audits/{audit_id}/complete")
async def complete_stock_audit(
    audit_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Mark a stock audit as completed."""
    result = await db.execute(select(StockAudit).where(StockAudit.id == audit_id))
    audit = result.scalar_one_or_none()
    if not audit:
        raise HTTPException(status_code=404, detail="Audit not found")
    audit.status = "completed"
    await db.flush()
    return {"success": True, "message": "Audit completed"}


@router.delete("/stock-audits/{audit_id}")
async def delete_stock_audit(
    audit_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a draft stock audit."""
    result = await db.execute(select(StockAudit).where(StockAudit.id == audit_id))
    audit = result.scalar_one_or_none()
    if not audit:
        raise HTTPException(status_code=404, detail="Audit not found")
    if audit.status not in ("draft", None):
        raise HTTPException(status_code=400, detail="Only draft audits can be deleted")
    await db.delete(audit)
    await db.flush()
    return {"success": True, "message": "Audit deleted"}


@router.post("/replenishment/trigger")
async def trigger_replenishment(
    warehouse_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Check replenishment rules and create actual bin-to-bin StockTransfer
    records for items below min_qty.

    BUG-INV-112: previously this only returned a JSON list — no actual
    transfer/movement was created so the warehouse never refilled. Now it
    creates a draft StockTransfer per triggered rule (status=draft) so the
    warehouse manager can review/approve via the regular transfer flow.
    """
    result = await db.execute(
        select(BinReplenishmentRule).where(BinReplenishmentRule.is_active == True)
    )
    rules = result.scalars().all()
    triggered = []

    from datetime import datetime as _dt, date as _date
    for rule in rules:
        # Check current qty in pick bin
        bal_result = await db.execute(
            select(StockBalance).where(
                StockBalance.item_id == rule.item_id,
                StockBalance.bin_id == rule.pick_bin_id,
            )
        )
        balance = bal_result.scalar_one_or_none()
        current_qty = float(balance.available_qty) if balance else 0

        if current_qty >= float(rule.min_qty):
            continue

        # BUG-INV-111: also confirm reserve bin actually has stock to give.
        reserve_bal = (await db.execute(
            select(StockBalance).where(
                StockBalance.item_id == rule.item_id,
                StockBalance.bin_id == rule.reserve_bin_id,
            )
        )).scalar_one_or_none()
        reserve_qty = float(reserve_bal.available_qty) if reserve_bal else 0
        replenish_qty = min(float(rule.replenish_qty), reserve_qty)
        if replenish_qty <= 0:
            triggered.append({
                "item_id": rule.item_id,
                "pick_bin_id": rule.pick_bin_id,
                "reserve_bin_id": rule.reserve_bin_id,
                "current_qty": current_qty,
                "replenish_qty": 0,
                "skipped_reason": "reserve bin empty",
            })
            continue

        # BUG-INV-112: actually create a draft bin-to-bin transfer task.
        try:
            transfer_number = await generate_number(db, "warehouse", "stock_transfer")
        except Exception:
            transfer_number = f"REPL-{warehouse_id}-{rule.id}-{_date.today().isoformat()}"
        transfer = StockTransfer(
            transfer_number=transfer_number,
            source_warehouse_id=warehouse_id,
            destination_warehouse_id=warehouse_id,  # bin-to-bin in same warehouse
            transfer_date=_dt.now(),
            transfer_type="bin_to_bin",
            remarks=f"Auto-replenishment from rule #{rule.id}",
            requested_by=current_user.id,
            status="draft",
        )
        db.add(transfer)
        await db.flush()
        ti = StockTransferItem(
            transfer_id=transfer.id,
            item_id=rule.item_id,
            qty=Decimal(str(replenish_qty)),
            source_bin_id=rule.reserve_bin_id,
            destination_bin_id=rule.pick_bin_id,
        )
        db.add(ti)
        triggered.append({
            "item_id": rule.item_id,
            "pick_bin_id": rule.pick_bin_id,
            "reserve_bin_id": rule.reserve_bin_id,
            "current_qty": current_qty,
            "replenish_qty": replenish_qty,
            "transfer_id": transfer.id,
            "transfer_number": transfer_number,
        })

    await db.flush()
    return {"triggered": triggered, "count": len(triggered)}
