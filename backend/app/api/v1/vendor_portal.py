"""Supplier (material vendor) portal API.

Suppliers can:
  - List MaterialRequests where they have been invited (have a draft/submitted Quotation)
  - Submit or update their Quotation (item-level pricing)
  - Decline an RFQ

This mirrors carrier_portal.py but wires into the procurement module instead of logistics.
"""
from datetime import datetime, time, timezone, date
from decimal import Decimal
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models.vendor_portal import VendorUser
from app.models.procurement import (
    MaterialRequest, MaterialRequestItem,
    Quotation, QuotationItem,
    PurchaseOrder, PurchaseOrderItem,
)
from app.models.system import ActivityLog
from app.schemas.vendor_auth import SupplierQuoteSubmit, SupplierDeclineRfq
from app.utils.dependencies import get_current_vendor_user

router = APIRouter()


def _can_modify_quotation(q: Quotation) -> bool:
    """Supplier can edit a quotation only when it's in draft or submitted state."""
    return q.status in ("draft", "submitted")


@router.get("/rfqs")
async def supplier_list_rfqs(
    db: AsyncSession = Depends(get_db),
    current_vendor: VendorUser = Depends(get_current_vendor_user),
):
    """List all RFQs where this supplier has been invited (has a Quotation record).
    
    Suppliers ONLY see RFQs where their vendor_id has a Quotation. They never
    see other vendors' quotes or pricing. RFQs can be both MR-linked and standalone.
    """
    vendor_id = current_vendor.vendor_id

    # Fetch all quotations for this vendor with their parent MR (if any)
    res = await db.execute(
        select(Quotation)
        .where(Quotation.vendor_id == vendor_id)
        .options(
            selectinload(Quotation.rfq),
            selectinload(Quotation.material_request).selectinload(MaterialRequest.items)
                .selectinload(MaterialRequestItem.item),
            selectinload(Quotation.material_request).selectinload(MaterialRequest.items)
                .selectinload(MaterialRequestItem.uom),
            selectinload(Quotation.items).selectinload(QuotationItem.item),
            selectinload(Quotation.items).selectinload(QuotationItem.uom),
        )
        .order_by(Quotation.id.desc())
    )
    quotations = res.scalars().unique().all()

    output = []
    for q in quotations:
        mr = q.material_request
        
        # Build MR items for display (from MR if linked, else use Q items as template)
        mr_items = []
        if mr:
            for mi in (mr.items or []):
                mr_items.append({
                    "id": mi.id,
                    "item_id": mi.item_id,
                    "item_name": mi.item.name if mi.item else None,
                    "item_code": mi.item.item_code if mi.item else None,
                    "qty": float(mi.qty or 0),
                    "uom_id": mi.uom_id,
                    "uom": mi.uom.name if mi.uom else None,
                    "remarks": mi.remarks,
                })
        else:
            # For standalone RFQs without MR, build items from quotation items
            for qi in (q.items or []):
                mr_items.append({
                    "id": qi.id,
                    "item_id": qi.item_id,
                    "item_name": qi.item.name if qi.item else None,
                    "item_code": qi.item.item_code if qi.item else None,
                    "qty": float(qi.qty or 0),
                    "uom_id": qi.uom_id,
                    "uom": qi.uom.name if qi.uom else None,
                    "remarks": qi.remarks,
                })

        # Build existing quote items (what the supplier has already filled in)
        quote_items = []
        for qi in (q.items or []):
            quote_items.append({
                "id": qi.id,
                "item_id": qi.item_id,
                "item_name": qi.item.name if qi.item else None,
                "item_code": qi.item.item_code if qi.item else None,
                "qty": float(qi.qty or 0),
                "uom_id": qi.uom_id,
                "uom": qi.uom.name if qi.uom else None,
                "rate": float(qi.rate or 0),
                "discount_pct": float(qi.discount_pct or 0),
                "tax_rate": float(qi.tax_rate or 0),
                "cgst_rate": float(qi.cgst_rate or 0),
                "sgst_rate": float(qi.sgst_rate or 0),
                "igst_rate": float(qi.igst_rate or 0),
                "amount": float(qi.amount or 0),
                "expected_delivery": qi.expected_delivery.strftime("%Y-%m-%d") if qi.expected_delivery else None,
                "remarks": qi.remarks,
            })

        my_quote = None
        if q.status not in ("draft",) or quote_items:
            my_quote = {
                "id": q.id,
                "quotation_number": q.quotation_number,
                "rfq_number": q.rfq_number or q.quotation_number,
                "status": q.status,
                "total_amount": float(q.total_amount or 0),
                "cgst_amount": float(q.cgst_amount or 0),
                "sgst_amount": float(q.sgst_amount or 0),
                "igst_amount": float(q.igst_amount or 0),
                "tax_amount": float(q.tax_amount or 0),
                "grand_total": float(q.grand_total or 0),
                "delivery_days": q.delivery_days,
                "payment_terms": q.payment_terms,
                "with_vehicle": q.with_vehicle,
                "vehicle_cost": float(q.vehicle_cost or 0),
                "valid_until": q.valid_until,
                "remarks": q.remarks,
                "terms_url": q.terms_url,
                "items": quote_items,
            } if quote_items else None

        output.append({
            "id": q.id,
            "mr_id": mr.id if mr else None,
            "mr_number": mr.mr_number if mr else None,
            "rfq_no": q.rfq_number or q.quotation_number,
            "department": mr.department if mr else None,
            "priority": "critical" if mr and mr.priority == "urgent" else (mr.priority if mr else None),
            "required_date": mr.required_date if mr else None,
            "request_date": mr.request_date if mr else None,
            "status": mr.status if mr else q.status,
            "remarks": mr.remarks if mr else q.remarks,
            "with_vehicle": q.with_vehicle,
            "items": mr_items,
            "quotation_id": q.id,
            "rfq_number": q.rfq_number or q.quotation_number,
            "quotation_status": q.status,
            "terms_url": q.terms_url,
            "my_quote": my_quote,
            "can_edit": _can_modify_quotation(q),
            "rfq_with_vehicle": q.rfq.with_vehicle if q.rfq else False,
        })

    return output


