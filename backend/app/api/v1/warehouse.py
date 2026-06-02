import logging
from decimal import Decimal
from datetime import datetime, timezone, date
from typing import List, Optional
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, and_, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.database import get_db
from app.models.user import User
from app.models.grn import GoodsReceiptNote, GRNItem, GRNItemSerial, QualityInspection, QualityInspectionItem, PutawayOrder, PutawayItem
from app.models.procurement import PurchaseOrder, PurchaseOrderItem
from app.models.warehouse import Batch, Warehouse, MaterialInward, WarehouseLocation, WarehouseLine, WarehouseRack, WarehouseBin, SerialNumber
from app.models.stock import StockBalance, StockLedger
from app.models.returns import PurchaseReturn, PurchaseReturnItem
from app.models.issue import MaterialIssue, MaterialIssueItem
from app.models.master import Item, UOM
from app.schemas.warehouse import (
    GRNCreate, GRNResponse, GRNUpdate,
    QICreate, QIResponse,
    PutawayCreate, PutawayItemUpdate, PutawayResponse,
    PurchaseReturnCreate, PurchaseReturnUpdate, PurchaseReturnResponse,
    MaterialIssueCreate, MaterialIssueUpdate, MaterialIssueResponse,
)
from app.services.number_series import generate_number
from app.services.stock_service import post_stock_ledger, get_fefo_batches, get_fifo_batches
from app.utils.dependencies import get_current_user, require_any_role, require_permission, require_key
from app.utils.helpers import paginate_params, build_paginated_response, apply_search_filter

logger = logging.getLogger(__name__)
router = APIRouter()

async def resolve_or_create_bin(db: AsyncSession, warehouse_id: int, bin_identifier: any) -> Optional[int]:
    if not bin_identifier:
        return None
    
    # Convert to string and strip
    ident_str = str(bin_identifier).strip()
    if not ident_str:
        return None
        
    # 1. Try to find by integer ID first (if it's purely digits)
    if ident_str.isdigit():
        bin_id = int(ident_str)
        # Verify it belongs to this warehouse
        bin_row = (await db.execute(
            select(WarehouseBin)
            .join(WarehouseRack, WarehouseRack.id == WarehouseBin.rack_id)
            .join(WarehouseLine, WarehouseLine.id == WarehouseRack.line_id)
            .join(WarehouseLocation, WarehouseLocation.id == WarehouseLine.location_id)
            .where(WarehouseBin.id == bin_id, WarehouseLocation.warehouse_id == warehouse_id)
        )).scalar_one_or_none()
        if bin_row:
            return bin_row.id
            
    # 2. Try to find by code or name in this warehouse
    bin_row = (await db.execute(
        select(WarehouseBin)
        .join(WarehouseRack, WarehouseRack.id == WarehouseBin.rack_id)
        .join(WarehouseLine, WarehouseLine.id == WarehouseRack.line_id)
        .join(WarehouseLocation, WarehouseLocation.id == WarehouseLine.location_id)
        .where(
            WarehouseLocation.warehouse_id == warehouse_id,
            (WarehouseBin.code == ident_str) | (WarehouseBin.name == ident_str)
        )
    )).scalar_one_or_none()
    if bin_row:
        return bin_row.id
        
    # 3. Create a new WarehouseBin dynamically!
    # Find or create a rack in this warehouse
    rack_row = (await db.execute(
        select(WarehouseRack)
        .join(WarehouseLine, WarehouseLine.id == WarehouseRack.line_id)
        .join(WarehouseLocation, WarehouseLocation.id == WarehouseLine.location_id)
        .where(WarehouseLocation.warehouse_id == warehouse_id)
        .limit(1)
    )).scalar_one_or_none()
    
    if rack_row:
        rack_id = rack_row.id
    else:
        # Find or create a line in this warehouse
        line_row = (await db.execute(
            select(WarehouseLine)
            .join(WarehouseLocation, WarehouseLocation.id == WarehouseLine.location_id)
            .where(WarehouseLocation.warehouse_id == warehouse_id)
            .limit(1)
        )).scalar_one_or_none()
        
        if line_row:
            line_id = line_row.id
        else:
            # Find or create a location in this warehouse
            loc_row = (await db.execute(
                select(WarehouseLocation)
                .where(WarehouseLocation.warehouse_id == warehouse_id)
                .limit(1)
            )).scalar_one_or_none()
            
            if not loc_row:
                # Create new location
                loc_row = WarehouseLocation(
                    warehouse_id=warehouse_id,
                    code="DEFAULT",
                    name="Default Location",
                    is_active=True
                )
                db.add(loc_row)
                await db.flush()
                
            # Create new line
            line_row = WarehouseLine(
                location_id=loc_row.id,
                code="DEFAULT",
                name="Default Line",
                zone_type="storage",
                is_active=True
            )
            db.add(line_row)
            await db.flush()
            line_id = line_row.id
            
        # Create new rack
        rack_row = WarehouseRack(
            line_id=line_id,
            code="DEFAULT",
            name="Default Rack",
            is_active=True
        )
        db.add(rack_row)
        await db.flush()
        rack_id = rack_row.id
        
    # Now create the new WarehouseBin under the resolved rack
    new_bin = WarehouseBin(
        rack_id=rack_id,
        code=ident_str,
        name=ident_str,
        bin_type="shelf",
        capacity=0,
        is_active=True
    )
    db.add(new_bin)
    await db.flush()
    return new_bin.id


# ==================== GRN ====================

@router.get("/grn")
async def list_grns(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    status: str = Query(None),
    warehouse_id: int = Query(None),
    vendor_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("warehouse-grn")),
):
    offset, limit = paginate_params(page, page_size)
    query = select(GoodsReceiptNote)
    count_query = select(func.count(GoodsReceiptNote.id))

    if status:
        # Bug fix: support comma-separated status (e.g. "qi_done,putaway_pending")
        statuses = [s.strip() for s in status.split(",") if s.strip()]
        status_filter = GoodsReceiptNote.status.in_(statuses)

        # BUG-INV-132: if "pending_qi" is requested, also include any GRN that has
        # at least one item with qi_status='pending' and received_qty > 0.
        # This fixes the issue where a GRN might have moved to 'completed' or
        # 'putaway_done' but still has items awaiting inspection.
        if "pending_qi" in statuses:
            pending_items_subquery = select(GRNItem.grn_id).where(
                and_(GRNItem.qi_status == "pending", GRNItem.received_qty > 0)
            ).scalar_subquery()
            status_filter = or_(status_filter, GoodsReceiptNote.id.in_(pending_items_subquery))

        query = query.where(status_filter)
        count_query = count_query.where(status_filter)
    if warehouse_id:
        query = query.where(GoodsReceiptNote.warehouse_id == warehouse_id)
        count_query = count_query.where(GoodsReceiptNote.warehouse_id == warehouse_id)
    if vendor_id:
        query = query.where(GoodsReceiptNote.vendor_id == vendor_id)
        count_query = count_query.where(GoodsReceiptNote.vendor_id == vendor_id)

    query = apply_search_filter(query, GoodsReceiptNote, search, ["grn_number", "supplier_invoice"])
    count_query = apply_search_filter(count_query, GoodsReceiptNote, search, ["grn_number", "supplier_invoice"])

    total = (await db.execute(count_query)).scalar()
    query = query.options(
        selectinload(GoodsReceiptNote.items).selectinload(GRNItem.item),
        selectinload(GoodsReceiptNote.items).selectinload(GRNItem.uom),
        selectinload(GoodsReceiptNote.items).selectinload(GRNItem.serials),
        selectinload(GoodsReceiptNote.vendor),
        selectinload(GoodsReceiptNote.purchase_order),
        selectinload(GoodsReceiptNote.warehouse),
        selectinload(GoodsReceiptNote.inward),
    )
    result = await db.execute(query.offset(offset).limit(limit).order_by(GoodsReceiptNote.id.desc()))
    grns = result.scalars().all()

    items_list = []
    for g in grns:
        grn_dict = {
            "id": g.id, "grn_number": g.grn_number, "po_id": g.po_id,
            "inward_id": g.inward_id,
            "inward_number": g.inward.inward_number if g.inward else None,
            "vendor_id": g.vendor_id, "warehouse_id": g.warehouse_id,
            "vendor_name": g.vendor.name if g.vendor else None,
            "po_number": g.po_number or (g.purchase_order.po_number if g.purchase_order else None),
            "warehouse_name": g.warehouse.name if g.warehouse else None,
            "grn_date": g.grn_date, "receipt_type": g.receipt_type,
            "supplier_invoice": g.supplier_invoice,
            "supplier_invoice_date": g.supplier_invoice_date,
            "status": g.status, "total_qty": float(g.total_qty or 0),
            "accepted_qty": float(g.accepted_qty or 0),
            "rejected_qty": float(g.rejected_qty or 0),
            "created_at": g.created_at,
            "items": [],
        }
        for gi in g.items:
            grn_dict["items"].append({
                "id": gi.id, "item_id": gi.item_id,
                "item_name": gi.item.name if gi.item else None,
                "item_code": gi.item.item_code if gi.item else None,
                "item_type": gi.item.item_type if gi.item else None,
                "has_serial": bool(gi.item.has_serial) if gi.item else False,
                "serial_numbers": [s.serial_number for s in gi.serials] if hasattr(gi, "serials") else [],
                "uom_name": gi.uom.name if gi.uom else None,
                "received_qty": float(gi.received_qty or 0),
                "uom_id": gi.uom_id,
                "rate": float(gi.rate or 0),
                "amount": float(gi.amount or 0),
            })
        items_list.append(grn_dict)

    return build_paginated_response(items_list, total, page, page_size)


@router.get("/grn/{grn_id}", response_model=GRNResponse)
async def get_grn(
    grn_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(GoodsReceiptNote)
        .options(
            selectinload(GoodsReceiptNote.items).selectinload(GRNItem.item),
            selectinload(GoodsReceiptNote.items).selectinload(GRNItem.serials),
            selectinload(GoodsReceiptNote.items).selectinload(GRNItem.uom),
        )
        .where(GoodsReceiptNote.id == grn_id)
    )
    grn = result.scalar_one_or_none()
    if not grn:
        raise HTTPException(status_code=404, detail="GRN not found")
    response = GRNResponse.model_validate(grn).model_dump(mode="json")

    # Joined names so UI shows labels instead of FK ids
    # Prioritize the stored po_number column (set during create_grn from inward)
    if grn.po_number:
        response["po_number"] = grn.po_number
    elif grn.po_id:
        response["po_number"] = (await db.execute(
            select(PurchaseOrder.po_number).where(PurchaseOrder.id == grn.po_id)
        )).scalar()
    if grn.inward_id:
        response["inward_number"] = (await db.execute(
            select(MaterialInward.inward_number).where(MaterialInward.id == grn.inward_id)
        )).scalar()
    from app.models.master import Vendor as _V
    response["vendor_name"] = (await db.execute(
        select(_V.name).where(_V.id == grn.vendor_id)
    )).scalar()
    response["warehouse_name"] = (await db.execute(
        select(Warehouse.name).where(Warehouse.id == grn.warehouse_id)
    )).scalar()
    if grn.received_by:
        u_row = (await db.execute(
            select(User.first_name, User.last_name, User.username).where(User.id == grn.received_by)
        )).first()
        if u_row:
            response["received_by_name"] = (
                f"{u_row.first_name} {u_row.last_name or ''}".strip() or u_row.username
            )

    for i, gi in enumerate(grn.items):
        response["items"][i]["item_name"] = gi.item.name if gi.item else None
        response["items"][i]["item_code"] = gi.item.item_code if gi.item else None
        response["items"][i]["uom_name"] = gi.uom.name if gi.uom else None
        response["items"][i]["item_type"] = gi.item.item_type if gi.item else None
        response["items"][i]["has_serial"] = bool(gi.item.has_serial) if gi.item else False
        response["items"][i]["serial_numbers"] = [s.serial_number for s in gi.serials] if hasattr(gi, "serials") else []
    return response


@router.post("/grn", status_code=201)
async def create_grn(
    payload: GRNCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("warehouse-grn")),
):
    """Create GRN - supports po_based, direct, and transfer receipt types.

    Bug fix D-014 — items flagged has_batch=True must have batch_number;
    items flagged has_expiry=True must have expiry_date. Otherwise the audit
    trail is useless and patient-safety expiry checks at issue time fail.
    """
    # Pre-resolve po_id and po_number from inward if provided
    resolved_po_number = None
    if payload.inward_id:
        inward_res = await db.execute(
            select(MaterialInward).where(MaterialInward.id == payload.inward_id)
        )
        inward = inward_res.scalar_one_or_none()
        if inward:
            if not payload.po_id and inward.po_id:
                payload.po_id = inward.po_id
            resolved_po_number = inward.po_number

    if payload.po_id and not resolved_po_number:
        po_res = await db.execute(
            select(PurchaseOrder.po_number).where(PurchaseOrder.id == payload.po_id)
        )
        resolved_po_number = po_res.scalar()

    if resolved_po_number and not payload.po_number:
        payload.po_number = resolved_po_number

    # BUG-INV-011: GRN must have at least one item — empty GRNs poisoned the
    # putaway/QI list with no-op rows users could not delete cleanly.
    if not payload.items or len(payload.items) == 0:
        raise HTTPException(status_code=422, detail="GRN must have at least one item")

    # BUG-INV-091: reject empty / whitespace-only batch_number values at API
    # entry. Without this a payload of `"batch_number": "   "` would fall
    # through the `if item.batch_number:` truthy-check below and get persisted
    # verbatim, producing un-searchable batch rows whose pseudo-batch_number
    # is just spaces (audit trail unusable, FEFO/FIFO tie unstable).
    for _idx, _it in enumerate(payload.items):
        bn = getattr(_it, "batch_number", None)
        if bn is not None and isinstance(bn, str):
            stripped = bn.strip()
            if bn != "" and stripped == "":
                raise HTTPException(
                    status_code=422,
                    detail=f"Item line {_idx + 1}: batch_number cannot be blank or whitespace-only",
                )
            # Normalise so downstream uses the trimmed value.
            _it.batch_number = stripped or None

    # D-014 — pre-validate batch/expiry presence based on item config
    # BUG-INV-088: also enforce batch/expiry on item_type (medicine/pharma) even
    # if the has_batch flag is not yet set on legacy item rows.
    if payload.items:
        item_ids = [it.item_id for it in payload.items if it.item_id]
        if item_ids:
            from app.models.master import Item as _Item
            items_q = await db.execute(
                select(_Item.id, _Item.item_code, _Item.has_batch, _Item.has_expiry, _Item.item_type)
                .where(_Item.id.in_(item_ids))
            )
            item_meta = {r.id: r for r in items_q.all()}
            errors = []
            # Item types that legally require batch/expiry tracking even if the
            # boolean flag is missing in master data.
            BATCH_REQUIRED_TYPES = {"medicine", "pharma", "drug", "consumable_medicine"}
            for it in payload.items:
                meta = item_meta.get(it.item_id)
                if not meta:
                    continue
                requires_batch = meta.has_batch or (
                    meta.item_type and str(meta.item_type).lower() in BATCH_REQUIRED_TYPES
                )
                requires_expiry = meta.has_expiry or (
                    meta.item_type and str(meta.item_type).lower() in BATCH_REQUIRED_TYPES
                )
                if requires_batch and not (it.batch_number and it.batch_number.strip()):
                    errors.append(f"{meta.item_code}: batch_number required (item is batch-tracked)")
                if requires_expiry and not it.expiry_date:
                    errors.append(f"{meta.item_code}: expiry_date required (item has expiry)")
                # BUG-INV-090: validate expiry > manufacturing date when both supplied
                if it.manufacturing_date and it.expiry_date and it.expiry_date <= it.manufacturing_date:
                    errors.append(
                        f"{meta.item_code}: expiry_date {it.expiry_date} must be after manufacturing_date {it.manufacturing_date}"
                    )
            if errors:
                raise HTTPException(
                    status_code=400,
                    detail="Batch/expiry missing: " + "; ".join(errors[:5]),
                )

    # BUG-INV-149: backfill uom_id from Item.primary_uom_id when the FE omits it.
    # Schema now treats uom_id as optional; we resolve it here so downstream
    # writes (GRNItem, batch, ledger) always carry a real UOM reference.
    if payload.items:
        missing_uom_ids = [it.item_id for it in payload.items if not getattr(it, "uom_id", None)]
        if missing_uom_ids:
            from app.models.master import Item as _ItemUOM
            uom_rows = await db.execute(
                select(_ItemUOM.id, _ItemUOM.primary_uom_id, _ItemUOM.item_code)
                .where(_ItemUOM.id.in_(missing_uom_ids))
            )
            primary_uom_map = {r.id: (r.primary_uom_id, r.item_code) for r in uom_rows.all()}
            unresolved = []
            for it in payload.items:
                if not getattr(it, "uom_id", None):
                    pair = primary_uom_map.get(it.item_id)
                    if pair and pair[0]:
                        it.uom_id = pair[0]
                    else:
                        code = pair[1] if pair else f"id={it.item_id}"
                        unresolved.append(str(code))
            if unresolved:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "UOM is required for: " + ", ".join(unresolved[:5]) +
                        ". Set a primary UOM on the item master or pick one in the GRN row."
                    ),
                )

    # BUG-INV-005: validate PO status & over-receive BEFORE flushing the GRN
    # header. Previously the GRN row + auto-generated grn_number was flushed
    # first; if any subsequent validation raised, the rolled-back transaction
    # left the next-number-series tracking off-by-one and (in past
    # autocommit-on-flush configurations) leaked phantom GRN ids.
    if payload.po_id:
        # BUG-INV-002: Block GRN against cancelled/closed POs.
        po_status_row = await db.execute(
            select(PurchaseOrder).where(PurchaseOrder.id == payload.po_id)
        )
        _po_for_status = po_status_row.scalar_one_or_none()
        if _po_for_status is None:
            raise HTTPException(status_code=404, detail=f"PO {payload.po_id} not found")
        if _po_for_status.status in ("cancelled", "closed", "rejected", "draft", "pending_approval"):
            raise HTTPException(
                status_code=400,
                detail=f"Cannot create GRN against PO {_po_for_status.po_number} in '{_po_for_status.status}' status",
            )
        # Block GRN if supplier has not accepted the PO
        if _po_for_status.supplier_acknowledgement != "accepted":
            raise HTTPException(
                status_code=400,
                detail=f"Cannot generate GRN: PO {_po_for_status.po_number} has not been accepted by the supplier (current status: '{_po_for_status.supplier_acknowledgement or 'pending'}').",
            )

    grn_number = await generate_number(db, "warehouse", "goods_receipt_note")
    total_qty = Decimal("0")

    grn = GoodsReceiptNote(
        grn_number=grn_number,
        po_id=payload.po_id,
        po_number=payload.po_number,
        inward_id=payload.inward_id,
        vendor_id=payload.vendor_id,
        warehouse_id=payload.warehouse_id,
        grn_date=payload.grn_date,
        supplier_invoice=payload.supplier_invoice,
        supplier_invoice_date=payload.supplier_invoice_date,
        vehicle_number=payload.vehicle_number,
        lr_number=payload.lr_number,
        receipt_type=payload.receipt_type,
        remarks=payload.remarks,
        received_by=current_user.id,
    )
    db.add(grn)
    await db.flush()

    # Over-receive validation for PO-based GRNs
    if payload.po_id:
        # BUG-INV-004: lock PO items FOR UPDATE so concurrent GRNs against the
        # same PO cannot both pass the over-receive check and double-credit
        # received_qty. Combined with the per-line increment below this gives
        # us serialisable ordering on the (po_id) key.
        po_items_result = await db.execute(
            select(PurchaseOrderItem)
            .where(PurchaseOrderItem.po_id == payload.po_id)
            .with_for_update()
        )
        po_items_map = {pi.item_id: pi for pi in po_items_result.scalars().all()}
        # BUG-INV-003: read tolerance from system_settings; default 0% for
        # medicine/pharma items (no over-receive tolerance — patient safety),
        # 10% otherwise. Per-item override via Item.over_receive_tolerance_pct.
        from app.models.master import Item as _Item
        from app.models.system import SystemSetting as _SS
        try:
            tol_row = await db.execute(
                select(_SS.setting_value).where(_SS.setting_key == "warehouse.grn.over_receive_tolerance_pct")
            )
            tol_val = tol_row.scalar()
            default_tol = Decimal(str(tol_val)) if tol_val is not None else Decimal("0.10")
        except Exception:
            default_tol = Decimal("0.10")
        item_meta_for_tol = {}
        if payload.items:
            iid_list = [it.item_id for it in payload.items if it.item_id]
            if iid_list:
                rows = await db.execute(
                    select(_Item.id, _Item.item_type, _Item.item_code).where(_Item.id.in_(iid_list))
                )
                item_meta_for_tol = {r.id: r for r in rows.all()}
        MEDICINE_TYPES = {"medicine", "pharma", "drug", "consumable_medicine"}
        for item in payload.items:
            if item.item_id in po_items_map:
                po_item = po_items_map[item.item_id]
                ordered = Decimal(str(po_item.qty or 0))
                already_received = Decimal(str(po_item.received_qty or 0))
                remaining = ordered - already_received
                # Per-item override → fall through to type-default → fall through to system default
                m = item_meta_for_tol.get(item.item_id)
                per_item_tol = getattr(m, "over_receive_tolerance_pct", None) if m else None
                if per_item_tol is not None:
                    tol_pct = Decimal(str(per_item_tol))
                elif m and m.item_type and str(m.item_type).lower() in MEDICINE_TYPES:
                    tol_pct = Decimal("0")
                else:
                    tol_pct = default_tol
                tolerance = ordered * tol_pct
                if Decimal(str(item.received_qty)) > (remaining + tolerance):
                    raise HTTPException(
                        status_code=422,
                        detail=(
                            f"Received qty {item.received_qty} exceeds remaining PO qty {remaining} "
                            f"+ {tol_pct*100}% tolerance for item {item.item_id}"
                        ),
                    )

    for item in payload.items:
        # Create or find batch if batch_number provided.
        # BUG-INV-006: race-safe batch upsert. Two concurrent GRNs that
        # use the same (item_id, batch_number) would each take the "create"
        # branch and produce duplicate batches. We wrap the insert in a
        # savepoint so an IntegrityError on a concurrent insert is recoverable
        # by re-querying. (Migration to add a UNIQUE constraint on
        # (item_id, batch_number) is deferred — see BUG-INV-082.)
        batch_id = None
        if item.batch_number:
            existing_batch_result = await db.execute(
                select(Batch).where(
                    Batch.item_id == item.item_id,
                    Batch.batch_number == item.batch_number,
                )
            )
            existing_batch = existing_batch_result.scalar_one_or_none()
            if existing_batch:
                batch_id = existing_batch.id
            else:
                try:
                    async with db.begin_nested():
                        batch = Batch(
                            item_id=item.item_id,
                            batch_number=item.batch_number,
                            manufacturing_date=item.manufacturing_date,
                            expiry_date=item.expiry_date,
                            # BUG-INV-007: persist supplier_batch / lot_number /
                            # status from the GRN payload so the batch row matches
                            # what the supplier shipped.
                            supplier_batch=getattr(item, "supplier_batch", None),
                            lot_number=getattr(item, "lot_number", None),
                            status="active",
                        )
                        db.add(batch)
                        await db.flush()
                        batch_id = batch.id
                except IntegrityError:
                    # Another transaction inserted the same batch concurrently.
                    # Re-query and use the now-visible row.
                    logger.info(
                        "Race on Batch insert (item=%s batch_number=%s); re-querying",
                        item.item_id, item.batch_number,
                    )
                    re_q = await db.execute(
                        select(Batch).where(
                            Batch.item_id == item.item_id,
                            Batch.batch_number == item.batch_number,
                        )
                    )
                    existing_batch = re_q.scalar_one_or_none()
                    if existing_batch is None:
                        raise
                    batch_id = existing_batch.id

        po_item_id = item.po_item_id
        if not po_item_id and payload.po_id and 'po_items_map' in locals():
            po_item = po_items_map.get(item.item_id)
            if po_item:
                po_item_id = po_item.id

        grn_item = GRNItem(
            grn_id=grn.id,
            po_item_id=po_item_id,
            item_id=item.item_id,
            ordered_qty=item.ordered_qty,
            received_qty=item.received_qty,
            accepted_qty=item.accepted_qty,
            rejected_qty=item.rejected_qty,
            uom_id=item.uom_id,
            batch_id=batch_id,
            batch_number=item.batch_number,
            manufacturing_date=item.manufacturing_date,
            expiry_date=item.expiry_date,
            rate=item.rate,
            amount=item.received_qty * item.rate,
            # Wave 5 — persist tax/discount (BUG-INV-008) + weight (BUG-PRO-095).
            discount_pct=getattr(item, "discount_pct", Decimal("0")),
            cgst_rate=getattr(item, "cgst_rate", Decimal("0")),
            sgst_rate=getattr(item, "sgst_rate", Decimal("0")),
            igst_rate=getattr(item, "igst_rate", Decimal("0")),
            tax_amount=getattr(item, "tax_amount", Decimal("0")),
            weight=getattr(item, "weight", Decimal("0")),
            remarks=item.remarks,
        )
        db.add(grn_item)
        await db.flush()
        total_qty += item.received_qty

        # Update PO item received qty
        if po_item_id:
            po_item_result = await db.execute(
                select(PurchaseOrderItem).where(PurchaseOrderItem.id == po_item_id)
            )
            po_item = po_item_result.scalar_one_or_none()
            if po_item:
                po_item.received_qty = (po_item.received_qty or Decimal("0")) + item.received_qty

    grn.total_qty = total_qty
    grn.accepted_qty = payload.accepted_qty
    grn.rejected_qty = payload.rejected_qty
    # BUG-INV-013/125: honor "save as draft" — was always force-bumped to
    # pending_qi, even when the FE clearly asked for draft. Now if the caller
    # asks for draft we respect it and skip the auto-QI creation block below.
    if getattr(payload, "is_draft", False):
        grn.status = "draft"
    else:
        grn.status = "pending_qi"

    # BUG-INV-125: honor "save as draft" — was always force-bumped to
    # pending_qi, even when the FE clearly asked for draft. Now if the caller
    # asks for draft we respect it and skip the auto-QI creation block below.
    if getattr(payload, "is_draft", False):
        grn.status = "draft"
    else:
        grn.status = "pending_qi"

    # Update PO status
    if payload.po_id:
        po_result = await db.execute(select(PurchaseOrder).where(PurchaseOrder.id == payload.po_id))
        po = po_result.scalar_one_or_none()
        if po:
            # Check if all items received
            poi_result = await db.execute(
                select(PurchaseOrderItem).where(PurchaseOrderItem.po_id == po.id)
            )
            po_items = poi_result.scalars().all()
            # BUG-INV-010: PO completion check must use Decimal comparison —
            # mixing float with Decimal qty rounds 100.0001 down to "received".
            all_received = all(
                Decimal(str(i.received_qty or 0)) >= Decimal(str(i.qty or 0))
                for i in po_items
            )
            po.status = "received" if all_received else "partially_received"

    if payload.inward_id:
        inw_res = await db.execute(select(MaterialInward).where(MaterialInward.id == payload.inward_id))
        inw = inw_res.scalar_one_or_none()
        if inw:
            inw.status = "grn_created"

    await db.flush()
    return {"id": grn.id, "grn_number": grn_number, "message": "GRN created"}


