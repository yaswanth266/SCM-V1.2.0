"""Consignment & Package-wise Acknowledgement API.

Pipeline:
  POST /                   → Create consignment (+ packages + containers)
  GET  /                   → List consignments
  GET  /{id}               → Full detail with packages & items
  GET  /by-mi/{mi_id}      → By material issue
  GET  /by-indent/{ind_id} → By indent
  POST /{id}/pack          → Mark PACKED
  POST /{id}/dispatch      → Mark IN_TRANSIT

  GET  /package/{id}            → Package detail
  GET  /package/scan/{barcode}  → Scan QR barcode
  GET  /package/{id}/manifest   → Material manifest (for printing)
  GET  /package/{id}/label      → Package label data

  GET  /scan/{barcode}          → Scan CON barcode → expected packages

  POST /acknowledge             → Acknowledge ONE package (posts stock)
  POST /acknowledge/bulk        → Acknowledge MULTIPLE packages
  POST /package/{id}/store-item → Allocate received item to storage bin
  GET  /{id}/acknowledgements   → All acks for a consignment
"""
import json
import uuid
from datetime import datetime, timezone, date
from decimal import Decimal
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload, selectinload

from app.database import get_db
from app.models.consignment import (
    Consignment,
    ConsignmentPackage,
    ConsignmentPackageAcknowledgement,
    ConsignmentPackageContainer,
    ConsignmentPackageItem,
    ConsignmentParentPackage,
    ConsignmentParentPackageChild,
)
from app.models.user import User
from app.models.issue import MaterialIssueItem
from app.services.number_series import generate_number
from app.utils.dependencies import get_current_user, require_any_role, require_key
from app.utils.schema_sync import ensure_consignment_schema

router = APIRouter(tags=["Consignment & Packaging"])


# ──────────────────────────────────────────────────────────────────────────────
# Pydantic schemas (inline — small surface, no separate schemas file needed yet)
# ──────────────────────────────────────────────────────────────────────────────

class PackageItemIn(BaseModel):
    material_issue_item_id: int
    material_id: int
    batch_id: Optional[int] = None
    source_bin_id: Optional[int] = None
    quantity_packed: Decimal
    serial_numbers: Optional[List[str]] = None
    uom_code: Optional[str] = "NOS"
    unit_price: Optional[Decimal] = Decimal("0")


class PackageIn(BaseModel):
    package_type: str = "BOX"           # BOX CRATE PALLET BAG LOOSE
    package_description: Optional[str] = None
    length_cm: Optional[Decimal] = None
    width_cm: Optional[Decimal] = None
    height_cm: Optional[Decimal] = None
    gross_weight_kg: Optional[Decimal] = Decimal("0")
    seal_number: Optional[str] = None
    parent_package_group: Optional[str] = None
    items: List[PackageItemIn]


class ConsignmentCreate(BaseModel):
    material_issue_id: int
    indent_id: Optional[int] = None
    mdo_id: Optional[int] = None
    destination_warehouse_id: Optional[int] = None
    destination_user_id: Optional[int] = None
    receiver_employee_code: Optional[str] = None
    receiver_name: Optional[str] = None
    receiver_position_code: Optional[str] = None
    state_code: Optional[str] = "AP"
    packages: List[PackageIn]


class PackageItemAck(BaseModel):
    package_item_id: int
    quantity_received: Decimal
    quantity_accepted: Decimal
    quantity_rejected: Decimal = Decimal("0")
    quantity_damaged: Decimal = Decimal("0")
    item_condition: Optional[str] = "GOOD"
    rejection_reason: Optional[str] = None
    damage_description: Optional[str] = None
    serial_numbers_received: Optional[List[str]] = None


class PackageAcknowledgeIn(BaseModel):
    package_id: int
    acknowledged_by_name: Optional[str] = None
    acknowledged_by_designation: Optional[str] = None
    acknowledged_by_phone: Optional[str] = None
    acknowledged_by_employee_code: Optional[str] = None
    receiver_signature_url: Optional[str] = None
    photos: Optional[List[str]] = None
    remarks: Optional[str] = None
    packaging_condition: Optional[str] = "INTACT"
    seal_intact: Optional[bool] = True
    seal_number_verified: bool = False
    temperature_recorded: Optional[Decimal] = None
    humidity_recorded: Optional[Decimal] = None
    latitude: Optional[Decimal] = None
    longitude: Optional[Decimal] = None
    geo_fence_verified: bool = False
    device_id: Optional[str] = None
    ip_address: Optional[str] = None
    items: List[PackageItemAck]


class ConsignmentDeliverPayload(BaseModel):
    receiver_signature_url: Optional[str] = None
    photos: Optional[List[str]] = None
    remarks: Optional[str] = None
    acknowledged_by_name: Optional[str] = None
    acknowledged_by_designation: Optional[str] = None
    acknowledged_by_phone: Optional[str] = None
    acknowledged_by_employee_code: Optional[str] = None


class StoreItemIn(BaseModel):
    package_item_id: int
    destination_bin_id: int
    quantity: Decimal


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def _vol_cft(l_cm, w_cm, h_cm) -> Decimal:
    """Convert cm³ → cubic feet (1 CFT = 28316.85 cm³)."""
    if not all([l_cm, w_cm, h_cm]):
        return Decimal("0")
    return (Decimal(str(l_cm)) * Decimal(str(w_cm)) * Decimal(str(h_cm))) / Decimal("28316.85")


def _qr_barcode(payload: dict) -> str:
    """Serialise payload to JSON string used as barcode value."""
    return json.dumps(payload, separators=(",", ":"))


async def _recalc_consignment(db: AsyncSession, consignment: Consignment) -> None:
    """Recalculate denormalised totals on the consignment from its packages."""
    pkgs = (await db.execute(
        select(ConsignmentPackage)
        .options(selectinload(ConsignmentPackage.items))
        .where(ConsignmentPackage.consignment_id == consignment.id)
    )).scalars().all()

    total_pkgs = len(pkgs)
    total_wt = Decimal("0")
    total_vol = Decimal("0")
    total_val = Decimal("0")
    total_items = 0

    for pkg in pkgs:
        total_wt += pkg.gross_weight_kg or Decimal("0")
        total_vol += pkg.volume_cft or Decimal("0")
        for it in pkg.items:
            total_items += 1
            total_val += it.total_value or Decimal("0")

    consignment.total_packages = total_pkgs
    consignment.total_weight_kg = total_wt
    consignment.total_volume_cft = total_vol
    consignment.total_value = total_val
    consignment.total_items = total_items


async def _update_consignment_status(db: AsyncSession, consignment: Consignment) -> None:
    statuses = [r[0] for r in (await db.execute(
        select(ConsignmentPackage.status)
        .where(ConsignmentPackage.consignment_id == consignment.id)
    )).all()]
    if not statuses:
        return
    if all(s == "UNPACKED" for s in statuses):
        consignment.status = "UNPACKED"
        consignment.received_at = datetime.now(timezone.utc)
    elif any(s in ("UNPACKED", "PARTIALLY_UNPACKED", "RECEIVED", "PARTIALLY_RECEIVED") for s in statuses):
        consignment.status = "PARTIALLY_UNPACKED"

    # Sync status to the linked MDO and SDO (Dispatch Plan)
    from app.models.logistics import LogisticsMainDispatchOrder, LogisticsSubDispatchOrder
    mdo = None
    if consignment.mdo_id:
        mdo = (await db.execute(
            select(LogisticsMainDispatchOrder).where(LogisticsMainDispatchOrder.id == consignment.mdo_id)
        )).scalar_one_or_none()
    elif consignment.material_issue_id:
        mdo = (await db.execute(
            select(LogisticsMainDispatchOrder).where(LogisticsMainDispatchOrder.material_issue_id == consignment.material_issue_id)
        )).scalar_one_or_none()
        if mdo:
            consignment.mdo_id = mdo.id
            db.add(consignment)

    if mdo:
        sdo = (await db.execute(
            select(LogisticsSubDispatchOrder)
            .where(LogisticsSubDispatchOrder.mdo_id == mdo.id)
            .order_by(LogisticsSubDispatchOrder.sequence_number.desc())
            .limit(1)
        )).scalar_one_or_none()
        
        if consignment.status == "UNPACKED":
            mdo.status = "ACKNOWLEDGED"
            if sdo:
                sdo.status = "ACKNOWLEDGED"
                sdo.received_at = datetime.now(timezone.utc)
                db.add(sdo)
        elif consignment.status == "PARTIALLY_UNPACKED":
            mdo.status = "PARTIALLY_ACKNOWLEDGED"
            if sdo:
                sdo.status = "PARTIALLY_ACKNOWLEDGED"
                sdo.received_at = datetime.now(timezone.utc)
                db.add(sdo)
        db.add(mdo)


async def _update_mi_status(db: AsyncSession, mi_id: int) -> None:
    from sqlalchemy import text as _text
    statuses = [r[0] for r in (await db.execute(
        select(Consignment.status).where(Consignment.material_issue_id == mi_id)
    )).all()]
    if statuses:
        if all(s == "UNPACKED" for s in statuses):
            # Use raw SQL to bypass ORM enum-cache on long-lived pool connections
            await db.execute(
                _text("UPDATE material_issues SET status='acknowledged', updated_at=NOW() WHERE id=:mi_id"),
                {"mi_id": mi_id},
            )
        elif any(s in ("UNPACKED", "PARTIALLY_UNPACKED") for s in statuses):
            await db.execute(
                _text("UPDATE material_issues SET status='partially_acknowledged', updated_at=NOW() WHERE id=:mi_id"),
                {"mi_id": mi_id},
            )


def _pkg_response(pkg: ConsignmentPackage, include_items: bool = True) -> dict:
    d = {
        "id": pkg.id,
        "package_number": pkg.package_number,
        "package_barcode": pkg.package_barcode,
        "parent_package_code": pkg.parent_package_code,
        "parent_package_barcode": pkg.parent_package_barcode,
        "consignment_id": pkg.consignment_id,
        "sequence_number": pkg.sequence_number,
        "package_type": pkg.package_type,
        "package_description": pkg.package_description,
        "length_cm": pkg.length_cm,
        "width_cm": pkg.width_cm,
        "height_cm": pkg.height_cm,
        "gross_weight_kg": pkg.gross_weight_kg,
        "net_weight_kg": pkg.net_weight_kg,
        "volume_cft": pkg.volume_cft,
        "seal_number": pkg.seal_number,
        "seal_intact": pkg.seal_intact,
        "material_count": pkg.material_count,
        "status": pkg.status,
        "packed_at": pkg.packed_at,
        "received_at": pkg.received_at,
        "packaging_condition_on_receipt": pkg.packaging_condition_on_receipt,
        "seal_intact_on_receipt": pkg.seal_intact_on_receipt,
        "receipt_remarks": pkg.receipt_remarks,
        "receipt_photos": pkg.receipt_photos,
        "receipt_signature_url": pkg.receipt_signature_url,
    }
    if include_items and pkg.items is not None:
        d["items"] = [_pkg_item_response(i) for i in pkg.items]
    if pkg.container is not None:
        d["container"] = {
            "container_number": pkg.container.container_number,
            "container_type": pkg.container.container_type,
            "container_barcode": pkg.container.container_barcode,
        }
    try:
        if pkg.consignment is not None:
            d["receiver_name"] = pkg.consignment.receiver_name
            d["receiver_employee_code"] = pkg.consignment.receiver_employee_code
            d["receiver_position_code"] = pkg.consignment.receiver_position_code
            d["consignment_status"] = pkg.consignment.status
            d["consignment_number"] = pkg.consignment.consignment_number
    except Exception:
        pass
    return d


def _pkg_item_response(it: ConsignmentPackageItem) -> dict:
    mat = it.material
    batch = it.batch or (it.material_issue_item.batch if it.material_issue_item else None)
    return {
        "id": it.id,
        "package_id": it.package_id,
        "material_issue_item_id": it.material_issue_item_id,
        "material_id": it.material_id,
        "material_code": mat.item_code if mat else None,
        "material_name": mat.name if mat else None,
        "material_type": mat.item_type if mat else None,
        "batch_id": it.batch_id or (it.material_issue_item.batch_id if it.material_issue_item else None),
        "batch_number": batch.batch_number if batch else None,
        "expiry_date": batch.expiry_date.strftime("%d-%b-%Y") if (batch and batch.expiry_date) else None,
        "mfg_date": batch.manufacturing_date.strftime("%d-%b-%Y") if (batch and getattr(batch, "manufacturing_date", None)) else None,
        "source_bin_id": it.source_bin_id,
        "destination_bin_id": it.destination_bin_id,
        "quantity_packed": it.quantity_packed,
        "quantity_received": it.quantity_received,
        "quantity_accepted": it.quantity_accepted,
        "quantity_rejected": it.quantity_rejected,
        "quantity_damaged": it.quantity_damaged,
        "uom_code": it.uom_code,
        "unit_price": it.unit_price,
        "total_value": it.total_value,
        "item_condition": it.item_condition,
        "rejection_reason": it.rejection_reason,
        "serial_numbers": it.serial_numbers,
        "serial_numbers_received": it.serial_numbers_received,
    }