@router.post("/rfqs/{quotation_id}/quote")
async def supplier_submit_or_update_quote(
    quotation_id: int,
    payload: SupplierQuoteSubmit,
    db: AsyncSession = Depends(get_db),
    current_vendor: VendorUser = Depends(get_current_vendor_user),
):
    """Supplier submits or updates their quotation for an RFQ."""
    vendor_id = current_vendor.vendor_id

    # Find existing quotation by its ID and vendor
    res_q = await db.execute(
        select(Quotation)
        .where(Quotation.id == quotation_id, Quotation.vendor_id == vendor_id)
        .options(
            selectinload(Quotation.items),
            selectinload(Quotation.material_request)
        )
    )
    existing = res_q.scalar_one_or_none()

    if not existing:
        raise HTTPException(
            403,
            "You have not been invited to quote on this RFQ. "
            "Please contact the procurement team."
        )

    if not _can_modify_quotation(existing):
        raise HTTPException(
            400,
            f"This quotation is in '{existing.status}' status and cannot be modified."
        )

    if not payload.items:
        raise HTTPException(422, "At least one item is required in the quotation")

    # Check vendor once
    from app.models.master import Vendor as _Vendor
    vendor_row = (await db.execute(select(_Vendor).where(_Vendor.id == vendor_id))).scalar_one_or_none()
    has_gstin = bool((getattr(vendor_row, "gst_number", None) or "").strip()) if vendor_row else False

    # Compute totals
    total_amount = Decimal("0")
    total_cgst = Decimal("0")
    total_sgst = Decimal("0")
    total_igst = Decimal("0")
    total_tax = Decimal("0")

    new_items_data = []
    for item_in in payload.items:
        base = item_in.qty * item_in.rate
        discount = base * (item_in.discount_pct or 0) / Decimal("100")
        net = base - discount

        cgst_rate = Decimal(str(item_in.cgst_rate or 0))
        sgst_rate = Decimal(str(item_in.sgst_rate or 0))
        igst_rate = Decimal(str(item_in.igst_rate or 0))
        tax_rate = Decimal(str(item_in.tax_rate or 0))

        if cgst_rate == 0 and sgst_rate == 0 and igst_rate == 0 and tax_rate > 0:
            if has_gstin:
                cgst_rate = tax_rate / Decimal("2")
                sgst_rate = tax_rate / Decimal("2")
            else:
                igst_rate = tax_rate
        else:
            tax_rate = cgst_rate + sgst_rate + igst_rate

        cgst = net * cgst_rate / Decimal("100")
        sgst = net * sgst_rate / Decimal("100")
        igst = net * igst_rate / Decimal("100")
        item_tax = cgst + sgst + igst
        amount = net + item_tax

        new_items_data.append({
            "item_id": item_in.item_id,
            "qty": item_in.qty,
            "uom_id": item_in.uom_id,
            "rate": item_in.rate,
            "discount_pct": item_in.discount_pct or 0,
            "tax_rate": tax_rate,
            "cgst_rate": cgst_rate,
            "sgst_rate": sgst_rate,
            "igst_rate": igst_rate,
            "amount": amount,
            "expected_delivery": (
                datetime.combine(item_in.expected_delivery, time.min).replace(tzinfo=timezone.utc)
                if item_in.expected_delivery else None
            ),
            "remarks": item_in.remarks,
        })
        total_amount += net
        total_cgst += cgst
        total_sgst += sgst
        total_igst += igst
        total_tax += item_tax

    # Update header
    existing.delivery_days = payload.delivery_days
    existing.payment_terms = payload.payment_terms
    existing.valid_until = (
        datetime.combine(payload.valid_until, time.max).replace(tzinfo=timezone.utc)
        if payload.valid_until else None
    )
    existing.remarks = payload.remarks
    existing.subtotal = total_amount
    existing.total_amount = total_amount
    existing.cgst_amount = total_cgst
    existing.sgst_amount = total_sgst
    existing.igst_amount = total_igst
    existing.tax_amount = total_tax
    existing.with_vehicle = payload.with_vehicle or False
    existing.vehicle_cost = payload.vehicle_cost or Decimal("0")
    
    if existing.with_vehicle:
        grand_total = total_amount + total_tax + existing.vehicle_cost
    else:
        grand_total = total_amount + total_tax
        
    if not existing.quotation_number:
        from app.services.number_series import generate_number
        existing.quotation_number = await generate_number(db, "procurement", "quotation", pad_length=7)
    existing.grand_total = grand_total
    existing.status = "submitted"
    existing.quotation_date = datetime.now(timezone.utc)

    # Replace items (delete old, insert new)
    for old_item in existing.items:
        await db.delete(old_item)
    await db.flush()

    for item_data in new_items_data:
        qi = QuotationItem(
            quotation_id=existing.id,
            **item_data,
        )
        db.add(qi)

    # Notify procurement team
    mr = existing.material_request
    mr_number_text = f" for MR {mr.mr_number}" if mr else " for standalone RFQ"
    db.add(ActivityLog(
        user_id=None,
        module="procurement",
        action="supplier_submit_quote",
        entity_type="quotation",
        entity_id=existing.id,
        description=(
            f"Supplier user {current_vendor.username} submitted/updated quotation "
            f"{existing.quotation_number}{mr_number_text}. "
            f"Grand total: ₹{float(grand_total):,.2f}."
        ),
    ))

    await db.commit()
    return {
        "message": "Quotation submitted successfully",
        "quotation_id": existing.id,
        "quotation_number": existing.quotation_number,
        "grand_total": float(grand_total),
    }