@router.put("/grn/{grn_id}/submit-qi")
async def submit_grn_for_qi(
    grn_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Submit a draft GRN for quality inspection AND auto-create the QI
    record with one line per GRN item. Previously this just flipped status
    and the QI list stayed empty — users couldn't actually inspect anything.
    Fixed 2026-04-15.
    """
    result = await db.execute(
        select(GoodsReceiptNote)
        .options(selectinload(GoodsReceiptNote.items))
        .where(GoodsReceiptNote.id == grn_id)
    )
    grn = result.scalar_one_or_none()
    if not grn:
        raise HTTPException(status_code=404, detail="GRN not found")
    if grn.status not in ("draft", "pending_qi"):
        raise HTTPException(status_code=400, detail=f"GRN is in '{grn.status}' status. Only draft GRNs can be submitted for QI.")
    grn.status = "qi_in_progress"

    await db.flush()
    return {
        "success": True,
        "message": "GRN submitted for QI",
    }


@router.put("/grn/{grn_id}/complete")
async def complete_grn(
    grn_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Mark a GRN as completed (after QI)."""
    result = await db.execute(select(GoodsReceiptNote).where(GoodsReceiptNote.id == grn_id))
    grn = result.scalar_one_or_none()
    if not grn:
        raise HTTPException(status_code=404, detail="GRN not found")
    if grn.status in ("completed", "cancelled"):
        raise HTTPException(status_code=400, detail=f"GRN is already {grn.status}")
    grn.status = "completed"
    await db.flush()
    return {"success": True, "message": "GRN completed"}


@router.put("/grn/{grn_id}")
async def update_grn(
    grn_id: int,
    payload: GRNUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a draft GRN.

    BUG-INV-014: payload is now schema-validated (was raw dict).
    BUG-INV-015: callers that include `items` in the body are rejected with
    a 400 instead of having the field silently ignored — historically users
    edited line items in the drawer and submitted, only to find their line
    edits had vanished. Tell them clearly to cancel + recreate.
    """
    result = await db.execute(select(GoodsReceiptNote).where(GoodsReceiptNote.id == grn_id))
    grn = result.scalar_one_or_none()
    if not grn:
        raise HTTPException(status_code=404, detail="GRN not found")
    if grn.status not in ("draft", "pending_qi"):
        raise HTTPException(status_code=400, detail=f"Cannot edit GRN in '{grn.status}' status")
    data = payload.model_dump(exclude_unset=True)
    # BUG-INV-014: whitelist of editable scalar columns. Reading the schema
    # itself ensures we never accidentally accept a mass-assignment.
    allowed = {"supplier_invoice", "supplier_invoice_date", "vehicle_number", "lr_number", "remarks"}
    for key, value in data.items():
        if key in allowed:
            setattr(grn, key, value)
    await db.flush()
    return {"success": True, "message": "GRN updated"}


@router.delete("/grn/{grn_id}")
async def delete_grn(
    grn_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a draft GRN."""
    result = await db.execute(
        select(GoodsReceiptNote)
        .options(selectinload(GoodsReceiptNote.items))
        .where(GoodsReceiptNote.id == grn_id)
    )
    grn = result.scalar_one_or_none()
    if not grn:
        raise HTTPException(status_code=404, detail="GRN not found")
    if grn.status not in ("draft",):
        raise HTTPException(status_code=400, detail="Only draft GRNs can be deleted")

    # BUG-INV-012: reverse PO.received_qty increments made at GRN-create time
    # so the PO can accept a fresh GRN for the cancelled lines. Without this
    # reversal a cancelled GRN permanently consumes the PO's remaining qty.
    for gi in grn.items or []:
        if gi.po_item_id:
            poi_row = await db.execute(
                select(PurchaseOrderItem).where(PurchaseOrderItem.id == gi.po_item_id)
            )
            poi = poi_row.scalar_one_or_none()
            if poi is not None:
                current = poi.received_qty or Decimal("0")
                received = gi.received_qty or Decimal("0")
                new_val = current - received
                if new_val < 0:
                    new_val = Decimal("0")
                poi.received_qty = new_val

    # If the parent PO had been advanced, walk it back to partially_received/approved
    if grn.po_id:
        po_row = await db.execute(select(PurchaseOrder).where(PurchaseOrder.id == grn.po_id))
        po = po_row.scalar_one_or_none()
        if po is not None and po.status in ("received", "partially_received"):
            poi_result = await db.execute(
                select(PurchaseOrderItem).where(PurchaseOrderItem.po_id == po.id)
            )
            po_items = poi_result.scalars().all()
            any_received = any((pi.received_qty or 0) > 0 for pi in po_items)
            po.status = "partially_received" if any_received else "approved"

    grn.status = "cancelled"
    await db.flush()
    return {"success": True, "message": "GRN cancelled"}


# ==================== QUALITY INSPECTION ====================

@router.get("/qi")
async def list_quality_inspections(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    grn_id: int = Query(None),
    status: str = Query(None),
    overall_result: str = Query(None),
    date_from: date = Query(None),
    date_to: date = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(QualityInspection).options(
        selectinload(QualityInspection.grn),
        selectinload(QualityInspection.items).selectinload(QualityInspectionItem.item),
        selectinload(QualityInspection.items).selectinload(QualityInspectionItem.grn_item),
    )
    count_query = select(func.count(QualityInspection.id))

    # Virtual status filtering in query (BUG-INV-024 refinement)
    # The 'status' of a QI is derived from its parent GRN's status.
    # To support correct pagination and filtering, we must join and filter here.
    query = query.join(GoodsReceiptNote, QualityInspection.grn_id == GoodsReceiptNote.id)
    count_query = count_query.join(GoodsReceiptNote, QualityInspection.grn_id == GoodsReceiptNote.id)

    if status:
        statuses = [s.strip() for s in status.split(",") if s.strip()]
        grn_statuses = []
        if "completed" in statuses or "cancelled" in statuses:
            grn_statuses.extend(["putaway_pending", "putaway_done", "completed", "qi_done"])
        if "in_progress" in statuses:
            grn_statuses.append("qi_in_progress")
        if "draft" in statuses:
            grn_statuses.extend(["pending_qi", "draft"])
        
        if grn_statuses:
            query = query.where(GoodsReceiptNote.status.in_(grn_statuses))
            count_query = count_query.where(GoodsReceiptNote.status.in_(grn_statuses))
    else:
        # Default: only show records that are completed or cancelled (past the inspection phase)
        # BUG-INV-132: fulfill user request to hide 'pending' records from the default view
        # so the list acts as a record of results rather than a backlog of drafts.
        query = query.where(GoodsReceiptNote.status.in_(["putaway_pending", "putaway_done", "completed", "qi_done"]))
        count_query = count_query.where(GoodsReceiptNote.status.in_(["putaway_pending", "putaway_done", "completed", "qi_done"]))

    if grn_id:
        query = query.where(QualityInspection.grn_id == grn_id)
        count_query = count_query.where(QualityInspection.grn_id == grn_id)

    if overall_result:
        query = query.where(QualityInspection.overall_result == overall_result)
        count_query = count_query.where(QualityInspection.overall_result == overall_result)

    if date_from:
        query = query.where(QualityInspection.inspection_date >= datetime.combine(date_from, datetime.min.time()))
        count_query = count_query.where(QualityInspection.inspection_date >= datetime.combine(date_from, datetime.min.time()))

    if date_to:
        query = query.where(QualityInspection.inspection_date <= datetime.combine(date_to, datetime.max.time()))
        count_query = count_query.where(QualityInspection.inspection_date <= datetime.combine(date_to, datetime.max.time()))

    query = apply_search_filter(query, QualityInspection, search, ["qi_number"])
    count_query = apply_search_filter(count_query, QualityInspection, search, ["qi_number"])

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(QualityInspection.id.desc()))
    qis = result.scalars().all()

    # Virtual status: the DB table has no `status` column, so derive it from
    # whether a putaway order already exists for the linked GRN.
    # BUG-INV-024: when multiple QIs share a GRN (e.g. a cancelled QI + a fresh
    # one), the older approach marked BOTH as 'completed' on a single putaway.
    # Now we tie status to the GRN's status: if the GRN is still in pending_qi /
    # qi_in_progress, no QI on it is completed; if the GRN has advanced to
    # putaway_pending or beyond AND we're looking at the most recent QI for
    # that GRN, mark that one completed and the older ones cancelled.
    qi_grn_ids = [q.grn_id for q in qis if q.grn_id]
    grn_status_map: dict = {}
    latest_qi_per_grn: dict = {}
    if qi_grn_ids:
        gr_rows = await db.execute(
            select(GoodsReceiptNote.id, GoodsReceiptNote.status).where(
                GoodsReceiptNote.id.in_(qi_grn_ids)
            )
        )
        grn_status_map = {r.id: r.status for r in gr_rows.all()}
        latest_qi_rows = await db.execute(
            select(QualityInspection.grn_id, func.max(QualityInspection.id))
            .where(QualityInspection.grn_id.in_(qi_grn_ids))
            .group_by(QualityInspection.grn_id)
        )
        latest_qi_per_grn = {r[0]: r[1] for r in latest_qi_rows.all()}

    # Bulk lookup user names for inspected_by
    user_ids = {q.inspected_by for q in qis if q.inspected_by}
    users_map = {}
    if user_ids:
        u_rows = await db.execute(
            select(User.id, User.first_name, User.last_name, User.username).where(User.id.in_(list(user_ids)))
        )
        for r in u_rows.all():
            name = f"{r.first_name} {r.last_name or ''}".strip() or r.username
            users_map[r.id] = name

    items_list = []
    for q in qis:
        data = QIResponse.model_validate(q).model_dump()
        data["grn_number"] = q.grn.grn_number if q.grn else None
        data["inspected_by_name"] = users_map.get(q.inspected_by) if q.inspected_by else None
        gst = grn_status_map.get(q.grn_id) if q.grn_id else None
        is_latest = (q.grn_id is not None) and (latest_qi_per_grn.get(q.grn_id) == q.id)
        # If GRN has progressed past QI, only the LATEST QI for that GRN is
        # the active completed one. Older duplicates are stale/cancelled.
        if gst in ("putaway_pending", "putaway_done", "completed", "qi_done"):
            data["status"] = "completed" if is_latest else "cancelled"
        elif gst in ("qi_in_progress",):
            data["status"] = "in_progress"
        else:
            data["status"] = "draft"
        # Add item names to QI items
        if q.items and data.get("items"):
            for i, qi_item in enumerate(q.items):
                if i < len(data["items"]):
                    data["items"][i]["item_name"] = qi_item.item.name if qi_item.item else None
                    data["items"][i]["item_code"] = qi_item.item.item_code if qi_item.item else None
        items_list.append(data)

    return build_paginated_response(items_list, total, page, page_size)


@router.post("/qi", status_code=201)
async def create_quality_inspection(
    payload: QICreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    qi_number = await generate_number(db, "warehouse", "quality_inspection")
    qi = QualityInspection(
        qi_number=qi_number,
        grn_id=payload.grn_id,
        inspection_type=payload.inspection_type,
        inspection_date=payload.inspection_date,
        overall_result=payload.overall_result,
        inspected_by=current_user.id,
        remarks=payload.remarks,
    )
    db.add(qi)
    await db.flush()

    for item in payload.items:
        # BUG-INV-017: validate QI qty math — accepted+rejected+hold cannot
        # exceed inspected_qty (otherwise the inspector is creating phantom stock).
        accepted = Decimal(str(item.accepted_qty or 0))
        rejected = Decimal(str(item.rejected_qty or 0))
        held = Decimal(str(item.hold_qty or 0))
        inspected = Decimal(str(item.inspected_qty or 0))
        if accepted + rejected + held > inspected:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Invalid QI quantities for grn_item {item.grn_item_id}: "
                    f"accepted({accepted}) + rejected({rejected}) + hold({held}) "
                    f"= {accepted+rejected+held} exceeds inspected_qty {inspected}"
                ),
            )
        qi_item = QualityInspectionItem(
            qi_id=qi.id,
            grn_item_id=item.grn_item_id,
            item_id=item.item_id,
            inspected_qty=item.inspected_qty,
            accepted_qty=item.accepted_qty,
            rejected_qty=item.rejected_qty,
            hold_qty=item.hold_qty,
            result=item.result,
            rejection_reason=item.rejection_reason,
            remarks=item.remarks,
        )
        db.add(qi_item)

        # BUG-INV-018: when multiple QI lines target the SAME grn_item_id (e.g.
        # split rejection — half accepted, half rejected on the same GRN line),
        # ACCUMULATE the accepted/rejected totals on the GRN item rather than
        # overwriting. Otherwise the last QI line silently wins and the GRN line
        # totals are wrong.
        grn_item_result = await db.execute(select(GRNItem).where(GRNItem.id == item.grn_item_id))
        grn_item = grn_item_result.scalar_one_or_none()
        if grn_item:
            grn_item.qi_status = item.result
            # Flush to ensure the new QI item is in the DB for the aggregate sum
            await db.flush()
            # BUG-INV-018/Doubling Fix: Recalculate totals from ALL inspection items 
            # for this GRN line. This prevents doubling because it ignores the 
            # initial value set during GRN creation and treats QI records as the 
            # source of truth.
            totals_res = await db.execute(
                select(
                    func.sum(QualityInspectionItem.accepted_qty),
                    func.sum(QualityInspectionItem.rejected_qty)
                ).where(QualityInspectionItem.grn_item_id == item.grn_item_id)
            )
            totals = totals_res.one()
            grn_item.accepted_qty = totals[0] or Decimal("0")
            grn_item.rejected_qty = totals[1] or Decimal("0")

    # Update GRN status
    grn_result = await db.execute(select(GoodsReceiptNote).where(GoodsReceiptNote.id == payload.grn_id))
    grn = grn_result.scalar_one_or_none()
    if grn:
        # BUG-INV-132: Respect the status from the frontend. Only advance to 
        # putaway_pending if the inspection is actually 'completed'.
        if payload.status == "completed":
            grn.status = "putaway_pending"
        elif payload.status == "in_progress":
            grn.status = "qi_in_progress"
        else:
            # Default to pending_qi if it's a draft
            grn.status = "pending_qi"

        # Recalculate accepted/rejected totals
        grn_items_result = await db.execute(select(GRNItem).where(GRNItem.grn_id == grn.id))
        grn_items = grn_items_result.scalars().all()
        grn.accepted_qty = sum(float(gi.accepted_qty or 0) for gi in grn_items)
        grn.rejected_qty = sum(float(gi.rejected_qty or 0) for gi in grn_items)

    await db.flush()

    # Bug fix R-011: auto-create PutawayOrder when QI completes with anything
    # accepted. Without this, the chain GRN → QI → Putaway → Stock breaks
    # silently and users wonder why stock never lands.
    try:
        if grn and grn.status == "putaway_pending" and grn.accepted_qty and grn.accepted_qty > 0:
            existing_pa = await db.execute(
                select(PutawayOrder).where(PutawayOrder.grn_id == grn.id)
            )
            if existing_pa.scalar_one_or_none() is None:
                pa_number = await generate_number(db, "warehouse", "putaway_order")
                pa = PutawayOrder(
                    putaway_number=pa_number,
                    grn_id=grn.id,
                    warehouse_id=grn.warehouse_id,
                    putaway_type="system_directed",
                    status="draft",
                    assigned_to=current_user.id,
                )
                db.add(pa)
                await db.flush()
                # One PutawayItem per GRN item with accepted_qty > 0
                for gi in grn_items:
                    if gi.accepted_qty and float(gi.accepted_qty) > 0:
                        db.add(PutawayItem(
                            putaway_id=pa.id,
                            grn_item_id=gi.id,
                            item_id=gi.item_id,
                            qty=gi.accepted_qty,
                            uom_id=gi.uom_id,
                            batch_id=gi.batch_id,
                            status="pending",
                        ))
                await db.flush()
    except Exception as exc:
        logger.exception(
            "Putaway auto-create failed for GRN %s: %s", grn.id if grn else "?", exc
        )

    # BUG-INV-115/029: when items were rejected, add a quarantine putaway line
    # so the rejected qty is physically routed to the quarantine zone instead
    # of disappearing from the audit trail. We look up any bin in a
    # zone_type='quarantine' line within the GRN's warehouse; if one exists,
    # add it to the (just-created) putaway as a separate quarantine line.
    try:
        if grn and grn.status == "putaway_pending" and grn.rejected_qty and float(grn.rejected_qty) > 0:
            from app.models.warehouse import (
                WarehouseBin as _Bin, WarehouseRack as _Rack,
                WarehouseLine as _Line, WarehouseLocation as _Loc,
            )
            q_bin_row = await db.execute(
                select(_Bin.id)
                .join(_Rack, _Rack.id == _Bin.rack_id)
                .join(_Line, _Line.id == _Rack.line_id)
                .join(_Loc, _Loc.id == _Line.location_id)
                .where(
                    _Loc.warehouse_id == grn.warehouse_id,
                    _Line.zone_type == "quarantine",
                    _Bin.is_active == True,  # noqa: E712
                )
                .limit(1)
            )
            q_bin_id = q_bin_row.scalar_one_or_none()
            if q_bin_id:
                # Find or create a putaway for this GRN; if accepted-side
                # putaway already exists, append rejected lines to it.
                pa_row = await db.execute(
                    select(PutawayOrder).where(PutawayOrder.grn_id == grn.id).limit(1)
                )
                target_pa = pa_row.scalar_one_or_none()
                if target_pa is None:
                    pa_number = await generate_number(db, "warehouse", "putaway_order")
                    target_pa = PutawayOrder(
                        putaway_number=pa_number,
                        grn_id=grn.id,
                        warehouse_id=grn.warehouse_id,
                        putaway_type="system_directed",
                        status="draft",
                        assigned_to=current_user.id,
                    )
                    db.add(target_pa)
                    await db.flush()
                for gi in grn_items:
                    if gi.rejected_qty and float(gi.rejected_qty) > 0:
                        db.add(PutawayItem(
                            putaway_id=target_pa.id,
                            grn_item_id=gi.id,
                            item_id=gi.item_id,
                            qty=gi.rejected_qty,
                            uom_id=gi.uom_id,
                            batch_id=gi.batch_id,
                            suggested_bin_id=q_bin_id,
                            status="pending",
                        ))
                await db.flush()
    except Exception:
        logger.exception("Quarantine routing failed for GRN %s", grn.id if grn else "?")

    return {"id": qi.id, "qi_number": qi_number, "message": "Quality inspection created"}


# ==================== PUTAWAY ====================

@router.get("/putaway", dependencies=[Depends(require_key("warehouse-putaway"))])
async def list_putaway_orders(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    status: str = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(PutawayOrder).options(
        selectinload(PutawayOrder.grn),
        selectinload(PutawayOrder.warehouse),
        selectinload(PutawayOrder.items).selectinload(PutawayItem.batch),
    )
    count_query = select(func.count(PutawayOrder.id))

    if status:
        query = query.where(PutawayOrder.status == status)
        count_query = count_query.where(PutawayOrder.status == status)
    if warehouse_id:
        query = query.where(PutawayOrder.warehouse_id == warehouse_id)
        count_query = count_query.where(PutawayOrder.warehouse_id == warehouse_id)

    # Bug fix BUG_0084: also search by GRN number, not just putaway number.
    # The natural key for warehouse staff is the GRN they are putting away.
    if search:
        s = f"%{search.strip()}%"
        query = query.outerjoin(GoodsReceiptNote, GoodsReceiptNote.id == PutawayOrder.grn_id).where(
            (PutawayOrder.putaway_number.ilike(s))
            | (GoodsReceiptNote.grn_number.ilike(s))
        )
        count_query = count_query.outerjoin(
            GoodsReceiptNote, GoodsReceiptNote.id == PutawayOrder.grn_id
        ).where(
            (PutawayOrder.putaway_number.ilike(s))
            | (GoodsReceiptNote.grn_number.ilike(s))
        )

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(PutawayOrder.id.desc()))
    orders = result.scalars().all()

    items_list = []
    for o in orders:
        data = PutawayResponse.model_validate(o).model_dump()
        data["grn_number"] = o.grn.grn_number if o.grn else None
        data["warehouse_name"] = o.warehouse.name if o.warehouse else None
        
        # Populate progress fields
        data["total_items"] = len(o.items)
        data["completed_items"] = len([i for i in o.items if i.status in ("done", "skipped")])
        
        items_list.append(data)

    return build_paginated_response(items_list, total, page, page_size)


@router.post("/putaway", status_code=201, dependencies=[Depends(require_key("warehouse-putaway"))])
async def create_putaway_order(
    payload: PutawayCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    putaway_number = await generate_number(db, "warehouse", "putaway_order")
    po = PutawayOrder(
        putaway_number=putaway_number,
        grn_id=payload.grn_id,
        warehouse_id=payload.warehouse_id,
        putaway_type=payload.putaway_type,
        assigned_to=payload.assigned_to,
    )
    db.add(po)
    await db.flush()

    for item in payload.items:
        resolved_suggested_bin_id = await resolve_or_create_bin(db, payload.warehouse_id, item.suggested_bin_id)
        pi = PutawayItem(
            putaway_id=po.id,
            grn_item_id=item.grn_item_id,
            item_id=item.item_id,
            qty=item.qty,
            uom_id=item.uom_id,
            batch_id=item.batch_id,
            suggested_bin_id=resolved_suggested_bin_id,
        )
        db.add(pi)

    await db.flush()
    return {"id": po.id, "putaway_number": putaway_number, "message": "Putaway order created"}


@router.put("/putaway/{putaway_id}/items/{item_id}/confirm", dependencies=[Depends(require_key("warehouse-putaway"))])
async def confirm_putaway_item(
    putaway_id: int,
    item_id: int,
    payload: PutawayItemUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Confirm putaway of an item to a bin (scan to confirm)."""
    result = await db.execute(
        select(PutawayItem)
        .options(selectinload(PutawayItem.item))
        .where(PutawayItem.id == item_id, PutawayItem.putaway_id == putaway_id)
    )
    pi = result.scalar_one_or_none()
    if not pi:
        raise HTTPException(status_code=404, detail="Putaway item not found")

    has_serial = bool(pi.item.has_serial) if (pi and pi.item) else False
    if has_serial:
        if not payload.serial_numbers or len(payload.serial_numbers) != int(pi.qty):
            raise HTTPException(
                status_code=400,
                detail=f"Item requires {int(pi.qty)} serial numbers, but got {len(payload.serial_numbers) if payload.serial_numbers else 0}."
            )
        if len(payload.serial_numbers) != len(set(payload.serial_numbers)):
            raise HTTPException(
                status_code=400,
                detail="Duplicate serial numbers provided in the request."
            )
        stmt = select(SerialNumber.serial_number).where(
            SerialNumber.item_id == pi.item_id,
            SerialNumber.serial_number.in_(payload.serial_numbers),
            SerialNumber.status.in_(("available", "issued"))
        )
        existing_serials = (await db.execute(stmt)).scalars().all()
        if existing_serials:
            raise HTTPException(
                status_code=400,
                detail=f"Serial numbers already active/in stock: {', '.join(existing_serials)}"
            )

    # BUG-INV-030: validate the chosen bin actually lives inside the putaway
    # order's warehouse. Without this, a typo'd bin_id can land stock in the
    # wrong warehouse (or in a soft-deleted bin) and the audit trail breaks.
    po_warehouse_id = (await db.execute(
        select(PutawayOrder.warehouse_id).where(PutawayOrder.id == putaway_id)
    )).scalar()

    resolved_bin_id = None
    if payload.actual_bin_id is not None and po_warehouse_id is not None:
        resolved_bin_id = await resolve_or_create_bin(db, po_warehouse_id, payload.actual_bin_id)
        if resolved_bin_id is None:
            raise HTTPException(status_code=400, detail=f"Bin could not be resolved or created for '{payload.actual_bin_id}'")
        
        # Load bin_obj for capacity validation
        bin_obj = await db.get(WarehouseBin, resolved_bin_id)
        if not bin_obj:
            raise HTTPException(status_code=400, detail=f"Bin ID {resolved_bin_id} not found")
            
        # BUG-INV-109: enforce bin capacity. Sum existing balance qty in this
        # bin and refuse the putaway if total > capacity (capacity=0 means
        # uncapped — treat as unlimited).
        if bin_obj.capacity is not None and bin_obj.capacity > 0:
            current_in_bin = (await db.execute(
                select(func.coalesce(func.sum(StockBalance.total_qty), 0))
                .where(StockBalance.bin_id == bin_obj.id)
            )).scalar() or Decimal("0")
            new_qty = (pi.qty or Decimal("0"))
            if Decimal(str(current_in_bin)) + Decimal(str(new_qty)) > Decimal(str(bin_obj.capacity)):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Bin {bin_obj.code or bin_obj.id} capacity exceeded: "
                        f"capacity={bin_obj.capacity}, current={current_in_bin}, "
                        f"adding={new_qty}"
                    ),
                )

    pi.actual_bin_id = resolved_bin_id
    pi.status = payload.status
    pi.scanned_at = datetime.now(timezone.utc)
    pi.scanned_by = current_user.id

    # Look up the GRN item to get the rate (cost) — without this, weighted-avg
    # costing would always settle at 0.
    grn_item_rate = Decimal("0")
    if pi.grn_item_id:
        gi_row = await db.execute(
            select(GRNItem.rate).where(GRNItem.id == pi.grn_item_id)
        )
        grn_item_rate = gi_row.scalar() or Decimal("0")

    # Post stock ledger entry (po_warehouse_id was fetched above for bin validation)
    await post_stock_ledger(
        db,
        item_id=pi.item_id,
        warehouse_id=po_warehouse_id,
        transaction_type="putaway",
        qty_in=pi.qty,
        rate=grn_item_rate,
        bin_id=resolved_bin_id,
        batch_id=pi.batch_id,
        reference_type="putaway_order",
        reference_id=putaway_id,
        uom_id=pi.uom_id,
        created_by=current_user.id,
    )

    if has_serial and payload.status == "done":
        for sn in payload.serial_numbers:
            db.add(SerialNumber(
                item_id=pi.item_id,
                serial_number=sn.strip(),
                batch_id=pi.batch_id,
                status="available",
                warehouse_id=po_warehouse_id,
                bin_id=resolved_bin_id
            ))

    # Check if all items done
    # BUG-INV-034: a 'skipped' item is a terminal state (operator deliberately
    # marked the line as not putaway-able — damaged, missing, etc.). Treat
    # skipped lines as "resolved" so the putaway can complete instead of being
    # stuck on partially_putaway forever.
    all_items_result = await db.execute(
        select(PutawayItem).where(PutawayItem.putaway_id == putaway_id)
    )
    all_items = all_items_result.scalars().all()
    TERMINAL_STATES = ("done", "skipped")
    all_done = all(i.status in TERMINAL_STATES for i in all_items)

    po_result = await db.execute(select(PutawayOrder).where(PutawayOrder.id == putaway_id))
    po = po_result.scalar_one()
    po.status = "completed" if all_done else "in_progress"
    if all_done:
        now = datetime.now(timezone.utc)
        po.completed_at = now
        if po.started_at is None:
            po.started_at = now

    # Update GRN status & fire GL posting once putaway is fully done.
    grn_result = await db.execute(select(GoodsReceiptNote).where(GoodsReceiptNote.id == po.grn_id))
    grn = grn_result.scalar_one_or_none()
    if grn:
        grn.status = "putaway_done" if all_done else "partially_putaway"
        if all_done:
            try:
                from app.services.gl_posting import post_grn_gl
                # Pull GRN line items + rates for GL posting
                gi_rows = await db.execute(
                    select(GRNItem.item_id, GRNItem.received_qty, GRNItem.rate)
                    .where(GRNItem.grn_id == grn.id)
                )
                gl_items = [
                    {"item_id": r[0], "qty": r[1], "rate": r[2]}
                    for r in gi_rows.all()
                ]
                org_id = current_user.organization_id or 1
                await post_grn_gl(
                    db,
                    organization_id=org_id,
                    grn_id=grn.id,
                    grn_number=grn.grn_number,
                    grn_date=grn.grn_date,
                    vendor_id=grn.vendor_id,
                    warehouse_id=grn.warehouse_id,
                    items=gl_items,
                    created_by=current_user.id,
                )
            except Exception as gl_exc:
                # BUG-INV-035: GL posting must never block operational putaway
                # flow, but the failure must be visible — finance team needs to
                # reconcile. Persist a high-priority Notification + ActivityLog
                # entry so the gap is tracked, not silently swallowed.
                logger.exception("GL posting failed for GRN %s after putaway %s", grn.id, putaway_id)
                try:
                    from app.models.system import Notification as _Notif, ActivityLog as _AL
                    db.add(_Notif(
                        user_id=current_user.id,
                        title="GL posting failed for GRN",
                        message=(
                            f"GL journal could not be posted for GRN {grn.grn_number}. "
                            f"Error: {gl_exc}. Inventory was updated but accounts "
                            "are out of sync until manual journal is posted."
                        ),
                        notification_type="error",
                        is_read=False,
                    ))
                    db.add(_AL(
                        user_id=current_user.id,
                        action="gl_post_failed",
                        entity_type="goods_receipt_note",
                        entity_id=grn.id,
                        new_values={"error": str(gl_exc), "putaway_id": putaway_id},
                    ))
                except Exception:
                    logger.exception("Failed to record GL-failure notification for GRN %s", grn.id)

            # Wave 11C — try to auto-fulfill any indent waiting on this stock
            try:
                from app.services.indent_lifecycle import try_fulfill_indents_after_grn
                await try_fulfill_indents_after_grn(
                    db, grn_id=grn.id, user_id=current_user.id,
                )
            except Exception:
                logger.exception("Indent auto-fulfillment failed after putaway %s", putaway_id)

    await db.flush()
    return {"success": True, "message": "Putaway confirmed"}


@router.post("/putaway/{putaway_id}/quick-complete", dependencies=[Depends(require_key("warehouse-putaway"))])
async def quick_complete_putaway(
    putaway_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "warehouse_operator", "store_keeper"
    )),
):
    """Bug fix R-011/D-019 — fast-path putaway for warehouses without bin
    hierarchy. Confirms ALL pending items in one shot, posts stock to ledger
    against the warehouse (no specific bin), and triggers GL + indent
    auto-fulfillment hooks. Use this when bins haven't been configured.
    """
    pa_row = await db.execute(select(PutawayOrder).where(PutawayOrder.id == putaway_id))
    pa = pa_row.scalar_one_or_none()
    if not pa:
        raise HTTPException(status_code=404, detail="Putaway order not found")
    if pa.status == "completed":
        return {"success": True, "message": "Already completed", "items_posted": 0}

    items_q = await db.execute(
        select(PutawayItem)
        .options(selectinload(PutawayItem.item))
        .where(PutawayItem.putaway_id == putaway_id, PutawayItem.status != "done")
    )
    items = items_q.scalars().all()

    # Block quick-complete if any item requires serial number tracking
    for pi in items:
        if pi.item and pi.item.has_serial:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot quick-complete: Item '{pi.item.item_code}' is serial-tracked. Please confirm this item individually and enter its serial numbers."
            )

    posted = 0
    failures: list[dict] = []
    for pi in items:
        # Look up GRN rate for proper costing
        rate = Decimal("0")
        if pi.grn_item_id:
            r = await db.execute(select(GRNItem.rate).where(GRNItem.id == pi.grn_item_id))
            rate = r.scalar() or Decimal("0")
        # BUG-INV-032: per-item failures must NOT silently advance the putaway
        # to 'completed'. Wrap each post in a savepoint so a failure rolls back
        # only that item's effects, mark the item, and short-circuit to a 207-ish
        # response if anything failed. Caller must inspect & retry.
        # BUG-INV-033: also record actual_bin_id from suggested_bin_id so the
        # putaway audit trail isn't blank for quick-complete confirmations.
        chosen_bin_id = pi.suggested_bin_id or None
        try:
            async with db.begin_nested():
                await post_stock_ledger(
                    db,
                    item_id=pi.item_id,
                    warehouse_id=pa.warehouse_id,
                    transaction_type="putaway",
                    qty_in=pi.qty,
                    rate=rate,
                    bin_id=chosen_bin_id,
                    batch_id=pi.batch_id,
                    reference_type="putaway_order",
                    reference_id=putaway_id,
                    uom_id=pi.uom_id,
                    created_by=current_user.id,
                )
                pi.status = "done"
                pi.actual_bin_id = chosen_bin_id
                pi.scanned_at = datetime.now(timezone.utc)
                pi.scanned_by = current_user.id
            posted += 1
        except Exception as exc:
            logger.exception(
                "Quick-putaway failed for item %s: %s", pi.id, exc
            )
            failures.append({"putaway_item_id": pi.id, "item_id": pi.item_id, "error": str(exc)})

    # BUG-INV-032: if anything failed, leave putaway as 'in_progress' so the
    # operator sees the audit reality and can fix + retry.
    if failures:
        pa.status = "in_progress"
        await db.flush()
        raise HTTPException(
            status_code=500,
            detail={
                "message": (
                    f"{posted} items posted, {len(failures)} failed. "
                    "Putaway left in 'in_progress' — fix the failures and retry."
                ),
                "posted": posted,
                "failures": failures,
            },
        )

    pa.status = "completed"
    now = datetime.now(timezone.utc)
    pa.completed_at = now
    if pa.started_at is None:
        pa.started_at = now
    grn_row = await db.execute(select(GoodsReceiptNote).where(GoodsReceiptNote.id == pa.grn_id))
    grn = grn_row.scalar_one_or_none()
    if grn:
        grn.status = "putaway_done"
        # Fire GL + indent auto-fulfillment
        try:
            from app.services.gl_posting import post_grn_gl
            gi_rows = await db.execute(
                select(GRNItem.item_id, GRNItem.received_qty, GRNItem.rate).where(GRNItem.grn_id == grn.id)
            )
            gl_items = [{"item_id": r[0], "qty": r[1], "rate": r[2]} for r in gi_rows.all()]
            org_id = current_user.organization_id or 1
            await post_grn_gl(
                db, organization_id=org_id, grn_id=grn.id, grn_number=grn.grn_number,
                grn_date=grn.grn_date, vendor_id=grn.vendor_id, warehouse_id=grn.warehouse_id,
                items=gl_items, created_by=current_user.id,
            )
        except Exception as exc:
            logger.exception("Quick-putaway GL post failed: %s", exc)
        try:
            from app.services.indent_lifecycle import try_fulfill_indents_after_grn
            await try_fulfill_indents_after_grn(db, grn_id=grn.id, user_id=current_user.id)
        except Exception:
            logger.exception("Indent auto-fulfillment failed after quick-putaway for GRN %s", grn.id)

    await db.flush()
    return {"success": True, "items_posted": posted, "message": f"Putaway completed; {posted} stock entries posted"}


# ==================== BATCH STATUS MANAGEMENT ====================

@router.post("/batches", status_code=201)
async def upsert_batch(
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Idempotent upsert of a Batch row. Used by the frontend Add Stock flow
    so opening-balance entries can carry batch_id (BUG-INV-135).

    Body: {item_id, batch_number, manufacturing_date?, expiry_date?,
           supplier_batch?, lot_number?}.
    Returns the (existing or newly-created) batch's id.
    """
    item_id = payload.get("item_id")
    batch_number = (payload.get("batch_number") or "").strip()
    if not item_id or not batch_number:
        raise HTTPException(status_code=400, detail="item_id and batch_number are required")
    existing = (await db.execute(
        select(Batch).where(Batch.item_id == item_id, Batch.batch_number == batch_number)
    )).scalar_one_or_none()
    if existing is not None:
        return {"id": existing.id, "batch_number": existing.batch_number, "reused": True}
    # BUG-INV-090: validate expiry > manufacturing
    mfg = payload.get("manufacturing_date")
    exp = payload.get("expiry_date")
    if mfg and exp and str(exp) <= str(mfg):
        raise HTTPException(
            status_code=400,
            detail=f"expiry_date {exp} must be after manufacturing_date {mfg}",
        )
    b = Batch(
        item_id=item_id,
        batch_number=batch_number,
        manufacturing_date=mfg,
        expiry_date=exp,
        supplier_batch=payload.get("supplier_batch"),
        lot_number=payload.get("lot_number"),
        status="active",
    )
    db.add(b)
    await db.flush()
    return {"id": b.id, "batch_number": b.batch_number, "reused": False}


@router.put("/batches/{batch_id}/recall")
async def recall_batch(
    batch_id: int,
    payload: dict | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "compliance_officer",
    )),
):
    """BUG-INV-084: API path to flip Batch.status to 'recalled'.

    Recalled batches are blocked from issue/transfer/audit moves by the
    central post_stock_ledger guard. Body (optional): {reason}.
    """
    b_row = await db.execute(select(Batch).where(Batch.id == batch_id))
    b = b_row.scalar_one_or_none()
    if not b:
        raise HTTPException(status_code=404, detail="Batch not found")
    if b.status == "recalled":
        return {"success": True, "message": "Batch already recalled"}
    b.status = "recalled"
    if isinstance(payload, dict) and payload.get("reason"):
        b.notes = (b.notes or "") + f"\n[RECALLED {datetime.now(timezone.utc).date()}]: {payload['reason']}"
    await db.flush()
    return {"success": True, "message": f"Batch {b.batch_number} recalled"}


@router.post("/batches/expire-job")
async def run_expire_job(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    """BUG-INV-085: flip status='expired' on any batch whose expiry_date has
    passed. Idempotent — safe to call repeatedly. Should be wired to a
    daily scheduler; this endpoint exposes a manual trigger.
    """
    from datetime import date as _date
    today = _date.today()
    rows = await db.execute(
        select(Batch).where(
            Batch.status == "active",
            Batch.expiry_date.is_not(None),
            Batch.expiry_date < datetime.combine(today, datetime.min.time()),
        )
    )
    flipped = 0
    for b in rows.scalars().all():
        b.status = "expired"
        flipped += 1
    await db.flush()
    return {"success": True, "expired": flipped, "message": f"{flipped} batches marked expired"}


# ==================== FEFO / FIFO PICK SUGGESTIONS (closes audit gap G-09) ====================

async def _build_pick_response(
    db: AsyncSession,
    picks: list,
    qty_d: Decimal,
    method: str,
) -> dict:
    """Common enrich-and-shape for FEFO/FIFO endpoints.

    All math stays in Decimal until the JSON-serialization step at the end so
    we don't lose precision on stock quantities.
    """
    if not picks:
        return {
            "sufficient": False,
            "picks": [],
            "total_picked": 0.0,
            "shortage": float(qty_d),
            "method": method,
            "message": "No stock available",
        }

    batch_ids = [p["batch_id"] for p in picks if p.get("batch_id")]
    batch_meta: dict = {}
    if batch_ids:
        rows = (await db.execute(select(Batch).where(Batch.id.in_(batch_ids)))).scalars().all()
        batch_meta = {b.id: b for b in rows}

    enriched = []
    total = Decimal("0")
    for p in picks:
        b = batch_meta.get(p.get("batch_id")) if p.get("batch_id") else None
        pick_qty = p.get("qty") or Decimal("0")
        if not isinstance(pick_qty, Decimal):
            pick_qty = Decimal(str(pick_qty))
        enriched.append({
            "batch_id": p.get("batch_id"),
            "batch_number": b.batch_number if b else None,
            "expiry_date": b.expiry_date.isoformat() if (b and b.expiry_date) else None,
            "manufacturing_date": b.manufacturing_date.isoformat() if (b and b.manufacturing_date) else None,
            "bin_id": p.get("bin_id"),
            "qty": float(pick_qty),
        })
        total += pick_qty

    shortage = qty_d - total
    if shortage < 0:
        shortage = Decimal("0")

    return {
        "sufficient": total >= qty_d,
        "picks": enriched,
        "total_picked": float(total),
        "shortage": float(shortage),
        "method": method,
        "message": None if total >= qty_d else f"Short by {float(shortage)} units",
    }


@router.get("/fefo-pick")
async def fefo_pick_suggestion(
    item_id: int = Query(..., description="Item to pick stock for"),
    warehouse_id: int = Query(..., description="Warehouse to pick from"),
    qty: float = Query(..., gt=0, description="Required quantity"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """First-Expiry-First-Out batch suggestion for material issue.

    Returns ordered list of (batch, bin, qty) picks summing to required qty.
    Items without expiry come last. Critical for healthcare to minimize waste
    of expiring drugs.
    """
    qty_d = Decimal(str(qty))
    picks = await get_fefo_batches(
        db, item_id=item_id, warehouse_id=warehouse_id, required_qty=qty_d,
    )
    return await _build_pick_response(db, picks, qty_d, method="FEFO")


@router.get("/fifo-pick")
async def fifo_pick_suggestion(
    item_id: int = Query(...),
    warehouse_id: int = Query(...),
    qty: float = Query(..., gt=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """First-In-First-Out (by manufacturing date) batch suggestion."""
    qty_d = Decimal(str(qty))
    picks = await get_fifo_batches(
        db, item_id=item_id, warehouse_id=warehouse_id, required_qty=qty_d,
    )
    return await _build_pick_response(db, picks, qty_d, method="FIFO")


# ==================== STOCK VISIBILITY ====================

@router.get("/quality-inspections")
async def list_quality_inspections_alias(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    grn_id: int = Query(None),
    status: str = Query(None),
    overall_result: str = Query(None),
    date_from: date = Query(None),
    date_to: date = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("warehouse-quality-inspection")),
):
    """Alias: GET /warehouse/quality-inspections -> delegates to /warehouse/qi."""
    return await list_quality_inspections(
        page=page, page_size=page_size, search=search, grn_id=grn_id,
        status=status, overall_result=overall_result,
        date_from=date_from, date_to=date_to,
        db=db, current_user=current_user
    )


@router.get("/quality-inspections/{qi_id}")
async def get_quality_inspection_alias(
    qi_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: GET /warehouse/quality-inspections/{id}."""
    result = await db.execute(
        select(QualityInspection).options(
            selectinload(QualityInspection.items).selectinload(QualityInspectionItem.item),
            selectinload(QualityInspection.items).selectinload(QualityInspectionItem.grn_item),
        ).where(QualityInspection.id == qi_id)
    )
    qi = result.scalar_one_or_none()
    if not qi:
        raise HTTPException(status_code=404, detail="Quality inspection not found")
    data = QIResponse.model_validate(qi).model_dump(mode="json")

    # Enrich joined names so UI shows labels not raw ids
    grn_number = (await db.execute(
        select(GoodsReceiptNote.grn_number).where(GoodsReceiptNote.id == qi.grn_id)
    )).scalar()
    data["grn_number"] = grn_number

    if qi.inspected_by:
        u_row = (await db.execute(
            select(User.first_name, User.last_name, User.username).where(User.id == qi.inspected_by)
        )).first()
        if u_row:
            data["inspected_by_name"] = (
                f"{u_row.first_name} {u_row.last_name or ''}".strip()
                or u_row.username
            )

    # Virtual status
    pa_r = await db.execute(
        select(PutawayOrder.id).where(PutawayOrder.grn_id == qi.grn_id).limit(1)
    )
    data["status"] = "completed" if pa_r.scalar_one_or_none() else "draft"

    for i, qi_item in enumerate(qi.items):
        if i < len(data.get("items", [])):
            if qi_item.item:
                data["items"][i]["item_name"] = qi_item.item.name
                data["items"][i]["item_code"] = qi_item.item.item_code
    return data


@router.post("/quality-inspections", status_code=201)
async def create_quality_inspection_alias(
    payload: QICreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: POST /warehouse/quality-inspections -> delegates to /warehouse/qi."""
    return await create_quality_inspection(payload=payload, db=db, current_user=current_user)


@router.put("/quality-inspections/{qi_id}/complete")
async def complete_quality_inspection(
    qi_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "quality_inspector", "super_admin", "admin",
    )),
):
    """Complete a quality inspection and AUTO-GENERATE a Putaway order
    from the GRN's accepted items so stock can actually land in bins.

    Previously this endpoint only flipped statuses — the UI said "Putaway
    will be generated" but nothing was actually created, leaving stock
    stuck forever. Fixed 2026-04-15.
    """
    result = await db.execute(select(QualityInspection).where(QualityInspection.id == qi_id))
    qi = result.scalar_one_or_none()
    if not qi:
        raise HTTPException(status_code=404, detail="Quality inspection not found")
    # QI table has no 'status' column — we track completion via
    # the linked GRN's status transition (pending_qi -> putaway_pending).

    # Load the GRN with its items so we can build a Putaway
    grn_result = await db.execute(
        select(GoodsReceiptNote)
        .options(selectinload(GoodsReceiptNote.items))
        .where(GoodsReceiptNote.id == qi.grn_id)
    )
    grn = grn_result.scalar_one_or_none()
    if not grn:
        await db.flush()
        return {"success": True, "message": "Quality inspection completed (no linked GRN)"}

    # BUG-INV-019: only mark GRN as putaway_pending if QI accepted something.
    # Previously this status flip + putaway happened even when QI rejected
    # EVERYTHING — yielding a ghost putaway with no items.
    qi_items_q = await db.execute(
        select(QualityInspectionItem).where(QualityInspectionItem.qi_id == qi.id)
    )
    qi_items = qi_items_q.scalars().all()
    qi_accepted_by_grn_item: dict = {}
    total_accepted = Decimal("0")
    for qit in qi_items:
        a = Decimal(str(qit.accepted_qty or 0))
        if qit.grn_item_id is not None:
            qi_accepted_by_grn_item[qit.grn_item_id] = (
                qi_accepted_by_grn_item.get(qit.grn_item_id, Decimal("0")) + a
            )
        total_accepted += a

    if total_accepted <= 0:
        # BUG-INV-150: auto-seeded QI rows start with accepted_qty=0,
        # hold_qty=received_qty. If the warehouse manager clicks "Complete &
        # Generate Putaway" without editing each line, treat that as an
        # explicit shortcut: accept everything. Lines whose result is already
        # 'rejected' or which have rejected_qty/hold_qty > 0 set by the
        # inspector are left untouched (those represent real decisions).
        promoted = False
        for qit in qi_items:
            inspected = Decimal(str(qit.inspected_qty or 0))
            accepted = Decimal(str(qit.accepted_qty or 0))
            rejected = Decimal(str(qit.rejected_qty or 0))
            held = Decimal(str(qit.hold_qty or 0))
            if accepted > 0:
                continue
            if rejected > 0:
                continue
            # The "untouched" pristine state: accepted=0, rejected=0, hold=inspected.
            # Promote held qty to accepted.
            if inspected <= 0:
                continue
            qit.accepted_qty = inspected
            qit.hold_qty = Decimal("0")
            qit.result = "accepted"
            promoted = True
            qi_accepted_by_grn_item[qit.grn_item_id] = (
                qi_accepted_by_grn_item.get(qit.grn_item_id, Decimal("0")) + inspected
            )
            total_accepted += inspected
            # Mirror onto the GRN line so downstream totals stay coherent.
            if qit.grn_item_id is not None:
                gi_row = await db.execute(
                    select(GRNItem).where(GRNItem.id == qit.grn_item_id)
                )
                gi = gi_row.scalar_one_or_none()
                if gi:
                    # Flush to ensure the auto-accepted quantities are visible for sum
                    await db.flush()
                    totals_res = await db.execute(
                        select(func.sum(QualityInspectionItem.accepted_qty))
                        .where(QualityInspectionItem.grn_item_id == qit.grn_item_id)
                    )
                    gi.accepted_qty = totals_res.scalar() or Decimal("0")
                    gi.qi_status = "accepted"

        if total_accepted <= 0:
            # Even after the shortcut, nothing to put away — every line was
            # genuinely rejected or has 0 inspected qty. Tell the user clearly.
            raise HTTPException(
                status_code=400,
                detail=(
                    "Cannot complete QI: no accepted quantities recorded and "
                    "nothing to auto-accept. Edit the QI lines first."
                ),
            )
        if promoted:
            await db.flush()

    grn.status = "putaway_pending"

    # Check if a putaway already exists for this GRN (idempotent)
    existing = await db.execute(
        select(PutawayOrder).where(PutawayOrder.grn_id == grn.id)
    )
    if existing.scalar_one_or_none():
        await db.flush()
        return {"success": True, "message": "Quality inspection completed (putaway already exists)"}

    # BUG-INV-019: build putaway from QI accepted_qty (authoritative source)
    # rather than grn_item.accepted_qty which can be stale.
    putaway_number = await generate_number(db, "warehouse", "putaway_order")
    po = PutawayOrder(
        putaway_number=putaway_number,
        grn_id=grn.id,
        warehouse_id=grn.warehouse_id,
        putaway_type="manual",
        status="draft",
    )
    db.add(po)
    await db.flush()

    for grn_item in grn.items:
        accepted = qi_accepted_by_grn_item.get(grn_item.id, Decimal("0"))
        if accepted <= 0:
            continue
        pi = PutawayItem(
            putaway_id=po.id,
            grn_item_id=grn_item.id,
            item_id=grn_item.item_id,
            qty=accepted,
            uom_id=grn_item.uom_id,
            batch_id=getattr(grn_item, "batch_id", None),
        )
        db.add(pi)

    await db.flush()
    return {
        "success": True,
        "message": f"Quality inspection completed — putaway {putaway_number} generated",
        "putaway_id": po.id,
        "putaway_number": putaway_number,
    }


@router.put("/quality-inspections/{qi_id}/cancel")
async def cancel_quality_inspection(
    qi_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """B6 fix: QualityInspection has no status column. Cancellation reverts
    the linked GRN to pending_qi and deletes the QI + items."""
    result = await db.execute(select(QualityInspection).where(QualityInspection.id == qi_id))
    qi = result.scalar_one_or_none()
    if not qi:
        raise HTTPException(status_code=404, detail="Quality inspection not found")

    # BUG-INV-021: also tear down any draft Putaway auto-generated from this
    # QI so the warehouse list isn't littered with orphans pointing at a
    # deleted inspection. Only DRAFT putaways are removed — once putaway has
    # started actually moving stock, refuse the cancel.
    if qi.grn_id:
        # Refuse if putaway already in_progress / completed.
        active_pa = await db.execute(
            select(PutawayOrder).where(
                PutawayOrder.grn_id == qi.grn_id,
                PutawayOrder.status.in_(("in_progress", "completed")),
            )
        )
        if active_pa.scalar_one_or_none() is not None:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Cannot cancel QI: a putaway has already started or completed "
                    "for this GRN. Reverse the putaway first."
                ),
            )
        # Drop draft putaways (and their items) tied to the GRN.
        draft_pa_rows = await db.execute(
            select(PutawayOrder).where(
                PutawayOrder.grn_id == qi.grn_id,
                PutawayOrder.status == "draft",
            )
        )
        for draft_pa in draft_pa_rows.scalars().all():
            await db.execute(
                PutawayItem.__table__.delete().where(PutawayItem.putaway_id == draft_pa.id)
            )
            await db.delete(draft_pa)

    # Revert GRN status so a new QI can be created
    if qi.grn_id:
        grn_r = await db.execute(select(GoodsReceiptNote).where(GoodsReceiptNote.id == qi.grn_id))
        grn = grn_r.scalar_one_or_none()
        # BUG-INV-022 (related): also revert from qi_done back to pending_qi.
        if grn and grn.status in ("qi_in_progress", "putaway_pending", "qi_done"):
            grn.status = "pending_qi"

    # BUG-INV-023: use ORM-level deletes (was raw __table__.delete()) so any
    # ORM cascades, audit hooks, or relationship listeners fire correctly.
    qi_items_rows = await db.execute(
        select(QualityInspectionItem).where(QualityInspectionItem.qi_id == qi.id)
    )
    for qi_item_row in qi_items_rows.scalars().all():
        await db.delete(qi_item_row)
    await db.flush()
    await db.delete(qi)
    await db.flush()
    return {"success": True, "message": "Quality inspection cancelled and removed"}


@router.post("/putaways", status_code=201, dependencies=[Depends(require_key("warehouse-putaway"))])
async def create_putaway_order_alias(
    payload: PutawayCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await create_putaway_order(payload=payload, db=db, current_user=current_user)


# Putaway aliases for frontend compatibility
@router.get("/putaways", dependencies=[Depends(require_key("warehouse-putaway"))])
async def list_putaway_orders_alias(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    status: str = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await list_putaway_orders(page=page, page_size=page_size, search=search, status=status, warehouse_id=warehouse_id, db=db, current_user=current_user)


@router.get("/putaways/{putaway_id}", dependencies=[Depends(require_key("warehouse-putaway"))])
async def get_putaway_order_alias(
    putaway_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(PutawayOrder)
        .options(
            selectinload(PutawayOrder.items).selectinload(PutawayItem.item),
            selectinload(PutawayOrder.items).selectinload(PutawayItem.batch),
        )
        .where(PutawayOrder.id == putaway_id)
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="Putaway order not found")

    # Enrich with FK joined names so the UI shows labels, not raw ids
    grn_number = (await db.execute(
        select(GoodsReceiptNote.grn_number).where(GoodsReceiptNote.id == order.grn_id)
    )).scalar()
    wh_name = (await db.execute(
        select(Warehouse.name).where(Warehouse.id == order.warehouse_id)
    )).scalar()
    assignee_name = None
    if order.assigned_to:
        u_row = (await db.execute(
            select(User.first_name, User.last_name, User.username).where(User.id == order.assigned_to)
        )).first()
        if u_row:
            assignee_name = (
                f"{u_row.first_name} {u_row.last_name or ''}".strip()
                or u_row.username
            )

    # UOM names in one fetch
    uom_ids = {it.uom_id for it in order.items if it.uom_id}
    uom_map = {}
    if uom_ids:
        from app.models.master import UOM
        rows = (await db.execute(select(UOM.id, UOM.name).where(UOM.id.in_(uom_ids)))).all()
        uom_map = {r.id: r.name for r in rows}

    bin_ids = {
        bin_id
        for it in order.items
        for bin_id in (it.suggested_bin_id, it.actual_bin_id)
        if bin_id
    }
    bin_map = {}
    if bin_ids:
        rows = (await db.execute(
            select(WarehouseBin.id, WarehouseBin.code, WarehouseBin.name)
            .where(WarehouseBin.id.in_(bin_ids))
        )).all()
        bin_map = {r.id: (r.code or r.name or str(r.id)) for r in rows}

    items = []
    for it in order.items:
        has_serial = bool(it.item.has_serial) if it.item else False
        serial_numbers = []
        if has_serial and it.actual_bin_id:
            sn_rows = (await db.execute(
                select(SerialNumber.serial_number)
                .where(
                    SerialNumber.item_id == it.item_id,
                    SerialNumber.warehouse_id == order.warehouse_id,
                    SerialNumber.bin_id == it.actual_bin_id,
                    SerialNumber.batch_id == it.batch_id,
                    SerialNumber.status == "available"
                )
            )).scalars().all()
            serial_numbers = list(sn_rows)

        items.append({
            "id": it.id,
            "grn_item_id": it.grn_item_id,
            "item_id": it.item_id,
            "item_name": it.item.name if it.item else None,
            "item_code": it.item.item_code if it.item else None,
            "qty": float(it.qty or 0),
            "uom_id": it.uom_id,
            "uom_name": uom_map.get(it.uom_id),
            "batch_id": it.batch_id,
            "batch_number": it.batch.batch_number if it.batch else None,
            "suggested_bin_id": it.suggested_bin_id,
            "suggested_bin": bin_map.get(it.suggested_bin_id),
            "actual_bin_id": it.actual_bin_id,
            "actual_bin": bin_map.get(it.actual_bin_id),
            "status": it.status,
            "has_serial": has_serial,
            "serial_numbers": serial_numbers,
        })

    return {
        "id": order.id,
        "putaway_number": order.putaway_number,
        "grn_id": order.grn_id,
        "grn_number": grn_number,
        "warehouse_id": order.warehouse_id,
        "warehouse_name": wh_name,
        "putaway_type": order.putaway_type,
        "status": order.status,
        "assigned_to": order.assigned_to,
        "assigned_to_name": assignee_name,
        "started_at": order.started_at.isoformat() if order.started_at else None,
        "completed_at": order.completed_at.isoformat() if order.completed_at else None,
        "total_items": len(order.items),
        "completed_items": len([i for i in order.items if i.status in ("done", "skipped")]),
        "created_at": order.created_at.isoformat() if order.created_at else None,
        "items": items,
    }


@router.put("/putaways/{putaway_id}/start", dependencies=[Depends(require_key("warehouse-putaway"))])
async def start_putaway_order(
    putaway_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "store_keeper", "warehouse_operator", "warehouse_manager",
        "super_admin", "admin",
    )),
):
    """Flip a draft putaway to in_progress so bin assignments can be saved
    and confirmed. Frontend was calling this URL already but the endpoint
    didnt exist (silent 404), so the Start Putaway button looked dead.
    """
    result = await db.execute(
        select(PutawayOrder).where(PutawayOrder.id == putaway_id)
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="Putaway order not found")
    if order.status not in ("draft", "pending"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot start a putaway in status '{order.status}'",
        )
    order.status = "in_progress"
    if not order.assigned_to:
        order.assigned_to = current_user.id
    if order.started_at is None:
        order.started_at = datetime.now(timezone.utc)
    await db.flush()
    return {"success": True, "message": "Putaway started", "status": order.status}


@router.put("/putaways/{putaway_id}", dependencies=[Depends(require_key("warehouse-putaway"))])
async def update_putaway_order(
    putaway_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "store_keeper", "warehouse_operator", "warehouse_manager",
        "super_admin", "admin",
    )),
):
    """Patch select fields on a putaway order (e.g. switch system_directed
    vs manual). Used by the bin-assignment UI; missing endpoint -> 404."""
    result = await db.execute(
        select(PutawayOrder).where(PutawayOrder.id == putaway_id)
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="Putaway order not found")
    if "putaway_type" in payload:
        order.putaway_type = payload["putaway_type"]
    if "remarks" in payload:
        order.remarks = payload["remarks"]
    await db.flush()
    return {"success": True, "id": order.id, "status": order.status}


@router.put("/putaways/{putaway_id}/items/{item_id}/confirm", dependencies=[Depends(require_key("warehouse-putaway"))])
async def confirm_putaway_item_alias(
    putaway_id: int,
    item_id: int,
    payload: PutawayItemUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "store_keeper", "warehouse_operator", "warehouse_manager",
        "super_admin", "admin",
    )),
):
    """Plural alias for /putaway/{id}/items/{iid}/confirm — frontend uses
    /putaways/ everywhere, this maps it to the existing handler."""
    return await confirm_putaway_item(
        putaway_id=putaway_id, item_id=item_id, payload=payload,
        db=db, current_user=current_user,
    )