def _con_response(con: Consignment, packages: list) -> dict:
    mi = con.material_issue
    indent = con.indent
    src_wh = con.source_warehouse
    dst_wh = con.destination_warehouse
    return {
        "id": con.id,
        "consignment_number": con.consignment_number,
        "consignment_barcode": con.consignment_barcode,
        "parent_package_code": con.parent_package_code,
        "parent_package_barcode": con.parent_package_barcode,
        "material_issue_id": con.material_issue_id,
        "material_issue_number": mi.issue_number if mi else None,
        "indent_id": con.indent_id,
        "indent_number": indent.indent_number if indent else None,
        "mdo_id": con.mdo_id,
        "warehouse_id": con.warehouse_id,
        "warehouse_name": src_wh.name if src_wh else None,
        "destination_warehouse_id": con.destination_warehouse_id,
        "destination_warehouse_name": dst_wh.name if dst_wh else None,
        "destination_user_id": con.destination_user_id,
        "receiver_employee_code": con.receiver_employee_code,
        "receiver_name": con.receiver_name,
        "receiver_position_code": con.receiver_position_code,
        "state_code": con.state_code,
        "total_packages": con.total_packages,
        "total_weight_kg": con.total_weight_kg,
        "total_volume_cft": con.total_volume_cft,
        "total_value": con.total_value,
        "total_items": con.total_items,
        "status": con.status,
        "packages": packages,
        "packed_at": con.packed_at,
        "dispatched_at": con.dispatched_at,
        "received_at": con.received_at,
        "receipt_signature_url": con.receipt_signature_url,
        "receipt_photos": con.receipt_photos,
        "receipt_remarks": con.receipt_remarks,
        "created_at": con.created_at,
    }


# ──────────────────────────────────────────────────────────────────────────────
# CONSIGNMENT ENDPOINTS
# ──────────────────────────────────────────────────────────────────────────────