@router.post("/rfqs/{quotation_id}/decline")
async def supplier_decline_rfq(
    quotation_id: int,
    payload: SupplierDeclineRfq,
    db: AsyncSession = Depends(get_db),
    current_vendor: VendorUser = Depends(get_current_vendor_user),
):
    """Supplier declines to quote on this RFQ."""
    vendor_id = current_vendor.vendor_id

    res_q = await db.execute(
        select(Quotation).where(Quotation.id == quotation_id, Quotation.vendor_id == vendor_id)
    )
    q = res_q.scalar_one_or_none()
    if not q:
        raise HTTPException(404, "Quotation invitation not found")

    q.status = "rejected"
    q.remarks = f"[DECLINED BY SUPPLIER] {payload.reason or 'No reason given'}"

    db.add(ActivityLog(
        user_id=None,
        module="procurement",
        action="supplier_decline_rfq",
        entity_type="quotation",
        entity_id=q.id,
        description=(
            f"Supplier {current_vendor.username} declined RFQ {q.rfq_number}. "
            f"Reason: {payload.reason}"
        ),
    ))

    await db.commit()
    return {"success": True, "message": "RFQ declined"}


# ─── SUPPLIER PURCHASE ORDERS ENDPOINTS ───
from pydantic import BaseModel
from typing import Optional