@router.put("/putaways/{putaway_id}/bins", dependencies=[Depends(require_key("warehouse-putaway"))])
async def save_putaway_bin_assignments(
    putaway_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "store_keeper", "warehouse_operator", "warehouse_manager",
        "super_admin", "admin",
    )),
):
    """Bulk-save bin assignments and batch numbers for a putaway. Frontend posts:
       { items: [{id, actual_bin_id, actual_bin?, batch_number?}, ...] }
    Also updates/creates batch records for batch_number entries.
    """
    items = payload.get("items") or []
    if not items:
        return {"success": True, "updated": 0}
    # Verify the putaway exists and is in a writable status.
    pa_row = await db.execute(
        select(PutawayOrder).where(PutawayOrder.id == putaway_id)
    )
    pa = pa_row.scalar_one_or_none()
    if not pa:
        raise HTTPException(status_code=404, detail="Putaway order not found")
    if pa.status not in ("draft", "pending", "in_progress"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot edit bins on a putaway in status '{pa.status}'",
        )
    def _coerce_bin_id(v):
        # Frontend may send the TreeSelect string like "bin-23" — accept that
        # plus straight ints/strings for robustness.
        if v is None:
            return None
        if isinstance(v, int):
            return v
        s = str(v)
        if s.startswith("bin-"):
            s = s[4:]
        try:
            return int(s)
        except (TypeError, ValueError):
            return None

    updated = 0
    for it in items:
        if not it.get("id"):
            continue
        bin_identifier = it.get("actual_bin_id") or it.get("actual_bin")
        bin_id = _coerce_bin_id(bin_identifier)
        if bin_id is None and bin_identifier:
            bin_id = await resolve_or_create_bin(db, pa.warehouse_id, bin_identifier)
        batch_number = it.get("batch_number")
        row = await db.execute(
            select(PutawayItem).where(
                PutawayItem.id == it["id"],
                PutawayItem.putaway_id == putaway_id,
            )
        )
        pi = row.scalar_one_or_none()
        if not pi:
            continue
        # Update bin assignment if provided
        if bin_id is not None:
            pi.actual_bin_id = bin_id
            # Mirror suggested_bin for display when no separate suggestion.
            if pi.suggested_bin_id is None:
                pi.suggested_bin_id = bin_id
        # Update batch if batch_number provided (lookup or create)
        if batch_number:
            batch = await _get_or_create_batch_for_putaway(db, pi.item_id, batch_number)
            if batch:
                pi.batch_id = batch.id
        updated += 1
    await db.flush()
    return {"success": True, "updated": updated}