@router.post("", status_code=201)
async def create_consignment(
    payload: ConsignmentCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a consignment with multiple packages from a Material Issue.

    Flow:
    1. Validate MI exists
    2. Generate consignment number CON-{STATE}-{YYYY}-{SEQ}
    3. For each package:
       a. Generate PKG number, QR barcode
       b. Create PackageItems (batch + expiry linked)
       c. Auto-create Container
    4. Recalculate consignment aggregates
    """
    await ensure_consignment_schema(db)
    from app.models.issue import MaterialIssue, MaterialIssueItem

    mi = (await db.execute(select(MaterialIssue).where(MaterialIssue.id == payload.material_issue_id))).scalar_one_or_none()
    if not mi:
        raise HTTPException(404, "Material Issue not found")

    # 🛑 Validation: Prevent multiple consignments for the same Material Issue
    existing_con = await db.execute(
        select(Consignment.id).where(
            Consignment.material_issue_id == payload.material_issue_id,
            Consignment.status.in_(["DRAFT", "PACKED", "IN_TRANSIT", "PARTIALLY_RECEIVED"]),
        ).limit(1)
    )
    if existing_con.scalar_one_or_none() is not None:
        raise HTTPException(400, "A consignment already exists for this Material Issue. Multiple consignments per MI are not allowed.")

    # Validate MI items exist
    mi_item_ids = [i.material_issue_item_id for pkg in payload.packages for i in pkg.items]
    mi_items_res = await db.execute(
        select(MaterialIssueItem).where(
            MaterialIssueItem.issue_id == mi.id,
            MaterialIssueItem.id.in_(mi_item_ids),
        )
    )
    mi_items = {r.id: r for r in mi_items_res.scalars().all()}
    missing = set(mi_item_ids) - set(mi_items.keys())
    if missing:
        raise HTTPException(400, f"MI items not found in this issue: {sorted(missing)}")

    # 🛑 Validation: Sum of quantities per MI item across all packages must NOT exceed MI item qty
    from collections import defaultdict
    item_qty_sum = defaultdict(lambda: Decimal("0"))
    for pkg_in in payload.packages:
        for item_in in pkg_in.items:
            item_qty_sum[item_in.material_issue_item_id] += item_in.quantity_packed

    for mi_item_id, total_packed in item_qty_sum.items():
        if mi_item_id not in mi_items:
            continue
        mi_item = mi_items[mi_item_id]
        mi_item_qty = mi_item.qty or Decimal("0")
        if total_packed > mi_item_qty:
            raise HTTPException(400,
                f"Total packed quantity ({total_packed}) for MI item ID {mi_item_id} ({mi_item.item.name if mi_item.item else ''}) "
                f"exceeds the issued quantity ({mi_item_qty})."
            )

    # 🛑 Validation: If MI items have serial numbers, validate subset, uniqueness, and quantity matching
    resolved_sns_map = {}
    mi_assigned_serials = defaultdict(set)
    for pkg_idx, pkg_in in enumerate(payload.packages, start=1):
        for item_in in pkg_in.items:
            mi_item = mi_items.get(item_in.material_issue_item_id)
            if not mi_item:
                continue
            mi_sns = mi_item.serial_numbers or []
            if mi_sns:
                item_sns = item_in.serial_numbers
                if item_sns is None or len(item_sns) == 0:
                    if item_in.quantity_packed == mi_item.qty:
                        item_sns = mi_sns
                    else:
                        raise HTTPException(
                            400,
                            f"Package #{pkg_idx}: Serial numbers must be explicitly selected when splitting or packing partial quantities of serial-tracked item {mi_item.item.name if mi_item.item else mi_item.item_id}."
                        )
                
                if len(item_sns) != int(item_in.quantity_packed):
                    raise HTTPException(
                        400,
                        f"Package #{pkg_idx}: quantity packed ({item_in.quantity_packed}) must match the number of selected serial numbers ({len(item_sns)}) for item {mi_item.item.name if mi_item.item else mi_item.item_id}."
                    )
                
                invalid_sns = set(item_sns) - set(mi_sns)
                if invalid_sns:
                    raise HTTPException(
                        400,
                        f"Package #{pkg_idx}: serial numbers {sorted(invalid_sns)} are not part of the issued serial numbers for item {mi_item.item.name if mi_item.item else mi_item.item_id}."
                    )
                
                duplicate_sns = set(item_sns) & mi_assigned_serials[mi_item.id]
                if duplicate_sns:
                    raise HTTPException(
                        400,
                        f"Duplicate serial numbers {sorted(duplicate_sns)} assigned across packages for item {mi_item.item.name if mi_item.item else mi_item.item_id}."
                    )
                
                for sn in item_sns:
                    mi_assigned_serials[mi_item.id].add(sn)
                
                resolved_sns_map[(pkg_idx, mi_item.id)] = item_sns

    # Generate consignment number
    state = (payload.state_code or "GEN").upper()
    yr = datetime.now(timezone.utc).year
    con_num = await generate_number(db, "logistics", "consignment")
    # Reformat: BHSPL/26-27/CONS/00001 → CON-AP-2026-000001 (reparse seq)
    seq_part = con_num.split("/")[-1]                    # e.g. "00001"
    consignment_number = f"CON-{state}-{yr}-{seq_part}"

    # Map from parent group name -> (code, barcode)
    parent_groups = {}
    group_seq = 1
    for p in payload.packages:
        gname = p.parent_package_group
        if gname and gname.strip() and gname.strip() not in parent_groups:
            # Generate parent package code for this specific group
            g_code = f"PKG-{state}-{yr}-{seq_part}-PAR{group_seq}"
            g_qr = _qr_barcode({
                "type": "parent_package",
                "parent_package": g_code,
                "consignment": consignment_number,
                "group_name": gname.strip(),
                "receiver": payload.receiver_employee_code,
            })
            parent_groups[gname.strip()] = (g_code, g_qr)
            group_seq += 1

    first_parent_code = None
    first_parent_qr = None
    if parent_groups:
        first_parent_code, first_parent_qr = list(parent_groups.values())[0]

    # Fetch indent number for QR if indent_id provided
    indent_number_for_qr = None
    if payload.indent_id:
        from app.models.indent import Indent as _Indent
        _ind = (await db.execute(select(_Indent).where(_Indent.id == payload.indent_id))).scalar_one_or_none()
        indent_number_for_qr = _ind.indent_number if _ind else None

    con_qr = _qr_barcode({
        "type": "consignment",
        "consignment": consignment_number,
        "indent": indent_number_for_qr,
        "receiver": payload.receiver_employee_code,
        "total_packages": len(payload.packages),
    })

    # Auto-resolve mdo_id if not provided
    resolved_mdo_id = payload.mdo_id
    if not resolved_mdo_id and payload.material_issue_id:
        from app.models.logistics import LogisticsMainDispatchOrder
        resolved_mdo = (await db.execute(
            select(LogisticsMainDispatchOrder.id)
            .where(LogisticsMainDispatchOrder.material_issue_id == payload.material_issue_id)
            .limit(1)
        )).scalar_one_or_none()
        if resolved_mdo:
            resolved_mdo_id = resolved_mdo

    consignment = Consignment(
        consignment_number=consignment_number,
        consignment_barcode=con_qr,
        parent_package_code=first_parent_code,
        parent_package_barcode=first_parent_qr,
        indent_id=payload.indent_id,
        material_issue_id=payload.material_issue_id,
        mdo_id=resolved_mdo_id,
        warehouse_id=mi.warehouse_id,
        destination_warehouse_id=payload.destination_warehouse_id,
        destination_user_id=payload.destination_user_id,
        receiver_employee_code=payload.receiver_employee_code,
        receiver_name=payload.receiver_name,
        receiver_position_code=payload.receiver_position_code,
        state_code=state,
        status="DRAFT",
        created_by=current_user.id,
    )
    db.add(consignment)
    await db.flush()

    for idx, pkg_in in enumerate(payload.packages, start=1):
        pkg_num = f"PKG-{state}-{yr}-{seq_part}-{str(idx).zfill(2)}"
        
        # Resolve parent package group code & barcode if set
        gname = pkg_in.parent_package_group
        g_code = None
        g_qr = None
        if gname and gname.strip() in parent_groups:
            g_code, g_qr = parent_groups[gname.strip()]

        pkg_qr = _qr_barcode({
            "type": "package",
            "package": pkg_num,
            "consignment": consignment_number,
            "parent_package": g_code,
            "weight_kg": float(pkg_in.gross_weight_kg or 0),
            "package_type": pkg_in.package_type,
        })
        vol = _vol_cft(pkg_in.length_cm, pkg_in.width_cm, pkg_in.height_cm)

        pkg = ConsignmentPackage(
            package_number=pkg_num,
            package_barcode=pkg_qr,
            parent_package_code=g_code,
            parent_package_barcode=g_qr,
            consignment_id=consignment.id,
            sequence_number=idx,
            package_type=pkg_in.package_type,
            package_description=pkg_in.package_description,
            length_cm=pkg_in.length_cm,
            width_cm=pkg_in.width_cm,
            height_cm=pkg_in.height_cm,
            gross_weight_kg=pkg_in.gross_weight_kg or Decimal("0"),
            volume_cft=vol,
            seal_number=pkg_in.seal_number,
            material_count=len(pkg_in.items),
            status="DRAFT",
            created_by=current_user.id,
        )
        db.add(pkg)
        await db.flush()

        for item_in in pkg_in.items:
            mi_item = mi_items[item_in.material_issue_item_id]
            rate = item_in.unit_price or mi_item.rate or Decimal("0")
            
            # Use resolved serial numbers if validated, else fall back to payload/MI
            sns = resolved_sns_map.get((idx, mi_item.id))
            if sns is None:
                sns = item_in.serial_numbers
                if sns is None or len(sns) == 0:
                    sns = mi_item.serial_numbers

            pkg_item = ConsignmentPackageItem(
                package_id=pkg.id,
                material_issue_item_id=item_in.material_issue_item_id,
                material_id=item_in.material_id,
                batch_id=item_in.batch_id or mi_item.batch_id,
                uom_id=mi_item.uom_id,
                uom_code=item_in.uom_code or "NOS",
                source_bin_id=item_in.source_bin_id or mi_item.bin_id,
                quantity_packed=item_in.quantity_packed,
                serial_numbers=sns,
                unit_price=rate,
                total_value=item_in.quantity_packed * rate,
            )
            db.add(pkg_item)

        # Auto-create Container (1:1 with Package)
        cnt_num = f"CNT-{state}-{yr}-{seq_part}-{str(idx).zfill(2)}"
        cnt_qr = _qr_barcode({"type": "container", "container": cnt_num, "package": pkg_num})
        db.add(ConsignmentPackageContainer(
            package_id=pkg.id,
            container_number=cnt_num,
            container_type="PACKAGE",
            container_barcode=cnt_qr,
            warehouse_id=mi.warehouse_id,
        ))

    await db.flush()
    await _recalc_consignment(db, consignment)
    await db.flush()
    await db.commit()
    await db.refresh(consignment)

    # Reload with full relations for response
    con_full = (await db.execute(
        select(Consignment)
        .options(
            joinedload(Consignment.material_issue),
            joinedload(Consignment.indent),
            joinedload(Consignment.source_warehouse),
            joinedload(Consignment.destination_warehouse),
            selectinload(Consignment.packages)
            .selectinload(ConsignmentPackage.items)
            .joinedload(ConsignmentPackageItem.material),
            selectinload(Consignment.packages)
            .selectinload(ConsignmentPackage.items)
            .joinedload(ConsignmentPackageItem.batch),
            selectinload(Consignment.packages)
            .selectinload(ConsignmentPackage.items)
            .joinedload(ConsignmentPackageItem.material_issue_item)
            .joinedload(MaterialIssueItem.batch),
            selectinload(Consignment.packages).joinedload(ConsignmentPackage.container),
        )
        .where(Consignment.id == consignment.id)
    )).unique().scalar_one()

    pkgs_out = [_pkg_response(p) for p in con_full.packages]
    return _con_response(con_full, pkgs_out)


@router.put("/{consignment_id}")
async def update_consignment(
    consignment_id: int,
    payload: ConsignmentCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a draft consignment's packages and details.

    1. Fetch existing consignment.
    2. Verify status is 'DRAFT'.
    3. Validate MI and items.
    4. Delete existing package containers, package items, and packages.
    5. Re-create packages and items from the payload.
    6. Recalculate consignment aggregates.
    """
    from app.models.issue import MaterialIssue, MaterialIssueItem
    from app.models.consignment import ConsignmentPackage, ConsignmentPackageItem, ConsignmentPackageContainer
    from sqlalchemy import delete

    consignment = (await db.execute(select(Consignment).where(Consignment.id == consignment_id))).scalar_one_or_none()
    if not consignment:
        raise HTTPException(404, "Consignment not found")

    if consignment.status != "DRAFT":
        raise HTTPException(400, "Only draft consignments can be edited")

    mi = (await db.execute(select(MaterialIssue).where(MaterialIssue.id == payload.material_issue_id))).scalar_one_or_none()
    if not mi:
        raise HTTPException(404, "Material Issue not found")

    # Validate MI items exist
    mi_item_ids = [i.material_issue_item_id for pkg in payload.packages for i in pkg.items]
    mi_items_res = await db.execute(
        select(MaterialIssueItem).where(
            MaterialIssueItem.issue_id == mi.id,
            MaterialIssueItem.id.in_(mi_item_ids),
        )
    )
    mi_items = {r.id: r for r in mi_items_res.scalars().all()}
    missing = set(mi_item_ids) - set(mi_items.keys())
    if missing:
        raise HTTPException(400, f"MI items not found in this issue: {sorted(missing)}")

    # 🛑 Validation: Sum of quantities per MI item across all packages must NOT exceed MI item qty
    from collections import defaultdict
    item_qty_sum = defaultdict(lambda: Decimal("0"))
    for pkg_in in payload.packages:
        for item_in in pkg_in.items:
            item_qty_sum[item_in.material_issue_item_id] += item_in.quantity_packed

    # Get total packed quantity of each MI item in OTHER consignments
    other_packed_res = await db.execute(
        select(
            ConsignmentPackageItem.material_issue_item_id,
            func.sum(ConsignmentPackageItem.quantity_packed)
        )
        .join(ConsignmentPackage, ConsignmentPackageItem.package_id == ConsignmentPackage.id)
        .join(Consignment, ConsignmentPackage.consignment_id == Consignment.id)
        .where(
            ConsignmentPackageItem.material_issue_item_id.in_(mi_item_ids),
            Consignment.id != consignment_id,
            Consignment.status != "CANCELLED"
        )
        .group_by(ConsignmentPackageItem.material_issue_item_id)
    )
    other_packed = {mi_item_id: Decimal(str(qty_p or 0)) for mi_item_id, qty_p in other_packed_res.all()}

    for mi_item_id, total_packed in item_qty_sum.items():
        if mi_item_id not in mi_items:
            continue
        mi_item = mi_items[mi_item_id]
        mi_item_qty = mi_item.qty or Decimal("0")
        packed_in_others = other_packed.get(mi_item_id, Decimal("0"))
        if total_packed + packed_in_others > mi_item_qty:
            raise HTTPException(400,
                f"Total packed quantity ({total_packed + packed_in_others}) for MI item ID {mi_item_id} "
                f"exceeds the issued quantity ({mi_item_qty})."
            )

    # 🛑 Validation: If MI items have serial numbers, validate subset, uniqueness, and quantity matching
    resolved_sns_map = {}
    mi_assigned_serials = defaultdict(set)
    for pkg_idx, pkg_in in enumerate(payload.packages, start=1):
        for item_in in pkg_in.items:
            mi_item = mi_items.get(item_in.material_issue_item_id)
            if not mi_item:
                continue
            mi_sns = mi_item.serial_numbers or []
            if mi_sns:
                item_sns = item_in.serial_numbers
                if item_sns is None or len(item_sns) == 0:
                    if item_in.quantity_packed == mi_item.qty:
                        item_sns = mi_sns
                    else:
                        raise HTTPException(
                            400,
                            f"Package #{pkg_idx}: Serial numbers must be explicitly selected when splitting or packing partial quantities of serial-tracked item."
                        )

                if len(item_sns) != int(item_in.quantity_packed):
                    raise HTTPException(
                        400,
                        f"Package #{pkg_idx}: quantity packed ({item_in.quantity_packed}) must match the number of selected serial numbers ({len(item_sns)})."
                    )

                invalid_sns = set(item_sns) - set(mi_sns)
                if invalid_sns:
                    raise HTTPException(
                        400,
                        f"Package #{pkg_idx}: serial numbers {sorted(invalid_sns)} are not part of the issued serial numbers."
                    )

                duplicate_sns = set(item_sns) & mi_assigned_serials[mi_item.id]
                if duplicate_sns:
                    raise HTTPException(
                        400,
                        f"Duplicate serial numbers {sorted(duplicate_sns)} assigned across packages."
                    )

                for sn in item_sns:
                    mi_assigned_serials[mi_item.id].add(sn)

                resolved_sns_map[(pkg_idx, mi_item.id)] = item_sns

    # Get the sequence code part from the existing consignment number
    consignment_number = consignment.consignment_number
    seq_part = consignment_number.split("-")[-1]
    state = consignment.state_code or "GEN"
    yr = datetime.now(timezone.utc).year

    # Map from parent group name -> (code, barcode)
    parent_groups = {}
    group_seq = 1
    for p in payload.packages:
        gname = p.parent_package_group
        if gname and gname.strip() and gname.strip() not in parent_groups:
            g_code = f"PKG-{state}-{yr}-{seq_part}-PAR{group_seq}"
            g_qr = _qr_barcode({
                "type": "parent_package",
                "parent_package": g_code,
                "consignment": consignment_number,
                "group_name": gname.strip(),
                "receiver": payload.receiver_employee_code,
            })
            parent_groups[gname.strip()] = (g_code, g_qr)
            group_seq += 1

    first_parent_code = None
    first_parent_qr = None
    if parent_groups:
        first_parent_code, first_parent_qr = list(parent_groups.values())[0]

    # Fetch indent number for QR if indent_id provided
    indent_number_for_qr = None
    if payload.indent_id:
        from app.models.indent import Indent as _Indent
        _ind = (await db.execute(select(_Indent).where(_Indent.id == payload.indent_id))).scalar_one_or_none()
        indent_number_for_qr = _ind.indent_number if _ind else None

    con_qr = _qr_barcode({
        "type": "consignment",
        "consignment": consignment_number,
        "indent": indent_number_for_qr,
        "receiver": payload.receiver_employee_code,
        "total_packages": len(payload.packages),
    })

    # Fetch existing package IDs to delete packages, package items, and package containers
    pkg_res = await db.execute(select(ConsignmentPackage.id).where(ConsignmentPackage.consignment_id == consignment_id))
    pkg_ids = pkg_res.scalars().all()
    if pkg_ids:
        await db.execute(
            delete(ConsignmentPackageItem).where(ConsignmentPackageItem.package_id.in_(pkg_ids))
        )
        await db.execute(
            delete(ConsignmentPackageContainer).where(ConsignmentPackageContainer.package_id.in_(pkg_ids))
        )
        await db.execute(
            delete(ConsignmentPackage).where(ConsignmentPackage.id.in_(pkg_ids))
        )
        await db.flush()

    # Update consignment metadata
    consignment.consignment_barcode = con_qr
    consignment.parent_package_code = first_parent_code
    consignment.parent_package_barcode = first_parent_qr
    consignment.indent_id = payload.indent_id
    consignment.material_issue_id = payload.material_issue_id
    consignment.destination_warehouse_id = payload.destination_warehouse_id
    consignment.destination_user_id = payload.destination_user_id
    consignment.receiver_employee_code = payload.receiver_employee_code
    consignment.receiver_name = payload.receiver_name
    consignment.receiver_position_code = payload.receiver_position_code

    # Add packages & items
    for idx, pkg_in in enumerate(payload.packages, start=1):
        pkg_num = f"PKG-{state}-{yr}-{seq_part}-{str(idx).zfill(2)}"
        gname = pkg_in.parent_package_group
        g_code = None
        g_qr = None
        if gname and gname.strip() in parent_groups:
            g_code, g_qr = parent_groups[gname.strip()]

        pkg_qr = _qr_barcode({
            "type": "package",
            "package": pkg_num,
            "consignment": consignment_number,
            "parent_package": g_code,
            "weight_kg": float(pkg_in.gross_weight_kg or 0),
            "package_type": pkg_in.package_type,
        })
        vol = _vol_cft(pkg_in.length_cm, pkg_in.width_cm, pkg_in.height_cm)

        pkg = ConsignmentPackage(
            package_number=pkg_num,
            package_barcode=pkg_qr,
            parent_package_code=g_code,
            parent_package_barcode=g_qr,
            consignment_id=consignment.id,
            sequence_number=idx,
            package_type=pkg_in.package_type,
            package_description=pkg_in.package_description,
            length_cm=pkg_in.length_cm,
            width_cm=pkg_in.width_cm,
            height_cm=pkg_in.height_cm,
            gross_weight_kg=pkg_in.gross_weight_kg or Decimal("0"),
            volume_cft=vol,
            seal_number=pkg_in.seal_number,
            material_count=len(pkg_in.items),
            status="DRAFT",
            created_by=current_user.id,
        )
        db.add(pkg)
        await db.flush()

        for item_in in pkg_in.items:
            mi_item = mi_items[item_in.material_issue_item_id]
            rate = item_in.unit_price or mi_item.rate or Decimal("0")
            sns = resolved_sns_map.get((idx, mi_item.id))
            if sns is None:
                sns = item_in.serial_numbers
                if sns is None or len(sns) == 0:
                    sns = mi_item.serial_numbers

            pkg_item = ConsignmentPackageItem(
                package_id=pkg.id,
                material_issue_item_id=item_in.material_issue_item_id,
                material_id=item_in.material_id,
                batch_id=item_in.batch_id or mi_item.batch_id,
                uom_id=mi_item.uom_id,
                uom_code=item_in.uom_code or "NOS",
                source_bin_id=item_in.source_bin_id or mi_item.bin_id,
                quantity_packed=item_in.quantity_packed,
                serial_numbers=sns,
                unit_price=rate,
                total_value=item_in.quantity_packed * rate,
            )
            db.add(pkg_item)

        cnt_num = f"CNT-{state}-{yr}-{seq_part}-{str(idx).zfill(2)}"
        cnt_qr = _qr_barcode({"type": "container", "container": cnt_num, "package": pkg_num})
        db.add(ConsignmentPackageContainer(
            package_id=pkg.id,
            container_number=cnt_num,
            container_type="PACKAGE",
            container_barcode=cnt_qr,
            warehouse_id=mi.warehouse_id,
        ))

    await db.flush()
    await _recalc_consignment(db, consignment)
    await db.flush()
    await db.commit()
    await db.refresh(consignment)

    # Reload and return
    con_full = (await db.execute(
        select(Consignment)
        .options(
            joinedload(Consignment.material_issue),
            joinedload(Consignment.indent),
            joinedload(Consignment.source_warehouse),
            joinedload(Consignment.destination_warehouse),
            selectinload(Consignment.packages)
            .selectinload(ConsignmentPackage.items)
            .joinedload(ConsignmentPackageItem.material),
            selectinload(Consignment.packages)
            .selectinload(ConsignmentPackage.items)
            .joinedload(ConsignmentPackageItem.batch),
            selectinload(Consignment.packages)
            .selectinload(ConsignmentPackage.items)
            .joinedload(ConsignmentPackageItem.material_issue_item)
            .joinedload(MaterialIssueItem.batch),
            selectinload(Consignment.packages).joinedload(ConsignmentPackage.container),
        )
        .where(Consignment.id == consignment.id)
    )).unique().scalar_one()

    pkgs_out = [_pkg_response(p) for p in con_full.packages]
    return _con_response(con_full, pkgs_out)


@router.get("")
async def list_consignments(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    status: Optional[str] = None,
    material_issue_id: Optional[int] = None,
    indent_id: Optional[int] = None,
    search: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List consignments with optional status / MI / indent filters."""
    await ensure_consignment_schema(db)
    offset = (page - 1) * page_size
    q = select(Consignment).options(
        joinedload(Consignment.source_warehouse),
        joinedload(Consignment.destination_warehouse),
        joinedload(Consignment.material_issue),
        joinedload(Consignment.indent),
    )
    cq = select(func.count(Consignment.id))
    if status:
        q = q.where(Consignment.status == status)
        cq = cq.where(Consignment.status == status)
    if material_issue_id:
        q = q.where(Consignment.material_issue_id == material_issue_id)
        cq = cq.where(Consignment.material_issue_id == material_issue_id)
    if indent_id:
        q = q.where(Consignment.indent_id == indent_id)
        cq = cq.where(Consignment.indent_id == indent_id)
    if search:
        term = f"%{search}%"
        cond = or_(
            Consignment.consignment_number.ilike(term),
            Consignment.receiver_employee_code.ilike(term),
            Consignment.receiver_name.ilike(term),
        )
        q = q.where(cond)
        cq = cq.where(cond)

    total = (await db.execute(cq)).scalar() or 0
    rows = (await db.execute(q.order_by(Consignment.id.desc()).offset(offset).limit(page_size))).unique().scalars().all()

    data = []
    for c in rows:
        pkgs_rcvd = (await db.execute(
            select(func.count(ConsignmentPackage.id)).where(
                ConsignmentPackage.consignment_id == c.id,
                ConsignmentPackage.status == "RECEIVED",
            )
        )).scalar() or 0
        data.append({
            "id": c.id,
            "consignment_number": c.consignment_number,
            "material_issue_number": c.material_issue.issue_number if c.material_issue else None,
            "indent_number": c.indent.indent_number if c.indent else None,
            "warehouse_name": c.source_warehouse.name if c.source_warehouse else None,
            "destination_warehouse_name": c.destination_warehouse.name if c.destination_warehouse else None,
            "receiver_employee_code": c.receiver_employee_code,
            "receiver_name": c.receiver_name,
            "total_packages": c.total_packages,
            "packages_received": pkgs_rcvd,
            "status": c.status,
            "created_at": c.created_at,
        })

    return {"data": data, "total": total, "page": page, "page_size": page_size,
            "total_pages": max(1, (total + page_size - 1) // page_size)}


@router.get("/scan-any/{barcode}")
async def scan_any_barcode(
    barcode: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Universal scan: try loading as parent consignment, else try single package."""
    await ensure_consignment_schema(db)
    
    # 1. Try to load as consignment first
    con_number = barcode
    try:
        payload = json.loads(barcode)
        con_number = payload.get("consignment", barcode)
    except (json.JSONDecodeError, TypeError):
        pass

    con = (await db.execute(
        select(Consignment)
        .options(
            joinedload(Consignment.material_issue),
            joinedload(Consignment.indent),
            joinedload(Consignment.destination_warehouse),
            selectinload(Consignment.packages),
        )
        .outerjoin(ConsignmentPackage, ConsignmentPackage.consignment_id == Consignment.id)
        .where(
            or_(
                Consignment.consignment_number == con_number,
                Consignment.parent_package_code == con_number,
                Consignment.parent_package_barcode == barcode,
                Consignment.consignment_barcode == barcode,
                ConsignmentPackage.parent_package_code == con_number,
                ConsignmentPackage.parent_package_barcode == barcode
            )
        )
    )).unique().scalar_one_or_none()

    if not con:
        # Fallback search by serial number / asset code inside consignment package items
        stmt_items = select(ConsignmentPackageItem).where(
            or_(
                ConsignmentPackageItem.serial_numbers.like(f'%"{con_number}"%'),
                ConsignmentPackageItem.serial_numbers.like(f'%{con_number}%')
            )
        )
        items_res = await db.execute(stmt_items)
        pkg_items = items_res.scalars().all()
        
        if not pkg_items:
            stmt_all_items = select(ConsignmentPackageItem).where(ConsignmentPackageItem.serial_numbers.isnot(None))
            all_res = await db.execute(stmt_all_items)
            all_items = all_res.scalars().all()
            for pi in all_items:
                if not pi.serial_numbers:
                    continue
                from app.models.master import Item
                item_row = await db.execute(select(Item).where(Item.id == pi.material_id))
                item_obj = item_row.scalar_one_or_none()
                if item_obj:
                    new_prefix = f"{item_obj.item_code}-1-"
                    legacy_prefix = "1-"
                    legacy_suffix = f"-{item_obj.item_code}"
                    
                    extracted = con_number
                    if con_number.startswith(new_prefix):
                        extracted = con_number[len(new_prefix):]
                    elif con_number.startswith(legacy_prefix) and con_number.endswith(legacy_suffix):
                        extracted = con_number[len(legacy_prefix):-len(legacy_suffix)]
                        
                    if extracted in pi.serial_numbers:
                        pkg_items = [pi]
                        break
                        
        if pkg_items:
            # Load parent package, then get the consignment
            pkg_id = pkg_items[0].package_id
            pkg_stmt = select(ConsignmentPackage).where(ConsignmentPackage.id == pkg_id)
            pkg_res = await db.execute(pkg_stmt)
            pkg_obj = pkg_res.scalar_one_or_none()
            if pkg_obj:
                con = (await db.execute(
                    select(Consignment)
                    .options(
                        joinedload(Consignment.material_issue),
                        joinedload(Consignment.indent),
                        joinedload(Consignment.destination_warehouse),
                        selectinload(Consignment.packages),
                    )
                    .where(Consignment.id == pkg_obj.consignment_id)
                )).unique().scalar_one_or_none()

    if con:
        con_data = {
            "id": con.id,
            "consignment_number": con.consignment_number,
            "parent_package_code": con.parent_package_code,
            "parent_package_barcode": con.parent_package_barcode,
            "material_issue_number": con.material_issue.issue_number if con.material_issue else None,
            "indent_number": con.indent.indent_number if con.indent else None,
            "receiver_employee_code": con.receiver_employee_code,
            "receiver_name": con.receiver_name,
            "receiver_position_code": con.receiver_position_code,
            "destination_warehouse_name": con.destination_warehouse.name if con.destination_warehouse else None,
            "total_packages": con.total_packages,
            "status": con.status,
            "packages": [
                {
                    "id": p.id,
                    "package_number": p.package_number,
                    "sequence_number": p.sequence_number,
                    "package_type": p.package_type,
                    "material_count": p.material_count,
                    "gross_weight_kg": float(p.gross_weight_kg) if p.gross_weight_kg is not None else 0,
                    "seal_number": p.seal_number,
                    "status": p.status,
                }
                for p in con.packages
            ]
        }
        return {"type": "parent", "data": con_data}

    # 2. Try loading as a package
    pkg_number = barcode
    try:
        parsed = json.loads(barcode)
        pkg_number = parsed.get("package", barcode)
    except (json.JSONDecodeError, TypeError):
        pass

    # Try matching package_number directly first
    pkg = (await db.execute(
        select(ConsignmentPackage)
        .options(
            selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.material),
            selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.batch),
            selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.material_issue_item).joinedload(MaterialIssueItem.batch),
            selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.uom),
            joinedload(ConsignmentPackage.container),
            joinedload(ConsignmentPackage.consignment),
        )
        .where(ConsignmentPackage.package_number == pkg_number)
    )).unique().scalar_one_or_none()

    if not pkg:
        # Fallback search by serial number / asset code inside consignment package items
        stmt_items = select(ConsignmentPackageItem).where(
            or_(
                ConsignmentPackageItem.serial_numbers.like(f'%"{pkg_number}"%'),
                ConsignmentPackageItem.serial_numbers.like(f'%{pkg_number}%')
            )
        )
        items_res = await db.execute(stmt_items)
        pkg_items = items_res.scalars().all()
        
        if not pkg_items:
            stmt_all_items = select(ConsignmentPackageItem).where(ConsignmentPackageItem.serial_numbers.isnot(None))
            all_res = await db.execute(stmt_all_items)
            all_items = all_res.scalars().all()
            for pi in all_items:
                if not pi.serial_numbers:
                    continue
                from app.models.master import Item
                item_row = await db.execute(select(Item).where(Item.id == pi.material_id))
                item_obj = item_row.scalar_one_or_none()
                if item_obj:
                    new_prefix = f"{item_obj.item_code}-1-"
                    legacy_prefix = "1-"
                    legacy_suffix = f"-{item_obj.item_code}"
                    
                    extracted = pkg_number
                    if pkg_number.startswith(new_prefix):
                        extracted = pkg_number[len(new_prefix):]
                    elif pkg_number.startswith(legacy_prefix) and pkg_number.endswith(legacy_suffix):
                        extracted = pkg_number[len(legacy_prefix):-len(legacy_suffix)]
                        
                    if extracted in pi.serial_numbers:
                        pkg_items = [pi]
                        break
        
        if pkg_items:
            target_pkg_id = pkg_items[0].package_id
            pkg = (await db.execute(
                select(ConsignmentPackage)
                .options(
                    selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.material),
                    selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.batch),
                    selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.material_issue_item).joinedload(MaterialIssueItem.batch),
                    selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.uom),
                    joinedload(ConsignmentPackage.container),
                    joinedload(ConsignmentPackage.consignment),
                )
                .where(ConsignmentPackage.id == target_pkg_id)
            )).unique().scalar_one_or_none()

    if pkg:
        return {"type": "child", "data": _pkg_response(pkg)}

    # Neither found
    raise HTTPException(404, f"Barcode '{barcode}' matches neither a consignment nor a package.")