@router.get("/purchase-orders", response_model=dict)
async def supplier_list_purchase_orders(
    db: AsyncSession = Depends(get_db),
    current_vendor: VendorUser = Depends(get_current_vendor_user),
):
    """List all approved or active Purchase Orders for the supplier."""
    vendor_id = current_vendor.vendor_id
    res = await db.execute(
        select(PurchaseOrder)
        .options(
            selectinload(PurchaseOrder.warehouse),
        )
        .where(
            PurchaseOrder.vendor_id == vendor_id,
            PurchaseOrder.is_current == True,
            PurchaseOrder.status.in_(("approved", "accepted", "rejected", "partially_received", "received", "closed", "cancelled"))
        )
        .order_by(PurchaseOrder.id.desc())
    )
    pos = res.scalars().all()

    def _po_to_dict(po, is_history: bool = False):
        return {
            "id": po.id,
            "po_number": po.po_number,
            "po_date": po.po_date.isoformat() if po.po_date else None,
            "expected_delivery_date": po.expected_delivery_date.isoformat() if po.expected_delivery_date else None,
            "subtotal": float(po.subtotal or 0),
            "discount_amount": float(po.discount_amount or 0),
            "tax_amount": float(po.tax_amount or 0),
            "grand_total": float(po.grand_total or 0),
            "status": po.status,
            "supplier_acknowledgement": po.supplier_acknowledgement or "pending",
            "supplier_delivery_date": po.supplier_delivery_date.isoformat() if po.supplier_delivery_date else None,
            "remarks": po.remarks,
            "warehouse_name": po.warehouse.name if po.warehouse else None,
            "version_number": po.version_number,
            "base_po_number": po.base_po_number,
            "is_history_row": is_history,
        }

    # Batch-load historical versions (is_current=False) so we can nest them as tree children.
    base_numbers = list({po.base_po_number for po in pos if po.base_po_number})
    history_map: dict[str, list] = {}
    if base_numbers:
        hist_res = await db.execute(
            select(PurchaseOrder)
            .options(selectinload(PurchaseOrder.warehouse))
            .where(
                PurchaseOrder.vendor_id == vendor_id,
                PurchaseOrder.base_po_number.in_(base_numbers),
                PurchaseOrder.is_current == False,  # noqa: E712
            )
            .order_by(PurchaseOrder.version_number.desc())
        )
        for hist_po in hist_res.scalars().all():
            key = hist_po.base_po_number
            if key not in history_map:
                history_map[key] = []
            history_map[key].append(_po_to_dict(hist_po, is_history=True))

    items_list = []
    for po in pos:
        row = _po_to_dict(po, is_history=False)
        if po.base_po_number and po.base_po_number in history_map:
            row["children"] = history_map[po.base_po_number]
        items_list.append(row)

    return {"items": items_list, "total": len(items_list)}