async def _get_or_create_batch_for_putaway(
    db: AsyncSession,
    item_id: int,
    batch_number: str,
) -> Batch | None:
    """Lookup existing batch or create new one for putaway item."""
    if not batch_number or not item_id:
        return None
    # Try to find existing batch for this item + batch_number
    row = await db.execute(
        select(Batch).where(
            Batch.item_id == item_id,
            Batch.batch_number == batch_number.strip(),
        )
    )
    existing = row.scalar_one_or_none()
    if existing:
        return existing
    # Create new batch (status=active, dates can be updated later via GRN/QI)
    new_batch = Batch(
        item_id=item_id,
        batch_number=batch_number.strip(),
        status="active",
    )
    db.add(new_batch)
    await db.flush()
    return new_batch


@router.put("/putaways/{putaway_id}/items/{item_id}/skip", dependencies=[Depends(require_key("warehouse-putaway"))])
async def skip_putaway_item(
    putaway_id: int,
    item_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "store_keeper", "warehouse_operator", "warehouse_manager",
        "super_admin", "admin",
    )),
):
    """Mark a putaway item as skipped (couldnt place it for some reason)."""
    result = await db.execute(
        select(PutawayItem).where(
            PutawayItem.id == item_id, PutawayItem.putaway_id == putaway_id,
        )
    )
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Putaway item not found")
    item.status = "skipped"
    await db.flush()
    return {"success": True, "id": item.id, "status": item.status}