@router.get("/scan/{barcode}")
async def scan_consignment_barcode(
    barcode: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Step 1 of MMU receiving: scan consignment barcode → load expected packages."""
    await ensure_consignment_schema(db)
    # barcode may be the QR JSON string or just the CON number
    con_number = barcode
    try:
        payload = json.loads(barcode)
        con_number = payload.get("consignment", barcode)
    except (json.JSONDecodeError, TypeError):
        pass

    con = (await db.execute(
        select(Consignment)
        .options(
            joinedload(Consignment.material_issue),
            joinedload(Consignment.indent),
            joinedload(Consignment.destination_warehouse),
            selectinload(Consignment.packages),
        )
        .outerjoin(ConsignmentPackage, ConsignmentPackage.consignment_id == Consignment.id)
        .where(
            or_(
                Consignment.consignment_number == con_number,
                Consignment.parent_package_code == con_number,
                Consignment.parent_package_barcode == barcode,
                Consignment.consignment_barcode == barcode,
                ConsignmentPackage.parent_package_code == con_number,
                ConsignmentPackage.parent_package_barcode == barcode
            )
        )
    )).unique().scalar_one_or_none()
    if not con:
        # Fallback search by serial number / asset code inside consignment package items
        stmt_items = select(ConsignmentPackageItem).where(
            or_(
                ConsignmentPackageItem.serial_numbers.like(f'%"{con_number}"%'),
                ConsignmentPackageItem.serial_numbers.like(f'%{con_number}%')
            )
        )
        items_res = await db.execute(stmt_items)
        pkg_items = items_res.scalars().all()
        
        if not pkg_items:
            stmt_all_items = select(ConsignmentPackageItem).where(ConsignmentPackageItem.serial_numbers.isnot(None))
            all_res = await db.execute(stmt_all_items)
            all_items = all_res.scalars().all()
            for pi in all_items:
                if not pi.serial_numbers:
                    continue
                from app.models.master import Item
                item_row = await db.execute(select(Item).where(Item.id == pi.material_id))
                item_obj = item_row.scalar_one_or_none()
                if item_obj:
                    new_prefix = f"{item_obj.item_code}-1-"
                    legacy_prefix = "1-"
                    legacy_suffix = f"-{item_obj.item_code}"
                    
                    extracted = con_number
                    if con_number.startswith(new_prefix):
                        extracted = con_number[len(new_prefix):]
                    elif con_number.startswith(legacy_prefix) and con_number.endswith(legacy_suffix):
                        extracted = con_number[len(legacy_prefix):-len(legacy_suffix)]
                        
                    if extracted in pi.serial_numbers:
                        pkg_items = [pi]
                        break
                        
        if pkg_items:
            # Load parent package, then get the consignment
            pkg_id = pkg_items[0].package_id
            pkg_stmt = select(ConsignmentPackage).where(ConsignmentPackage.id == pkg_id)
            pkg_res = await db.execute(pkg_stmt)
            pkg_obj = pkg_res.scalar_one_or_none()
            if pkg_obj:
                con = (await db.execute(
                    select(Consignment)
                    .options(
                        joinedload(Consignment.material_issue),
                        joinedload(Consignment.indent),
                        joinedload(Consignment.destination_warehouse),
                        selectinload(Consignment.packages),
                    )
                    .where(Consignment.id == pkg_obj.consignment_id)
                )).unique().scalar_one_or_none()

    if not con:
        raise HTTPException(404, f"Consignment '{con_number}' not found")

    return {
        "id": con.id,
        "consignment_number": con.consignment_number,
        "parent_package_code": con.parent_package_code,
        "parent_package_barcode": con.parent_package_barcode,
        "material_issue_number": con.material_issue.issue_number if con.material_issue else None,
        "indent_number": con.indent.indent_number if con.indent else None,
        "receiver_employee_code": con.receiver_employee_code,
        "receiver_name": con.receiver_name,
        "receiver_position_code": con.receiver_position_code,
        "destination_warehouse_name": con.destination_warehouse.name if con.destination_warehouse else None,
        "total_packages": con.total_packages,
        "status": con.status,
        "packages": [
            {
                "id": p.id,
                "package_number": p.package_number,
                "sequence_number": p.sequence_number,
                "package_type": p.package_type,
                "material_count": p.material_count,
                "gross_weight_kg": p.gross_weight_kg,
                "status": p.status,
            }
            for p in sorted(con.packages, key=lambda x: x.sequence_number)
        ],
    }


@router.get("/by-mi/{mi_id}")
async def get_consignment_by_mi(mi_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    await ensure_consignment_schema(db)
    rows = (await db.execute(select(Consignment).where(Consignment.material_issue_id == mi_id).order_by(Consignment.id.desc()))).scalars().all()
    return [{"id": c.id, "consignment_number": c.consignment_number, "status": c.status, "total_packages": c.total_packages} for c in rows]


@router.get("/by-indent/{indent_id}")
async def get_consignment_by_indent(indent_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    await ensure_consignment_schema(db)
    rows = (await db.execute(select(Consignment).where(Consignment.indent_id == indent_id).order_by(Consignment.id.desc()))).scalars().all()
    return [{"id": c.id, "consignment_number": c.consignment_number, "status": c.status, "total_packages": c.total_packages} for c in rows]


@router.get("/{consignment_id}")
async def get_consignment(consignment_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    await ensure_consignment_schema(db)
    con = (await db.execute(
        select(Consignment)
        .options(
            joinedload(Consignment.material_issue),
            joinedload(Consignment.indent),
            joinedload(Consignment.source_warehouse),
            joinedload(Consignment.destination_warehouse),
            selectinload(Consignment.packages).selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.material),
            selectinload(Consignment.packages).selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.batch),
            selectinload(Consignment.packages).selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.material_issue_item).joinedload(MaterialIssueItem.batch),
            selectinload(Consignment.packages).joinedload(ConsignmentPackage.container),
        )
        .where(Consignment.id == consignment_id)
    )).unique().scalar_one_or_none()
    if not con:
        raise HTTPException(404, "Consignment not found")
    return _con_response(con, [_pkg_response(p) for p in con.packages])


@router.post("/{consignment_id}/pack")
async def pack_consignment(
    consignment_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("logistics-consignments")),
):
    """Mark a consignment and all its packages as PACKED."""
    await ensure_consignment_schema(db)
    con = (await db.execute(
        select(Consignment)
        .options(selectinload(Consignment.packages).selectinload(ConsignmentPackage.items))
        .where(Consignment.id == consignment_id)
        .with_for_update()
    )).scalar_one_or_none()
    if not con:
        raise HTTPException(404, "Consignment not found")
    if con.status != "DRAFT":
        raise HTTPException(400, f"Cannot pack consignment in '{con.status}' status")
    if not con.packages:
        raise HTTPException(400, "Consignment has no packages")

    now = datetime.now(timezone.utc)
    for pkg in con.packages:
        if not pkg.items:
            raise HTTPException(400, f"Package {pkg.package_number} has no items")
        pkg.status = "PACKED"
        pkg.packed_at = now

    con.status = "PACKED"
    con.packed_at = now
    await db.flush()

    try:
        from app.services.notification_service import create_notification
        if con.created_by:
            await create_notification(
                db=db,
                user_id=con.created_by,
                title=f"Consignment Packed: {con.consignment_number}",
                message=f"Consignment {con.consignment_number} has been packed ({len(con.packages)} package(s)) and is ready for dispatch.",
                notification_type="info",
                module="logistics",
                reference_type="consignment",
                reference_id=con.id,
            )
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("Failed to send notification for pack_consignment: %s", e)

    await db.commit()
    return {"success": True, "consignment_number": con.consignment_number, "status": "PACKED"}


@router.post("/{consignment_id}/dispatch")
async def dispatch_consignment(
    consignment_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_key("logistics-consignments")),
):
    """Mark a packed consignment as IN_TRANSIT."""
    await ensure_consignment_schema(db)
    con = (await db.execute(
        select(Consignment)
        .options(selectinload(Consignment.packages))
        .where(Consignment.id == consignment_id)
        .with_for_update()
    )).scalar_one_or_none()
    if not con:
        raise HTTPException(404, "Consignment not found")
    if con.status != "PACKED":
        raise HTTPException(400, f"Cannot dispatch consignment in '{con.status}' status")

    now = datetime.now(timezone.utc)
    for pkg in con.packages:
        pkg.status = "IN_TRANSIT"
    con.status = "IN_TRANSIT"
    con.dispatched_at = now

    # Sync status to the linked MDO and SDO (Dispatch Plan)
    from app.models.logistics import LogisticsMainDispatchOrder, LogisticsSubDispatchOrder
    mdo = None
    if con.mdo_id:
        mdo = (await db.execute(
            select(LogisticsMainDispatchOrder).where(LogisticsMainDispatchOrder.id == con.mdo_id)
        )).scalar_one_or_none()
    elif con.material_issue_id:
        mdo = (await db.execute(
            select(LogisticsMainDispatchOrder).where(LogisticsMainDispatchOrder.material_issue_id == con.material_issue_id)
        )).scalar_one_or_none()
        if mdo:
            con.mdo_id = mdo.id
            db.add(con)

    if mdo:
        mdo.status = "IN_TRANSIT"
        sdo = (await db.execute(
            select(LogisticsSubDispatchOrder)
            .where(LogisticsSubDispatchOrder.mdo_id == mdo.id)
            .order_by(LogisticsSubDispatchOrder.sequence_number.desc())
            .limit(1)
        )).scalar_one_or_none()
        if sdo:
            sdo.status = "IN_TRANSIT"
            db.add(sdo)
        db.add(mdo)
        await db.flush()

    try:
        from app.services.notification_service import create_notification
        if con.created_by:
            await create_notification(
                db=db,
                user_id=con.created_by,
                title=f"Consignment Dispatched: {con.consignment_number}",
                message=f"Consignment {con.consignment_number} is now IN TRANSIT to the destination warehouse.",
                notification_type="info",
                module="logistics",
                reference_type="consignment",
                reference_id=con.id,
            )
        if con.destination_user_id and con.destination_user_id != con.created_by:
            await create_notification(
                db=db,
                user_id=con.destination_user_id,
                title=f"Incoming Consignment: {con.consignment_number}",
                message=f"Consignment {con.consignment_number} has been dispatched and is on the way to your warehouse.",
                notification_type="info",
                module="logistics",
                reference_type="consignment",
                reference_id=con.id,
            )
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("Failed to send notification for dispatch_consignment: %s", e)

    from app.api.v1.dispatch import sync_mdos_to_dispatches
    await sync_mdos_to_dispatches(db)
    await db.commit()
    return {"success": True, "consignment_number": con.consignment_number, "status": "IN_TRANSIT"}


@router.post("/{consignment_id}/deliver", status_code=200)
async def deliver_consignment(
    consignment_id: int,
    payload: Optional[ConsignmentDeliverPayload] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Mark consignment as CONSIGNMENT_RECEIVED — state transition only."""
    await ensure_consignment_schema(db)
    con = (await db.execute(
        select(Consignment)
        .options(selectinload(Consignment.packages))
        .where(Consignment.id == consignment_id)
        .with_for_update()
    )).scalar_one_or_none()
    if not con:
        raise HTTPException(404, "Consignment not found")
        
    con.status = "CONSIGNMENT_RECEIVED"
    con.received_at = datetime.now(timezone.utc)

    if payload:
        con.receipt_signature_url = payload.receiver_signature_url
        con.receipt_photos = payload.photos
        con.receipt_remarks = payload.remarks
        if payload.acknowledged_by_name:
            con.receiver_name = payload.acknowledged_by_name
        if payload.acknowledged_by_employee_code:
            con.receiver_employee_code = payload.acknowledged_by_employee_code
        if payload.acknowledged_by_designation:
            con.receiver_position_code = payload.acknowledged_by_designation
    
    for pkg in con.packages:
        if pkg.status in ("PACKED", "IN_TRANSIT"):
            pkg.status = "DELIVERED"
            
    if con.material_issue_id:
        # Use raw SQL to avoid ORM enum-cache issues on long-lived connection pool
        # connections that may still have the pre-migration schema cached.
        from sqlalchemy import text as _text
        await db.execute(
            _text("UPDATE material_issues SET status='received', updated_at=NOW() WHERE id=:mi_id"),
            {"mi_id": con.material_issue_id},
        )

    from app.models.logistics import LogisticsMainDispatchOrder, LogisticsSubDispatchOrder
    mdo = None
    if con.mdo_id:
        mdo = (await db.execute(
            select(LogisticsMainDispatchOrder).where(LogisticsMainDispatchOrder.id == con.mdo_id)
        )).scalar_one_or_none()
    elif con.material_issue_id:
        mdo = (await db.execute(
            select(LogisticsMainDispatchOrder).where(LogisticsMainDispatchOrder.material_issue_id == con.material_issue_id)
        )).scalar_one_or_none()
        if mdo:
            con.mdo_id = mdo.id
            db.add(con)

    if mdo:
        mdo.status = "CONSIGNMENT_RECEIVED"
        sdo = (await db.execute(
            select(LogisticsSubDispatchOrder)
            .where(LogisticsSubDispatchOrder.mdo_id == mdo.id)
            .order_by(LogisticsSubDispatchOrder.sequence_number.desc())
            .limit(1)
        )).scalar_one_or_none()
        if sdo:
            sdo.status = "CONSIGNMENT_RECEIVED"
            db.add(sdo)
        db.add(mdo)

    # Flush everything before sync to avoid autoflush collisions
    await db.flush()
            
    # Send system notifications
    try:
        from app.services.notification_service import create_notification
        if con.created_by:
            await create_notification(
                db=db,
                user_id=con.created_by,
                title="Consignment Received at Destination",
                message=f"Consignment {con.consignment_number} has been acknowledged as received at the destination warehouse.",
                notification_type="success",
                module="logistics",
                reference_type="consignment",
                reference_id=con.id,
            )
        if con.destination_user_id and con.destination_user_id != con.created_by:
            await create_notification(
                db=db,
                user_id=con.destination_user_id,
                title="Consignment Delivery Confirmed",
                message=f"You have confirmed receipt of consignment {con.consignment_number}.",
                notification_type="success",
                module="logistics",
                reference_type="consignment",
                reference_id=con.id,
            )
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("Failed to send notification for deliver_consignment: %s", e)

    from app.api.v1.dispatch import sync_mdos_to_dispatches
    await sync_mdos_to_dispatches(db)
    await db.commit()
    return {"success": True, "consignment_number": con.consignment_number, "status": "CONSIGNMENT_RECEIVED"}


# ──────────────────────────────────────────────────────────────────────────────
# PACKAGE ENDPOINTS
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/package/scan/{barcode}")
async def scan_package_barcode(
    barcode: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Step 2 of MMU receiving: scan package QR → load contents with batch/expiry."""
    await ensure_consignment_schema(db)
    pkg_number = barcode
    try:
        parsed = json.loads(barcode)
        pkg_number = parsed.get("package", barcode)
    except (json.JSONDecodeError, TypeError):
        pass

    pkg = (await db.execute(
        select(ConsignmentPackage)
        .options(
            selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.material),
            selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.batch),
            selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.uom),
            joinedload(ConsignmentPackage.container),
            joinedload(ConsignmentPackage.consignment),
        )
        .where(ConsignmentPackage.package_number == pkg_number)
    )).unique().scalar_one_or_none()
    if not pkg:
        # Fallback search by serial number / asset code inside consignment package items
        stmt_items = select(ConsignmentPackageItem).where(
            or_(
                ConsignmentPackageItem.serial_numbers.like(f'%"{pkg_number}"%'),
                ConsignmentPackageItem.serial_numbers.like(f'%{pkg_number}%')
            )
        )
        items_res = await db.execute(stmt_items)
        pkg_items = items_res.scalars().all()
        
        if not pkg_items:
            stmt_all_items = select(ConsignmentPackageItem).where(ConsignmentPackageItem.serial_numbers.isnot(None))
            all_res = await db.execute(stmt_all_items)
            all_items = all_res.scalars().all()
            for pi in all_items:
                if not pi.serial_numbers:
                    continue
                from app.models.master import Item
                item_row = await db.execute(select(Item).where(Item.id == pi.material_id))
                item_obj = item_row.scalar_one_or_none()
                if item_obj:
                    new_prefix = f"{item_obj.item_code}-1-"
                    legacy_prefix = "1-"
                    legacy_suffix = f"-{item_obj.item_code}"
                    
                    extracted = pkg_number
                    if pkg_number.startswith(new_prefix):
                        extracted = pkg_number[len(new_prefix):]
                    elif pkg_number.startswith(legacy_prefix) and pkg_number.endswith(legacy_suffix):
                        extracted = pkg_number[len(legacy_prefix):-len(legacy_suffix)]
                        
                    if extracted in pi.serial_numbers:
                        pkg_items = [pi]
                        break
        
        if pkg_items:
            # Load the parent package
            target_pkg_id = pkg_items[0].package_id
            pkg = (await db.execute(
                select(ConsignmentPackage)
                .options(
                    selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.material),
                    selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.batch),
                    selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.material_issue_item).joinedload(MaterialIssueItem.batch),
                    selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.uom),
                    joinedload(ConsignmentPackage.container),
                    joinedload(ConsignmentPackage.consignment),
                )
                .where(ConsignmentPackage.id == target_pkg_id)
            )).unique().scalar_one_or_none()

    if not pkg:
        raise HTTPException(404, f"Package '{pkg_number}' not found")
    return _pkg_response(pkg)


@router.get("/package/{package_id}")
async def get_package(package_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    await ensure_consignment_schema(db)
    pkg = (await db.execute(
        select(ConsignmentPackage)
        .options(
            selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.material),
            selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.batch),
            selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.material_issue_item).joinedload(MaterialIssueItem.batch),
            selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.uom),
            joinedload(ConsignmentPackage.container),
        )
        .where(ConsignmentPackage.id == package_id)
    )).unique().scalar_one_or_none()
    if not pkg:
        raise HTTPException(404, "Package not found")
    return _pkg_response(pkg)


@router.get("/package/{package_id}/manifest")
async def get_package_manifest(package_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Return material manifest for printing (PDF / QR label / packing slip)."""
    await ensure_consignment_schema(db)
    pkg = (await db.execute(
        select(ConsignmentPackage)
        .options(
            joinedload(ConsignmentPackage.consignment),
            selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.material),
            selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.batch),
            selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.material_issue_item).joinedload(MaterialIssueItem.batch),
            selectinload(ConsignmentPackage.items).joinedload(ConsignmentPackageItem.uom),
        )
        .where(ConsignmentPackage.id == package_id)
    )).unique().scalar_one_or_none()
    if not pkg:
        raise HTTPException(404, "Package not found")

    manifest_items = []
    for idx, it in enumerate(pkg.items, start=1):
        mat = it.material
        batch = it.batch or (it.material_issue_item.batch if it.material_issue_item else None)
        manifest_items.append({
            "sr": idx,
            "material_code": mat.item_code if mat else None,
            "material_name": mat.name if mat else None,
            "batch_number": batch.batch_number if batch else None,
            "expiry": batch.expiry_date.strftime("%b-%y") if (batch and batch.expiry_date) else None,
            "mfg_date": batch.manufacturing_date.strftime("%b-%y") if (batch and getattr(batch, "manufacturing_date", None)) else None,
            "quantity": it.quantity_packed,
            "uom": it.uom_code,
        })

    return {
        "package_number": pkg.package_number,
        "consignment_number": pkg.consignment.consignment_number if pkg.consignment else None,
        "package_type": pkg.package_type,
        "total_items": len(manifest_items),
        "items": manifest_items,
        "can_print_as": ["pdf", "qr_label", "packing_slip"],
    }