@router.get("/purchase-orders/{po_id}", response_model=dict)
async def supplier_get_purchase_order(
    po_id: int,
    db: AsyncSession = Depends(get_db),
    current_vendor: VendorUser = Depends(get_current_vendor_user),
):
    """Fetch details of a specific Purchase Order, including its line items."""
    vendor_id = current_vendor.vendor_id
    res = await db.execute(
        select(PurchaseOrder)
        .options(
            selectinload(PurchaseOrder.items).selectinload(PurchaseOrderItem.item),
            selectinload(PurchaseOrder.items).selectinload(PurchaseOrderItem.uom),
            selectinload(PurchaseOrder.warehouse),
        )
        .where(
            PurchaseOrder.id == po_id,
            PurchaseOrder.vendor_id == vendor_id
        )
    )
    po = res.scalar_one_or_none()
    if not po:
        raise HTTPException(404, "Purchase Order not found")
        
    items_list = []
    for poi in po.items:
        items_list.append({
            "id": poi.id,
            "item_id": poi.item_id,
            "item_code": poi.item.item_code if poi.item else None,
            "item_name": poi.item.name if poi.item else None,
            "qty": float(poi.qty or 0),
            "received_qty": float(poi.received_qty or 0),
            "uom_name": poi.uom.name if poi.uom else None,
            "rate": float(poi.rate or 0),
            "discount_pct": float(poi.discount_pct or 0),
            "cgst_rate": float(poi.cgst_rate or 0),
            "sgst_rate": float(poi.sgst_rate or 0),
            "igst_rate": float(poi.igst_rate or 0),
            "tax_amount": float(poi.tax_amount or 0),
            "amount": float(poi.amount or 0),
        })
        
    # Load comparison details for amendments
    comparison = None
    if po.parent_po_id:
        parent_result = await db.execute(
            select(PurchaseOrder)
            .options(selectinload(PurchaseOrder.items))
            .where(PurchaseOrder.id == po.parent_po_id)
        )
        parent_po = parent_result.scalar_one_or_none()
        if parent_po:
            curr_items = {item.item_id: item for item in po.items}
            par_items = {item.item_id: item for item in parent_po.items}

            modified_items = {}
            added_item_ids = []
            removed_items = []

            for item_id, c_item in curr_items.items():
                if item_id not in par_items:
                    added_item_ids.append(item_id)
                else:
                    p_item = par_items[item_id]
                    if c_item.qty != p_item.qty or c_item.rate != p_item.rate:
                        modified_items[item_id] = {
                            "old_qty": float(p_item.qty or 0),
                            "old_rate": float(p_item.rate or 0)
                        }

            for item_id, p_item in par_items.items():
                if item_id not in curr_items:
                    removed_items.append({
                        "item_id": item_id,
                        "qty": float(p_item.qty or 0),
                        "rate": float(p_item.rate or 0),
                    })

            comparison = {
                "has_parent": True,
                "parent_version": parent_po.version_number,
                "modified_items": {str(k): v for k, v in modified_items.items()},
                "added_item_ids": added_item_ids,
                "removed_items": removed_items
            }

    return {
        "id": po.id,
        "po_number": po.po_number,
        "po_date": po.po_date.isoformat() if po.po_date else None,
        "expected_delivery_date": po.expected_delivery_date.isoformat() if po.expected_delivery_date else None,
        "subtotal": float(po.subtotal or 0),
        "discount_amount": float(po.discount_amount or 0),
        "tax_amount": float(po.tax_amount or 0),
        "grand_total": float(po.grand_total or 0),
        "status": po.status,
        "supplier_acknowledgement": po.supplier_acknowledgement or "pending",
        "remarks": po.remarks,
        "billing_address": po.billing_address,
        "shipping_address": po.shipping_address,
        "warehouse_name": po.warehouse.name if po.warehouse else None,
        "version_number": po.version_number,
        "supplier_delivery_date": po.supplier_delivery_date.isoformat() if po.supplier_delivery_date else None,
        "items": items_list,
        "comparison": comparison,
    }