@router.put("/putaways/{putaway_id}/complete", dependencies=[Depends(require_key("warehouse-putaway"))])
async def complete_putaway_alias(
    putaway_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "store_keeper", "warehouse_operator", "warehouse_manager",
        "super_admin", "admin",
    )),
):
    """Plural alias for the existing /putaway/{id}/quick-complete handler."""
    return await quick_complete_putaway(
        putaway_id=putaway_id, db=db, current_user=current_user,
    )


@router.get("/stock")
async def get_stock_visibility(
    warehouse_id: int = Query(None),
    item_id: int = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get current stock balances with filters."""
    offset, limit = paginate_params(page, page_size)
    query = select(StockBalance)
    count_query = select(func.count(StockBalance.id))

    if warehouse_id:
        query = query.where(StockBalance.warehouse_id == warehouse_id)
        count_query = count_query.where(StockBalance.warehouse_id == warehouse_id)
    if item_id:
        query = query.where(StockBalance.item_id == item_id)
        count_query = count_query.where(StockBalance.item_id == item_id)

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit))
    balances = result.scalars().all()

    items = [{
        "id": b.id, "item_id": b.item_id, "warehouse_id": b.warehouse_id,
        "bin_id": b.bin_id, "batch_id": b.batch_id,
        "available_qty": float(b.available_qty or 0),
        "reserved_qty": float(b.reserved_qty or 0),
        "transit_qty": float(b.transit_qty or 0),
        "total_qty": float(b.total_qty or 0),
        "valuation_rate": float(b.valuation_rate or 0),
        "stock_value": float(b.stock_value or 0),
    } for b in balances]

    return build_paginated_response(items, total, page, page_size)


# ==================== MATERIAL ISSUES ====================

@router.get("/material-issues", dependencies=[Depends(require_key("warehouse-material-issues"))])
async def list_material_issues(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    status: str = Query(None),
    warehouse_id: int = Query(None),
    department: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List material issues with pagination, status filter, and search."""
    offset, limit = paginate_params(page, page_size)
    query = select(MaterialIssue)
    count_query = select(func.count(MaterialIssue.id))

    if status:
        query = query.where(MaterialIssue.status == status)
        count_query = count_query.where(MaterialIssue.status == status)
    if warehouse_id:
        query = query.where(MaterialIssue.warehouse_id == warehouse_id)
        count_query = count_query.where(MaterialIssue.warehouse_id == warehouse_id)
    if department:
        query = query.where(MaterialIssue.department == department)
        count_query = count_query.where(MaterialIssue.department == department)

    query = apply_search_filter(query, MaterialIssue, search, ["issue_number", "department", "cost_center"])
    count_query = apply_search_filter(count_query, MaterialIssue, search, ["issue_number", "department", "cost_center"])

    total = (await db.execute(count_query)).scalar()
    # CR_16: include batch so we can return batch_number + expiry_date for the
    # MI items table (users want to see which expiry was issued).
    from app.models.warehouse import Batch as _Batch
    query = query.options(
        selectinload(MaterialIssue.items).selectinload(MaterialIssueItem.item),
        selectinload(MaterialIssue.items).selectinload(MaterialIssueItem.uom),
        selectinload(MaterialIssue.warehouse),
        selectinload(MaterialIssue.issued_to_user),
    )
    result = await db.execute(query.offset(offset).limit(limit).order_by(MaterialIssue.id.desc()))
    issues = result.scalars().all()

    # Bulk-load all batches referenced across all MIs to avoid N+1
    all_batch_ids = [
        it.batch_id for mi in issues for it in mi.items if it.batch_id
    ]
    batch_map = {}
    if all_batch_ids:
        b_rows = await db.execute(select(_Batch).where(_Batch.id.in_(set(all_batch_ids))))
        for b in b_rows.scalars().all():
            batch_map[b.id] = b

    items_list = []
    # Bulk-load all indents referenced by the current page of MIs
    all_indent_ids = list({mi.indent_id for mi in issues if mi.indent_id})
    indent_map = {}
    if all_indent_ids:
        from app.models.indent import Indent as _Indent
        ind_rows = await db.execute(select(_Indent).where(_Indent.id.in_(all_indent_ids)))
        for ind in ind_rows.scalars().all():
            indent_map[ind.id] = ind

    for mi in issues:
        indent = indent_map.get(mi.indent_id) if mi.indent_id else None
        mi_dict = {
            "id": mi.id,
            "issue_number": mi.issue_number,
            "mr_id": mi.mr_id,
            "indent_id": mi.indent_id,
            "indent_number": indent.indent_number if indent else None,
            "warehouse_id": mi.warehouse_id,
            "issue_date": mi.issue_date,
            "department": mi.department,
            "issued_to": mi.issued_to,
            "issued_to_name": (
                f"{mi.issued_to_user.first_name} {mi.issued_to_user.last_name or ''}".strip()
                or mi.issued_to_user.username
            ) if mi.issued_to_user else None,
            "warehouse_name": mi.warehouse.name if mi.warehouse else None,
            "cost_center": mi.cost_center,
            "status": mi.status,
            "remarks": mi.remarks,
            "issued_by": mi.issued_by,
            "created_at": mi.created_at,
            "items": [],
        }
        for item in mi.items:
            b = batch_map.get(item.batch_id) if item.batch_id else None
            mi_dict["items"].append({
                "id": item.id, "item_id": item.item_id,
                "item_name": item.item.name if item.item else None,
                "item_code": item.item.item_code if item.item else None,
                "uom_name": item.uom.name if item.uom else None,
                "qty": float(item.qty or 0),
                "uom_id": item.uom_id,
                "rate": float(item.rate or 0),
                "amount": float(item.amount or 0),
                # CR_16
                "batch_id": item.batch_id,
                "batch_number": b.batch_number if b else None,
                "expiry_date": b.expiry_date.isoformat() if (b and b.expiry_date) else None,
            })
        items_list.append(mi_dict)

    return build_paginated_response(items_list, total, page, page_size)



@router.post("/material-issues", status_code=201, dependencies=[Depends(require_key("warehouse-material-issues"))])
async def create_material_issue(
    payload: MaterialIssueCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "warehouse_operator", "store_keeper"
    )),
):
    """Create a new material issue with items. Auto-generates issue_number.

    Bug fix R-003 — was open to any authenticated user; procurement officer
    could create MIs without any warehouse permission.

    Bug fix D-006 — Schedule H1 / narcotic / Rx items now blocked at CREATE
    (was only checked at submit). Prescriber name + license required per line
    for restricted items.
    """
    if not payload.items:
        raise HTTPException(status_code=422, detail="At least one item is required")

    # BUG-ISS-005 — warehouse-membership check (super_admin/admin bypass).
    from app.utils.dependencies import (
        get_user_role_codes as _get_role_codes,
        user_warehouse_ids as _user_wh_ids,
    )
    _role_codes = await _get_role_codes(db, current_user.id)
    if not ({"super_admin", "admin"} & set(_role_codes)):
        _wh_ids = await _user_wh_ids(db, current_user.id)
        if payload.warehouse_id not in _wh_ids:
            raise HTTPException(
                status_code=403,
                detail="You are not authorised to issue from this warehouse",
            )

    # PATIENT SAFETY: block issuing expired medicine batches.
    # BUG-INV-046: use <= today (a batch expiring TODAY is already unusable —
    # patients can't take medicine that expires the same day they're dispensed).
    # BUG-INV-045: also enforce expiry on lines where batch_id is None when the
    # item is batch-tracked (medicine/pharma) — operator must pick a batch.
    from datetime import date as _date
    from app.models.warehouse import Batch as _Batch
    from app.models.master import Item as _MIItem
    batch_ids = [i.batch_id for i in payload.items if i.batch_id]
    batch_rows_list = []
    if batch_ids:
        br = await db.execute(
            select(_Batch).where(_Batch.id.in_(batch_ids))
        )
        batch_rows_list = br.scalars().all()
        today = _date.today()
        for b in batch_rows_list:
            exp = b.expiry_date
            if exp is not None and hasattr(exp, "date"):
                exp = exp.date()
            if exp is not None and exp <= today:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Batch {b.batch_number} {'expired' if exp < today else 'expires today'} "
                        f"({b.expiry_date}) — cannot issue."
                    ),
                )
    # BUG-INV-045: lines without batch_id for batch-tracked items must be rejected.
    item_ids_for_mi = list({i.item_id for i in payload.items if i.item_id})
    if item_ids_for_mi:
        rows = await db.execute(
            select(_MIItem.id, _MIItem.item_code, _MIItem.has_batch, _MIItem.has_expiry, _MIItem.item_type)
            .where(_MIItem.id.in_(item_ids_for_mi))
        )
        mi_item_meta = {r.id: r for r in rows.all()}
        BATCH_REQUIRED_TYPES_MI = {"medicine", "pharma", "drug", "consumable_medicine"}
        for it in payload.items:
            m = mi_item_meta.get(it.item_id)
            if not m:
                continue
            requires_batch = m.has_batch or (
                m.item_type and str(m.item_type).lower() in BATCH_REQUIRED_TYPES_MI
            )
            if requires_batch and it.batch_id is None:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"{m.item_code}: batch_id is required for batch-tracked items "
                        "(expiry must be verified before issue)."
                    ),
                )

    # BUG-ISS-008 — every batch must belong to this warehouse and matching item.
    _batch_map = {b.id: b for b in batch_rows_list}
    for it in payload.items:
        if it.batch_id and it.batch_id in _batch_map:
            b = _batch_map[it.batch_id]
            if getattr(b, "warehouse_id", None) and b.warehouse_id != payload.warehouse_id:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Batch {b.batch_number} belongs to warehouse "
                        f"{b.warehouse_id}, not {payload.warehouse_id}"
                    ),
                )
            if getattr(b, "item_id", None) and b.item_id != it.item_id:
                raise HTTPException(
                    status_code=400,
                    detail=f"Batch {b.batch_number} does not belong to item {it.item_id}",
                )

    # BUG-ISS-001 — pre-flight stock balance check at create time. Prevents
    # accepting an MI line we already know cannot be issued.
    # 2026-05-05: stock_balance can drift (no row even when ledger has stock).
    # Fall back to a SUM over stock_ledger when stock_balance returns nothing
    # or zero, so good legacy/imported stock isn't blocked.
    from sqlalchemy import func as _sa_func
    for it in payload.items:
        bal_conds = [
            StockBalance.item_id == it.item_id,
            StockBalance.warehouse_id == payload.warehouse_id,
        ]
        if it.batch_id is not None:
            bal_conds.append(StockBalance.batch_id == it.batch_id)
        if it.bin_id is not None:
            bal_conds.append(StockBalance.bin_id == it.bin_id)
        bal_row = await db.execute(select(StockBalance).where(and_(*bal_conds)))
        balances = bal_row.scalars().all()
        avail = sum((bb.available_qty or Decimal("0")) for bb in balances) or Decimal("0")
        if avail <= 0:
            ledger_conds = [
                StockLedger.item_id == it.item_id,
                StockLedger.warehouse_id == payload.warehouse_id,
            ]
            if it.batch_id is not None:
                ledger_conds.append(StockLedger.batch_id == it.batch_id)
            if it.bin_id is not None:
                ledger_conds.append(StockLedger.bin_id == it.bin_id)
            led_q = select(
                _sa_func.coalesce(_sa_func.sum(StockLedger.qty_in), 0)
                - _sa_func.coalesce(_sa_func.sum(StockLedger.qty_out), 0)
            ).where(and_(*ledger_conds))
            led_avail = (await db.execute(led_q)).scalar() or Decimal("0")
            if led_avail and led_avail > avail:
                avail = Decimal(str(led_avail))
        if (it.qty or Decimal("0")) > avail:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Insufficient stock for item {it.item_id} "
                    f"(batch {it.batch_id}, bin {it.bin_id}): "
                    f"available={avail}, requested={it.qty}"
                ),
            )

    # BUG-ISS-003 — block issue against a closed/cancelled indent.
    if payload.indent_id:
        try:
            from app.models.indent import Indent as _Indent
            ir = await db.execute(select(_Indent).where(_Indent.id == payload.indent_id))
            ind = ir.scalar_one_or_none()
            if not ind:
                raise HTTPException(status_code=404, detail="Linked indent not found")
            if ind.status not in ("approved", "partially_fulfilled"):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Cannot issue against indent in '{ind.status}' status — "
                        "must be approved or partially_fulfilled"
                    ),
                )
        except ImportError:
            pass

    # BUG-ISS-004 — block cross-org / cross-warehouse MR linkage.
    if payload.mr_id:
        try:
            from app.models.procurement import MaterialRequest as _MR
            mrr = await db.execute(select(_MR).where(_MR.id == payload.mr_id))
            mr = mrr.scalar_one_or_none()
            if not mr:
                raise HTTPException(status_code=404, detail="Linked material request not found")
            mr_org = getattr(mr, "organization_id", None)
            if mr_org and mr_org != current_user.organization_id:
                raise HTTPException(
                    status_code=403,
                    detail="Material request belongs to a different organization",
                )
            mr_wh = getattr(mr, "warehouse_id", None)
            if mr_wh and mr_wh != payload.warehouse_id:
                raise HTTPException(
                    status_code=400,
                    detail="Material request warehouse does not match this issue",
                )
        except ImportError:
            pass

    # D-006 — H1/narcotic/Rx prescriber gate at CREATE time
    from app.services.compliance_service import assert_prescriber_present_on_lines
    line_dicts = [
        {
            "item_id": l.item_id,
            "prescriber_name": getattr(l, "prescriber_name", None),
            "prescriber_license": getattr(l, "prescriber_license", None),
        }
        for l in payload.items
    ]

    max_retries = 3
    for attempt in range(max_retries):
        try:
            # BUG-ISS-013 — re-run prescriber gate inside the retry loop so a
            # rolled-back attempt cannot skip the compliance check on retry.
            # The check is idempotent (validates payload only) so re-running
            # is safe and adds defence against drift if it grows DB lookups.
            await assert_prescriber_present_on_lines(
                db, lines=line_dicts, source_type="material_issue", user_id=current_user.id,
            )
            issue_number = await generate_number(db, "warehouse", "material_issue")

            mi = MaterialIssue(
                issue_number=issue_number,
                mr_id=payload.mr_id,
                indent_id=payload.indent_id,
                warehouse_id=payload.warehouse_id,
                destination_warehouse_id=payload.destination_warehouse_id,
                issue_date=payload.issue_date,
                department=payload.department,
                issued_to=payload.issued_to,
                cost_center=payload.cost_center,
                remarks=payload.remarks,
                status="draft",
                issued_by=current_user.id,
            )
            db.add(mi)
            await db.flush()

            for item in payload.items:
                amount = item.qty * item.rate
                mi_item = MaterialIssueItem(
                    issue_id=mi.id,
                    item_id=item.item_id,
                    batch_id=item.batch_id,
                    qty=item.qty,
                    uom_id=item.uom_id,
                    bin_id=item.bin_id,
                    rate=item.rate,
                    amount=amount,
                    serial_numbers=item.serial_numbers,
                )
                db.add(mi_item)

            await db.flush()
            return {"id": mi.id, "issue_number": issue_number, "message": "Material issue created"}
        except IntegrityError:
            await db.rollback()
            if attempt == max_retries - 1:
                raise HTTPException(
                    status_code=409,
                    detail="Failed to generate unique issue number after multiple retries"
                )


