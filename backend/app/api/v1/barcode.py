from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.models.user import User
from app.models.master import Item
from app.models.warehouse import Batch
from app.models.barcode import BarcodeRegistry, ScanLog
from app.services.barcode_service import (
    generate_barcode_value, auto_detect_barcode_type,
    generate_barcode_image, get_label_data, generate_qr_code,
    generate_code128_barcode,
)
from app.utils.dependencies import get_current_user
import io
import json

router = APIRouter()


class BarcodeGenerateRequest(BaseModel):
    entity_type: str
    entity_id: int
    barcode_type: Optional[str] = None  # If None, auto-detect
    item_id: Optional[int] = None
    batch_id: Optional[int] = None


class ScanLogCreate(BaseModel):
    barcode_value: str
    scan_type: str
    warehouse_id: Optional[int] = None
    bin_id: Optional[int] = None
    reference_type: Optional[str] = None
    reference_id: Optional[int] = None
    device_info: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    notes: Optional[str] = None


@router.post("/generate", status_code=201)
async def generate_barcode(
    payload: BarcodeGenerateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Generate barcode/QR code with auto-detection based on item type.

    Auto-detection logic:
    - Medicines/items with batch+expiry -> QR code (encodes item, batch, expiry, serial)
    - General items -> Code128 barcode
    """
    # BUG-INV-097: validate that the referenced entity actually exists before
    # creating a registry row. Generating a barcode for a non-existent entity
    # leaves dangling registry rows that lookup endpoints will resolve but
    # produce confusing 404s when the operator tries to use them.
    ENTITY_TABLE_MAP = {
        "item": (Item, Item.id),
        "batch": (Batch, Batch.id),
    }
    if payload.entity_type in ENTITY_TABLE_MAP:
        cls_, id_col = ENTITY_TABLE_MAP[payload.entity_type]
        exists_row = await db.execute(
            select(cls_.id).where(id_col == payload.entity_id).limit(1)
        )
        if exists_row.scalar_one_or_none() is None:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"{payload.entity_type} with id={payload.entity_id} does not exist; "
                    "cannot generate barcode."
                ),
            )

    barcode_val = generate_barcode_value(payload.entity_type, payload.entity_id)
    barcode_type = payload.barcode_type
    barcode_data = {}

    # Auto-detect barcode type if not specified
    if payload.item_id:
        item_result = await db.execute(select(Item).where(Item.id == payload.item_id))
        item = item_result.scalar_one_or_none()
        if item:
            if not barcode_type or barcode_type == "auto":
                barcode_type = auto_detect_barcode_type(
                    item.item_type, item.has_batch, item.has_expiry, item.has_serial
                )
            barcode_data["item_code"] = item.item_code
            barcode_data["item_name"] = item.name
            barcode_data["item_type"] = item.item_type

    if payload.batch_id:
        batch_result = await db.execute(select(Batch).where(Batch.id == payload.batch_id))
        batch = batch_result.scalar_one_or_none()
        if batch:
            barcode_data["batch_number"] = batch.batch_number
            barcode_data["expiry_date"] = batch.expiry_date.isoformat() if batch.expiry_date else None
            barcode_data["manufacturing_date"] = batch.manufacturing_date.isoformat() if batch.manufacturing_date else None

    if not barcode_type:
        barcode_type = "code128"

    # BUG-INV-098: enforce uniqueness on (entity_type, entity_id) — generating a
    # second barcode for the same entity is almost always a UI mis-click, and
    # creates conflicting barcodes for the same item/batch. Return the existing
    # barcode instead of creating a duplicate.
    existing_q = await db.execute(
        select(BarcodeRegistry).where(
            BarcodeRegistry.entity_type == payload.entity_type,
            BarcodeRegistry.entity_id == payload.entity_id,
            BarcodeRegistry.is_active == True,  # noqa: E712
        )
    )
    existing_reg = existing_q.scalar_one_or_none()
    if existing_reg is not None:
        return {
            "id": existing_reg.id,
            "barcode_value": existing_reg.barcode_value,
            "barcode_type": existing_reg.barcode_type,
            "barcode_data": json.loads(existing_reg.barcode_data) if existing_reg.barcode_data else {},
            "message": "Barcode already exists for this entity",
            "reused": True,
        }

    # Save to registry
    registry = BarcodeRegistry(
        entity_type=payload.entity_type,
        entity_id=payload.entity_id,
        barcode_type=barcode_type,
        barcode_value=barcode_val,
        barcode_data=json.dumps(barcode_data) if barcode_data else None,
    )
    db.add(registry)
    await db.flush()

    return {
        "id": registry.id,
        "barcode_value": barcode_val,
        "barcode_type": barcode_type,
        "barcode_data": barcode_data,
        "message": "Barcode generated",
    }


@router.get("/image/{barcode_value}")
async def get_barcode_image(
    barcode_value: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get barcode/QR image as PNG."""
    result = await db.execute(
        select(BarcodeRegistry).where(BarcodeRegistry.barcode_value == barcode_value)
    )
    registry = result.scalar_one_or_none()
    if not registry:
        raise HTTPException(status_code=404, detail="Barcode not found")

    data = json.loads(registry.barcode_data) if registry.barcode_data else {}

    image_bytes = generate_barcode_image(
        barcode_type=registry.barcode_type,
        barcode_value=barcode_value,
        item_code=data.get("item_code"),
        item_name=data.get("item_name"),
        batch_number=data.get("batch_number"),
        expiry_date=data.get("expiry_date"),
    )

    return StreamingResponse(io.BytesIO(image_bytes), media_type="image/png")


@router.get("/label/{barcode_value}")
async def get_label_print_data(
    barcode_value: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get label print data including barcode image as base64."""
    result = await db.execute(
        select(BarcodeRegistry).where(BarcodeRegistry.barcode_value == barcode_value)
    )
    registry = result.scalar_one_or_none()
    if not registry:
        raise HTTPException(status_code=404, detail="Barcode not found")

    data = json.loads(registry.barcode_data) if registry.barcode_data else {}

    label = get_label_data(
        barcode_value=barcode_value,
        barcode_type=registry.barcode_type,
        item_code=data.get("item_code"),
        item_name=data.get("item_name"),
        batch_number=data.get("batch_number"),
        expiry_date=data.get("expiry_date"),
    )

    # Update print count
    registry.label_printed = True
    registry.print_count = (registry.print_count or 0) + 1
    await db.flush()

    return label


@router.post("/registry/{registry_id}/reset-print-flag")
async def reset_label_printed_flag(
    registry_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """BUG-INV-101: explicitly reset the `label_printed` boolean.

    The flag is set to True on first print and never reset by any other path,
    so once a label is reprinted the FE has no way to flip the indicator back
    (e.g., after voiding the printed label or rotating to a new printer batch).
    This endpoint resets the flag without touching `print_count`, which still
    accumulates the lifetime print count for audit.
    """
    reg = (await db.execute(
        select(BarcodeRegistry).where(BarcodeRegistry.id == registry_id)
    )).scalar_one_or_none()
    if reg is None:
        raise HTTPException(status_code=404, detail="Barcode registry entry not found")
    reg.label_printed = False
    await db.flush()
    return {
        "id": reg.id,
        "label_printed": reg.label_printed,
        "print_count": reg.print_count,
        "message": "label_printed flag reset",
    }


@router.get("/lookup/{barcode_value}")
async def lookup_barcode(
    barcode_value: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Look up entity info by barcode value."""
    result = await db.execute(
        select(BarcodeRegistry).where(BarcodeRegistry.barcode_value == barcode_value)
    )
    registry = result.scalar_one_or_none()
    if not registry:
        raise HTTPException(status_code=404, detail="Barcode not found")

    data = json.loads(registry.barcode_data) if registry.barcode_data else {}

    return {
        "barcode_value": registry.barcode_value,
        "barcode_type": registry.barcode_type,
        "entity_type": registry.entity_type,
        "entity_id": registry.entity_id,
        "barcode_data": data,
        "is_active": registry.is_active,
    }


# ==================== REGISTRY ALIAS (frontend compatibility) ====================

@router.get("/registry")
async def list_barcode_registry(
    entity_type: str = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: GET /barcode/registry -> list all registered barcodes."""
    from sqlalchemy import func
    from app.utils.helpers import paginate_params, build_paginated_response
    offset, limit = paginate_params(page, page_size)
    query = select(BarcodeRegistry).order_by(BarcodeRegistry.id.desc())
    count_query = select(func.count(BarcodeRegistry.id))
    if entity_type:
        query = query.where(BarcodeRegistry.entity_type == entity_type)
        count_query = count_query.where(BarcodeRegistry.entity_type == entity_type)

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit))
    registries = result.scalars().all()

    items = [{
        "id": r.id, "entity_type": r.entity_type, "entity_id": r.entity_id,
        "barcode_type": r.barcode_type, "barcode_value": r.barcode_value,
        "barcode_data": json.loads(r.barcode_data) if r.barcode_data else None,
        "is_active": r.is_active, "label_printed": r.label_printed,
        "print_count": r.print_count,
    } for r in registries]

    return build_paginated_response(items, total, page, page_size)


# ==================== SCAN LOG ====================

@router.post("/scan", status_code=201)
async def record_scan(
    payload: ScanLogCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Record a barcode scan event.

    BUG-INV-096: when the scanned barcode_value isn't in BarcodeRegistry the
    scan is still logged (operators frequently scan vendor barcodes that we
    haven't generated ourselves), but the response now flags the unknown
    state and the scan row is annotated in `notes` so a downstream report can
    surface unmatched scans for cleanup. Previously the endpoint silently
    accepted any string and the caller had no way to tell that the scan
    didn't resolve to anything.
    """
    # Best-effort lookup — if the barcode is unknown we still log it (could be
    # an external vendor barcode), but mark the response so the caller's UI
    # can prompt the operator instead of silently moving on.
    matched = False
    matched_entity_type = None
    matched_entity_id = None
    try:
        reg_row = await db.execute(
            select(BarcodeRegistry).where(BarcodeRegistry.barcode_value == payload.barcode_value)
        )
        reg = reg_row.scalar_one_or_none()
        if reg is not None:
            matched = True
            matched_entity_type = reg.entity_type
            matched_entity_id = reg.entity_id
    except Exception:
        # Lookup failure should not block the audit-trail write.
        matched = False

    notes = payload.notes
    if not matched:
        prefix = "[UNKNOWN_BARCODE] "
        notes = (prefix + (notes or "")).strip()

    scan = ScanLog(
        barcode_value=payload.barcode_value,
        scan_type=payload.scan_type,
        warehouse_id=payload.warehouse_id,
        bin_id=payload.bin_id,
        reference_type=payload.reference_type,
        reference_id=payload.reference_id,
        scanned_by=current_user.id,
        scan_timestamp=datetime.now(timezone.utc),
        device_info=payload.device_info,
        latitude=payload.latitude,
        longitude=payload.longitude,
        notes=notes,
    )
    db.add(scan)
    await db.flush()
    return {
        "id": scan.id,
        "message": "Scan recorded" if matched else "Scan recorded (barcode not in registry)",
        "matched": matched,
        "entity_type": matched_entity_type,
        "entity_id": matched_entity_id,
    }


@router.get("/scan-history")
async def get_scan_history(
    barcode_value: str = Query(None),
    scan_type: str = Query(None),
    warehouse_id: int = Query(None),
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get scan log history."""
    query = select(ScanLog).order_by(ScanLog.scan_timestamp.desc())
    if barcode_value:
        query = query.where(ScanLog.barcode_value == barcode_value)
    if scan_type:
        query = query.where(ScanLog.scan_type == scan_type)
    if warehouse_id:
        query = query.where(ScanLog.warehouse_id == warehouse_id)

    result = await db.execute(query.limit(limit))
    scans = result.scalars().all()

    return [{
        "id": s.id, "barcode_value": s.barcode_value, "scan_type": s.scan_type,
        "warehouse_id": s.warehouse_id, "bin_id": s.bin_id,
        "reference_type": s.reference_type, "reference_id": s.reference_id,
        "scanned_by": s.scanned_by, "scan_timestamp": s.scan_timestamp,
        "device_info": s.device_info, "notes": s.notes,
    } for s in scans]