from typing import List, Optional

class SupplierAcknowledgeItem(BaseModel):
    item_id: int
    rate: Decimal
    discount_pct: Decimal = Decimal("0")
    # BUG-SUPPLIER-RATE fix: supplier can set tax rates when procurement left them blank
    cgst_rate: Optional[Decimal] = None
    sgst_rate: Optional[Decimal] = None
    igst_rate: Optional[Decimal] = None


from pydantic import field_validator

class SupplierAcknowledgePO(BaseModel):
    action: str  # "accept" or "reject"
    remarks: Optional[str] = None
    delivery_date: Optional[date] = None
    items: Optional[List[SupplierAcknowledgeItem]] = None

    @field_validator("delivery_date")
    @classmethod
    def validate_delivery_date(cls, v):
        if v is not None and v < date.today():
            raise ValueError("Delivery date cannot be in the past")
        return v


@router.post("/purchase-orders/{po_id}/acknowledge", response_model=dict)
async def supplier_acknowledge_po(
    po_id: int,
    payload: SupplierAcknowledgePO,
    db: AsyncSession = Depends(get_db),
    current_vendor: VendorUser = Depends(get_current_vendor_user),
):
    """Supplier accepts or rejects the Purchase Order."""
    from pydantic import BaseModel
    vendor_id = current_vendor.vendor_id
    res = await db.execute(
        select(PurchaseOrder).where(
            PurchaseOrder.id == po_id,
            PurchaseOrder.vendor_id == vendor_id
        )
    )
    po = res.scalar_one_or_none()
    if not po:
        raise HTTPException(404, "Purchase Order not found")
        
    if payload.action == "accept":
        if not payload.delivery_date:
            raise HTTPException(400, "Delivery date is required when accepting the Purchase Order.")
        po.supplier_acknowledgement = "accepted"
        po.status = "accepted"
        po.supplier_delivery_date = datetime.combine(payload.delivery_date, time.min).replace(tzinfo=timezone.utc)
        
        # If supplier provided updated rates, apply them to the PO items
        if payload.items:
            item_res = await db.execute(
                select(PurchaseOrderItem).where(PurchaseOrderItem.po_id == po.id)
            )
            po_items = item_res.scalars().all()
            po_items_map = {item.item_id: item for item in po_items}
            
            # Enforce that for version 1.0 (not amended), supplier cannot change pricing/tax fields
            if po.parent_po_id is None:
                for item_input in payload.items:
                    if item_input.item_id in po_items_map:
                        item_row = po_items_map[item_input.item_id]
                        if (
                            item_input.rate != item_row.rate
                            or item_input.discount_pct != item_row.discount_pct
                            or (item_input.cgst_rate is not None and item_input.cgst_rate != item_row.cgst_rate)
                            or (item_input.sgst_rate is not None and item_input.sgst_rate != item_row.sgst_rate)
                            or (item_input.igst_rate is not None and item_input.igst_rate != item_row.igst_rate)
                        ):
                            raise HTTPException(400, "Editing pricing and tax fields is not allowed for PO version V1.0.")
            
            for item_input in payload.items:
                if item_input.item_id in po_items_map:
                    item_row = po_items_map[item_input.item_id]
                    # Only allow editing rate/discount/tax if PO is amended
                    if po.parent_po_id is not None:
                        item_row.rate = item_input.rate
                        item_row.discount_pct = item_input.discount_pct
 
                        # BUG-SUPPLIER-RATE fix: apply supplier-provided tax rates
                        # when they were originally zero (supplier fills pricing).
                        if item_input.cgst_rate is not None:
                            item_row.cgst_rate = item_input.cgst_rate
                        if item_input.sgst_rate is not None:
                            item_row.sgst_rate = item_input.sgst_rate
                        if item_input.igst_rate is not None:
                            item_row.igst_rate = item_input.igst_rate
                    
                    # Recalculate line total amount and tax amount
                    base = item_row.qty * item_row.rate
                    disc = base * item_row.discount_pct / Decimal("100")
                    net = base - disc
                    cgst = net * item_row.cgst_rate / Decimal("100")
                    sgst = net * item_row.sgst_rate / Decimal("100")
                    igst = net * item_row.igst_rate / Decimal("100")
                    item_row.tax_amount = cgst + sgst + igst
                    item_row.amount = net + item_row.tax_amount
            
            await db.flush()
            
            # Recalculate PO header totals
            sub_t = Decimal("0")
            tax_t = Decimal("0")
            cgst_t = Decimal("0")
            sgst_t = Decimal("0")
            igst_t = Decimal("0")
            disc_t = Decimal("0")
            for it in po_items:
                qty = Decimal(str(it.qty or 0))
                rate = Decimal(str(it.rate or 0))
                disc_pct = Decimal(str(it.discount_pct or 0))
                base = qty * rate
                disc = base * disc_pct / Decimal("100")
                net = base - disc
                cgst = net * Decimal(str(it.cgst_rate or 0)) / Decimal("100")
                sgst = net * Decimal(str(it.sgst_rate or 0)) / Decimal("100")
                igst = net * Decimal(str(it.igst_rate or 0)) / Decimal("100")
                
                sub_t += base
                disc_t += disc
                cgst_t += cgst
                sgst_t += sgst
                igst_t += igst
                tax_t += (cgst + sgst + igst)
            
            po.subtotal = sub_t
            po.discount_amount = disc_t
            po.cgst_amount = cgst_t
            po.sgst_amount = sgst_t
            po.igst_amount = igst_t
            po.tax_amount = tax_t

            # Parse vehicle cost from remarks
            vehicle_cost = Decimal("0")
            if po.remarks:
                import re
                match = re.search(r"Includes vehicle cost:\s*(\d+(\.\d+)?)", po.remarks)
                if match:
                    vehicle_cost = Decimal(match.group(1))
            
            po.grand_total = sub_t - disc_t + tax_t + vehicle_cost
            
        action_desc = "accepted"
    elif payload.action == "reject":
        po.supplier_acknowledgement = "rejected"
        po.status = "rejected"
        action_desc = "rejected"
        po.remarks = (po.remarks or "") + f" | [REJECTED BY SUPPLIER] {payload.remarks or 'No reason given'}"
        
        # Update linked MR ordered quantities and status incrementally
        if po.mr_id:
            try:
                from app.services.procurement_service import update_mr_ordered_qty_delta
                deltas = {item.item_id: -item.qty for item in po.items}
                await update_mr_ordered_qty_delta(db, po.mr_id, deltas)
            except Exception:
                import logging
                logging.getLogger(__name__).exception("Failed to release MR quantities after supplier PO rejection for PO %s", po.id)
    else:
        raise HTTPException(400, "Invalid action. Must be 'accept' or 'reject'.")
        
    db.add(ActivityLog(
        user_id=None,
        module="procurement",
        action=f"supplier_po_{payload.action}",
        entity_type="purchase_order",
        entity_id=po.id,
        description=f"Supplier {current_vendor.username} {action_desc} PO {po.po_number}. Remarks: {payload.remarks or 'None'}",
    ))
    
    await db.commit()
    return {"success": True, "message": f"Purchase Order {action_desc} successfully", "supplier_acknowledgement": po.supplier_acknowledgement}