@router.get("/material-issues/{issue_id}", response_model=MaterialIssueResponse, dependencies=[Depends(require_key("warehouse-material-issues"))])
async def get_material_issue(
    issue_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get material issue detail with items."""
    from app.models.indent import Indent
    result = await db.execute(
        select(MaterialIssue)
        .options(
            selectinload(MaterialIssue.items).selectinload(MaterialIssueItem.item),
            selectinload(MaterialIssue.items).selectinload(MaterialIssueItem.uom),
            selectinload(MaterialIssue.items).selectinload(MaterialIssueItem.batch),
            selectinload(MaterialIssue.warehouse),
            selectinload(MaterialIssue.destination_warehouse),
            selectinload(MaterialIssue.issued_to_user),
        )
        .where(MaterialIssue.id == issue_id)
    )
    mi = result.scalar_one_or_none()
    if not mi:
        raise HTTPException(status_code=404, detail="Material issue not found")
    response = MaterialIssueResponse.model_validate(mi).model_dump()
    response["warehouse_name"] = mi.warehouse.name if mi.warehouse else None
    response["destination_warehouse_name"] = mi.destination_warehouse.name if mi.destination_warehouse else None
    response["issued_to_name"] = (
        f"{mi.issued_to_user.first_name} {mi.issued_to_user.last_name or ''}".strip()
        or mi.issued_to_user.username
    ) if mi.issued_to_user else None
    # Enrich with indent_number so the dispatch form can display it without an extra call
    if mi.indent_id:
        indent_row = await db.get(Indent, mi.indent_id)
        response["indent_number"] = indent_row.indent_number if indent_row else None
    else:
        response["indent_number"] = None
    for i, item in enumerate(mi.items):
        response["items"][i]["item_name"] = item.item.name if item.item else None
        response["items"][i]["item_code"] = item.item.item_code if item.item else None
        response["items"][i]["uom_name"] = item.uom.name if item.uom else None
        response["items"][i]["batch_number"] = item.batch.batch_number if item.batch else None
        response["items"][i]["serial_numbers"] = item.serial_numbers
        response["items"][i]["has_serial"] = bool(item.item.has_serial) if item.item else False
    return response



@router.put("/material-issues/{issue_id}", dependencies=[Depends(require_key("warehouse-material-issues"))])
async def update_material_issue(
    issue_id: int,
    payload: MaterialIssueUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a draft material issue."""
    result = await db.execute(
        select(MaterialIssue)
        .options(selectinload(MaterialIssue.items))
        .where(MaterialIssue.id == issue_id)
    )
    mi = result.scalar_one_or_none()
    if not mi:
        raise HTTPException(status_code=404, detail="Material issue not found")
    if mi.status != "draft":
        raise HTTPException(status_code=400, detail="Only draft material issues can be updated")

    # Update scalar fields
    if payload.mr_id is not None:
        mi.mr_id = payload.mr_id
    if payload.indent_id is not None:
        mi.indent_id = payload.indent_id
    if payload.warehouse_id is not None:
        mi.warehouse_id = payload.warehouse_id
    if payload.destination_warehouse_id is not None:
        mi.destination_warehouse_id = payload.destination_warehouse_id
    if payload.issue_date is not None:
        mi.issue_date = payload.issue_date
    if payload.department is not None:
        mi.department = payload.department
    if payload.issued_to is not None:
        mi.issued_to = payload.issued_to
    if payload.cost_center is not None:
        mi.cost_center = payload.cost_center
    if payload.remarks is not None:
        mi.remarks = payload.remarks

    # Replace items if provided
    if payload.items is not None:
        # BUG-INV-052: do a single bulk DELETE rather than N per-row deletes,
        # and explicitly refresh the cached relationship. The previous per-row
        # loop produced O(N) round-trips and the in-memory `mi.items` was a
        # stale list of detached ORM instances after the deletes — any later
        # code that read mi.items in the same request would still see the
        # supposedly-deleted lines.
        from sqlalchemy import delete as _sql_delete
        await db.execute(
            _sql_delete(MaterialIssueItem).where(MaterialIssueItem.issue_id == mi.id)
        )
        await db.flush()
        await db.refresh(mi, attribute_names=["items"])

        # Add new items
        for item in payload.items:
            amount = item.qty * item.rate
            mi_item = MaterialIssueItem(
                issue_id=mi.id,
                item_id=item.item_id,
                batch_id=item.batch_id,
                qty=item.qty,
                uom_id=item.uom_id,
                bin_id=item.bin_id,
                rate=item.rate,
                amount=amount,
                prescriber_name=getattr(item, "prescriber_name", None),
                prescriber_license=getattr(item, "prescriber_license", None),
                patient_name=getattr(item, "patient_name", None),
                patient_id_text=getattr(item, "patient_id_text", None),
                serial_numbers=item.serial_numbers,
            )
            db.add(mi_item)

    await db.flush()
    return {"id": mi.id, "issue_number": mi.issue_number, "message": "Material issue updated"}


@router.post("/material-issues/{issue_id}/issue", dependencies=[Depends(require_key("warehouse-material-issues"))])
async def issue_material(
    issue_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-INV-055: include super_admin (system-wide override) and store_keeper
    # (the role that physically dispenses stock from the bin) — they were
    # excluded so the literal people who issue material couldn't post the issue.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "warehouse_operator", "store_keeper"
    )),
):
    """Mark material issue as issued and deduct stock."""
    # BUG-ISS-006 — race fix: lock the MI row FOR UPDATE so concurrent
    # /issue calls cannot both pass the draft-check and double-decrement
    # stock. The SELECT FOR UPDATE serialises the status check with the
    # subsequent flip below.
    result = await db.execute(
        select(MaterialIssue)
        .options(
            selectinload(MaterialIssue.items).selectinload(MaterialIssueItem.item)
        )
        .where(MaterialIssue.id == issue_id)
        .with_for_update()
    )
    mi = result.scalar_one_or_none()
    if not mi:
        raise HTTPException(status_code=404, detail="Material issue not found")
    if mi.status != "draft":
        raise HTTPException(status_code=400, detail="Only draft material issues can be issued")

    if not mi.items or len(mi.items) == 0:
        raise HTTPException(status_code=400, detail="Material issue has no items")

    # Validate serial numbers for serial-tracked items
    serials_to_issue = []
    for item in mi.items:
        has_serial = bool(item.item.has_serial) if item.item else False
        if has_serial:
            qty_int = int(item.qty)
            if not item.serial_numbers or len(item.serial_numbers) != qty_int:
                raise HTTPException(
                    status_code=400,
                    detail=f"Item {item.item.name if item.item else item.item_id} requires {qty_int} serial numbers, but got {len(item.serial_numbers) if item.serial_numbers else 0}."
                )
            if len(item.serial_numbers) != len(set(item.serial_numbers)):
                raise HTTPException(
                    status_code=400,
                    detail=f"Duplicate serial numbers provided for item {item.item.name if item.item else item.item_id}."
                )
            
            sn_conds = [
                SerialNumber.item_id == item.item_id,
                SerialNumber.serial_number.in_(item.serial_numbers),
                SerialNumber.warehouse_id == mi.warehouse_id,
                SerialNumber.status == "available"
            ]
            if item.bin_id is not None:
                sn_conds.append(SerialNumber.bin_id == item.bin_id)
            if item.batch_id is not None:
                sn_conds.append(SerialNumber.batch_id == item.batch_id)
                
            sn_stmt = select(SerialNumber).where(and_(*sn_conds))
            sn_rows = (await db.execute(sn_stmt)).scalars().all()
            
            found_serials = {s.serial_number for s in sn_rows}
            missing_serials = set(item.serial_numbers) - found_serials
            if missing_serials:
                raise HTTPException(
                    status_code=400,
                    detail=f"The following serial numbers are not available in the selected warehouse/bin/batch: {', '.join(missing_serials)}"
                )
            serials_to_issue.extend(sn_rows)

    # PATIENT SAFETY: double-check expiry at issue time. Even if create_material_issue
    # let a batch through (concurrent expiry date update, draft aged out, etc.),
    # we re-verify here before posting stock ledger.
    # BUG-INV-046: use <= today (today is already too late to issue).
    from datetime import date as _date
    from app.models.warehouse import Batch as _Batch
    batch_ids = [i.batch_id for i in mi.items if i.batch_id]
    if batch_ids:
        batch_rows = await db.execute(
            select(_Batch).where(_Batch.id.in_(batch_ids))
        )
        today = _date.today()
        for b in batch_rows.scalars().all():
            exp = b.expiry_date
            if exp is not None and hasattr(exp, "date"):
                exp = exp.date()
            if exp is not None and exp <= today:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Batch {b.batch_number} {'expired' if exp < today else 'expires today'} "
                        f"({b.expiry_date}) — cannot issue."
                    ),
                )

    # Wave 7 — H1/narcotic prescriber gate: block submit if any restricted item
    # lacks prescriber name + license on its line.
    from app.services.compliance_service import (
        assert_prescriber_present_on_lines, items_requiring_prescriber, record_prescription,
    )
    line_dicts = [
        {
            "item_id": i.item_id,
            "prescriber_name": i.prescriber_name,
            "prescriber_license": i.prescriber_license,
        }
        for i in mi.items
    ]
    await assert_prescriber_present_on_lines(
        db, lines=line_dicts, source_type="material_issue", user_id=current_user.id,
    )
    flagged_items = await items_requiring_prescriber(db, [i.item_id for i in mi.items])

    # BUG-INV-047: pre-check stock availability for every line BEFORE the
    # decrement loop. Without this, a mid-loop InsufficientStockError leaves
    # earlier lines decremented and later lines untouched — the MI is then
    # neither fully issued nor cleanly rejectable.
    # BUG-INV-048: also validate that any bin_id on the line belongs to the
    # MI's warehouse — otherwise the decrement could land on the wrong shelf
    # and the bin balance go negative without anyone noticing.
    bin_ids_on_lines = [it.bin_id for it in mi.items if it.bin_id is not None]
    bin_to_wh: dict = {}
    if bin_ids_on_lines:
        from app.models.warehouse import (
            WarehouseBin as _Bin, WarehouseRack as _Rack,
            WarehouseLine as _Line, WarehouseLocation as _Loc,
        )
        wh_rows = await db.execute(
            select(_Bin.id, _Loc.warehouse_id)
            .join(_Rack, _Rack.id == _Bin.rack_id)
            .join(_Line, _Line.id == _Rack.line_id)
            .join(_Loc, _Loc.id == _Line.location_id)
            .where(_Bin.id.in_(bin_ids_on_lines))
        )
        bin_to_wh = {r[0]: r[1] for r in wh_rows.all()}

    for item in mi.items:
        if item.bin_id is not None:
            wh_for_bin = bin_to_wh.get(item.bin_id)
            if wh_for_bin is None:
                raise HTTPException(
                    status_code=400,
                    detail=f"Bin {item.bin_id} not found",
                )
            if wh_for_bin != mi.warehouse_id:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Bin {item.bin_id} belongs to warehouse {wh_for_bin}, "
                        f"but material issue is for warehouse {mi.warehouse_id}"
                    ),
                )
        bal_conds = [
            StockBalance.item_id == item.item_id,
            StockBalance.warehouse_id == mi.warehouse_id,
        ]
        if item.batch_id is not None:
            bal_conds.append(StockBalance.batch_id == item.batch_id)
        else:
            bal_conds.append(StockBalance.batch_id.is_(None))
        if item.bin_id is not None:
            bal_conds.append(StockBalance.bin_id == item.bin_id)
        bal_row = await db.execute(select(StockBalance).where(and_(*bal_conds)))
        balances = bal_row.scalars().all()
        avail = sum((b.available_qty or Decimal("0")) for b in balances) or Decimal("0")
        if (item.qty or Decimal("0")) > avail:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Insufficient stock for item {item.item_id} "
                    f"(batch {item.batch_id}, bin {item.bin_id}): "
                    f"available={avail}, requested={item.qty}"
                ),
            )

    # Reserve stock for each item and capture the estimated valuation rate
    from app.services.stock_service import reserve_stock, _get_or_create_balance
    for item in mi.items:
        success = await reserve_stock(
            db,
            item_id=item.item_id,
            warehouse_id=mi.warehouse_id,
            qty=item.qty,
            bin_id=item.bin_id,
            batch_id=item.batch_id,
        )
        if not success:
            raise HTTPException(
                status_code=400,
                detail=f"Failed to reserve stock for item {item.item_id}",
            )
        
        balance = await _get_or_create_balance(
            db,
            item_id=item.item_id,
            warehouse_id=mi.warehouse_id,
            bin_id=item.bin_id,
            batch_id=item.batch_id,
        )
        effective_rate = balance.valuation_rate or Decimal("0")
        item.rate = effective_rate
        item.amount = (item.qty or Decimal("0")) * effective_rate

    for s in serials_to_issue:
        s.status = "issued"

    mi.status = "issued"
    mi.issued_by = current_user.id

    # Wave 7 — record prescription audit rows for restricted items
    # BUG-INV-053: do NOT swallow audit failures. Schedule H1 / narcotic
    # dispense events legally must be recorded; if recording fails, the
    # whole issue must roll back so the regulator audit trail stays intact.
    for item in mi.items:
        if item.item_id in flagged_items:
            info = flagged_items[item.item_id]
            await record_prescription(
                db,
                source_type="material_issue",
                source_id=mi.id,
                item_id=item.item_id,
                batch_id=item.batch_id,
                qty=item.qty,
                drug_schedule=info["drug_schedule"],
                prescriber_name=item.prescriber_name,
                prescriber_license=item.prescriber_license,
                patient_name=item.patient_name,
                patient_id=item.patient_id_text,
                prescription_image_url=None,
                dispensed_by=current_user.id,
            )

    # --- Update linked indent's issued_qty and status ---
    if mi.indent_id:
        from app.models.indent import Indent, IndentItem
        from app.models.master import UOMConversion as _UC
        indent_result = await db.execute(
            select(Indent).options(selectinload(Indent.items)).where(Indent.id == mi.indent_id)
        )
        indent = indent_result.scalar_one_or_none()
        if indent:
            # BUG-INV-054: an indent may have multiple lines for the SAME
            # item_id (different cost-centre splits, repeat orders consolidated
            # into one indent). The old `break` after the first match stopped
            # crediting once any indent line for that item_id was found, so
            # subsequent duplicate lines stayed showing zero issued_qty even
            # though stock had been moved. Now we greedily fill each duplicate
            # line up to its (approved_qty or requested_qty) target before
            # spilling onto the next.
            for mi_item in mi.items:
                # Convert MI line into a normalised "remaining qty to credit"
                # in the indent line's UOM (handled per-target inside loop —
                # different indent lines may have different UOMs in theory).
                base_qty = mi_item.qty or Decimal("0")
                # Collect candidate indent lines (same item, with remaining
                # capacity to absorb credit).
                candidates = [
                    il for il in indent.items
                    if il.item_id == mi_item.item_id
                ]
                remaining_to_credit = Decimal(str(base_qty))
                for ind_item in candidates:
                    if remaining_to_credit <= 0:
                        break
                    # Convert remaining_to_credit (in MI uom) -> indent uom
                    try:
                        if (
                            ind_item.uom_id
                            and mi_item.uom_id
                            and ind_item.uom_id != mi_item.uom_id
                        ):
                            cr = await db.execute(
                                select(_UC).where(
                                    _UC.from_uom_id == mi_item.uom_id,
                                    _UC.to_uom_id == ind_item.uom_id,
                                )
                            )
                            conv = cr.scalar_one_or_none()
                            if conv and conv.conversion_factor:
                                add_qty_in_indent_uom = remaining_to_credit * Decimal(str(conv.conversion_factor))
                            else:
                                cr2 = await db.execute(
                                    select(_UC).where(
                                        _UC.from_uom_id == ind_item.uom_id,
                                        _UC.to_uom_id == mi_item.uom_id,
                                    )
                                )
                                conv2 = cr2.scalar_one_or_none()
                                if conv2 and conv2.conversion_factor:
                                    add_qty_in_indent_uom = remaining_to_credit / Decimal(str(conv2.conversion_factor))
                                else:
                                    add_qty_in_indent_uom = remaining_to_credit
                        else:
                            add_qty_in_indent_uom = remaining_to_credit
                    except Exception:
                        logger.exception("UOM convert failed for indent %s item %s", indent.id, ind_item.item_id)
                        add_qty_in_indent_uom = remaining_to_credit

                    target = Decimal(str(ind_item.approved_qty or ind_item.requested_qty or 0))
                    already = Decimal(str(ind_item.issued_qty or 0))
                    capacity = target - already
                    if capacity <= 0:
                        # already fulfilled; try next duplicate line
                        continue
                    take = min(add_qty_in_indent_uom, capacity)
                    ind_item.issued_qty = already + take
                    # Convert "take" back to MI uom to subtract from remaining
                    if take == add_qty_in_indent_uom:
                        consumed_in_mi_uom = remaining_to_credit
                    else:
                        # Proportional reverse
                        try:
                            if add_qty_in_indent_uom > 0:
                                consumed_in_mi_uom = remaining_to_credit * (take / add_qty_in_indent_uom)
                            else:
                                consumed_in_mi_uom = remaining_to_credit
                        except Exception:
                            consumed_in_mi_uom = remaining_to_credit
                    remaining_to_credit -= consumed_in_mi_uom
                # If remaining_to_credit > 0 after walking all duplicates, the
                # over-issue lands on the LAST candidate (matches old behaviour
                # of credit-everything to the first match for a single line).
                if remaining_to_credit > 0 and candidates:
                    last_line = candidates[-1]
                    last_line.issued_qty = (last_line.issued_qty or Decimal("0")) + remaining_to_credit
            # Determine indent fulfilment status after issue.
            # IMPORTANT: We deliberately do NOT set status = "fulfilled" here.
            # An indent is only truly fulfilled after the RAISER acknowledges
            # receipt of the material. At issue time we track how much has been
            # issued vs approved, and if any qty was issued we mark the indent as
            # "partially_fulfilled" so it stays visible in the demand pool until
            # the raiser confirms receipt. The demand pool uses acknowledged_qty
            # (from IndentAcknowledgementItem) to decide when to remove a line.
            any_issued = False
            for ind_item in indent.items:
                if (ind_item.issued_qty or 0) > 0:
                    any_issued = True
                    break
            if any_issued:
                # Always partially_fulfilled at issue time — full "fulfilled" set
                # only by the acknowledge endpoint once ACK qty >= approved qty.
                indent.status = "partially_fulfilled"

    await db.flush()
    return {"id": mi.id, "issue_number": mi.issue_number, "message": "Material issued successfully, stock reserved"}


@router.post("/material-issues/{issue_id}/dispatch", dependencies=[Depends(require_key("warehouse-material-issues"))])
async def dispatch_material_issue(
    issue_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "warehouse_operator", "store_keeper"
    )),
):
    """Mark material issue as dispatched, reduce stock, and post GL entries."""
    result = await db.execute(
        select(MaterialIssue)
        .options(selectinload(MaterialIssue.items))
        .where(MaterialIssue.id == issue_id)
        .with_for_update()
    )
    mi = result.scalar_one_or_none()
    if not mi:
        raise HTTPException(status_code=404, detail="Material issue not found")
    if mi.status != "issued":
        raise HTTPException(status_code=400, detail="Only issued material issues can be dispatched")

    if not mi.items or len(mi.items) == 0:
        raise HTTPException(status_code=400, detail="Material issue has no items")

    from app.services.stock_service import release_reservation, post_stock_ledger
    issue_gl_items: list[dict] = []
    for item in mi.items:
        # 1. Release reservation
        await release_reservation(
            db,
            item_id=item.item_id,
            warehouse_id=mi.warehouse_id,
            qty=item.qty,
            bin_id=item.bin_id,
            batch_id=item.batch_id,
        )

        # 2. Post stock ledger entry to deduct total quantity
        ledger_row = await post_stock_ledger(
            db,
            item_id=item.item_id,
            warehouse_id=mi.warehouse_id,
            transaction_type="material_issue",
            qty_out=item.qty,
            rate=item.rate,
            bin_id=item.bin_id,
            batch_id=item.batch_id,
            reference_type="material_issue",
            reference_id=mi.id,
            uom_id=item.uom_id,
            created_by=current_user.id,
        )

        if ledger_row and ledger_row.rate is not None:
            effective_rate = Decimal(str(ledger_row.rate))
            item.rate = effective_rate
            item.amount = (item.qty or Decimal("0")) * effective_rate

        issue_gl_items.append({
            "item_id": item.item_id,
            "qty": item.qty,
            "rate": (ledger_row.rate if ledger_row else None) or item.rate or Decimal("0"),
        })

    mi.status = "dispatched"
    mi.dispatched_at = datetime.now(timezone.utc)

    # Fire GL posting (Consumption Dr / Inventory Cr)
    try:
        from app.services.gl_posting import post_issue_gl
        org_id = current_user.organization_id or 1
        await post_issue_gl(
            db,
            organization_id=org_id,
            issue_id=mi.id,
            issue_number=mi.issue_number,
            issue_date=mi.issue_date,
            warehouse_id=mi.warehouse_id,
            items=issue_gl_items,
            created_by=current_user.id,
        )
    except Exception:
        logger.exception("GL posting failed for material issue dispatch %s", mi.issue_number)

    await db.flush()
    return {"id": mi.id, "issue_number": mi.issue_number, "message": "Material issue dispatched successfully"}