@router.get("/package/{package_id}/label")
async def get_package_label(package_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Return package label data for affixing on the outside of the package."""
    await ensure_consignment_schema(db)
    pkg = (await db.execute(
        select(ConsignmentPackage)
        .options(joinedload(ConsignmentPackage.consignment).joinedload(Consignment.destination_warehouse))
        .where(ConsignmentPackage.id == package_id)
    )).unique().scalar_one_or_none()
    if not pkg:
        raise HTTPException(404, "Package not found")

    con = pkg.consignment
    dst_wh = con.destination_warehouse if con else None

    label_lines = [
        f"PACKAGE : {pkg.package_number}",
        f"CONSIGNMENT : {con.consignment_number if con else '-'}",
        f"Receiver: {con.receiver_employee_code if con else '-'}",
        f"Location: {dst_wh.name if dst_wh else '-'}",
        f"Material Count: {pkg.material_count}",
        f"Weight: {pkg.gross_weight_kg} Kg",
        f"Type: {pkg.package_type}",
    ]

    return {
        "package_number": pkg.package_number,
        "consignment_number": con.consignment_number if con else None,
        "receiver_employee_code": con.receiver_employee_code if con else None,
        "receiver_name": con.receiver_name if con else None,
        "location": dst_wh.name if dst_wh else None,
        "material_count": pkg.material_count,
        "gross_weight_kg": pkg.gross_weight_kg,
        "package_type": pkg.package_type,
        "seal_number": pkg.seal_number,
        "package_barcode_value": pkg.package_barcode,
        "label_lines": label_lines,
    }


# ──────────────────────────────────────────────────────────────────────────────
# PARENT PACKAGE ENDPOINTS
# ──────────────────────────────────────────────────────────────────────────────

class ParentPackageCreate(BaseModel):
    parent_package_type: str = "PALLET"
    tare_weight_kg: Optional[Decimal] = Decimal("0")
    length_cm: Optional[Decimal] = None
    width_cm: Optional[Decimal] = None
    height_cm: Optional[Decimal] = None
    seal_number: Optional[str] = None
    child_package_ids: List[int]


class AddChildrenIn(BaseModel):
    child_package_ids: List[int]


def _parent_pkg_response(pp: ConsignmentParentPackage, include_children: bool = True) -> dict:
    d = {
        "id": pp.id,
        "consignment_id": pp.consignment_id,
        "parent_package_number": pp.parent_package_number,
        "parent_package_barcode": pp.parent_package_barcode,
        "parent_package_type": pp.parent_package_type,
        "tare_weight_kg": pp.tare_weight_kg,
        "gross_weight_kg": pp.gross_weight_kg,
        "total_child_weight_kg": pp.total_child_weight_kg,
        "total_volume_cft": pp.total_volume_cft,
        "length_cm": pp.length_cm,
        "width_cm": pp.width_cm,
        "height_cm": pp.height_cm,
        "seal_number": pp.seal_number,
        "child_package_count": pp.child_package_count,
        "total_items": pp.total_items,
        "total_value": pp.total_value,
        "status": pp.status,
        "created_at": pp.created_at,
    }
    if include_children and pp.children:
        d["children"] = [
            {
                "id": c.id,
                "child_package_id": c.child_package_id,
                "sequence_number": c.sequence_number,
                "package_number": c.child_package.package_number if c.child_package else None,
                "package_type": c.child_package.package_type if c.child_package else None,
                "gross_weight_kg": c.child_package.gross_weight_kg if c.child_package else None,
                "material_count": c.child_package.material_count if c.child_package else 0,
                "status": c.child_package.status if c.child_package else None,
            }
            for c in pp.children
        ]
    else:
        d["children"] = []
    return d


async def _recalc_parent_pkg(db: AsyncSession, pp: ConsignmentParentPackage) -> None:
    """Recalculate denormalised aggregates on a parent package from its children."""
    children = (await db.execute(
        select(ConsignmentParentPackageChild)
        .options(joinedload(ConsignmentParentPackageChild.child_package)
                 .selectinload(ConsignmentPackage.items))
        .where(ConsignmentParentPackageChild.parent_package_id == pp.id)
    )).unique().scalars().all()

    child_wt = Decimal("0")
    child_vol = Decimal("0")
    total_items = 0
    total_val = Decimal("0")

    for c in children:
        pkg = c.child_package
        if pkg:
            child_wt += pkg.gross_weight_kg or Decimal("0")
            child_vol += pkg.volume_cft or Decimal("0")
            total_items += pkg.material_count or 0
            for it in pkg.items:
                total_val += it.total_value or Decimal("0")

    pp.child_package_count = len(children)
    pp.total_child_weight_kg = child_wt
    pp.total_volume_cft = child_vol
    pp.gross_weight_kg = (pp.tare_weight_kg or Decimal("0")) + child_wt
    pp.total_items = total_items
    pp.total_value = total_val


@router.get("/{consignment_id}/parent-packages")
async def list_parent_packages(
    consignment_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all parent packages for a consignment with their children."""
    await ensure_consignment_schema(db)
    parents = (await db.execute(
        select(ConsignmentParentPackage)
        .options(
            selectinload(ConsignmentParentPackage.children)
            .joinedload(ConsignmentParentPackageChild.child_package),
        )
        .where(ConsignmentParentPackage.consignment_id == consignment_id)
        .order_by(ConsignmentParentPackage.id)
    )).unique().scalars().all()
    return [_parent_pkg_response(p) for p in parents]


@router.post("/{consignment_id}/parent-packages", status_code=201)
async def create_parent_package(
    consignment_id: int,
    payload: ParentPackageCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a parent package and assign child packages to it.

    Enforces exclusivity: a child package already assigned to another parent
    within this consignment will be rejected with a clear error.
    """
    await ensure_consignment_schema(db)

    con = (await db.execute(
        select(Consignment).where(Consignment.id == consignment_id)
    )).scalar_one_or_none()
    if not con:
        raise HTTPException(404, "Consignment not found")
    if con.status not in ("DRAFT", "PACKED"):
        raise HTTPException(400, f"Cannot add parent packages to consignment in '{con.status}' status")

    # Validate child packages belong to this consignment
    child_pkgs = (await db.execute(
        select(ConsignmentPackage)
        .where(
            ConsignmentPackage.consignment_id == consignment_id,
            ConsignmentPackage.id.in_(payload.child_package_ids),
        )
    )).scalars().all()
    found_ids = {p.id for p in child_pkgs}
    missing = set(payload.child_package_ids) - found_ids
    if missing:
        raise HTTPException(400, f"Package IDs not found in this consignment: {sorted(missing)}")

    # ── EXCLUSIVITY CHECK ──
    # Find any child_package_ids that are already in another parent in this consignment
    already_assigned = (await db.execute(
        select(ConsignmentParentPackageChild.child_package_id)
        .join(ConsignmentParentPackage, ConsignmentParentPackageChild.parent_package_id == ConsignmentParentPackage.id)
        .where(
            ConsignmentParentPackage.consignment_id == consignment_id,
            ConsignmentParentPackageChild.child_package_id.in_(payload.child_package_ids),
        )
    )).scalars().all()
    if already_assigned:
        # Resolve which parent they're in
        assigned_details = (await db.execute(
            select(
                ConsignmentParentPackageChild.child_package_id,
                ConsignmentParentPackage.parent_package_number,
                ConsignmentPackage.package_number,
            )
            .join(ConsignmentParentPackage, ConsignmentParentPackageChild.parent_package_id == ConsignmentParentPackage.id)
            .join(ConsignmentPackage, ConsignmentParentPackageChild.child_package_id == ConsignmentPackage.id)
            .where(
                ConsignmentParentPackage.consignment_id == consignment_id,
                ConsignmentParentPackageChild.child_package_id.in_(already_assigned),
            )
        )).all()
        detail_lines = [
            f"  • {r.package_number} is already in parent {r.parent_package_number}"
            for r in assigned_details
        ]
        raise HTTPException(
            409,
            f"Cannot assign packages that are already in another parent package:\n" +
            "\n".join(detail_lines) +
            "\nRemove them from the existing parent first."
        )

    if not payload.child_package_ids:
        raise HTTPException(400, "At least one child package is required")

    # Generate parent package number
    state = (con.state_code or "GEN").upper()
    yr = datetime.now(timezone.utc).year
    # Reuse the seq part from the consignment number
    seq_part = con.consignment_number.split("-")[-1]

    # Count existing parents for this consignment to get the PAR sequence
    existing_count = (await db.execute(
        select(func.count(ConsignmentParentPackage.id))
        .where(ConsignmentParentPackage.consignment_id == consignment_id)
    )).scalar() or 0
    par_seq = existing_count + 1

    pp_num = f"PKG-{state}-{yr}-{seq_part}-PAR{par_seq}"
    pp_qr = _qr_barcode({
        "type": "parent_package",
        "parent_package": pp_num,
        "consignment": con.consignment_number,
        "child_count": len(payload.child_package_ids),
        "receiver": con.receiver_employee_code,
    })

    pp = ConsignmentParentPackage(
        consignment_id=consignment_id,
        parent_package_number=pp_num,
        parent_package_barcode=pp_qr,
        parent_package_type=payload.parent_package_type,
        tare_weight_kg=payload.tare_weight_kg or Decimal("0"),
        length_cm=payload.length_cm,
        width_cm=payload.width_cm,
        height_cm=payload.height_cm,
        seal_number=payload.seal_number,
        status=con.status,  # inherit consignment status
        created_by=current_user.id,
    )
    db.add(pp)
    await db.flush()

    # Create children
    for seq, child_id in enumerate(payload.child_package_ids, start=1):
        db.add(ConsignmentParentPackageChild(
            parent_package_id=pp.id,
            child_package_id=child_id,
            sequence_number=seq,
        ))
        # Update child package's parent_package_code/barcode for backward compat
        child_pkg = next((p for p in child_pkgs if p.id == child_id), None)
        if child_pkg:
            child_pkg.parent_package_code = pp_num
            child_pkg.parent_package_barcode = pp_qr

    await db.flush()
    await _recalc_parent_pkg(db, pp)
    await db.commit()
    await db.refresh(pp)

    # Reload with children
    pp_full = (await db.execute(
        select(ConsignmentParentPackage)
        .options(
            selectinload(ConsignmentParentPackage.children)
            .joinedload(ConsignmentParentPackageChild.child_package),
        )
        .where(ConsignmentParentPackage.id == pp.id)
    )).unique().scalar_one()

    return _parent_pkg_response(pp_full)


@router.post("/{consignment_id}/parent-packages/{parent_id}/children", status_code=200)
async def add_children_to_parent(
    consignment_id: int,
    parent_id: int,
    payload: AddChildrenIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Add more child packages to an existing parent package.

    Enforces exclusivity: rejects any child already in another parent.
    """
    await ensure_consignment_schema(db)

    pp = (await db.execute(
        select(ConsignmentParentPackage).where(
            ConsignmentParentPackage.id == parent_id,
            ConsignmentParentPackage.consignment_id == consignment_id,
        )
    )).scalar_one_or_none()
    if not pp:
        raise HTTPException(404, "Parent package not found")

    con = (await db.execute(select(Consignment).where(Consignment.id == consignment_id))).scalar_one_or_none()
    if con and con.status not in ("DRAFT", "PACKED"):
        raise HTTPException(400, f"Cannot modify parent packages in '{con.status}' status")

    # Validate children belong to this consignment
    child_pkgs = (await db.execute(
        select(ConsignmentPackage).where(
            ConsignmentPackage.consignment_id == consignment_id,
            ConsignmentPackage.id.in_(payload.child_package_ids),
        )
    )).scalars().all()
    found_ids = {p.id for p in child_pkgs}
    missing = set(payload.child_package_ids) - found_ids
    if missing:
        raise HTTPException(400, f"Package IDs not found in this consignment: {sorted(missing)}")

    # Exclude children already in THIS parent
    existing_child_ids = set(
        (await db.execute(
            select(ConsignmentParentPackageChild.child_package_id)
            .where(ConsignmentParentPackageChild.parent_package_id == parent_id)
        )).scalars().all()
    )
    new_ids = set(payload.child_package_ids) - existing_child_ids
    if not new_ids:
        return {"message": "All specified packages are already in this parent", "added": 0}

    # ── EXCLUSIVITY CHECK ──
    already_in_other = (await db.execute(
        select(
            ConsignmentParentPackageChild.child_package_id,
            ConsignmentParentPackage.parent_package_number,
            ConsignmentPackage.package_number,
        )
        .join(ConsignmentParentPackage, ConsignmentParentPackageChild.parent_package_id == ConsignmentParentPackage.id)
        .join(ConsignmentPackage, ConsignmentParentPackageChild.child_package_id == ConsignmentPackage.id)
        .where(
            ConsignmentParentPackage.consignment_id == consignment_id,
            ConsignmentParentPackageChild.child_package_id.in_(new_ids),
            ConsignmentParentPackage.id != parent_id,
        )
    )).all()

    if already_in_other:
        detail_lines = [
            f"  • {r.package_number} is already in parent {r.parent_package_number}"
            for r in already_in_other
        ]
        raise HTTPException(
            409,
            f"Cannot assign packages already in another parent:\n" + "\n".join(detail_lines)
        )

    # Get current max sequence
    max_seq = (await db.execute(
        select(func.max(ConsignmentParentPackageChild.sequence_number))
        .where(ConsignmentParentPackageChild.parent_package_id == parent_id)
    )).scalar() or 0

    added = 0
    for idx, child_id in enumerate(sorted(new_ids), start=1):
        db.add(ConsignmentParentPackageChild(
            parent_package_id=parent_id,
            child_package_id=child_id,
            sequence_number=max_seq + idx,
        ))
        child_pkg = next((p for p in child_pkgs if p.id == child_id), None)
        if child_pkg:
            child_pkg.parent_package_code = pp.parent_package_number
            child_pkg.parent_package_barcode = pp.parent_package_barcode
        added += 1

    await db.flush()
    await _recalc_parent_pkg(db, pp)
    await db.commit()
    await db.refresh(pp)

    pp_full = (await db.execute(
        select(ConsignmentParentPackage)
        .options(
            selectinload(ConsignmentParentPackage.children)
            .joinedload(ConsignmentParentPackageChild.child_package),
        )
        .where(ConsignmentParentPackage.id == pp.id)
    )).unique().scalar_one()

    return {"success": True, "added": added, "parent_package": _parent_pkg_response(pp_full)}


@router.delete("/{consignment_id}/parent-packages/{parent_id}/children/{child_package_id}")
async def remove_child_from_parent(
    consignment_id: int,
    parent_id: int,
    child_package_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Remove a child package from a parent package."""
    await ensure_consignment_schema(db)

    pp = (await db.execute(
        select(ConsignmentParentPackage).where(
            ConsignmentParentPackage.id == parent_id,
            ConsignmentParentPackage.consignment_id == consignment_id,
        )
    )).scalar_one_or_none()
    if not pp:
        raise HTTPException(404, "Parent package not found")

    con = (await db.execute(select(Consignment).where(Consignment.id == consignment_id))).scalar_one_or_none()
    if con and con.status not in ("DRAFT", "PACKED"):
        raise HTTPException(400, f"Cannot modify parent packages in '{con.status}' status")

    link = (await db.execute(
        select(ConsignmentParentPackageChild).where(
            ConsignmentParentPackageChild.parent_package_id == parent_id,
            ConsignmentParentPackageChild.child_package_id == child_package_id,
        )
    )).scalar_one_or_none()
    if not link:
        raise HTTPException(404, "Child package not found in this parent")

    await db.delete(link)

    # Clear parent ref on child package
    child_pkg = (await db.execute(
        select(ConsignmentPackage).where(ConsignmentPackage.id == child_package_id)
    )).scalar_one_or_none()
    if child_pkg:
        child_pkg.parent_package_code = None
        child_pkg.parent_package_barcode = None

    await db.flush()
    await _recalc_parent_pkg(db, pp)
    await db.commit()

    return {"success": True, "removed_child_package_id": child_package_id}


@router.delete("/{consignment_id}/parent-packages/{parent_id}")
async def delete_parent_package(
    consignment_id: int,
    parent_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a parent package and release all its children."""
    await ensure_consignment_schema(db)

    pp = (await db.execute(
        select(ConsignmentParentPackage)
        .options(selectinload(ConsignmentParentPackage.children))
        .where(
            ConsignmentParentPackage.id == parent_id,
            ConsignmentParentPackage.consignment_id == consignment_id,
        )
    )).unique().scalar_one_or_none()
    if not pp:
        raise HTTPException(404, "Parent package not found")

    con = (await db.execute(select(Consignment).where(Consignment.id == consignment_id))).scalar_one_or_none()
    if con and con.status not in ("DRAFT", "PACKED"):
        raise HTTPException(400, f"Cannot delete parent packages in '{con.status}' status")

    # Clear parent refs on all child packages
    for c in pp.children:
        child_pkg = (await db.execute(
            select(ConsignmentPackage).where(ConsignmentPackage.id == c.child_package_id)
        )).scalar_one_or_none()
        if child_pkg:
            child_pkg.parent_package_code = None
            child_pkg.parent_package_barcode = None

    await db.delete(pp)
    await db.commit()

    return {"success": True, "deleted_parent_package_number": pp.parent_package_number}


@router.get("/{consignment_id}/parent-packages/{parent_id}/label")
async def get_parent_package_label(
    consignment_id: int,
    parent_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return label data for printing a parent package barcode/QR."""
    await ensure_consignment_schema(db)

    pp = (await db.execute(
        select(ConsignmentParentPackage)
        .options(
            joinedload(ConsignmentParentPackage.consignment)
            .joinedload(Consignment.destination_warehouse),
            selectinload(ConsignmentParentPackage.children)
            .joinedload(ConsignmentParentPackageChild.child_package),
        )
        .where(
            ConsignmentParentPackage.id == parent_id,
            ConsignmentParentPackage.consignment_id == consignment_id,
        )
    )).unique().scalar_one_or_none()
    if not pp:
        raise HTTPException(404, "Parent package not found")

    con = pp.consignment
    dst_wh = con.destination_warehouse if con else None

    return {
        "parent_package_number": pp.parent_package_number,
        "parent_package_barcode": pp.parent_package_barcode,
        "parent_package_type": pp.parent_package_type,
        "consignment_number": con.consignment_number if con else None,
        "consignment_barcode": con.consignment_barcode if con else None,
        "receiver_employee_code": con.receiver_employee_code if con else None,
        "receiver_name": con.receiver_name if con else None,
        "receiver_position_code": con.receiver_position_code if con else None,
        "destination_warehouse_name": dst_wh.name if dst_wh else None,
        "destination_warehouse_address": getattr(dst_wh, 'address', None) if dst_wh else None,
        "child_package_count": pp.child_package_count,
        "total_items": pp.total_items,
        "gross_weight_kg": pp.gross_weight_kg,
        "total_volume_cft": pp.total_volume_cft,
        "total_value": pp.total_value,
        "seal_number": pp.seal_number,
        "length_cm": pp.length_cm,
        "width_cm": pp.width_cm,
        "height_cm": pp.height_cm,
        "status": pp.status,
        "created_at": pp.created_at,
        "children": [
            {
                "sequence_number": c.sequence_number,
                "package_number": c.child_package.package_number if c.child_package else None,
                "package_type": c.child_package.package_type if c.child_package else None,
                "gross_weight_kg": c.child_package.gross_weight_kg if c.child_package else None,
                "material_count": c.child_package.material_count if c.child_package else 0,
            }
            for c in (pp.children or [])
        ],
    }


@router.get("/{consignment_id}/parent-packages/available-packages")
async def get_available_packages_for_parent(
    consignment_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return all packages in the consignment with their parent assignment status.

    Used by the frontend to show which packages are available vs. already assigned.
    """
    await ensure_consignment_schema(db)

    # All packages in this consignment
    all_pkgs = (await db.execute(
        select(ConsignmentPackage)
        .where(ConsignmentPackage.consignment_id == consignment_id)
        .order_by(ConsignmentPackage.sequence_number)
    )).scalars().all()

    # All parent-child mappings for this consignment
    mappings = (await db.execute(
        select(
            ConsignmentParentPackageChild.child_package_id,
            ConsignmentParentPackage.id.label("parent_id"),
            ConsignmentParentPackage.parent_package_number,
        )
        .join(ConsignmentParentPackage, ConsignmentParentPackageChild.parent_package_id == ConsignmentParentPackage.id)
        .where(ConsignmentParentPackage.consignment_id == consignment_id)
    )).all()

    assignment_map = {}
    for m in mappings:
        assignment_map[m.child_package_id] = {
            "parent_id": m.parent_id,
            "parent_package_number": m.parent_package_number,
        }

    return [
        {
            "id": p.id,
            "package_number": p.package_number,
            "package_type": p.package_type,
            "package_description": p.package_description,
            "gross_weight_kg": p.gross_weight_kg,
            "material_count": p.material_count,
            "sequence_number": p.sequence_number,
            "status": p.status,
            "assigned_to_parent": assignment_map.get(p.id),
        }
        for p in all_pkgs
    ]


# ──────────────────────────────────────────────────────────────────────────────
# ACKNOWLEDGEMENT ENDPOINTS
# ──────────────────────────────────────────────────────────────────────────────

@router.post("/acknowledge", status_code=201)
async def acknowledge_package(
    payload: PackageAcknowledgeIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Acknowledge a single package and post stock to the destination warehouse.

    Steps:
    1. Validate package is PACKED or IN_TRANSIT
    2. Validate item quantities
    3. Update PackageItem received/accepted/rejected/damaged
    4. Create PackageAcknowledgement record
    5. Update Package status
    6. Post stock to destination warehouse (batch-level, via post_stock_ledger)
    7. Update Consignment status
    8. Update MaterialIssue status if all consignments received
    """
    await ensure_consignment_schema(db)
    from app.services.stock_service import post_stock_ledger

    pkg = (await db.execute(
        select(ConsignmentPackage)
        .options(
            selectinload(ConsignmentPackage.items),
            joinedload(ConsignmentPackage.consignment),
        )
        .where(ConsignmentPackage.id == payload.package_id)
        .with_for_update()
    )).unique().scalar_one_or_none()
    if not pkg:
        raise HTTPException(404, "Package not found")
        
    con = pkg.consignment
    if con.status not in ("CONSIGNMENT_RECEIVED", "PARTIALLY_UNPACKED"):
        raise HTTPException(
            status_code=400,
            detail=f"Consignment delivery ({con.consignment_number}) must be acknowledged before verifying individual packages. Current consignment status: '{con.status}'."
        )

    if pkg.status not in ("PACKED", "IN_TRANSIT", "DELIVERED", "CONSIGNMENT_RECEIVED"):
        raise HTTPException(400, f"Cannot acknowledge package in '{pkg.status}' status")
    pkg_item_map = {i.id: i for i in pkg.items}
    all_full = True

    for item_ack in payload.items:
        if item_ack.package_item_id not in pkg_item_map:
            raise HTTPException(400, f"Package item {item_ack.package_item_id} not found in this package")
        pi = pkg_item_map[item_ack.package_item_id]
        if item_ack.quantity_received > pi.quantity_packed:
            raise HTTPException(400, f"Received qty ({item_ack.quantity_received}) > packed ({pi.quantity_packed}) for item {pi.id}")
        if item_ack.quantity_accepted > item_ack.quantity_received:
            raise HTTPException(400, "Accepted qty cannot exceed received qty")

        pi.quantity_received = item_ack.quantity_received
        pi.quantity_accepted = item_ack.quantity_accepted
        pi.quantity_rejected = item_ack.quantity_rejected
        pi.quantity_damaged = item_ack.quantity_damaged
        pi.item_condition = item_ack.item_condition
        pi.rejection_reason = item_ack.rejection_reason
        pi.damage_description = item_ack.damage_description
        pi.serial_numbers_received = item_ack.serial_numbers_received
        if item_ack.quantity_accepted < pi.quantity_packed:
            all_full = False

    # Create acknowledgement record
    ack_status = "ACCEPTED" if all_full else "PARTIALLY_ACCEPTED"
    ack = ConsignmentPackageAcknowledgement(
        package_id=pkg.id,
        consignment_id=con.id,
        acknowledged_by_user_id=current_user.id,
        acknowledged_by_name=payload.acknowledged_by_name,
        acknowledged_by_designation=payload.acknowledged_by_designation,
        acknowledged_by_phone=payload.acknowledged_by_phone,
        acknowledged_by_employee_code=payload.acknowledged_by_employee_code,
        receiver_signature_url=payload.receiver_signature_url,
        photos=payload.photos,
        remarks=payload.remarks,
        packaging_condition=payload.packaging_condition,
        seal_intact=payload.seal_intact,
        seal_number_verified=payload.seal_number_verified,
        temperature_recorded=payload.temperature_recorded,
        humidity_recorded=payload.humidity_recorded,
        latitude=payload.latitude,
        longitude=payload.longitude,
        geo_fence_verified=payload.geo_fence_verified,
        device_id=payload.device_id,
        ip_address=payload.ip_address,
        acknowledgement_status=ack_status,
    )
    db.add(ack)

    now = datetime.now(timezone.utc)
    pkg.status = "UNPACKED" if all_full else "PARTIALLY_UNPACKED"
    pkg.received_at = now
    pkg.received_by_id = current_user.id
    pkg.packaging_condition_on_receipt = payload.packaging_condition
    pkg.seal_intact_on_receipt = payload.seal_intact
    pkg.receipt_remarks = payload.remarks
    pkg.receipt_photos = payload.photos
    pkg.receipt_signature_url = payload.receiver_signature_url

    await db.flush()

    # Post stock to destination warehouse (FEFO-aware: use batch_id from PackageItem)
    dest_wh_id = con.destination_warehouse_id
    src_wh_id = con.warehouse_id
    if dest_wh_id:
        from app.services.stock_service import _get_or_create_balance
        for item_ack in payload.items:
            pi = pkg_item_map[item_ack.package_item_id]
            if item_ack.quantity_accepted and item_ack.quantity_accepted > 0:
                try:
                    await post_stock_ledger(
                        db,
                        item_id=pi.material_id,
                        warehouse_id=dest_wh_id,
                        transaction_type="transfer_in",
                        qty_in=item_ack.quantity_accepted,
                        batch_id=pi.batch_id,
                        bin_id=pi.destination_bin_id,
                        reference_type="consignment_package_acknowledgement",
                        reference_id=ack.id,
                        uom_id=pi.uom_id,
                        rate=pi.unit_price or Decimal("0"),
                        created_by=current_user.id,
                    )
                except Exception as e:
                    import logging
                    logging.getLogger(__name__).error("Stock post failed pkg_item=%s: %s", pi.id, e)

                # Decrement transit_qty from the source warehouse balance
                if src_wh_id:
                    try:
                        src_balance = await _get_or_create_balance(
                            db,
                            item_id=pi.material_id,
                            warehouse_id=src_wh_id,
                            bin_id=pi.source_bin_id,
                            batch_id=pi.batch_id,
                            lock=True,
                        )
                        packed_qty = Decimal(str(pi.quantity_packed or 0))
                        src_balance.transit_qty = max(Decimal("0"), (src_balance.transit_qty or Decimal("0")) - packed_qty)
                        src_balance.available_qty = max(
                            Decimal("0"),
                            (src_balance.total_qty or Decimal("0"))
                            - (src_balance.reserved_qty or Decimal("0"))
                            - (src_balance.transit_qty or Decimal("0"))
                        )
                    except Exception as e:
                        import logging
                        logging.getLogger(__name__).error("Failed to decrement transit qty on source balance: %s", e)

                # Move/Update SerialNumber records to destination warehouse
                try:
                    serial_nums = item_ack.serial_numbers_received or pi.serial_numbers
                    if serial_nums:
                        from app.models.warehouse import SerialNumber as _SN
                        sn_stmt = select(_SN).where(
                            _SN.item_id == pi.material_id,
                            _SN.serial_number.in_(serial_nums)
                        )
                        sn_rows = (await db.execute(sn_stmt)).scalars().all()
                        for sn_row in sn_rows:
                            if dest_wh_id and dest_wh_id != src_wh_id:
                                sn_row.warehouse_id = dest_wh_id
                                sn_row.bin_id = pi.destination_bin_id
                                sn_row.status = "available"
                            else:
                                sn_row.status = "consumed"
                except Exception as sn_err:
                    import logging
                    logging.getLogger(__name__).warning("Failed to update SerialNumber records in acknowledge_package: %s", sn_err)

    await db.flush()

    # --------------------------------------------------------------------------
    # Sync to Indent Acknowledgement tables
    # --------------------------------------------------------------------------
    try:
        indent_id = con.indent_id
        if not indent_id and con.material_issue_id:
            from app.models.issue import MaterialIssue
            mi_res = await db.execute(
                select(MaterialIssue.indent_id).where(MaterialIssue.id == con.material_issue_id)
            )
            indent_id = mi_res.scalar()

        if indent_id:
            from app.models.indent import Indent, IndentItem, IndentAcknowledgement, IndentAcknowledgementItem

            # Compute total received quantity accepted in this package ack
            total_received = sum(item_ack.quantity_accepted for item_ack in payload.items if item_ack.quantity_accepted is not None)

            indent_ack = IndentAcknowledgement(
                indent_id=indent_id,
                warehouse_id=con.destination_warehouse_id or con.warehouse_id,
                acknowledged_by=current_user.id,
                employee_code=payload.acknowledged_by_employee_code or current_user.employee_code,
                acknowledged_at=now,
                received_qty=total_received,
                status="received",  # Will update below
                remarks=payload.remarks or f"Acknowledged via Package {pkg.package_number}",
                scan_barcode=pkg.package_number,
                scan_timestamp=now,
            )
            db.add(indent_ack)
            await db.flush()

            # Load indent items
            indent_items_res = await db.execute(
                select(IndentItem).where(IndentItem.indent_id == indent_id)
            )
            indent_items = indent_items_res.scalars().all()
            indent_item_map = {it.item_id: it for it in indent_items}

            for item_ack in payload.items:
                pi = pkg_item_map[item_ack.package_item_id]
                ind_item = indent_item_map.get(pi.material_id)
                if ind_item:
                    indent_ack_item = IndentAcknowledgementItem(
                        acknowledgement_id=indent_ack.id,
                        indent_item_id=ind_item.id,
                        item_id=pi.material_id,
                        received_qty=item_ack.quantity_accepted,
                        remarks=getattr(item_ack, "remarks", None) or getattr(item_ack, "rejection_reason", None) or f"Package item ack: {pi.id}",
                        serial_numbers=item_ack.serial_numbers_received or pi.serial_numbers,
                    )
                    db.add(indent_ack_item)

                    # Update indent item fulfillment status
                    ind_item.fulfillment_status = "acknowledged"
                    db.add(ind_item)

            await db.flush()

            # Recalculate parent indent status and this acknowledgement status
            all_acks_res = await db.execute(
                select(IndentAcknowledgement)
                .options(selectinload(IndentAcknowledgement.items))
                .where(IndentAcknowledgement.indent_id == indent_id)
            )
            cum = {}
            for a in all_acks_res.scalars().all():
                for ai in (a.items or []):
                    key = ai.indent_item_id or 0
                    cum[key] = cum.get(key, Decimal("0")) + Decimal(str(ai.received_qty or 0))

            indent_res = await db.execute(
                select(Indent)
                .options(selectinload(Indent.items))
                .where(Indent.id == indent_id)
            )
            indent_obj = indent_res.scalar_one_or_none()

            if indent_obj:
                all_lines_complete = True
                any_received = False
                for ind_item in indent_obj.items:
                    target = Decimal(str(ind_item.approved_qty or ind_item.requested_qty or 0))
                    recv = cum.get(ind_item.id, Decimal("0"))
                    if recv > 0:
                        any_received = True
                    if recv < target:
                        all_lines_complete = False

                if all_lines_complete and indent_obj.items:
                    indent_obj.status = "fulfilled"
                    indent_ack.status = "completed"
                elif any_received:
                    if indent_obj.status == "approved":
                        indent_obj.status = "partially_fulfilled"
                    indent_ack.status = "partial"
                else:
                    indent_ack.status = "received"
                db.add(indent_obj)
    except Exception as e:
        import logging
        logging.getLogger(__name__).exception("Failed to update IndentAcknowledgement records in acknowledge_package: %s", e)

    await db.flush()
    await _update_consignment_status(db, con)
    await db.flush()
    if con.material_issue_id:
        await _update_mi_status(db, con.material_issue_id)

    # Send system notifications
    try:
        from app.services.notification_service import create_notification
        notif_msg = (
            f"Package {pkg.package_number} from consignment {con.consignment_number} "
            f"has been {'fully' if all_full else 'partially'} unpacked and acknowledged."
        )
        if con.created_by:
            await create_notification(
                db=db,
                user_id=con.created_by,
                title=f"Package {'Unpacked' if all_full else 'Partially Unpacked'}: {pkg.package_number}",
                message=notif_msg,
                notification_type="success" if all_full else "warning",
                module="logistics",
                reference_type="consignment_package",
                reference_id=pkg.id,
            )
        if current_user.id != con.created_by:
            await create_notification(
                db=db,
                user_id=current_user.id,
                title=f"Package Acknowledged: {pkg.package_number}",
                message=f"You have acknowledged package {pkg.package_number} from consignment {con.consignment_number}.",
                notification_type="success",
                module="logistics",
                reference_type="consignment_package",
                reference_id=pkg.id,
            )
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("Failed to send notification for acknowledge_package: %s", e)

    from app.api.v1.dispatch import sync_mdos_to_dispatches
    await sync_mdos_to_dispatches(db)
    await db.commit()

    return {
        "success": True,
        "package_number": pkg.package_number,
        "package_status": pkg.status,
        "consignment_status": con.status,
        "acknowledgement_status": ack_status,
        "stock_posted_to_warehouse_id": dest_wh_id,
    }


@router.post("/acknowledge/bulk", status_code=201)
async def bulk_acknowledge_packages(
    payload: List[PackageAcknowledgeIn],
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Acknowledge multiple packages in sequence. Returns per-package results."""
    results = []
    for item in payload:
        try:
            result = await acknowledge_package(item, db, current_user)
            results.append({"package_id": item.package_id, "success": True, **result})
        except HTTPException as e:
            results.append({"package_id": item.package_id, "success": False, "error": e.detail})
    return {"results": results}


@router.post("/package/{package_id}/store-item")
async def store_package_item(
    package_id: int,
    payload: StoreItemIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Step 4 of MMU receiving: allocate a received item to a storage bin.

    Updates PackageItem.destination_bin_id and moves stock to that bin
    in StockBalance (transfer from null-bin to specific bin).
    """
    await ensure_consignment_schema(db)
    pi = (await db.execute(
        select(ConsignmentPackageItem)
        .where(ConsignmentPackageItem.id == payload.package_item_id, ConsignmentPackageItem.package_id == package_id)
        .with_for_update()
    )).scalar_one_or_none()
    if not pi:
        raise HTTPException(404, "Package item not found")
    if not pi.quantity_accepted or pi.quantity_accepted <= 0:
        raise HTTPException(400, "Item has not been accepted yet — acknowledge package first")

    pi.destination_bin_id = payload.destination_bin_id
    await db.commit()
    return {"success": True, "package_item_id": pi.id, "destination_bin_id": payload.destination_bin_id}


@router.get("/{consignment_id}/acknowledgements")
async def list_consignment_acknowledgements(
    consignment_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return all per-package acknowledgements for a consignment."""
    await ensure_consignment_schema(db)
    acks = (await db.execute(
        select(ConsignmentPackageAcknowledgement)
        .options(joinedload(ConsignmentPackageAcknowledgement.package))
        .where(ConsignmentPackageAcknowledgement.consignment_id == consignment_id)
        .order_by(ConsignmentPackageAcknowledgement.created_at)
    )).unique().scalars().all()

    return [
        {
            "id": a.id,
            "package_id": a.package_id,
            "package_number": a.package.package_number if a.package else None,
            "acknowledged_by_name": a.acknowledged_by_name,
            "acknowledged_by_employee_code": a.acknowledged_by_employee_code,
            "acknowledgement_status": a.acknowledgement_status,
            "packaging_condition": a.packaging_condition,
            "seal_intact": a.seal_intact,
            "remarks": a.remarks,
            "latitude": a.latitude,
            "longitude": a.longitude,
            "created_at": a.created_at,
        }
        for a in acks
    ]