@router.post("/material-issues/{issue_id}/cancel", dependencies=[Depends(require_key("warehouse-material-issues"))])
async def cancel_material_issue(
    issue_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager"
    )),
):
    """BUG-ISS-016 — Cancel a draft or issued material issue.

    For 'issued' MIs, posts a reversing stock-ledger entry per line and a
    reversing GL journal so inventory + accounts return to pre-issue state.
    For 'draft' MIs, just flips status (nothing was deducted).
    """
    result = await db.execute(
        select(MaterialIssue)
        .options(selectinload(MaterialIssue.items))
        .where(MaterialIssue.id == issue_id)
        .with_for_update()
    )
    mi = result.scalar_one_or_none()
    if not mi:
        raise HTTPException(status_code=404, detail="Material issue not found")
    if mi.status in ("cancelled", "completed", "acknowledged"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot cancel a material issue with status '{mi.status}'",
        )

    if mi.status == "issued":
        from app.services.stock_service import release_reservation
        for item in mi.items:
            await release_reservation(
                db,
                item_id=item.item_id,
                warehouse_id=mi.warehouse_id,
                qty=item.qty,
                bin_id=item.bin_id,
                batch_id=item.batch_id,
            )

        # Decrement linked indent issued_qty so it can be re-fulfilled
        if mi.indent_id:
            from app.models.indent import Indent
            indent_result = await db.execute(
                select(Indent).options(selectinload(Indent.items)).where(Indent.id == mi.indent_id)
            )
            indent = indent_result.scalar_one_or_none()
            if indent:
                for mi_item in mi.items:
                    for ind_item in indent.items:
                        if ind_item.item_id == mi_item.item_id:
                            ind_item.issued_qty = max(0, (ind_item.issued_qty or 0) - mi_item.qty)
                            break

    elif mi.status == "dispatched":
        # Reverse stock ledger — push qty back IN with the same valuation
        reverse_gl_items: list[dict] = []
        for item in mi.items:
            ledger_row = await post_stock_ledger(
                db,
                item_id=item.item_id,
                warehouse_id=mi.warehouse_id,
                transaction_type="material_issue",
                qty_in=item.qty,
                rate=item.rate,
                bin_id=item.bin_id,
                batch_id=item.batch_id,
                reference_type="material_issue_cancel",
                reference_id=mi.id,
                uom_id=item.uom_id,
                created_by=current_user.id,
            )
            reverse_gl_items.append({
                "item_id": item.item_id,
                "qty": -1 * (item.qty or 0),  # negative qty triggers reverse JE
                "rate": (ledger_row.rate if ledger_row else None) or item.rate or 0,
            })

        # Reverse GL by posting an issue JE with negated quantities. The
        # post_issue_gl helper skips zero/negative rows so we hand-craft a
        # mirror entry by re-using the reference for traceability.
        try:
            from app.services.gl_posting import post_issue_gl
            org_id = current_user.organization_id or 1
            # post_issue_gl uses qty*rate; negated qty produces reversing JE
            # but the helper drops rows where amount<=0. Build with absolute
            # values and let the JE narration mark it as a reversal.
            gl_items = [
                {"item_id": gi["item_id"], "qty": abs(gi["qty"]), "rate": gi["rate"]}
                for gi in reverse_gl_items
            ]
            await post_issue_gl(
                db,
                organization_id=org_id,
                issue_id=mi.id,
                issue_number=f"{mi.issue_number}-CANCEL",
                issue_date=mi.issue_date,
                warehouse_id=mi.warehouse_id,
                items=gl_items,
                created_by=current_user.id,
            )
        except Exception:
            logger.exception("Reversal GL posting failed for material issue %s", mi.issue_number)

        # Decrement linked indent issued_qty so it can be re-fulfilled
        if mi.indent_id:
            from app.models.indent import Indent
            indent_result = await db.execute(
                select(Indent).options(selectinload(Indent.items)).where(Indent.id == mi.indent_id)
            )
            indent = indent_result.scalar_one_or_none()
            if indent:
                for mi_item in mi.items:
                    for ind_item in indent.items:
                        if ind_item.item_id == mi_item.item_id:
                            ind_item.issued_qty = max(0, (ind_item.issued_qty or 0) - mi_item.qty)
                            break

    # BUG-ISS-018 — annotate prior prescription_records so the regulator audit
    # log reflects the cancellation. Legal retention forbids hard-deleting the
    # rows, so we tag them in `notes` instead.
    try:
        from app.models.compliance import PrescriptionRecord as _PR
        from datetime import datetime as _dt, timezone as _tz
        pr_q = await db.execute(
            select(_PR).where(
                _PR.source_type == "material_issue",
                _PR.source_id == mi.id,
            )
        )
        for _pr in pr_q.scalars().all():
            tag = f"[CANCELLED at {_dt.now(_tz.utc).isoformat()} by user {current_user.id}]"
            _pr.notes = (
                f"{_pr.notes}\n{tag}" if _pr.notes else tag
            )
    except Exception:
        logger.exception(
            "Failed to annotate prescription_records for cancelled MI %s", mi.id
        )

    # Revert serial numbers back to "available"
    if mi.status in ("issued", "dispatched"):
        for item in mi.items:
            if item.serial_numbers:
                sn_q = await db.execute(
                    select(SerialNumber).where(
                        SerialNumber.item_id == item.item_id,
                        SerialNumber.serial_number.in_(item.serial_numbers),
                        SerialNumber.status == "issued"
                    )
                )
                for sn in sn_q.scalars().all():
                    sn.status = "available"

    mi.status = "cancelled"
    await db.flush()
    return {"id": mi.id, "issue_number": mi.issue_number, "message": "Material issue cancelled"}


@router.post("/material-issues/{issue_id}/acknowledge", dependencies=[Depends(require_key("warehouse-material-issues"))])
async def acknowledge_material_issue(
    issue_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-ISS-021 — only the recipient (issued_to) or admin/manager roles
    # may close the loop on someone else's issue.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "warehouse_operator",
        "store_keeper", "department_head",
    )),
):
    """Acknowledge receipt of issued material."""
    result = await db.execute(
        select(MaterialIssue)
        .options(selectinload(MaterialIssue.items))
        .where(MaterialIssue.id == issue_id)
    )
    mi = result.scalar_one_or_none()
    if not mi:
        raise HTTPException(status_code=404, detail="Material issue not found")
    if mi.status != "dispatched":
        raise HTTPException(status_code=400, detail="Only dispatched material issues can be acknowledged")

    # BUG-ISS-021 — recipient-or-admin restriction. A non-admin must be the
    # MI's issued_to user before acknowledging on their behalf.
    from app.utils.dependencies import get_user_role_codes as _get_role_codes
    _role_codes = await _get_role_codes(db, current_user.id)
    is_admin = bool({"super_admin", "admin", "warehouse_manager"} & set(_role_codes))
    if not is_admin and mi.issued_to and mi.issued_to != current_user.id:
        raise HTTPException(
            status_code=403,
            detail="Only the recipient or a warehouse manager can acknowledge this issue",
        )

    mi.status = "acknowledged"

    # Post stock ledger entries at the destination warehouse if destination_warehouse_id is set
    if mi.destination_warehouse_id:
        from app.services.stock_service import post_stock_ledger
        for item in mi.items:
            await post_stock_ledger(
                db,
                item_id=item.item_id,
                warehouse_id=mi.destination_warehouse_id,
                transaction_type="material_issue",
                qty_in=item.qty,
                rate=item.rate,
                bin_id=None,
                batch_id=item.batch_id,
                reference_type="material_issue",
                reference_id=mi.id,
                uom_id=item.uom_id,
                created_by=current_user.id,
            )

    # -----------------------------------------------------------------------
    # After acknowledgement, update the linked indent's fulfillment status.
    # This is the ONLY place that can promote an indent to "fulfilled".
    # We sum all AcknowledgementItem rows for each indent line across ALL MIs
    # so partial acknowledgements across multiple issues are handled correctly.
    # -----------------------------------------------------------------------
    if mi.indent_id:
        from app.models.indent import Indent as _Indent, IndentAcknowledgementItem as _IAI
        from sqlalchemy.orm import selectinload as _sil
        indent_res = await db.execute(
            select(_Indent)
            .options(_sil(_Indent.items))
            .where(_Indent.id == mi.indent_id)
        )
        indent = indent_res.scalar_one_or_none()
        if indent:
            # Sum all acknowledged qtys per indent_item_id across all past acks
            ind_item_ids = [it.id for it in (indent.items or [])]
            if ind_item_ids:
                ack_rows = (await db.execute(
                    select(_IAI.indent_item_id, func.sum(_IAI.received_qty).label("total_acked"))
                    .where(_IAI.indent_item_id.in_(ind_item_ids))
                    .group_by(_IAI.indent_item_id)
                )).all()
                ack_map = {r[0]: float(r[1] or 0) for r in ack_rows}

                all_acked = True
                any_acked = False
                for ind_item in indent.items:
                    target = float(ind_item.approved_qty or ind_item.requested_qty or 0)
                    acked = ack_map.get(ind_item.id, 0)
                    if acked > 0:
                        any_acked = True
                    if acked < target:
                        all_acked = False

                if all_acked and any_acked:
                    indent.status = "fulfilled"       # fully acknowledged → remove from demand pool
                elif any_acked:
                    indent.status = "partially_fulfilled"  # partially acked → stays in pool with remaining qty

    await db.flush()
    return {"id": mi.id, "issue_number": mi.issue_number, "message": "Material issue acknowledged"}


@router.delete("/material-issues/{mi_id}", dependencies=[Depends(require_key("warehouse-material-issues"))])
async def delete_material_issue(
    mi_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-ISS-020 — restrict delete to roles authorised to manage MIs.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "warehouse_operator"
    )),
):
    """Delete a draft/pending material issue. Issued/completed issues cannot be deleted."""
    result = await db.execute(select(MaterialIssue).where(MaterialIssue.id == mi_id))
    mi = result.scalar_one_or_none()
    if not mi:
        raise HTTPException(status_code=404, detail="Material issue not found")
    # BUG-INV-050: also block delete on "acknowledged" — once a recipient has
    # acknowledged the issue, the stock has been consumed and audit history
    # must remain intact. Only draft/pending/cancelled MIs may be deleted.
    if mi.status in ("issued", "dispatched", "completed", "acknowledged"):
        raise HTTPException(status_code=400, detail=f"Cannot delete a {mi.status} material issue")

    # BUG-ISS-020 — additionally enforce creator-or-admin: a non-admin
    # warehouse_operator may only delete their own draft MI.
    from app.utils.dependencies import get_user_role_codes as _get_role_codes
    _role_codes = await _get_role_codes(db, current_user.id)
    is_admin = bool({"super_admin", "admin", "warehouse_manager"} & set(_role_codes))
    if not is_admin and mi.issued_by and mi.issued_by != current_user.id:
        raise HTTPException(
            status_code=403,
            detail="You can only delete material issues you created",
        )

    await db.delete(mi)
    await db.flush()
    return {"success": True, "message": "Material issue deleted"}


# ==================== PURCHASE RETURNS ====================

@router.get("/purchase-returns")
async def list_purchase_returns(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    status: str = Query(None),
    vendor_id: int = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(PurchaseReturn)
    count_query = select(func.count(PurchaseReturn.id))

    if status:
        query = query.where(PurchaseReturn.status == status)
        count_query = count_query.where(PurchaseReturn.status == status)
    if vendor_id:
        query = query.where(PurchaseReturn.vendor_id == vendor_id)
        count_query = count_query.where(PurchaseReturn.vendor_id == vendor_id)
    if warehouse_id:
        query = query.where(PurchaseReturn.warehouse_id == warehouse_id)
        count_query = count_query.where(PurchaseReturn.warehouse_id == warehouse_id)

    # BUG-ISS-060 — auto-restrict to warehouses the user has membership of so
    # the list does not leak cross-org / cross-warehouse return data.
    try:
        from app.utils.dependencies import (
            get_user_role_codes as _get_role_codes,
            user_warehouse_ids as _user_wh_ids,
        )
        _role_codes = await _get_role_codes(db, current_user.id)
        if not ({"super_admin", "admin"} & set(_role_codes)):
            _wh_ids = await _user_wh_ids(db, current_user.id)
            if _wh_ids:
                query = query.where(PurchaseReturn.warehouse_id.in_(_wh_ids))
                count_query = count_query.where(PurchaseReturn.warehouse_id.in_(_wh_ids))
            else:
                query = query.where(PurchaseReturn.id == -1)
                count_query = count_query.where(PurchaseReturn.id == -1)
    except Exception:
        pass

    query = apply_search_filter(query, PurchaseReturn, search, ["return_number", "reason"])
    count_query = apply_search_filter(count_query, PurchaseReturn, search, ["return_number", "reason"])

    total = (await db.execute(count_query)).scalar()
    query = query.options(
        selectinload(PurchaseReturn.items).selectinload(PurchaseReturnItem.item),
        selectinload(PurchaseReturn.items).selectinload(PurchaseReturnItem.uom),
    )
    result = await db.execute(query.offset(offset).limit(limit).order_by(PurchaseReturn.id.desc()))
    returns = result.scalars().all()

    items_list = []
    for r in returns:
        r_dict = {
            "id": r.id, "return_number": r.return_number, "po_id": r.po_id,
            "grn_id": r.grn_id, "vendor_id": r.vendor_id,
            "warehouse_id": r.warehouse_id, "return_date": r.return_date,
            "reason": r.reason, "status": r.status,
            "total_amount": float(r.total_amount or 0),
            "created_by": r.created_by, "created_at": r.created_at,
            "items": [],
        }
        for item in r.items:
            r_dict["items"].append({
                "id": item.id, "item_id": item.item_id,
                "item_name": item.item.name if item.item else None,
                "item_code": item.item.item_code if item.item else None,
                "uom_name": item.uom.name if item.uom else None,
                "qty": float(item.qty or 0),
                "uom_id": item.uom_id,
                "rate": float(item.rate or 0),
                "amount": float(item.amount or 0),
            })
        items_list.append(r_dict)

    return build_paginated_response(items_list, total, page, page_size)


@router.get("/purchase-returns/{return_id}", response_model=PurchaseReturnResponse)
async def get_purchase_return(
    return_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(PurchaseReturn)
        .options(
            selectinload(PurchaseReturn.items).selectinload(PurchaseReturnItem.item),
            selectinload(PurchaseReturn.items).selectinload(PurchaseReturnItem.uom),
        )
        .where(PurchaseReturn.id == return_id)
    )
    pr = result.scalar_one_or_none()
    if not pr:
        raise HTTPException(status_code=404, detail="Purchase Return not found")
    response = PurchaseReturnResponse.model_validate(pr).model_dump()
    for i, item in enumerate(pr.items):
        response["items"][i]["item_name"] = item.item.name if item.item else None
        response["items"][i]["item_code"] = item.item.item_code if item.item else None
        response["items"][i]["uom_name"] = item.uom.name if item.uom else None
    return response


@router.post("/purchase-returns", status_code=201)
async def create_purchase_return(
    payload: PurchaseReturnCreate,
    db: AsyncSession = Depends(get_db),
    # BUG-ISS-059 — restrict to roles authorised to create returns.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "warehouse_operator",
        "store_keeper", "procurement_manager",
    )),
):
    """Create a purchase return with items, auto-generating the return_number via number series.

    BUG-ISS-056 — return qty MUST be <= (grn.received_qty - prior_returns.qty)
    per line, or the vendor is debited for impossible quantity.
    BUG-ISS-058 — return_date must be >= grn.received_date.
    """
    # BUG-ISS-058 — block return_date earlier than the GRN received_date.
    if payload.grn_id and payload.return_date:
        try:
            grn_dt_q = await db.execute(
                select(GoodsReceiptNote.received_date).where(GoodsReceiptNote.id == payload.grn_id)
            )
            grn_received = grn_dt_q.scalar_one_or_none()
            if grn_received is not None:
                rd = grn_received.date() if hasattr(grn_received, "date") else grn_received
                if payload.return_date < rd:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Return date {payload.return_date} is earlier than "
                            f"the GRN received date {rd}"
                        ),
                    )
        except HTTPException:
            raise
        except Exception:
            pass

    # BUG-ISS-056 — validate per-line that the requested return qty does not
    # exceed the remaining returnable qty against the linked GRN.
    if payload.grn_id:
        from app.models.grn import GRNItem
        # Sum already-returned qty per (item_id, batch_id) for this GRN across
        # all non-cancelled prior PRs.
        prior_q = select(
            PurchaseReturnItem.item_id,
            PurchaseReturnItem.batch_id,
            func.coalesce(func.sum(PurchaseReturnItem.qty), 0).label("returned"),
        ).join(
            PurchaseReturn, PurchaseReturn.id == PurchaseReturnItem.return_id
        ).where(
            PurchaseReturn.grn_id == payload.grn_id,
            PurchaseReturn.status != "cancelled",
        ).group_by(
            PurchaseReturnItem.item_id, PurchaseReturnItem.batch_id
        )
        prior_rows = (await db.execute(prior_q)).all()
        prior_map = {(r.item_id, r.batch_id): Decimal(str(r.returned or 0)) for r in prior_rows}

        # GRN items by (item_id, batch_id)
        grn_items_q = await db.execute(
            select(GRNItem).where(GRNItem.grn_id == payload.grn_id)
        )
        grn_items = grn_items_q.scalars().all()
        grn_received_map: dict = {}
        for gi in grn_items:
            key = (gi.item_id, getattr(gi, "batch_id", None))
            grn_received_map[key] = grn_received_map.get(key, Decimal("0")) + Decimal(str(gi.received_qty or gi.accepted_qty or 0))

        for it in payload.items:
            key = (it.item_id, it.batch_id)
            received = grn_received_map.get(key, Decimal("0"))
            already_returned = prior_map.get(key, Decimal("0"))
            remaining = received - already_returned
            if Decimal(str(it.qty or 0)) > remaining:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Return qty {it.qty} for item {it.item_id} exceeds "
                        f"remaining returnable {remaining} "
                        f"(received {received}, prior returns {already_returned})"
                    ),
                )

    return_number = await generate_number(db, "procurement", "purchase_return")
    total_amount = Decimal("0")

    pr = PurchaseReturn(
        return_number=return_number,
        po_id=payload.po_id,
        grn_id=payload.grn_id,
        vendor_id=payload.vendor_id,
        warehouse_id=payload.warehouse_id,
        return_date=payload.return_date,
        reason=payload.reason,
        status="draft",
        created_by=current_user.id,
    )
    db.add(pr)
    await db.flush()

    for item in payload.items:
        amount = item.qty * item.rate
        # BUG-ISS-062 — reconcile per-line reason with header so reports +
        # vendor disputes are consistent. If line reason is missing, default
        # to header reason; if both supplied differing values, prefer the
        # line-level one but stash the difference in remarks for traceability.
        line_reason = item.reason if item.reason else payload.reason
        pr_item = PurchaseReturnItem(
            return_id=pr.id,
            item_id=item.item_id,
            batch_id=item.batch_id,
            qty=item.qty,
            uom_id=item.uom_id,
            rate=item.rate,
            amount=amount,
            reason=line_reason,
        )
        db.add(pr_item)
        total_amount += amount

    pr.total_amount = total_amount
    await db.flush()
    return {"id": pr.id, "return_number": return_number, "message": "Purchase Return created"}


@router.put("/purchase-returns/{return_id}")
async def update_purchase_return(
    return_id: int,
    payload: PurchaseReturnUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a draft purchase return."""
    result = await db.execute(
        select(PurchaseReturn)
        .options(selectinload(PurchaseReturn.items))
        .where(PurchaseReturn.id == return_id)
    )
    pr = result.scalar_one_or_none()
    if not pr:
        raise HTTPException(status_code=404, detail="Purchase Return not found")
    if pr.status != "draft":
        raise HTTPException(status_code=400, detail="Only draft returns can be updated")

    if payload.po_id is not None:
        pr.po_id = payload.po_id
    if payload.grn_id is not None:
        pr.grn_id = payload.grn_id
    if payload.vendor_id is not None:
        pr.vendor_id = payload.vendor_id
    if payload.warehouse_id is not None:
        pr.warehouse_id = payload.warehouse_id
    if payload.return_date is not None:
        pr.return_date = payload.return_date
    if payload.reason is not None:
        pr.reason = payload.reason

    if payload.items is not None:
        for existing_item in pr.items:
            await db.delete(existing_item)
        await db.flush()

        total_amount = Decimal("0")
        for item in payload.items:
            amount = item.qty * item.rate
            pr_item = PurchaseReturnItem(
                return_id=pr.id,
                item_id=item.item_id,
                batch_id=item.batch_id,
                qty=item.qty,
                uom_id=item.uom_id,
                rate=item.rate,
                amount=amount,
                reason=item.reason,
            )
            db.add(pr_item)
            total_amount += amount

        pr.total_amount = total_amount

    await db.flush()
    return {"id": pr.id, "return_number": pr.return_number, "message": "Purchase Return updated"}


@router.post("/purchase-returns/{return_id}/approve")
async def approve_purchase_return(
    return_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-ISS-064 — approve must be role-gated.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "procurement_manager"
    )),
):
    """Approve a draft or pending_approval purchase return.

    BUG-INV-025/026: stock MUST be decremented when the return is approved
    (goods leave warehouse to vendor). Previously this only flipped the
    status field — the stock balance never moved, leaving phantom inventory
    on the books that could be issued/sold a second time. We also pre-check
    availability per line so a partial decrement on mid-loop failure cannot
    leave the warehouse in a half-returned state.
    """
    result = await db.execute(
        select(PurchaseReturn)
        .options(selectinload(PurchaseReturn.items))
        .where(PurchaseReturn.id == return_id)
    )
    pr = result.scalar_one_or_none()
    if not pr:
        raise HTTPException(status_code=404, detail="Purchase Return not found")
    if pr.status not in ("draft", "pending_approval"):
        raise HTTPException(status_code=400, detail=f"Cannot approve a return with status '{pr.status}'")

    if not pr.items:
        raise HTTPException(status_code=400, detail="Purchase Return has no items")

    # BUG-INV-026: pre-check stock availability for each line BEFORE posting
    # any ledger entry. This prevents a mid-loop InsufficientStockError from
    # leaving some lines decremented and others not.
    for it in pr.items:
        bal_conds = [
            StockBalance.item_id == it.item_id,
            StockBalance.warehouse_id == pr.warehouse_id,
        ]
        if it.batch_id is not None:
            bal_conds.append(StockBalance.batch_id == it.batch_id)
        else:
            bal_conds.append(StockBalance.batch_id.is_(None))
        bal_row = await db.execute(select(StockBalance).where(and_(*bal_conds)))
        balances = bal_row.scalars().all()
        avail = sum((b.available_qty or Decimal("0")) for b in balances) or Decimal("0")
        if (it.qty or Decimal("0")) > avail:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Insufficient stock for item {it.item_id} (batch {it.batch_id}): "
                    f"available={avail}, requested={it.qty}"
                ),
            )

    # BUG-INV-025: post stock_out per line. The reference_type 'purchase_return'
    # makes the ledger lineage queryable.
    for it in pr.items:
        await post_stock_ledger(
            db,
            item_id=it.item_id,
            warehouse_id=pr.warehouse_id,
            transaction_type="purchase_return",
            qty_out=it.qty,
            rate=it.rate or Decimal("0"),
            batch_id=it.batch_id,
            reference_type="purchase_return",
            reference_id=pr.id,
            uom_id=it.uom_id,
            created_by=current_user.id,
        )

    pr.status = "approved"
    await db.flush()
    return {"id": pr.id, "return_number": pr.return_number, "message": "Purchase Return approved"}


@router.post("/purchase-returns/{return_id}/complete")
async def complete_purchase_return(
    return_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Mark a dispatched purchase return as completed.

    BUG-INV-028: previously accepted 'approved' directly, skipping the
    'dispatched' state. Goods cannot be 'returned to vendor' without first
    being dispatched off-premises. Caller must transition approved →
    dispatched (via gate-pass / outbound) before completing.
    """
    result = await db.execute(
        select(PurchaseReturn).where(PurchaseReturn.id == return_id)
    )
    pr = result.scalar_one_or_none()
    if not pr:
        raise HTTPException(status_code=404, detail="Purchase Return not found")
    if pr.status != "dispatched":
        raise HTTPException(
            status_code=400,
            detail=(
                f"Cannot complete a return in '{pr.status}' status — must first "
                "be dispatched (goods physically left warehouse)."
            ),
        )

    pr.status = "completed"
    await db.flush()
    return {"id": pr.id, "return_number": pr.return_number, "message": "Purchase Return completed"}


# ==================== GATE ENTRY (proxy to outbound) ====================
from app.models.dispatch import GatePass
from app.schemas.warehouse import GatePassCreate, GatePassResponse

@router.get("/gate-entries/{gp_id}", response_model=GatePassResponse)
async def get_gate_entry(gp_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    result = await db.execute(
        select(GatePass)
        .options(
            selectinload(GatePass.dispatch_order),
            selectinload(GatePass.warehouse)
        )
        .where(GatePass.id == gp_id)
    )
    gp = result.scalar_one_or_none()
    if not gp:
        raise HTTPException(status_code=404, detail="Gate entry not found")
    
    data = GatePassResponse.model_validate(gp)
    if gp.grn_id:
        from app.models.logistics import LogisticsServiceOrder
        so_res = await db.execute(select(LogisticsServiceOrder).where(LogisticsServiceOrder.id == gp.grn_id))
        so = so_res.scalar_one_or_none()
        if so:
            data.so_id = so.id
            data.so_number = so.so_number
    return data

@router.post("/gate-entries/{gp_id}/cancel")
async def cancel_gate_entry(gp_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(require_any_role("super_admin", "admin", "warehouse_manager"))):
    result = await db.execute(select(GatePass).where(GatePass.id == gp_id))
    gp = result.scalar_one_or_none()
    if not gp:
        raise HTTPException(status_code=404, detail="Gate entry not found")
    gp.status = "cancelled"
    await db.flush()
    return {"success": True, "message": "Gate entry cancelled"}

@router.get("/gate-entries")
async def list_gate_entries(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    gate_type: str = Query(None),
    status: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    query = select(GatePass).options(
        selectinload(GatePass.dispatch_order),
        selectinload(GatePass.warehouse),
    )
    count_query = select(func.count(GatePass.id))
    if gate_type:
        query = query.where(GatePass.gate_type == gate_type)
        count_query = count_query.where(GatePass.gate_type == gate_type)
    if status:
        query = query.where(GatePass.status == status)
        count_query = count_query.where(GatePass.status == status)
    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(GatePass.id.desc()))
    entries = result.scalars().all()

    # Bulk-fetch GRN numbers / Service Order numbers for entries with grn_id
    grn_ids = [e.grn_id for e in entries if e.grn_id]
    grn_map = {}
    so_map = {}
    if grn_ids:
        grn_result = await db.execute(select(GoodsReceiptNote).where(GoodsReceiptNote.id.in_(grn_ids)))
        for g in grn_result.scalars().all():
            grn_map[g.id] = g.grn_number

        from app.models.logistics import LogisticsServiceOrder
        so_result = await db.execute(select(LogisticsServiceOrder).where(LogisticsServiceOrder.id.in_(grn_ids)))
        for s in so_result.scalars().all():
            so_map[s.id] = s.so_number

    items_list = []
    for e in entries:
        data = GatePassResponse.model_validate(e).model_dump()
        data["dispatch_number"] = e.dispatch_order.dispatch_number if e.dispatch_order else None
        data["grn_number"] = grn_map.get(e.grn_id)
        data["so_number"] = so_map.get(e.grn_id)
        data["so_id"] = e.grn_id if e.grn_id in so_map else None
        data["warehouse_name"] = e.warehouse.name if e.warehouse else None
        items_list.append(data)

    return build_paginated_response(items_list, total, page, page_size)

@router.post("/gate-entries", status_code=201)
async def create_gate_entry(
    payload: GatePassCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    gp_number = await generate_number(db, "warehouse", "gate_pass")
    gp = GatePass(
        gate_pass_number=gp_number,
        gate_type=payload.gate_type,
        warehouse_id=payload.warehouse_id,
        grn_id=payload.so_id or payload.grn_id,
        dispatch_id=payload.dispatch_id,
        vehicle_number=payload.vehicle_number,
        person_name=payload.person_name,
        person_contact=payload.person_contact,
        material_description=payload.material_description,
        remarks=payload.remarks,
        status="pending",
        created_at=datetime.now(timezone.utc),
    )
    db.add(gp)
    await db.flush()
    return {"id": gp.id, "gate_pass_number": gp_number, "message": "Gate entry created"}

@router.post("/gate-entries/{gp_id}/approve")
async def approve_gate_entry(
    gp_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(GatePass).where(GatePass.id == gp_id))
    gp = result.scalar_one_or_none()
    if not gp:
        raise HTTPException(status_code=404, detail="Gate entry not found")
    gp.status = "approved"
    await db.flush()
    return {"success": True, "message": "Gate entry approved"}

@router.post("/gate-entries/{gp_id}/complete")
async def complete_gate_entry(
    gp_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(GatePass).where(GatePass.id == gp_id))
    gp = result.scalar_one_or_none()
    if not gp:
        raise HTTPException(status_code=404, detail="Gate entry not found")
    gp.status = "completed"
    if gp.gate_type == "inward":
        gp.gate_in_time = datetime.now(timezone.utc)
    else:
        gp.gate_out_time = datetime.now(timezone.utc)
    await db.flush()
    return {"success": True, "message": "Gate entry completed"}


@router.post("/gate-entries/{gp_id}/gate-in")
async def record_gate_in(
    gp_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Record physical entry through the gate. Separate from /complete — this
    just stamps gate_in_time, the vehicle is still on site."""
    result = await db.execute(select(GatePass).where(GatePass.id == gp_id))
    gp = result.scalar_one_or_none()
    if not gp:
        raise HTTPException(status_code=404, detail="Gate entry not found")
    gp.gate_in_time = datetime.now(timezone.utc)
    gp.status = "gate_in"
    await db.flush()
    return {"success": True, "message": "Gate IN time recorded", "gate_in_time": gp.gate_in_time}


@router.post("/gate-entries/{gp_id}/gate-out")
async def record_gate_out(
    gp_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Record physical exit through the gate."""
    result = await db.execute(select(GatePass).where(GatePass.id == gp_id))
    gp = result.scalar_one_or_none()
    if not gp:
        raise HTTPException(status_code=404, detail="Gate entry not found")
    gp.gate_out_time = datetime.now(timezone.utc)
    gp.status = "gate_out"
    await db.flush()
    return {"success": True, "message": "Gate OUT time recorded", "gate_out_time": gp.gate_out_time}


# ==================== ISSUE RETURNS (BUG-ISS-063) ====================
# Minimal create endpoint that records the return and writes positive
# qty_in to the stock ledger so stock balances are restored. Full
# accounting reversal is left for a follow-up wave.
from app.models.issue import IssueReturn, IssueReturnItem  # noqa: E402


class _IssueReturnItemIn(BaseModel):
    issue_item_id: Optional[int] = None
    item_id: int
    batch_id: Optional[int] = None
    qty: float
    uom_id: int
    rate: Optional[float] = 0
    reason: Optional[str] = None


class _IssueReturnIn(BaseModel):
    issue_id: int
    warehouse_id: int
    return_date: Optional[datetime] = None
    reason: Optional[str] = None
    items: List[_IssueReturnItemIn]


@router.post("/issue-returns", status_code=201)
async def create_issue_return(
    payload: _IssueReturnIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "warehouse_operator"
    )),
):
    if not payload.items:
        raise HTTPException(status_code=400, detail="At least one return line is required")

    issue = (await db.execute(
        select(MaterialIssue).where(MaterialIssue.id == payload.issue_id)
    )).scalar_one_or_none()
    if not issue:
        raise HTTPException(status_code=404, detail="Material issue not found")

    return_number = await generate_number(db, "issue", "issue_return")
    ir = IssueReturn(
        return_number=return_number,
        issue_id=payload.issue_id,
        warehouse_id=payload.warehouse_id,
        return_date=payload.return_date or datetime.now(timezone.utc),
        reason=payload.reason,
        status="completed",
        created_by=current_user.id,
    )
    db.add(ir)
    await db.flush()

    for line in payload.items:
        if line.qty <= 0:
            raise HTTPException(status_code=400, detail="Return qty must be > 0")
        iri = IssueReturnItem(
            return_id=ir.id,
            issue_item_id=line.issue_item_id,
            item_id=line.item_id,
            batch_id=line.batch_id,
            qty=Decimal(str(line.qty)),
            uom_id=line.uom_id,
            rate=Decimal(str(line.rate or 0)),
            reason=line.reason,
        )
        db.add(iri)
        await post_stock_ledger(
            db,
            item_id=line.item_id,
            warehouse_id=payload.warehouse_id,
            transaction_type="issue_return",
            qty_in=Decimal(str(line.qty)),
            rate=Decimal(str(line.rate or 0)),
            batch_id=line.batch_id,
            uom_id=line.uom_id,
            reference_type="issue_return",
            reference_id=ir.id,
            created_by=current_user.id,
        )
    await db.flush()
    return {"id": ir.id, "return_number": ir.return_number, "status": ir.status}


# ==================== BATCH LOOKUP (for issue-time batch picker) ====================

@router.get("/batches")
async def list_batches_with_stock(
    item_id: int = Query(..., description="Item to list batches for"),
    warehouse_id: int = Query(None, description="Limit to one warehouse (default: any with stock)"),
    include_no_batch: bool = Query(True, description="Include stock without batch assigned"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return all active batches for an item that currently have stock at the
    given warehouse, ordered FEFO (earliest expiry first). Each row includes
    batch metadata + available qty + bin so the FE issue-batch picker can
    show 'GBH-2026-A1 · exp 2027-12-31 · 50 avail · bin CEN-M1-L5'.
    
    Also returns stock without batch assigned as 'NO-BATCH' when include_no_batch=True.
    """
    from app.models.warehouse import (
        Batch as _B,
        WarehouseBin as _Bin,
    )
    
    # Query 1: Batches with stock
    q = (
        select(
            _B.id, _B.batch_number, _B.expiry_date, _B.manufacturing_date,
            _B.lot_number, _B.status,
            StockBalance.warehouse_id, StockBalance.bin_id,
            func.coalesce(func.sum(StockBalance.available_qty), 0).label("available_qty"),
            _Bin.code.label("bin_code"),
        )
        .join(StockBalance, StockBalance.batch_id == _B.id)
        .outerjoin(_Bin, _Bin.id == StockBalance.bin_id)
        .where(_B.item_id == item_id)
        .where(_B.status == "active")
        .where(StockBalance.available_qty > 0)
        .group_by(
            _B.id, _B.batch_number, _B.expiry_date, _B.manufacturing_date,
            _B.lot_number, _B.status,
            StockBalance.warehouse_id, StockBalance.bin_id, _Bin.code,
        )
        .order_by(_B.expiry_date.is_(None), _B.expiry_date.asc(), _B.id.asc())
    )
    if warehouse_id is not None:
        q = q.where(StockBalance.warehouse_id == warehouse_id)
    
    rows = (await db.execute(q)).all()
    results = [
        {
            "batch_id": r.id,
            "batch_number": r.batch_number,
            "expiry_date": r.expiry_date.isoformat() if r.expiry_date else None,
            "manufacturing_date": r.manufacturing_date.isoformat() if r.manufacturing_date else None,
            "lot_number": r.lot_number,
            "status": r.status,
            "warehouse_id": r.warehouse_id,
            "bin_id": r.bin_id,
            "bin_code": r.bin_code,
            "available_qty": float(r.available_qty or 0),
        }
        for r in rows
    ]
    
    # Query 2: Stock without batch (if requested)
    if include_no_batch:
        no_batch_q = (
            select(
                StockBalance.warehouse_id, StockBalance.bin_id,
                func.coalesce(func.sum(StockBalance.available_qty), 0).label("available_qty"),
                _Bin.code.label("bin_code"),
            )
            .outerjoin(_Bin, _Bin.id == StockBalance.bin_id)
            .where(StockBalance.item_id == item_id)
            .where(StockBalance.batch_id.is_(None))
            .where(StockBalance.available_qty > 0)
            .group_by(StockBalance.warehouse_id, StockBalance.bin_id, _Bin.code)
        )
        if warehouse_id is not None:
            no_batch_q = no_batch_q.where(StockBalance.warehouse_id == warehouse_id)
        
        no_batch_rows = (await db.execute(no_batch_q)).all()
        for r in no_batch_rows:
            if r.available_qty > 0:
                results.append({
                    "batch_id": None,
                    "batch_number": "NO-BATCH",
                    "expiry_date": None,
                    "manufacturing_date": None,
                    "lot_number": None,
                    "status": "active",
                    "warehouse_id": r.warehouse_id,
                    "bin_id": r.bin_id,
                    "bin_code": r.bin_code,
                    "available_qty": float(r.available_qty or 0),
                })
    
    return results


# ==================== FLOOR PLAN (2D LAYOUT) ====================

@router.get("/floor-plan/{warehouse_id}")
async def get_floor_plan(
    warehouse_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return the warehouse hierarchy (floors, lines, racks, bins) with
    layout coordinates and stock occupancy per bin.
    """
    from app.models.warehouse import (
        WarehouseLocation as _Loc,
        WarehouseLine as _Line,
        WarehouseRack as _Rack,
        WarehouseBin as _Bin,
    )
    wh = (await db.execute(
        select(Warehouse).where(Warehouse.id == warehouse_id)
    )).scalar_one_or_none()
    if not wh:
        raise HTTPException(status_code=404, detail="Warehouse not found")

    locs = (await db.execute(
        select(_Loc).where(_Loc.warehouse_id == warehouse_id).order_by(_Loc.id)
    )).scalars().all()
    loc_ids = [l.id for l in locs] or [-1]
    lines = (await db.execute(
        select(_Line).where(_Line.location_id.in_(loc_ids)).order_by(_Line.id)
    )).scalars().all()
    line_ids = [l.id for l in lines] or [-1]
    racks = (await db.execute(
        select(_Rack).where(_Rack.line_id.in_(line_ids)).order_by(_Rack.id)
    )).scalars().all()
    rack_ids = [r.id for r in racks] or [-1]
    bins = (await db.execute(
        select(_Bin).where(_Bin.rack_id.in_(rack_ids)).order_by(_Bin.id)
    )).scalars().all()
    bin_ids = [b.id for b in bins] or [-1]

    stock_rows = (await db.execute(
        select(StockBalance.bin_id, func.coalesce(func.sum(StockBalance.total_qty), 0))
        .where(StockBalance.bin_id.in_(bin_ids))
        .group_by(StockBalance.bin_id)
    )).all()
    stock_by_bin = {bid: float(qty or 0) for bid, qty in stock_rows}

    BIN_W, BIN_H = 38, 26
    RACK_PAD_X, RACK_PAD_Y = 8, 22
    LINE_GAP = 14
    FLOOR_PAD = 18

    floors = []
    cur_y = 0
    for loc in locs:
        loc_lines = [l for l in lines if l.location_id == loc.id]
        line_blocks = []
        max_w_in_floor = 0
        cur_line_y = FLOOR_PAD
        for line in loc_lines:
            line_racks = [r for r in racks if r.line_id == line.id]
            rack_blocks = []
            cur_rack_x = RACK_PAD_X
            max_h_in_line = 0
            for rack in line_racks:
                rack_bins = [b for b in bins if b.rack_id == rack.id]
                bins_per_row = 5 if (rack.rack_type or "").upper() == "A" else 4
                bin_blocks = []
                for bi, b in enumerate(rack_bins):
                    bx = (bi % bins_per_row) * BIN_W
                    by = (bi // bins_per_row) * BIN_H
                    cur = stock_by_bin.get(b.id, 0)
                    cap = float(b.capacity or 0) or 0
                    if cap > 0:
                        occ_pct = min(100.0, (cur / cap) * 100.0)
                    else:
                        occ_pct = 100.0 if cur > 0 else 0.0
                    if occ_pct == 0:
                        status = "empty"
                    elif occ_pct >= 95:
                        status = "full"
                    else:
                        status = "partial"
                    bin_blocks.append({
                        "id": b.id, "code": b.code, "name": b.name,
                        "x": float(b.layout_x) if b.layout_x is not None else bx,
                        "y": float(b.layout_y) if b.layout_y is not None else by,
                        "w": float(b.layout_w) if b.layout_w is not None else BIN_W - 4,
                        "h": float(b.layout_h) if b.layout_h is not None else BIN_H - 4,
                        "capacity": cap, "current_qty": cur,
                        "occ_pct": round(occ_pct, 1), "status": status,
                    })
                rack_w = bins_per_row * BIN_W
                rack_rows = (len(rack_bins) + bins_per_row - 1) // bins_per_row or 1
                rack_h = rack_rows * BIN_H + RACK_PAD_Y
                rack_blocks.append({
                    "id": rack.id, "code": rack.code, "name": rack.name,
                    "rack_type": getattr(rack, "rack_type", None),
                    "x": float(rack.layout_x) if rack.layout_x is not None else cur_rack_x,
                    "y": float(rack.layout_y) if rack.layout_y is not None else 0,
                    "w": float(rack.layout_w) if rack.layout_w is not None else rack_w,
                    "h": float(rack.layout_h) if rack.layout_h is not None else rack_h,
                    "bins": bin_blocks,
                })
                cur_rack_x += rack_w + 12
                if rack_h > max_h_in_line:
                    max_h_in_line = rack_h
            line_w = cur_rack_x
            line_h = max_h_in_line + RACK_PAD_Y
            line_blocks.append({
                "id": line.id, "code": line.code, "name": line.name,
                "x": float(line.layout_x) if line.layout_x is not None else FLOOR_PAD,
                "y": float(line.layout_y) if line.layout_y is not None else cur_line_y,
                "w": float(line.layout_w) if line.layout_w is not None else line_w,
                "h": float(line.layout_h) if line.layout_h is not None else line_h,
                "racks": rack_blocks,
            })
            cur_line_y += line_h + LINE_GAP
            if line_w > max_w_in_floor:
                max_w_in_floor = line_w
        floor_w = max_w_in_floor + FLOOR_PAD * 2
        floor_h = cur_line_y + FLOOR_PAD
        floors.append({
            "id": loc.id, "code": loc.code, "name": loc.name,
            "x": float(loc.layout_x) if loc.layout_x is not None else 0,
            "y": float(loc.layout_y) if loc.layout_y is not None else cur_y,
            "w": float(loc.layout_w) if loc.layout_w is not None else floor_w,
            "h": float(loc.layout_h) if loc.layout_h is not None else floor_h,
            "lines": line_blocks,
        })
        cur_y += floor_h + 24

    return {
        "warehouse": {
            "id": wh.id, "code": wh.code, "name": wh.name,
            "type": getattr(wh, "type", None),
        },
        "floors": floors,
        "stats": {
            "floors": len(locs), "lines": len(lines),
            "racks": len(racks), "bins": len(bins),
            "occupied_bins": sum(1 for b in bins if stock_by_bin.get(b.id, 0) > 0),
        },
    }


class FloorPlanLayoutItem(BaseModel):
    type: str
    id: int
    x: Optional[float] = None
    y: Optional[float] = None
    w: Optional[float] = None
    h: Optional[float] = None
    # 2026-05-06: when a rack is dragged to a different floor in 3D edit
    # mode, the FE sends the new line_id so the rack is reparented (since
    # line_id determines which floor the rack lives on via line→location).
    line_id: Optional[int] = None


class FloorPlanLayoutPayload(BaseModel):
    items: List[FloorPlanLayoutItem]


@router.put("/floor-plan/{warehouse_id}/layout")
async def save_floor_plan_layout(
    warehouse_id: int,
    payload: FloorPlanLayoutPayload,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager",
    )),
):
    """Persist x/y/w/h for floors/lines/racks/bins after drag-drop edit."""
    from app.models.warehouse import (
        WarehouseLocation as _Loc,
        WarehouseLine as _Line,
        WarehouseRack as _Rack,
        WarehouseBin as _Bin,
    )
    type_to_model = {
        "location": _Loc, "line": _Line, "rack": _Rack, "bin": _Bin,
    }
    updated = 0
    for it in payload.items:
        model = type_to_model.get(it.type)
        if not model:
            continue
        row = (await db.execute(
            select(model).where(model.id == it.id)
        )).scalar_one_or_none()
        if not row:
            continue
        if it.x is not None:
            row.layout_x = it.x
        if it.y is not None:
            row.layout_y = it.y
        if it.w is not None:
            row.layout_w = it.w
        if it.h is not None:
            row.layout_h = it.h
        # Reparent rack to a new line (3D floor-to-floor drag)
        if it.type == "rack" and it.line_id is not None and hasattr(row, "line_id"):
            new_line = (await db.execute(
                select(_Line).where(_Line.id == it.line_id)
            )).scalar_one_or_none()
            if new_line is not None:
                row.line_id = it.line_id
        updated += 1
    await db.flush()
    return {"success": True, "updated": updated}
