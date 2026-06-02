import logging
from datetime import datetime, timezone
from decimal import Decimal
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.database import get_db
from app.models.user import User
from app.models.procurement import (
    MaterialRequest, MaterialRequestItem, MrIndentLink,
    Quotation, QuotationItem,
    PurchaseOrder, PurchaseOrderItem,
    RFQ, RFQItem, RFQVendor,
)
from app.models.indent import Indent, IndentItem
from app.schemas.procurement import (
    MRCreate, MRUpdate, MRResponse,
    QuotationCreate, QuotationUpdate, QuotationResponse, RFQCreate,
    POCreate, POUpdate, POResponse, POListResponse,
    SplitPORequest,
)
from app.services.number_series import generate_number
from app.services.approval_service import submit_for_approval
from app.services.notification_service import create_notification
from app.utils.dependencies import get_current_user, require_any_role, require_permission, require_key

# Role groups for procurement endpoints.
# BUG-PRO-024 fix: super_admin must be present in every approver tuple — the
# system superuser was previously 403'd from PO approvals, breaking the
# escalation path when a purchase_manager was unavailable.
MR_CREATOR_ROLES = ("super_admin", "warehouse_manager", "store_keeper", "purchase_manager", "purchase_officer", "admin")
PO_CREATOR_ROLES = ("super_admin", "purchase_manager", "purchase_officer", "admin")
PO_APPROVER_ROLES = ("super_admin", "purchase_manager", "admin")
QUOTATION_ROLES = ("super_admin", "purchase_manager", "purchase_officer", "admin")
from app.utils.helpers import paginate_params, build_paginated_response, apply_search_filter, calculate_line_amount
from app.utils.schema_sync import ensure_rfq_schema

logger = logging.getLogger(__name__)
router = APIRouter()


# ==================== MATERIAL REQUESTS ====================

@router.get("/material-requests")
async def list_material_requests(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=500),
    search: str = Query(None),
    status: str = Query(None),
    priority: str = Query(None),
    request_type: str = Query(None),
    db: AsyncSession = Depends(get_db),
    # R-001: read-level RBAC enforcement
    current_user: User = Depends(require_permission("procurement", "view", "material_requests")),
):
    offset, limit = paginate_params(page, page_size)
    query = select(MaterialRequest).options(
        selectinload(MaterialRequest.items).selectinload(MaterialRequestItem.item),
        selectinload(MaterialRequest.items).selectinload(MaterialRequestItem.uom),
    )
    count_query = select(func.count(MaterialRequest.id))

    if status:
        query = query.where(MaterialRequest.status == status)
        count_query = count_query.where(MaterialRequest.status == status)
    if priority:
        query = query.where(MaterialRequest.priority == priority)
        count_query = count_query.where(MaterialRequest.priority == priority)
    if request_type:
        query = query.where(MaterialRequest.request_type == request_type)
        count_query = count_query.where(MaterialRequest.request_type == request_type)

    query = apply_search_filter(query, MaterialRequest, search, ["mr_number", "department"])
    count_query = apply_search_filter(count_query, MaterialRequest, search, ["mr_number", "department"])

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(MaterialRequest.id.desc()))
    mrs = result.scalars().all()

    # Collect unique requested_by user IDs for batch lookup
    user_ids = {mr.requested_by for mr in mrs if mr.requested_by}
    user_map = {}
    if user_ids:
        user_result = await db.execute(select(User).where(User.id.in_(user_ids)))
        for u in user_result.scalars().all():
            user_map[u.id] = f"{u.first_name or ''} {u.last_name or ''}".strip() or u.username

    response_items = []
    for mr in mrs:
        data = MRResponse.model_validate(mr).model_dump()
        # Resolve requested_by to user name
        if mr.requested_by and mr.requested_by in user_map:
            data["requested_by_name"] = user_map[mr.requested_by]
        for i, item in enumerate(mr.items):
            if i < len(data.get("items", [])):
                if item.item:
                    data["items"][i]["item_name"] = item.item.name
                    data["items"][i]["item_code"] = item.item.item_code
                if item.uom:
                    data["items"][i]["uom"] = item.uom.name
        response_items.append(data)
    return build_paginated_response(response_items, total, page, page_size)


@router.get("/material-requests/{mr_id}")
async def get_material_request(
    mr_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from app.models.master import Item, UOM
    result = await db.execute(
        select(MaterialRequest)
        .options(selectinload(MaterialRequest.items).selectinload(MaterialRequestItem.item))
        .options(selectinload(MaterialRequest.items).selectinload(MaterialRequestItem.uom))
        .where(MaterialRequest.id == mr_id)
    )
    mr = result.scalar_one_or_none()
    if not mr:
        raise HTTPException(status_code=404, detail="Material request not found")
    data = MRResponse.model_validate(mr).model_dump()

    # Warehouse name
    if mr.warehouse_id:
        from app.models.warehouse import Warehouse
        wh_r = await db.execute(select(Warehouse).where(Warehouse.id == mr.warehouse_id))
        wh = wh_r.scalar_one_or_none()
        data["warehouse_name"] = wh.name if wh else None

    # Indent reference (MRs raised from an approved indent)
    if mr.indent_id:
        from app.models.indent import Indent
        i_r = await db.execute(select(Indent).where(Indent.id == mr.indent_id))
        i = i_r.scalar_one_or_none()
        data["indent_number"] = i.indent_number if i else None

    # Requester + approver names in one go
    user_ids = {mr.requested_by, mr.approved_by} - {None}
    user_map: dict[int, str] = {}
    if user_ids:
        u_r = await db.execute(select(User).where(User.id.in_(user_ids)))
        for u in u_r.scalars().all():
            full = f"{u.first_name or ''} {u.last_name or ''}".strip() or u.username
            user_map[u.id] = full
    data["requested_by_name"] = user_map.get(mr.requested_by)
    data["approved_by_name"] = user_map.get(mr.approved_by)
    # Enrich items with item_name, item_code, uom_name
    for i, item in enumerate(mr.items):
        if i < len(data.get("items", [])):
            if item.item:
                data["items"][i]["item_name"] = item.item.name
                data["items"][i]["item_code"] = item.item.item_code
            if item.uom:
                data["items"][i]["uom"] = item.uom.name
                data["items"][i]["uom_name"] = item.uom.name
    return data


@router.post("/material-requests", status_code=201)
async def create_material_request(
    payload: MRCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(*MR_CREATOR_ROLES)),
):
    if not payload.items:
        raise HTTPException(status_code=422, detail="At least one item is required")
    mr_number = await generate_number(db, "procurement", "material_request")
    # Handle department_id → department mapping
    department = payload.department or payload.department_id or None
    mr = MaterialRequest(
        mr_number=mr_number,
        indent_id=payload.indent_id,
        project_id=payload.project_id,
        warehouse_id=payload.warehouse_id,
        request_type=payload.request_type,
        department=department,
        requested_by=current_user.id,
        # BUG-PRO-063 fix: MaterialRequest.request_date is a DateTime column.
        # Other call sites (consolidate, indent → MR) pass a full datetime; this
        # path passed a `date()` which silently coerced and lost timezone/precision.
        # Use a full timezone-aware datetime so type-handling matches.
        request_date=(
            datetime.combine(payload.request_date, datetime.min.time(), tzinfo=timezone.utc)
            if payload.request_date else datetime.now(timezone.utc)
        ),
        required_date=payload.required_date,
        priority=payload.priority,
        remarks=payload.remarks,
    )
    db.add(mr)
    await db.flush()

    for item in payload.items:
        # Fallback uom_id: if not provided, look up the item's primary_uom_id
        uom_id = item.uom_id
        if not uom_id:
            from app.models.master import Item
            item_result = await db.execute(select(Item).where(Item.id == item.item_id))
            found_item = item_result.scalar_one_or_none()
            if found_item:
                uom_id = found_item.primary_uom_id
        mr_item = MaterialRequestItem(
            mr_id=mr.id, item_id=item.item_id, qty=item.qty,
            uom_id=uom_id, target_warehouse_id=item.target_warehouse_id,
            remarks=item.remarks,
        )
        db.add(mr_item)
    await db.flush()

    return {"id": mr.id, "mr_number": mr_number, "message": "Material request created"}


@router.put("/material-requests/{mr_id}")
async def update_material_request(
    mr_id: int,
    payload: MRUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(*MR_CREATOR_ROLES)),
):
    result = await db.execute(select(MaterialRequest).where(MaterialRequest.id == mr_id))
    mr = result.scalar_one_or_none()
    if not mr:
        raise HTTPException(status_code=404, detail="Material request not found")

    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(mr, k, v)
    await db.flush()
    return {"success": True, "message": "Material request updated"}


@router.post("/material-requests/{mr_id}/submit")
async def submit_mr_for_approval(
    mr_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(MaterialRequest).where(MaterialRequest.id == mr_id))
    mr = result.scalar_one_or_none()
    if not mr:
        raise HTTPException(status_code=404, detail="Material request not found")
    if mr.status != "draft":
        raise HTTPException(status_code=400, detail="Only draft MRs can be submitted")

    mr.status = "pending_approval"
    approval = await submit_for_approval(
        db, "procurement", "material_request", mr.id, mr.mr_number,
        current_user.id, mr.project_id,
        department=getattr(mr, "department", None),
        request_type=getattr(mr, "request_type", None) or getattr(mr, "priority", None),
    )
    if not approval:
        raise HTTPException(status_code=400, detail="No approval workflow configured for material requests.")
    await db.flush()

    return {"success": True, "message": "Submitted for approval", "approval_id": approval.id}


@router.post("/material-requests/{mr_id}/approve")
async def approve_material_request(
    mr_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("warehouse_manager", "purchase_manager", "admin")),
):
    result = await db.execute(select(MaterialRequest).where(MaterialRequest.id == mr_id))
    mr = result.scalar_one_or_none()
    if not mr:
        raise HTTPException(status_code=404, detail="Material request not found")

    if mr.status != "pending_approval":
        raise HTTPException(status_code=400, detail=f"Cannot approve MR in '{mr.status}' status")

    mr.status = "approved"
    mr.approved_by = current_user.id
    mr.approved_date = datetime.now(timezone.utc)
    await db.flush()
    return {"success": True, "message": "Material request approved"}


# ==================== QUOTATIONS ====================

def _rfq_key(q: Quotation) -> str:
    return q.rfq_number or q.quotation_number


async def _quotation_to_response_dict(db: AsyncSession, q: Quotation) -> dict:
    data = QuotationResponse.model_validate(q).model_dump()
    data["rfq_number"] = _rfq_key(q)
    data["vendor_name"] = q.vendor.name if q.vendor else None
    if q.mr_id:
        mr_r = await db.execute(select(MaterialRequest).where(MaterialRequest.id == q.mr_id))
        mr = mr_r.scalar_one_or_none()
        data["mr_number"] = mr.mr_number if mr else None
    for i, item in enumerate(q.items):
        if i < len(data.get("items", [])):
            if item.item:
                data["items"][i]["item_name"] = item.item.name
                data["items"][i]["item_code"] = item.item.item_code
            if item.uom:
                data["items"][i]["uom_name"] = item.uom.name
                data["items"][i]["uom"] = item.uom.name
    return data


@router.get("/rfqs")
async def list_rfqs(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=500),
    search: str = Query(None),
    status: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("procurement", "view", "quotations")),
):
    await ensure_rfq_schema(db)
    q_result = await db.execute(
        select(RFQ)
        .options(selectinload(RFQ.vendors).selectinload(RFQVendor.vendor), selectinload(RFQ.quotations))
        .order_by(RFQ.id.desc())
    )
    rows = q_result.scalars().all()

    items = []
    for r in rows:
        if search and search.lower() not in r.rfq_number.lower():
            continue
        if status and r.status != status:
            continue
        
        vendor_names = [v.vendor.name for v in r.vendors if v.vendor and v.vendor.name]
        items.append({
            "id": r.id,
            "rfq_number": r.rfq_number,
            "mr_id": r.mr_id,
            "rfq_date": r.rfq_date,
            "valid_until": r.valid_until,
            "payment_terms": r.payment_terms,
            "with_vehicle": r.with_vehicle,
            "remarks": r.remarks,
            "status": r.status,
            "vendor_count": len(r.vendors),
            "quotation_count": len(r.quotations),
            "submitted_count": len([q for q in r.quotations if q.status == "submitted"]),
            "accepted_count": len([q for q in r.quotations if q.status == "accepted"]),
            "vendor_names": vendor_names,
        })

    mr_ids = {item["mr_id"] for item in items if item["mr_id"]}
    mr_number_map: dict[int, str] = {}
    if mr_ids:
        mr_r = await db.execute(select(MaterialRequest.id, MaterialRequest.mr_number).where(MaterialRequest.id.in_(mr_ids)))
        mr_number_map = {row[0]: row[1] for row in mr_r.all()}
    for item in items:
        item["mr_number"] = mr_number_map.get(item["mr_id"])

    total = len(items)
    offset, limit = paginate_params(page, page_size)
    return build_paginated_response(items[offset:offset + limit], total, page, page_size)


@router.get("/rfqs/{rfq_number:path}")
async def get_rfq(
    rfq_number: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("procurement", "view", "quotations")),
):
    await ensure_rfq_schema(db)
    # Segregated RFQ details loading
    rfq_res = await db.execute(
        select(RFQ)
        .options(
            selectinload(RFQ.items).selectinload(RFQItem.item),
            selectinload(RFQ.items).selectinload(RFQItem.uom),
        )
        .where(RFQ.rfq_number == rfq_number)
    )
    rfq_row = rfq_res.scalar_one_or_none()
    if not rfq_row:
        raise HTTPException(status_code=404, detail="RFQ not found")

    # Fetch corresponding quotations
    q_result = await db.execute(
        select(Quotation)
        .options(
            selectinload(Quotation.vendor),
            selectinload(Quotation.items).selectinload(QuotationItem.item),
            selectinload(Quotation.items).selectinload(QuotationItem.uom),
        )
        .where(Quotation.rfq_id == rfq_row.id)
        .order_by(Quotation.id.asc())
    )
    quotations = q_result.scalars().unique().all()

    # Pre-fill response details
    data = {
        "id": rfq_row.id,
        "rfq_number": rfq_row.rfq_number,
        "mr_id": rfq_row.mr_id,
        "rfq_date": rfq_row.rfq_date,
        "valid_until": rfq_row.valid_until,
        "payment_terms": rfq_row.payment_terms,
        "with_vehicle": rfq_row.with_vehicle,
        "remarks": rfq_row.remarks,
        "items": [
            {
                "id": line.id,
                "item_id": line.item_id,
                "item_code": line.item.item_code if line.item else "",
                "item_name": line.item.name if line.item else "",
                "qty": line.qty,
                "uom": line.uom.name if line.uom else "",
                "remarks": line.remarks,
            }
            for line in rfq_row.items
        ],
        "quotations": [await _quotation_to_response_dict(db, q) for q in quotations],
    }
    if rfq_row.mr_id:
        mr_r = await db.execute(select(MaterialRequest).where(MaterialRequest.id == rfq_row.mr_id))
        mr = mr_r.scalar_one_or_none()
        if mr:
            data["mr_number"] = mr.mr_number
    return data


@router.post("/rfqs", status_code=201)
async def create_rfq(
    payload: RFQCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(*QUOTATION_ROLES)),
):
    await ensure_rfq_schema(db)
    rfq_number = await generate_number(db, "procurement", "rfq")
    
    # 1. Create RFQ Sourcing Event
    rfq = RFQ(
        rfq_number=rfq_number,
        mr_id=payload.mr_id,
        title=payload.title,
        rfq_date=payload.rfq_date,
        valid_until=payload.valid_until,
        payment_terms=payload.payment_terms,
        with_vehicle=payload.with_vehicle,
        remarks=payload.remarks,
        status="draft",
        created_by=current_user.id,
    )
    db.add(rfq)
    await db.flush()

    # 2. Add RFQ Items
    for item in payload.items:
        rfq_item = RFQItem(
            rfq_id=rfq.id,
            item_id=item.item_id,
            qty=item.qty,
            uom_id=item.uom_id,
            remarks=item.remarks,
        )
        db.add(rfq_item)

    created_ids = []
    unique_vendor_ids = list(dict.fromkeys(payload.vendor_ids))
    
    # 3. Invite Vendors (and pre-fill Quotation drafts)
    for vendor_id in unique_vendor_ids:
        db.add(RFQVendor(
            rfq_id=rfq.id,
            vendor_id=vendor_id,
            status="invited",
        ))
        
        quotation_number = await generate_number(db, "procurement", "quotation")
        q = Quotation(
            rfq_id=rfq.id,
            rfq_number=rfq_number,
            quotation_number=quotation_number,
            mr_id=payload.mr_id,
            vendor_id=vendor_id,
            quotation_date=payload.rfq_date,
            valid_until=payload.valid_until,
            currency=payload.currency,
            delivery_days=payload.delivery_days,
            payment_terms=payload.payment_terms,
            with_vehicle=payload.with_vehicle,
            remarks=payload.remarks,
            status="draft",
            submitted_by=None,
        )
        db.add(q)
        await db.flush()
        created_ids.append(q.id)
        
        for item in payload.items:
            calc = calculate_line_amount(item.qty, item.rate, item.discount_pct, item.tax_rate)
            db.add(QuotationItem(
                quotation_id=q.id,
                item_id=item.item_id,
                qty=item.qty,
                uom_id=item.uom_id,
                rate=item.rate,
                discount_pct=item.discount_pct,
                tax_rate=item.tax_rate,
                amount=calc["total_amount"],
                expected_delivery=(
                    datetime.combine(item.expected_delivery, datetime.min.time(), tzinfo=timezone.utc)
                    if item.expected_delivery else None
                ),
                remarks=item.remarks,
            ))
            
    await db.flush()
    return {
        "rfq_number": rfq_number,
        "quotation_ids": created_ids,
        "message": f"RFQ {rfq_number} created and assigned to {len(unique_vendor_ids)} supplier(s)",
    }

@router.get("/quotations")
async def list_quotations(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=500),
    search: str = Query(None),
    status: str = Query(None),
    vendor_id: int = Query(None),
    mr_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    # R-001: read-level RBAC enforcement
    current_user: User = Depends(require_permission("procurement", "view", "quotations")),
):
    await ensure_rfq_schema(db)
    offset, limit = paginate_params(page, page_size)
    query = select(Quotation).options(
        selectinload(Quotation.vendor),
        selectinload(Quotation.items).selectinload(QuotationItem.item),
        selectinload(Quotation.items).selectinload(QuotationItem.uom),
    )
    count_query = select(func.count(Quotation.id))

    if status:
        query = query.where(Quotation.status == status)
        count_query = count_query.where(Quotation.status == status)
    if vendor_id:
        query = query.where(Quotation.vendor_id == vendor_id)
        count_query = count_query.where(Quotation.vendor_id == vendor_id)
    if mr_id:
        query = query.where(Quotation.mr_id == mr_id)
        count_query = count_query.where(Quotation.mr_id == mr_id)

    query = apply_search_filter(query, Quotation, search, ["quotation_number"])
    count_query = apply_search_filter(count_query, Quotation, search, ["quotation_number"])

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(Quotation.id.desc()))
    quotations = result.scalars().all()

    # Bulk-fetch MR numbers for all quotations that link to one, so the list
    # column "MR Ref" renders the number instead of "-".
    mr_ids = {q.mr_id for q in quotations if q.mr_id}
    mr_number_map: dict[int, str] = {}
    if mr_ids:
        mr_r = await db.execute(
            select(MaterialRequest.id, MaterialRequest.mr_number)
            .where(MaterialRequest.id.in_(mr_ids))
        )
        mr_number_map = {row[0]: row[1] for row in mr_r.all()}

    response_items = []
    for q in quotations:
        data = QuotationResponse.model_validate(q).model_dump()
        data["vendor_name"] = q.vendor.name if q.vendor else None
        data["mr_number"] = mr_number_map.get(q.mr_id) if q.mr_id else None
        for i, item in enumerate(q.items):
            if i < len(data.get("items", [])):
                if item.item:
                    data["items"][i]["item_name"] = item.item.name
                    data["items"][i]["item_code"] = item.item.item_code
                if item.uom:
                    data["items"][i]["uom_name"] = item.uom.name
                    data["items"][i]["uom"] = item.uom.name
        response_items.append(data)
    return build_paginated_response(response_items, total, page, page_size)


@router.get("/quotations/{quotation_id}")
async def get_quotation(
    quotation_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_rfq_schema(db)
    """Quotation detail with display-friendly relationship fields.

    Removed response_model so mr_number, vendor_name and per-item uom get
    through instead of being stripped by the schema filter.
    """
    result = await db.execute(
        select(Quotation).options(
            selectinload(Quotation.vendor),
            selectinload(Quotation.items).selectinload(QuotationItem.item),
            selectinload(Quotation.items).selectinload(QuotationItem.uom),
        ).where(Quotation.id == quotation_id)
    )
    q = result.scalar_one_or_none()
    if not q:
        raise HTTPException(status_code=404, detail="Quotation not found")
    data = QuotationResponse.model_validate(q).model_dump()
    data["vendor_name"] = q.vendor.name if q.vendor else None

    # MR reference
    if q.mr_id:
        mr_r = await db.execute(select(MaterialRequest).where(MaterialRequest.id == q.mr_id))
        mr = mr_r.scalar_one_or_none()
        data["mr_number"] = mr.mr_number if mr else None

    # Submitter name
    if q.submitted_by:
        from app.models.user import User as UserModel
        u_r = await db.execute(select(UserModel).where(UserModel.id == q.submitted_by))
        u = u_r.scalar_one_or_none()
        if u:
            data["submitted_by_name"] = f"{u.first_name or ''} {u.last_name or ''}".strip() or u.username

    for i, item in enumerate(q.items):
        if i < len(data.get("items", [])):
            if item.item:
                data["items"][i]["item_name"] = item.item.name
                data["items"][i]["item_code"] = item.item.item_code
            if item.uom:
                data["items"][i]["uom_name"] = item.uom.name
                data["items"][i]["uom"] = item.uom.name
    return data


@router.post("/quotations", status_code=201)
async def create_quotation(
    payload: QuotationCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(*QUOTATION_ROLES)),
):
    await ensure_rfq_schema(db)
    if not payload.items:
        raise HTTPException(status_code=422, detail="At least one item is required")
    q_number = await generate_number(db, "procurement", "quotation")
    total_cgst = Decimal("0")
    total_sgst = Decimal("0")
    total_igst = Decimal("0")
    subtotal = Decimal("0")
    total_tax = Decimal("0")

    # Check vendor once
    from app.models.master import Vendor as _Vendor
    vendor_row = (await db.execute(select(_Vendor).where(_Vendor.id == payload.vendor_id))).scalar_one_or_none()
    has_gstin = bool((getattr(vendor_row, "gst_number", None) or "").strip()) if vendor_row else False

    q = Quotation(
        rfq_number=payload.rfq_number,
        quotation_number=q_number,
        mr_id=payload.mr_id,
        vendor_id=payload.vendor_id,
        quotation_date=payload.quotation_date,
        valid_until=payload.valid_until,
        currency=payload.currency,
        delivery_days=payload.delivery_days,
        payment_terms=payload.payment_terms,
        remarks=payload.remarks,
        submitted_by=current_user.id,
    )
    db.add(q)
    await db.flush()

    for item in payload.items:
        base = item.qty * item.rate
        discount = base * item.discount_pct / Decimal("100")
        net = base - discount

        cgst_rate = Decimal(str(item.cgst_rate or 0))
        sgst_rate = Decimal(str(item.sgst_rate or 0))
        igst_rate = Decimal(str(item.igst_rate or 0))
        tax_rate = Decimal(str(item.tax_rate or 0))

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

        qi = QuotationItem(
            quotation_id=q.id, item_id=item.item_id, qty=item.qty,
            uom_id=item.uom_id, rate=item.rate, discount_pct=item.discount_pct,
            tax_rate=tax_rate, cgst_rate=cgst_rate, sgst_rate=sgst_rate, igst_rate=igst_rate,
            amount=amount,
            expected_delivery=(
                datetime.combine(item.expected_delivery, datetime.min.time(), tzinfo=timezone.utc)
                if item.expected_delivery else None
            ),
            remarks=item.remarks,
        )
        db.add(qi)
        subtotal += net
        total_cgst += cgst
        total_sgst += sgst
        total_igst += igst
        total_tax += item_tax

    q.subtotal = subtotal
    q.total_amount = subtotal
    q.cgst_amount = total_cgst
    q.sgst_amount = total_sgst
    q.igst_amount = total_igst
    q.tax_amount = total_tax
    q.grand_total = subtotal + total_tax
    q.status = "submitted"
    return {"id": q.id, "quotation_number": q_number, "message": "Quotation submitted"}


@router.put("/quotations/{quotation_id}")
async def update_quotation(
    quotation_id: int,
    payload: QuotationUpdate,
    db: AsyncSession = Depends(get_db),
    # BUG-PRO-049 fix: role-gate quotation update. Same procurement-roles set
    # used by /quotations create. Plain get_current_user let any logged-in
    # user mutate quotation fields.
    current_user: User = Depends(require_any_role(*QUOTATION_ROLES)),
):
    result = await db.execute(select(Quotation).options(selectinload(Quotation.items)).where(Quotation.id == quotation_id))
    q = result.scalar_one_or_none()
    if not q:
        raise HTTPException(status_code=404, detail="Quotation not found")
    # BUG-PRO-048 fix: whitelist editable fields. Never accept status (must use
    # /accept or /reject endpoints), quotation_number (system-generated), or
    # vendor_id (would silently re-attribute a quote to a different vendor).
    _QUOTATION_PUT_DENY = {
        "status",
        "quotation_number",
        "vendor_id",
        "items",  # handled separately below
    }
    for k, v in payload.model_dump(exclude_unset=True).items():
        if k in _QUOTATION_PUT_DENY:
            continue
        if hasattr(q, k):
            setattr(q, k, v)

    # If items are provided, replace existing items and recalculate all totals
    if payload.items is not None:
        # Check vendor GSTIN for CGST/SGST compliance
        from app.models.master import Vendor as _Vendor
        vendor_row = (await db.execute(select(_Vendor).where(_Vendor.id == q.vendor_id))).scalar_one_or_none()
        has_gstin = bool((getattr(vendor_row, "gst_number", None) or "").strip()) if vendor_row else False

        # Delete old items
        for old_item in q.items:
            await db.delete(old_item)
        await db.flush()

        subtotal = Decimal("0")
        total_cgst = Decimal("0")
        total_sgst = Decimal("0")
        total_igst = Decimal("0")
        total_tax = Decimal("0")

        for item in payload.items:
            base = item.qty * item.rate
            discount = base * item.discount_pct / Decimal("100")
            net = base - discount

            cgst_rate = Decimal(str(item.cgst_rate or 0))
            sgst_rate = Decimal(str(item.sgst_rate or 0))
            igst_rate = Decimal(str(item.igst_rate or 0))
            tax_rate = Decimal(str(item.tax_rate or 0))

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

            db.add(QuotationItem(
                quotation_id=q.id, item_id=item.item_id, qty=item.qty,
                uom_id=item.uom_id, rate=item.rate, discount_pct=item.discount_pct,
                tax_rate=tax_rate, cgst_rate=cgst_rate, sgst_rate=sgst_rate, igst_rate=igst_rate,
                amount=amount,
                expected_delivery=(
                    datetime.combine(item.expected_delivery, datetime.min.time(), tzinfo=timezone.utc)
                    if item.expected_delivery else None
                ),
                remarks=item.remarks,
            ))
            subtotal += net
            total_cgst += cgst
            total_sgst += sgst
            total_igst += igst
            total_tax += item_tax

        q.subtotal = subtotal
        q.total_amount = subtotal
        q.cgst_amount = total_cgst
        q.sgst_amount = total_sgst
        q.igst_amount = total_igst
        q.tax_amount = total_tax
        q.grand_total = subtotal + total_tax

    await db.flush()
    return {"success": True, "message": "Quotation updated"}


# ==================== PURCHASE ORDERS ====================

@router.get("/purchase-orders")
async def list_purchase_orders(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=500),
    search: str = Query(None),
    status: str = Query(None),
    vendor_id: int = Query(None),
    project_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    # R-001: read-level RBAC. Warehouse staff also need PO visibility (CR_08/09)
    # so we allow either procurement.view or warehouse.view permission.
    current_user: User = Depends(get_current_user),
):
    # R-001 inline check (multi-permission OR)
    from app.utils.dependencies import get_user_permissions, get_user_role_codes
    role_codes = await get_user_role_codes(db, current_user.id)
    if "super_admin" not in role_codes and "admin" not in role_codes:
        perms = set(await get_user_permissions(db, current_user.id))
        if not (perms & {"procurement.view.purchase_orders", "warehouse.view.grn", "warehouse.view.material_issue"}):
            raise HTTPException(status_code=403, detail="Permission denied: procurement.view.purchase_orders")
    offset, limit = paginate_params(page, page_size)
    query = select(PurchaseOrder).options(
        selectinload(PurchaseOrder.vendor),
        selectinload(PurchaseOrder.items).selectinload(PurchaseOrderItem.item),
        selectinload(PurchaseOrder.items).selectinload(PurchaseOrderItem.uom),
    )
    count_query = select(func.count(PurchaseOrder.id))

    if status:
        # Bug fix: support comma-separated status (e.g. "approved,partially_received")
        statuses = [s.strip() for s in status.split(",") if s.strip()]
        if len(statuses) == 1:
            query = query.where(PurchaseOrder.status == statuses[0])
            count_query = count_query.where(PurchaseOrder.status == statuses[0])
        else:
            query = query.where(PurchaseOrder.status.in_(statuses))
            count_query = count_query.where(PurchaseOrder.status.in_(statuses))
    if vendor_id:
        query = query.where(PurchaseOrder.vendor_id == vendor_id)
        count_query = count_query.where(PurchaseOrder.vendor_id == vendor_id)
    if project_id:
        query = query.where(PurchaseOrder.project_id == project_id)
        count_query = count_query.where(PurchaseOrder.project_id == project_id)

    query = apply_search_filter(query, PurchaseOrder, search, ["po_number"])
    count_query = apply_search_filter(count_query, PurchaseOrder, search, ["po_number"])

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(PurchaseOrder.id.desc()))
    pos = result.scalars().all()

    response_items = []
    for po in pos:
        data = POListResponse.model_validate(po).model_dump()
        data["vendor_name"] = po.vendor.name if po.vendor else None
        for i, item in enumerate(po.items):
            if i < len(data.get("items", [])):
                if item.item:
                    data["items"][i]["item_name"] = item.item.name
                    data["items"][i]["item_code"] = item.item.item_code
                if item.uom:
                    data["items"][i]["uom_name"] = item.uom.name
        response_items.append(data)
    return build_paginated_response(response_items, total, page, page_size)


@router.get("/purchase-orders/{po_id}")
async def get_purchase_order(
    po_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return a PO with all reference/display fields populated.

    response_model was removed so we can add mr_number, quotation_number,
    warehouse_name, created_by_name, approved_by_name and per-item uom
    without the Pydantic schema filter dropping them on the way out.
    """
    # R-001 inline check (mirrors list_purchase_orders): warehouse staff need
    # read access to POs so the GRN page can fetch line items. Procurement
    # staff also need it. Anyone else 403.
    from app.utils.dependencies import get_user_permissions, get_user_role_codes
    role_codes = await get_user_role_codes(db, current_user.id)
    if "super_admin" not in role_codes and "admin" not in role_codes:
        perms = set(await get_user_permissions(db, current_user.id))
        if not (perms & {"procurement.view.purchase_orders", "warehouse.view.grn", "warehouse.view.material_issue"}):
            raise HTTPException(status_code=403, detail="Permission denied: procurement.view.purchase_orders")

    result = await db.execute(
        select(PurchaseOrder).options(
            selectinload(PurchaseOrder.vendor),
            selectinload(PurchaseOrder.items).selectinload(PurchaseOrderItem.item),
            selectinload(PurchaseOrder.items).selectinload(PurchaseOrderItem.uom),
        ).where(PurchaseOrder.id == po_id)
    )
    po = result.scalar_one_or_none()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    data = POResponse.model_validate(po).model_dump()
    data["vendor_name"] = po.vendor.name if po.vendor else None

    # Warehouse name
    if po.warehouse_id:
        from app.models.warehouse import Warehouse
        wh_r = await db.execute(select(Warehouse).where(Warehouse.id == po.warehouse_id))
        wh = wh_r.scalar_one_or_none()
        data["warehouse_name"] = wh.name if wh else None

    # MR reference
    if po.mr_id:
        mr_r = await db.execute(select(MaterialRequest).where(MaterialRequest.id == po.mr_id))
        mr = mr_r.scalar_one_or_none()
        data["mr_number"] = mr.mr_number if mr else None

    # Quotation reference
    if po.quotation_id:
        q_r = await db.execute(select(Quotation).where(Quotation.id == po.quotation_id))
        q = q_r.scalar_one_or_none()
        data["quotation_number"] = q.quotation_number if q else None

    # Project name
    if po.project_id:
        from app.models.user import Project
        p_r = await db.execute(select(Project).where(Project.id == po.project_id))
        p = p_r.scalar_one_or_none()
        data["project_name"] = p.name if p else None

    # Creator + approver names (same fix as get_indent)
    user_ids = {po.created_by, po.approved_by} - {None}
    user_map: dict[int, str] = {}
    if user_ids:
        from app.models.user import User as UserModel
        u_r = await db.execute(select(UserModel).where(UserModel.id.in_(user_ids)))
        for u in u_r.scalars().all():
            full = f"{u.first_name or ''} {u.last_name or ''}".strip() or u.username
            user_map[u.id] = full
    data["created_by_name"] = user_map.get(po.created_by)
    data["approved_by_name"] = user_map.get(po.approved_by)

    for i, item in enumerate(po.items):
        if i < len(data.get("items", [])):
            if item.item:
                data["items"][i]["item_name"] = item.item.name
                data["items"][i]["item_code"] = item.item.item_code
            if item.uom:
                data["items"][i]["uom_name"] = item.uom.name
                # Frontend reads `uom` (not uom_name) on PO detail
                data["items"][i]["uom"] = item.uom.name
    return data


@router.post("/purchase-orders", status_code=201, dependencies=[Depends(require_key("procurement-purchase-orders"))])
async def create_purchase_order(
    payload: POCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(*PO_CREATOR_ROLES)),
):
    if not payload.items:
        raise HTTPException(status_code=422, detail="At least one item is required")

    # BUG-PRO-012 fix: refuse PO creation against an inactive vendor.
    from app.models.master import Vendor as _Vendor, Item as _Item
    vendor_row = (await db.execute(
        select(_Vendor).where(_Vendor.id == payload.vendor_id)
    )).scalar_one_or_none()
    if not vendor_row:
        raise HTTPException(status_code=404, detail=f"Vendor {payload.vendor_id} not found")
    if not getattr(vendor_row, "is_active", True):
        raise HTTPException(
            status_code=400,
            detail=f"Vendor '{vendor_row.name}' is inactive — cannot raise a PO",
        )

    # BUG-PRO-005 fix: PO must reference an approved MR (when mr_id is supplied).
    if payload.mr_id:
        _mr_row = (await db.execute(
            select(MaterialRequest).where(MaterialRequest.id == payload.mr_id)
        )).scalar_one_or_none()
        if not _mr_row:
            raise HTTPException(status_code=404, detail=f"Material request {payload.mr_id} not found")
        if _mr_row.status not in ("approved", "ordered", "partially_ordered"):
            raise HTTPException(
                status_code=400,
                detail=f"Cannot raise PO against MR in '{_mr_row.status}' status — only approved MRs allowed",
            )
        # BUG-PRO-004 fix: PO qty per item must not exceed the MR qty for that item.
        mr_items_rows = (await db.execute(
            select(MaterialRequestItem.item_id, MaterialRequestItem.qty)
            .where(MaterialRequestItem.mr_id == payload.mr_id)
        )).all()
        mr_qty_by_item: dict[int, Decimal] = {}
        for r in mr_items_rows:
            mr_qty_by_item[r.item_id] = Decimal(str(r.qty or 0))
        for li in payload.items:
            mr_qty = mr_qty_by_item.get(li.item_id)
            if mr_qty is None:
                raise HTTPException(
                    status_code=400,
                    detail=f"Item {li.item_id} is not on MR {_mr_row.mr_number}",
                )
            if Decimal(str(li.qty or 0)) > mr_qty:
                raise HTTPException(
                    status_code=400,
                    detail=f"PO qty {li.qty} exceeds MR qty {mr_qty} for item {li.item_id}",
                )

    # BUG-PRO-006 fix: when raising from a quotation, that quotation must be 'accepted'.
    if payload.quotation_id:
        _q_row = (await db.execute(
            select(Quotation).where(Quotation.id == payload.quotation_id)
        )).scalar_one_or_none()
        if not _q_row:
            raise HTTPException(status_code=404, detail=f"Quotation {payload.quotation_id} not found")
        if _q_row.status != "accepted":
            raise HTTPException(
                status_code=400,
                detail=f"Cannot raise PO from quotation in '{_q_row.status}' status — only accepted",
            )
        # BUG-PRO-003 fix: PO item rate must match accepted quote rates per item.
        q_items_rows = (await db.execute(
            select(QuotationItem.item_id, QuotationItem.rate)
            .where(QuotationItem.quotation_id == payload.quotation_id)
        )).all()
        q_rate_by_item = {r.item_id: Decimal(str(r.rate or 0)) for r in q_items_rows}
        for li in payload.items:
            qrate = q_rate_by_item.get(li.item_id)
            if qrate is None:
                raise HTTPException(
                    status_code=400,
                    detail=f"Item {li.item_id} is not on quotation {_q_row.quotation_number}",
                )
            if Decimal(str(li.rate or 0)) > qrate:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"PO rate {li.rate} exceeds accepted quotation rate "
                        f"{qrate} for item {li.item_id}"
                    ),
                )

    # BUG-PRO-002 fix: enforce a procurement source for every PO. Either it
    # references an approved MR, an accepted quotation, or an active rate
    # contract for the vendor (covers the negotiated-rate path).
    if not payload.mr_id and not payload.quotation_id:
        # Fall back to checking that an active rate contract exists for vendor+items.
        try:
            from app.models.healthcare import RateContract, RateContractItem
            from datetime import date as _date
            today = _date.today()
            item_ids_for_rc = [li.item_id for li in payload.items]
            rc_rows = (await db.execute(
                select(RateContractItem.item_id)
                .join(RateContract, RateContract.id == RateContractItem.contract_id)
                .where(
                    RateContract.vendor_id == payload.vendor_id,
                    RateContract.status == "active",
                    RateContract.start_date <= today,
                    RateContract.end_date >= today,
                    RateContractItem.item_id.in_(item_ids_for_rc),
                )
            )).all()
            covered = {r.item_id for r in rc_rows}
            missing = [iid for iid in item_ids_for_rc if iid not in covered]
            if missing:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "PO must originate from an approved MR, an accepted quotation, "
                        "or an active rate contract covering all items. No source found for items: "
                        f"{missing}"
                    ),
                )
        except HTTPException:
            raise
        except Exception:
            logger.exception("Rate-contract source check failed for PO creation; refusing")
            raise HTTPException(
                status_code=400,
                detail="PO must originate from an approved MR, an accepted quotation, or an active rate contract.",
            )

    # BUG-PRO-083 / BUG-PRO-084 fix: enforce rate-contract pricing/qty caps when an
    # active RC covers the line — even if the PO came in via MR / quotation path.
    rc_min_order_values: dict[int, dict] = {}  # contract_id → {min_order_value, contract_number}
    try:
        from app.models.healthcare import RateContract, RateContractItem
        from datetime import date as _date
        today = _date.today()
        item_ids_for_rc = [li.item_id for li in payload.items]
        rc_rows = (await db.execute(
            select(RateContractItem, RateContract)
            .join(RateContract, RateContract.id == RateContractItem.contract_id)
            .where(
                RateContract.vendor_id == payload.vendor_id,
                RateContract.status == "active",
                RateContract.start_date <= today,
                RateContract.end_date >= today,
                RateContractItem.item_id.in_(item_ids_for_rc),
            )
        )).all()
        rc_caps_by_item: dict[int, dict] = {}
        for rci, rc in rc_rows:
            rc_caps_by_item[rci.item_id] = {
                "effective_rate": Decimal(str(rci.effective_rate or 0)),
                "min_qty": Decimal(str(rci.min_qty or 0)),
                "max_qty": Decimal(str(rci.max_qty or 0)),
                "contract_number": rc.contract_number,
            }
            # BUG-PRO-085 fix: also capture min_order_value so we can enforce it
            # against the PO grand_total once it's computed.
            rc_min_order_values[rc.id] = {
                "min_order_value": Decimal(str(rc.min_order_value or 0)),
                "contract_number": rc.contract_number,
            }
        for li in payload.items:
            cap = rc_caps_by_item.get(li.item_id)
            if not cap:
                continue
            li_qty = Decimal(str(li.qty or 0))
            li_rate = Decimal(str(li.rate or 0))
            if cap["effective_rate"] > 0 and li_rate > cap["effective_rate"]:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"PO rate {li_rate} exceeds rate-contract "
                        f"{cap['contract_number']} effective rate {cap['effective_rate']} "
                        f"for item {li.item_id}"
                    ),
                )
            if cap["min_qty"] > 0 and li_qty < cap["min_qty"]:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"PO qty {li_qty} is below RC {cap['contract_number']} "
                        f"min_qty {cap['min_qty']} for item {li.item_id}"
                    ),
                )
            if cap["max_qty"] > 0 and li_qty > cap["max_qty"]:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"PO qty {li_qty} exceeds RC {cap['contract_number']} "
                        f"max_qty {cap['max_qty']} for item {li.item_id}"
                    ),
                )
    except HTTPException:
        raise
    except Exception:
        # RC cap check is advisory; log but do not bypass the rest of the create.
        logger.exception("Rate-contract cap check failed for PO create vendor_id=%s", payload.vendor_id)

    # BUG-PRO-014 / BUG-PRO-022 fix: do NOT swallow non-HTTPException failures
    # of the medicine compliance gate. Hard-fail on any unexpected error so we
    # never silently approve a PO whose drug-license check threw.
    from app.services.compliance_service import assert_vendor_compliant
    item_ids = [i.item_id for i in payload.items if getattr(i, "item_id", None)]
    has_medicine = False
    if item_ids:
        # BUG-PRO-015 fix: broaden the DL-required detection. The previous gate
        # only matched ``item_type == 'medicine'``. Items flagged via the Wave 7
        # healthcare compliance columns (drug_schedule, schedule H1, narcotic,
        # requires_prescription) ALSO require a valid drug license even if their
        # item_type is something else (e.g. consumable for reagents).
        r = await db.execute(
            select(_Item.id).where(
                _Item.id.in_(item_ids),
                or_(
                    _Item.item_type == "medicine",
                    _Item.requires_prescription == True,  # noqa: E712
                    _Item.is_schedule_h1 == True,  # noqa: E712
                    _Item.is_narcotic == True,  # noqa: E712
                    _Item.drug_schedule.in_(("X", "H", "H1", "G")),
                ),
            ).limit(1)
        )
        has_medicine = r.scalar() is not None
    if has_medicine:
        # If the compliance service raises, propagate the actual error rather than
        # logging-and-passing — pharma POs MUST NOT bypass DL checks.
        await assert_vendor_compliant(
            db, vendor_id=payload.vendor_id,
            require_drug_license=True, user_id=current_user.id,
        )

    subtotal = Decimal("0")
    total_tax = Decimal("0")
    total_cgst = Decimal("0")
    total_sgst = Decimal("0")
    total_igst = Decimal("0")
    total_discount = Decimal("0")

    # BUG-PRO-001 fix: generate po_number before constructing PO (was undefined NameError)
    po_number = await generate_number(db, "procurement", "purchase_order")

    # BUG-PRO-013 fix: refuse a CGST/SGST PO when the vendor has no GSTIN. CGST/SGST
    # are intra-state taxes that legally require a registered GSTIN on both sides;
    # IGST may apply when the vendor is unregistered (composition / inter-state).
    if not (vendor_row.gst_number or "").strip():
        for li in payload.items:
            cgst_r = Decimal(str(getattr(li, "cgst_rate", 0) or 0))
            sgst_r = Decimal(str(getattr(li, "sgst_rate", 0) or 0))
            if cgst_r > 0 or sgst_r > 0:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Vendor '{vendor_row.name}' has no GSTIN — CGST/SGST cannot "
                        f"be applied. Use IGST or update the vendor's GSTIN first."
                    ),
                )

    po = PurchaseOrder(
        po_number=po_number,
        vendor_id=payload.vendor_id,
        mr_id=payload.mr_id,
        quotation_id=payload.quotation_id,
        project_id=payload.project_id,
        warehouse_id=payload.warehouse_id,
        po_date=payload.po_date,
        expected_delivery_date=payload.expected_delivery_date,
        billing_address=payload.billing_address,
        shipping_address=payload.shipping_address,
        payment_terms_days=payload.payment_terms_days,
        remarks=payload.remarks,
        # BUG-PRO-008 fix: schema accepted attachment_url but the constructor
        # never persisted it, so PO uploads were silently dropped.
        attachment_url=payload.attachment_url,
        created_by=current_user.id,
    )
    db.add(po)
    await db.flush()

    for item in payload.items:
        base = item.qty * item.rate
        discount = base * item.discount_pct / 100
        net = base - discount
        cgst = net * item.cgst_rate / 100
        sgst = net * item.sgst_rate / 100
        igst = net * item.igst_rate / 100
        item_tax = cgst + sgst + igst
        amount = net + item_tax

        poi = PurchaseOrderItem(
            po_id=po.id, item_id=item.item_id, qty=item.qty,
            uom_id=item.uom_id, rate=item.rate, discount_pct=item.discount_pct,
            cgst_rate=item.cgst_rate, sgst_rate=item.sgst_rate,
            igst_rate=item.igst_rate, tax_amount=item_tax, amount=amount,
            # BUG-PRO-018 fix: initialise these explicitly. The model defaults to 0
            # but relying on column defaults left freshly-inserted rows briefly
            # NULL in some flows (bulk-insert paths that skipped server defaults).
            received_qty=Decimal("0"),
            returned_qty=Decimal("0"),
        )
        db.add(poi)
        subtotal += net
        total_discount += discount
        total_cgst += cgst
        total_sgst += sgst
        total_igst += igst
        total_tax += item_tax

    po.subtotal = subtotal
    po.discount_amount = total_discount
    po.cgst_amount = total_cgst
    po.sgst_amount = total_sgst
    po.igst_amount = total_igst
    po.tax_amount = total_tax
    po.grand_total = subtotal + total_tax

    # BUG-PRO-085 fix: enforce RC min_order_value against the freshly computed
    # PO grand_total. If any of the RCs covering this PO has a positive
    # min_order_value and the PO falls below it, refuse.
    try:
        for _rc_id, _info in (rc_min_order_values or {}).items():
            mov = _info["min_order_value"]
            if mov > 0 and Decimal(str(po.grand_total or 0)) < mov:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"PO grand_total {po.grand_total} is below rate-contract "
                        f"{_info['contract_number']} min_order_value {mov}"
                    ),
                )
    except HTTPException:
        raise
    except Exception:
        logger.exception("min_order_value check failed (non-HTTP); continuing")

    # BUG-PRO-021 fix: refuse zero-value POs. A 0 grand_total PO is either a
    # data-entry mistake (qty/rate=0 across the board) or a deliberate attempt
    # to create a placeholder PO that would slip past every spend control.
    if po.grand_total is None or Decimal(str(po.grand_total)) <= 0:
        raise HTTPException(
            status_code=400,
            detail="PO grand_total must be > 0 — review item qty/rate values",
        )

    await db.flush()

    # Update MR status if linked
    if payload.mr_id:
        mr_result = await db.execute(select(MaterialRequest).where(MaterialRequest.id == payload.mr_id))
        mr = mr_result.scalar_one_or_none()
        if mr and mr.status == "approved":
            mr.status = "ordered"
            await db.flush()

    return {"id": po.id, "po_number": po_number, "message": "Purchase order created"}


@router.put("/purchase-orders/{po_id}", dependencies=[Depends(require_key("procurement-purchase-orders"))])
async def update_purchase_order(
    po_id: int,
    payload: POUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(*PO_CREATOR_ROLES)),
):
    result = await db.execute(select(PurchaseOrder).where(PurchaseOrder.id == po_id))
    po = result.scalar_one_or_none()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    # BUG-PRO-035 fix: only draft POs may be edited via PUT. Approved /
    # partially_received / received / cancelled POs must go through the
    # explicit transition endpoints (submit, approve, cancel, GRN).
    if po.status != "draft":
        raise HTTPException(
            status_code=400,
            detail=f"Cannot edit PO in '{po.status}' status — only drafts may be amended via PUT",
        )
    # BUG-PRO-033 fix: whitelist editable fields. Never accept status / numbering /
    # totals / tax / qty / audit fields via PUT — those are flipped only by the
    # /submit, /approve, /cancel, GRN, and creation flows.
    _PO_PUT_ALLOWED = {
        "expected_delivery_date",
        "delivery_address",
        "notes",
        "attachment_url",
        "remarks",
    }
    for k, v in payload.model_dump(exclude_unset=True).items():
        if k not in _PO_PUT_ALLOWED:
            continue
        setattr(po, k, v)
    await db.flush()
    return {"success": True, "message": "Purchase order updated"}


@router.post("/purchase-orders/{po_id}/submit", dependencies=[Depends(require_key("procurement-purchase-orders"))])
async def submit_po_for_approval(
    po_id: int,
    payload: dict | None = None,
    db: AsyncSession = Depends(get_db),
    # BUG-PRO-031 fix: role-gate submit. Previously any logged-in user could
    # push another user's draft PO into the approval workflow — that lets
    # non-procurement staff move drafts they were never meant to see.
    current_user: User = Depends(require_any_role(*PO_CREATOR_ROLES)),
):
    result = await db.execute(select(PurchaseOrder).where(PurchaseOrder.id == po_id))
    po = result.scalar_one_or_none()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    if po.status != "draft":
        raise HTTPException(status_code=400, detail="Only draft POs can be submitted")

    # BUG-PRO-032 fix: recompute header totals from current items before submit so
    # the approval workflow sees the truth even if the items table changed since
    # the last save (manual DB tweak, race with another save, etc.).
    items_rows = (await db.execute(
        select(PurchaseOrderItem).where(PurchaseOrderItem.po_id == po.id)
    )).scalars().all()
    if not items_rows:
        raise HTTPException(status_code=400, detail="Cannot submit a PO with no items")
    sub_t = Decimal("0")
    tax_t = Decimal("0")
    cgst_t = Decimal("0")
    sgst_t = Decimal("0")
    igst_t = Decimal("0")
    disc_t = Decimal("0")
    for it in items_rows:
        qty = Decimal(str(it.qty or 0))
        rate = Decimal(str(it.rate or 0))
        disc_pct = Decimal(str(it.discount_pct or 0))
        base = qty * rate
        disc = base * disc_pct / Decimal("100")
        net = base - disc
        cgst = net * Decimal(str(it.cgst_rate or 0)) / Decimal("100")
        sgst = net * Decimal(str(it.sgst_rate or 0)) / Decimal("100")
        igst = net * Decimal(str(it.igst_rate or 0)) / Decimal("100")
        sub_t += net
        disc_t += disc
        cgst_t += cgst
        sgst_t += sgst
        igst_t += igst
        tax_t += cgst + sgst + igst
    po.subtotal = sub_t
    po.discount_amount = disc_t
    po.cgst_amount = cgst_t
    po.sgst_amount = sgst_t
    po.igst_amount = igst_t
    po.tax_amount = tax_t
    po.grand_total = sub_t + tax_t
    if Decimal(str(po.grand_total or 0)) <= 0:
        raise HTTPException(
            status_code=400,
            detail="PO grand_total must be > 0 — review item qty/rate values",
        )

    # Wave 8 — state-transition compliance gate
    try:
        from app.services.document_service import assert_transition_compliance
        await assert_transition_compliance(
            db, user=current_user,
            module="procurement", source_type="purchase_order", source_id=po.id,
            from_state="draft", to_state="pending_approval",
            submitted_password=(payload or {}).get("password"),
            payload_for_sign={"po_number": po.po_number, "amount": float(po.grand_total or 0)},
        )
    except HTTPException:
        raise
    except Exception:
        logger.exception("Transition compliance check failed on PO submit for PO %s", po.id)

    po.status = "pending_approval"
    approval = await submit_for_approval(
        db, "procurement", "purchase_order", po.id, po.po_number,
        current_user.id, po.project_id, float(po.grand_total),
        department=getattr(po, "department", None),
        extra={
            "vendor_id": po.vendor_id,
            "currency": getattr(po, "currency", None),
        },
    )
    if not approval:
        raise HTTPException(status_code=400, detail="No approval workflow configured for purchase orders.")
    await db.flush()
    return {"success": True, "message": "PO submitted for approval", "approval_id": approval.id}


@router.post("/purchase-orders/{po_id}/approve", dependencies=[Depends(require_key("procurement-purchase-orders"))])
async def approve_purchase_order(
    po_id: int,
    payload: dict | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(*PO_APPROVER_ROLES)),
):
    result = await db.execute(select(PurchaseOrder).where(PurchaseOrder.id == po_id))
    po = result.scalar_one_or_none()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")

    if po.status != "pending_approval":
        raise HTTPException(status_code=400, detail=f"Cannot approve PO in '{po.status}' status")

    # BUG-PRO-030 fix: refuse approval of zero/null grand_total POs. The previous
    # code passed `float(po.grand_total or 0)` to the e-sign payload silently;
    # an approver's signature should never be attached to a 0-value PO.
    if po.grand_total is None or Decimal(str(po.grand_total)) <= 0:
        raise HTTPException(
            status_code=400,
            detail="Cannot approve PO with grand_total <= 0",
        )

    # BUG-PRO-027 fix: re-run the drug-license / vendor compliance gate at
    # approval time. The DL could have expired between submit and approve
    # (sometimes weeks apart) and approvers must not rubber-stamp a now-non-
    # compliant pharma vendor.
    try:
        from app.models.master import Item as _Item
        # BUG-PRO-015 fix (approve site): same broadened DL detection as PO create.
        item_rows = (await db.execute(
            select(_Item.id).join(
                PurchaseOrderItem, PurchaseOrderItem.item_id == _Item.id,
            ).where(
                PurchaseOrderItem.po_id == po.id,
                or_(
                    _Item.item_type == "medicine",
                    _Item.requires_prescription == True,  # noqa: E712
                    _Item.is_schedule_h1 == True,  # noqa: E712
                    _Item.is_narcotic == True,  # noqa: E712
                    _Item.drug_schedule.in_(("X", "H", "H1", "G")),
                ),
            ).limit(1)
        )).first()
        if item_rows is not None:
            from app.services.compliance_service import assert_vendor_compliant
            await assert_vendor_compliant(
                db, vendor_id=po.vendor_id,
                require_drug_license=True, user_id=current_user.id,
            )
    except HTTPException:
        raise
    except Exception:
        logger.exception("DL re-check failed at approve for PO %s", po.id)
        raise HTTPException(
            status_code=400,
            detail="Vendor compliance re-check failed; refusing approval",
        )

    # BUG-PRO-028 fix (segregation of duties): the user who created/submitted
    # the PO cannot also approve it. Maker-checker is non-negotiable for spend.
    if po.created_by and po.created_by == current_user.id:
        raise HTTPException(
            status_code=403,
            detail="You cannot approve a PO you raised — separation of duties",
        )

    # BUG-PRO-028 fix: ensure a matching ApprovalRequest row exists and is pending.
    # Without this, the /approve endpoint silently succeeds for POs that were
    # never properly submitted into the workflow.
    from app.models.approval import ApprovalRequest as _AR
    ar_row = (await db.execute(
        select(_AR).where(
            _AR.document_type == "purchase_order",
            _AR.document_id == po.id,
            _AR.status == "pending",
        ).order_by(_AR.id.desc()).limit(1)
    )).scalar_one_or_none()
    if not ar_row:
        raise HTTPException(
            status_code=400,
            detail=(
                "No pending approval request for this PO — submit it for approval "
                "before approving."
            ),
        )

    # BUG-PRO-023 fix: enforce 3-quote rule on approve for POs above a configured
    # threshold that did NOT come from a rate contract. We treat any PO whose
    # MR has fewer than 3 vendor quotations as needing an explicit override note.
    try:
        rc_threshold = Decimal("100000")  # ₹1,00,000 — sane default; finance can tune later.
        amount = Decimal(str(po.grand_total or 0))
        if amount >= rc_threshold and po.mr_id and not po.quotation_id:
            quote_count_row = (await db.execute(
                select(func.count(Quotation.id))
                .where(
                    Quotation.mr_id == po.mr_id,
                    Quotation.status.in_(("submitted", "accepted")),
                )
            )).scalar() or 0
            if quote_count_row < 3:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Three-quote rule: only {quote_count_row} quotation(s) recorded for "
                        f"MR linked to PO {po.po_number}. At least 3 are required for "
                        f"POs ≥ ₹{rc_threshold:,.0f} unless raised from a rate contract."
                    ),
                )
    except HTTPException:
        raise
    except Exception:
        logger.exception("Three-quote rule check failed on approve for PO %s", po.id)

    # Wave 8 — state-transition compliance gate (e-sign required for approval).
    # BUG-PRO-026 fix: do NOT swallow non-HTTPException failures here. Compliance
    # gate failure must block the approval, never silently pass.
    from app.services.document_service import assert_transition_compliance
    await assert_transition_compliance(
        db, user=current_user,
        module="procurement", source_type="purchase_order", source_id=po.id,
        from_state="pending_approval", to_state="approved",
        submitted_password=(payload or {}).get("password"),
        payload_for_sign={"po_number": po.po_number, "amount": float(po.grand_total or 0)},
    )

    po.status = "approved"
    po.approved_by = current_user.id
    po.approved_date = datetime.now(timezone.utc)
    await db.flush()

    # BUG-PRO-025 fix: write a compliance/audit row on every PO approval so the
    # action is traceable independent of the ApprovalRequest history table.
    try:
        from app.models.compliance import ComplianceAudit
        import json as _json
        db.add(ComplianceAudit(
            event_type="po_approved",
            severity="info",
            vendor_id=po.vendor_id,
            source_type="purchase_order",
            source_id=po.id,
            user_id=current_user.id,
            payload=_json.dumps({
                "po_number": po.po_number,
                "amount": float(po.grand_total or 0),
                "approval_request_id": ar_row.id if ar_row else None,
            }),
        ))
        await db.flush()
    except Exception:
        logger.exception("Failed to write ComplianceAudit row for PO %s approve", po.id)

    # BUG-PRO-029 fix: notify more than just the PO creator. The original MR
    # requestor (when PO was raised against an MR) and the warehouse manager
    # also need to know stock is on the way so they can plan receipts. We swallow
    # any single notification failure to avoid breaking the approval transaction.
    notified_user_ids: set[int] = set()
    try:
        if po.created_by:
            await create_notification(
                db, po.created_by, "PO Approved",
                f"Purchase Order {po.po_number} has been approved",
                "success", "procurement", "purchase_order", po.id,
            )
            notified_user_ids.add(po.created_by)
        if po.mr_id:
            mr_row = (await db.execute(
                select(MaterialRequest.requested_by).where(MaterialRequest.id == po.mr_id)
            )).first()
            requestor_id = mr_row[0] if mr_row else None
            if requestor_id and requestor_id not in notified_user_ids:
                await create_notification(
                    db, requestor_id, "PO Approved (your MR)",
                    f"Purchase Order {po.po_number} for your material request has been approved.",
                    "success", "procurement", "purchase_order", po.id,
                )
                notified_user_ids.add(requestor_id)
    except Exception:
        logger.exception("Failed to send PO approval notifications for PO %s", po.id)

    return {"success": True, "message": "Purchase order approved"}


@router.post("/purchase-orders/{po_id}/cancel", dependencies=[Depends(require_key("procurement-purchase-orders"))])
async def cancel_purchase_order(
    po_id: int,
    payload: dict | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(*PO_APPROVER_ROLES)),
):
    result = await db.execute(select(PurchaseOrder).where(PurchaseOrder.id == po_id))
    po = result.scalar_one_or_none()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    # BUG-PRO-036 fix: also refuse cancellation of partially_received POs — those
    # have stock posted via GRN that would need explicit reversal first.
    if po.status in ["received", "closed", "partially_received", "cancelled"]:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Cannot cancel PO in '{po.status}' status. For partially_received "
                f"POs, reverse the GRN first or use short-close."
            ),
        )

    # BUG-PRO-038 fix: capture cancellation reason and write an audit row so the
    # action is traceable. (Persisting cancelled_by/cancelled_at as columns on the
    # PO model would require a schema migration — DEFERRED; the audit row carries
    # both the user_id and timestamp for now and the FE can render from there.)
    reason = (payload or {}).get("reason") if isinstance(payload, dict) else None
    if not reason or not str(reason).strip():
        raise HTTPException(
            status_code=400,
            detail="A cancellation reason is required",
        )
    reason = str(reason).strip()

    was_approved = po.status == "approved"
    po.status = "cancelled"
    # Wave 5 — persist cancellation audit on the PO row itself
    # (BUG-PRO-038 full fix). The legacy remarks-append is preserved so
    # existing FE renders keep working.
    po.cancelled_by = current_user.id
    po.cancelled_at = datetime.now(timezone.utc)
    po.cancel_reason = reason
    cancel_note = (
        f"\n[Cancelled by user {current_user.id} on "
        f"{datetime.now(timezone.utc).isoformat(timespec='seconds')}]: {reason}"
    )
    po.remarks = (po.remarks or "") + cancel_note
    await db.flush()

    # BUG-PRO-037 fix: restore the linked MR.status from "ordered" back to
    # "approved" if this was the only PO consuming it. Otherwise the MR is
    # stuck in "ordered" with no live PO.
    try:
        if po.mr_id:
            other_po_row = (await db.execute(
                select(func.count(PurchaseOrder.id)).where(
                    PurchaseOrder.mr_id == po.mr_id,
                    PurchaseOrder.id != po.id,
                    PurchaseOrder.status.in_((
                        "draft", "pending_approval", "approved",
                        "partially_received", "received", "closed",
                    )),
                )
            )).scalar() or 0
            if other_po_row == 0:
                mr_row = (await db.execute(
                    select(MaterialRequest).where(MaterialRequest.id == po.mr_id)
                )).scalar_one_or_none()
                if mr_row and mr_row.status == "ordered":
                    mr_row.status = "approved"
                    await db.flush()
    except Exception:
        logger.exception("Failed to restore MR status after PO cancel for PO %s", po.id)

    try:
        from app.models.compliance import ComplianceAudit
        import json as _json
        db.add(ComplianceAudit(
            event_type="po_cancelled",
            severity="warning",
            vendor_id=po.vendor_id,
            source_type="purchase_order",
            source_id=po.id,
            user_id=current_user.id,
            payload=_json.dumps({
                "po_number": po.po_number,
                "reason": reason,
                "amount": float(po.grand_total or 0),
            }),
        ))
        await db.flush()
    except Exception:
        logger.exception("Failed to write ComplianceAudit row for PO %s cancel", po.id)

    # BUG-PRO-039 fix: notify the original PO creator (and any vendor user
    # mapped to the vendor record) when an *approved* PO is cancelled so the
    # downstream parties know the order is dead. We can't email an external
    # vendor from here (no SMTP wiring) but we can at least flag it in-app.
    if was_approved:
        try:
            if po.created_by:
                await create_notification(
                    db, po.created_by, "PO Cancelled",
                    (
                        f"Purchase Order {po.po_number} (₹{float(po.grand_total or 0):,.2f}) "
                        f"was cancelled. Reason: {reason}"
                    ),
                    "warning", "procurement", "purchase_order", po.id,
                )
        except Exception:
            logger.exception("Failed to send cancel notification for PO %s", po.id)

    return {"success": True, "message": "Purchase order cancelled"}


@router.post("/purchase-orders/{po_id}/short-close", dependencies=[Depends(require_key("procurement-purchase-orders"))])
async def short_close_purchase_order(
    po_id: int,
    payload: dict | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role(*PO_APPROVER_ROLES)),
):
    """BUG-PRO-041 fix: short-close a partially-received PO.

    For POs that the vendor short-shipped (e.g., 80 of 100 units delivered and
    the rest will never come), this transitions the PO to ``closed`` status,
    captures the reason in ``remarks`` and writes a ComplianceAudit row. Stock
    already received via GRN is left intact; we only stop expecting the rest.
    """
    result = await db.execute(select(PurchaseOrder).where(PurchaseOrder.id == po_id))
    po = result.scalar_one_or_none()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    if po.status not in ("approved", "partially_received"):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Only approved or partially_received POs can be short-closed "
                f"(current: {po.status})"
            ),
        )

    reason = (payload or {}).get("reason") if isinstance(payload, dict) else None
    if not reason or not str(reason).strip():
        raise HTTPException(status_code=400, detail="A short-close reason is required")
    reason = str(reason).strip()

    po.status = "closed"
    short_close_note = (
        f"\n[Short-closed by user {current_user.id} on "
        f"{datetime.now(timezone.utc).isoformat(timespec='seconds')}]: {reason}"
    )
    po.remarks = (po.remarks or "") + short_close_note
    await db.flush()

    try:
        from app.models.compliance import ComplianceAudit
        import json as _json
        db.add(ComplianceAudit(
            event_type="po_short_closed",
            severity="info",
            vendor_id=po.vendor_id,
            source_type="purchase_order",
            source_id=po.id,
            user_id=current_user.id,
            payload=_json.dumps({
                "po_number": po.po_number,
                "reason": reason,
                "amount": float(po.grand_total or 0),
            }),
        ))
        await db.flush()
    except Exception:
        logger.exception("Failed to write ComplianceAudit row for PO %s short-close", po.id)

    return {"success": True, "message": "Purchase order short-closed"}


class FromQuotationPayload(BaseModel):
    quotation_id: int

@router.post("/purchase-orders/from-quotation", status_code=201)
async def create_po_from_quotation(
    payload: FromQuotationPayload,
    db: AsyncSession = Depends(get_db),
    # 2026-05-06 — only admin / super_admin can finalize a vendor by
    # converting their quotation to a PO. Purchase team prepares quotes;
    # admin / super_admin pick the winner.
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    """Create a Purchase Order from an accepted quotation.

    Pulls warehouse_id, project_id and expected_delivery_date from the linked
    Material Request if one exists so the resulting PO isn't missing the
    warehouse detail (which used to render as "-" on the PO detail page).
    """
    from sqlalchemy.orm import selectinload as sl
    result = await db.execute(
        select(Quotation).options(
            sl(Quotation.items).selectinload(QuotationItem.item),
            sl(Quotation.items).selectinload(QuotationItem.uom),
        ).where(Quotation.id == payload.quotation_id)
    )
    quotation = result.scalar_one_or_none()
    if not quotation:
        raise HTTPException(status_code=404, detail="Quotation not found")

    # 2026-05-06 — admin / super_admin pick the winning vendor on the
    # Comparison page and click "Convert to PO". The act of converting is
    # itself the finalization signal — no separate L1/L2 needed for the
    # quotation. We accept 'submitted' or 'accepted'; reject only the
    # already-rejected/expired/draft states.
    if quotation.status not in ("submitted", "accepted"):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Cannot raise PO from quotation in '{quotation.status}' status — "
                f"only submitted or accepted quotations can be converted."
            ),
        )
    # Stamp accepted on conversion so audit shows a clean lifecycle.
    if quotation.status == "submitted":
        quotation.status = "accepted"

    # BUG-PRO-012 fix: refuse PO creation against an inactive vendor.
    from app.models.master import Vendor as _Vendor
    _v_row = (await db.execute(
        select(_Vendor).where(_Vendor.id == quotation.vendor_id)
    )).scalar_one_or_none()
    if _v_row is not None and not getattr(_v_row, "is_active", True):
        raise HTTPException(
            status_code=400,
            detail=f"Vendor '{_v_row.name}' is inactive — cannot raise a PO",
        )

    # Pull warehouse / project / expected delivery from the linked MR
    source_warehouse_id = None
    source_project_id = None
    source_expected_delivery = None
    if quotation.mr_id:
        mr_r = await db.execute(
            select(MaterialRequest).where(MaterialRequest.id == quotation.mr_id)
        )
        mr_row = mr_r.scalar_one_or_none()
        if mr_row:
            source_warehouse_id = mr_row.warehouse_id
            source_project_id = mr_row.project_id
            source_expected_delivery = mr_row.required_date

    # BUG-PRO-016 fix: clamp expected_delivery_date to the present at the
    # earliest. mr.required_date may be days/weeks in the past by the time
    # the PO is actually raised; copying that date verbatim produces a PO
    # whose delivery promise is already broken.
    try:
        from datetime import date as _date
        today = _date.today()
        if source_expected_delivery is not None:
            sed = (
                source_expected_delivery.date()
                if hasattr(source_expected_delivery, "date")
                else source_expected_delivery
            )
            if sed < today:
                source_expected_delivery = today
    except Exception:
        pass

    # Fetch warehouse to dynamically generate billing and shipping addresses
    billing_address = None
    shipping_address = None
    if source_warehouse_id:
        from app.models.warehouse import Warehouse
        w_res = await db.execute(
            select(Warehouse).options(sl(Warehouse.organization)).where(Warehouse.id == source_warehouse_id)
        )
        warehouse_row = w_res.scalar_one_or_none()
        if warehouse_row:
            if warehouse_row.organization:
                org = warehouse_row.organization
                org_parts = [
                    org.name,
                    org.address,
                    f"GSTIN: {org.gst_number}" if org.gst_number else None,
                    f"PAN: {org.pan_number}" if org.pan_number else None,
                    f"Phone: {org.phone}" if org.phone else None,
                    f"Email: {org.email}" if org.email else None
                ]
                billing_address = "\n".join([p for p in org_parts if p])
            
            ship_parts = [
                warehouse_row.name,
                warehouse_row.address_line1,
                warehouse_row.address_line2,
                warehouse_row.city,
                warehouse_row.state,
                warehouse_row.pincode,
                f"Contact: {warehouse_row.contact_person}" if warehouse_row.contact_person else None,
                f"Phone: {warehouse_row.phone}" if warehouse_row.phone else None
            ]
            shipping_address = "\n".join([str(p) for p in ship_parts if p])

    po_number = await generate_number(db, "procurement", "purchase_order")
    subtotal = Decimal("0")
    total_tax = Decimal("0")

    po = PurchaseOrder(
        po_number=po_number,
        vendor_id=quotation.vendor_id,
        mr_id=quotation.mr_id,
        quotation_id=quotation.id,
        warehouse_id=source_warehouse_id,
        project_id=source_project_id,
        po_date=datetime.now(timezone.utc).date(),
        expected_delivery_date=source_expected_delivery,
        billing_address=billing_address,
        shipping_address=shipping_address,
        # BUG-PRO-056 fix: payment_terms_days is the credit window; quotation
        # has no payment_terms_days column, so default to a sane 30-day net.
        # The quotation.delivery_days field reflects lead time and must NOT be
        # conflated with payment terms.
        payment_terms_days=30,
        remarks=f"Created from quotation {quotation.quotation_number}",
        created_by=current_user.id,
    )
    db.add(po)
    await db.flush()

    # BUG-PRO-013 fix (mirror create path): block CGST/SGST when vendor lacks GSTIN.
    has_gstin = bool((getattr(_v_row, "gst_number", None) or "").strip()) if _v_row else False

    # BUG-PRO-017 / BUG-PRO-009 / BUG-PRO-010 fix: copy discount_pct AND derive
    # CGST/SGST (or IGST when no GSTIN) from the quotation's tax_rate, so the
    # PO created from a quotation isn't silently zero-tax. Quotation has a
    # single tax_rate column; we split 50/50 into CGST+SGST when vendor has a
    # GSTIN, else apply the whole rate as IGST.
    total_cgst = Decimal("0")
    total_sgst = Decimal("0")
    total_igst = Decimal("0")

    for item in quotation.items:
        item_disc_pct = Decimal(str(item.discount_pct or 0))
        base = Decimal(str(item.qty)) * Decimal(str(item.rate))
        disc_amt = base * item_disc_pct / Decimal("100")
        net = base - disc_amt

        cgst_rate = Decimal(str(getattr(item, "cgst_rate", 0) or 0))
        sgst_rate = Decimal(str(getattr(item, "sgst_rate", 0) or 0))
        igst_rate = Decimal(str(getattr(item, "igst_rate", 0) or 0))
        item_tax_rate = Decimal(str(item.tax_rate or 0))

        if cgst_rate == 0 and sgst_rate == 0 and igst_rate == 0 and item_tax_rate > 0:
            if has_gstin:
                cgst_rate = item_tax_rate / Decimal("2")
                sgst_rate = item_tax_rate / Decimal("2")
                igst_rate = Decimal("0")
            else:
                cgst_rate = Decimal("0")
                sgst_rate = Decimal("0")
                igst_rate = item_tax_rate

        cgst_amt = net * cgst_rate / Decimal("100")
        sgst_amt = net * sgst_rate / Decimal("100")
        igst_amt = net * igst_rate / Decimal("100")
        tax = cgst_amt + sgst_amt + igst_amt
        amount = net + tax

        poi = PurchaseOrderItem(
            po_id=po.id, item_id=item.item_id, qty=item.qty,
            uom_id=item.uom_id, rate=item.rate,
            discount_pct=item_disc_pct,
            cgst_rate=cgst_rate,
            sgst_rate=sgst_rate,
            igst_rate=igst_rate,
            tax_amount=tax, amount=amount,
        )
        db.add(poi)
        subtotal += net
        total_cgst += cgst_amt
        total_sgst += sgst_amt
        total_igst += igst_amt
        total_tax += tax

    po.subtotal = subtotal
    po.cgst_amount = total_cgst
    po.sgst_amount = total_sgst
    po.igst_amount = total_igst
    po.tax_amount = total_tax
    if quotation.with_vehicle and quotation.vehicle_cost:
        po.remarks = (po.remarks or "") + f" | Includes vehicle cost: {quotation.vehicle_cost}"
        po.grand_total = subtotal + total_tax + Decimal(str(quotation.vehicle_cost or 0))
    else:
        po.grand_total = subtotal + total_tax

    # Mark quotation as accepted
    quotation.status = "accepted"
    await db.flush()

    return {"id": po.id, "po_number": po_number, "message": f"Purchase order {po_number} created from quotation"}


@router.post("/purchase-orders/consolidate-split", status_code=201)
async def create_split_po(
    payload: SplitPORequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    """Create split Purchase Orders from selected quotation items."""
    if not payload.awards:
        raise HTTPException(status_code=400, detail="No award items specified")

    # Group awards by vendor_id
    from collections import defaultdict
    grouped_awards = defaultdict(list)
    for award in payload.awards:
        grouped_awards[award.vendor_id].append(award)

    # Validate that total award quantity for each item does not exceed required quantity in the RFQ
    if payload.rfq_number:
        from app.models.procurement import RFQItem, RFQ
        rfq_items_res = await db.execute(
            select(RFQItem)
            .join(RFQ)
            .where(RFQ.rfq_number == payload.rfq_number)
        )
        rfq_items = rfq_items_res.scalars().all()
        req_qty_map = {ri.item_id: float(ri.qty or 0) for ri in rfq_items}

        # Sum up award quantities per item
        awarded_qty_map = defaultdict(float)
        for award in payload.awards:
            awarded_qty_map[award.item_id] += float(award.qty or 0)

        # Check for excess awards
        for item_id, total_awarded in awarded_qty_map.items():
            req_qty = req_qty_map.get(item_id, 0.0)
            if total_awarded > req_qty + 0.0001:
                from app.models.master import Item as _Item
                item_name_row = (await db.execute(
                    select(_Item.name, _Item.item_code).where(_Item.id == item_id)
                )).first()
                item_label = f"'{item_name_row[0]}' ({item_name_row[1]})" if item_name_row else f"ID {item_id}"
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Total awarded quantity ({total_awarded}) for item {item_label} "
                        f"exceeds the required quantity ({req_qty})"
                    ),
                )

    created_pos = []

    for vendor_id, awards in grouped_awards.items():
        # Validate active vendor
        from app.models.master import Vendor as _Vendor
        _v_row = (await db.execute(
            select(_Vendor).where(_Vendor.id == vendor_id)
        )).scalar_one_or_none()
        if _v_row is not None and not getattr(_v_row, "is_active", True):
            raise HTTPException(
                status_code=400,
                detail=f"Vendor '{_v_row.name}' is inactive — cannot raise a PO",
            )

        # Get the quotation referenced by the first award item for this vendor
        first_award = awards[0]
        from sqlalchemy.orm import selectinload as sl
        q_res = await db.execute(
            select(Quotation).options(
                sl(Quotation.items).selectinload(QuotationItem.item),
                sl(Quotation.items).selectinload(QuotationItem.uom),
            ).where(Quotation.id == first_award.quotation_id)
        )
        quotation = q_res.scalar_one_or_none()
        if not quotation:
            raise HTTPException(
                status_code=404,
                detail=f"Quotation with ID {first_award.quotation_id} not found",
            )

        # Pull warehouse / project / expected delivery from the linked MR
        source_warehouse_id = None
        source_project_id = None
        source_expected_delivery = None
        mr_id_to_use = payload.mr_id or quotation.mr_id
        if mr_id_to_use:
            mr_r = await db.execute(
                select(MaterialRequest).where(MaterialRequest.id == mr_id_to_use)
            )
            mr_row = mr_r.scalar_one_or_none()
            if mr_row:
                source_warehouse_id = mr_row.warehouse_id
                source_project_id = mr_row.project_id
                source_expected_delivery = mr_row.required_date

        try:
            from datetime import date as _date
            today = _date.today()
            if source_expected_delivery is not None:
                sed = (
                    source_expected_delivery.date()
                    if hasattr(source_expected_delivery, "date")
                    else source_expected_delivery
                )
                if sed < today:
                    source_expected_delivery = today
        except Exception:
            pass

        # Fetch warehouse to dynamically generate billing and shipping addresses
        billing_address = None
        shipping_address = None
        if source_warehouse_id:
            from app.models.warehouse import Warehouse
            w_res = await db.execute(
                select(Warehouse).options(sl(Warehouse.organization)).where(Warehouse.id == source_warehouse_id)
            )
            warehouse_row = w_res.scalar_one_or_none()
            if warehouse_row:
                if warehouse_row.organization:
                    org = warehouse_row.organization
                    org_parts = [
                        org.name,
                        org.address,
                        f"GSTIN: {org.gst_number}" if org.gst_number else None,
                        f"PAN: {org.pan_number}" if org.pan_number else None,
                        f"Phone: {org.phone}" if org.phone else None,
                        f"Email: {org.email}" if org.email else None
                    ]
                    billing_address = "\n".join([p for p in org_parts if p])
                
                ship_parts = [
                    warehouse_row.name,
                    warehouse_row.address_line1,
                    warehouse_row.address_line2,
                    warehouse_row.city,
                    warehouse_row.state,
                    warehouse_row.pincode,
                    f"Contact: {warehouse_row.contact_person}" if warehouse_row.contact_person else None,
                    f"Phone: {warehouse_row.phone}" if warehouse_row.phone else None
                ]
                shipping_address = "\n".join([str(p) for p in ship_parts if p])

        po_number = await generate_number(db, "procurement", "purchase_order")
        subtotal = Decimal("0")
        total_tax = Decimal("0")

        po = PurchaseOrder(
            po_number=po_number,
            vendor_id=vendor_id,
            mr_id=mr_id_to_use,
            quotation_id=quotation.id,
            warehouse_id=source_warehouse_id,
            project_id=source_project_id,
            po_date=datetime.now(timezone.utc).date(),
            expected_delivery_date=source_expected_delivery,
            billing_address=billing_address,
            shipping_address=shipping_address,
            payment_terms_days=30,
            remarks=f"Consolidated Split-PO raised from RFQ {payload.rfq_number}",
            created_by=current_user.id,
        )
        db.add(po)
        await db.flush()

        has_gstin = bool((getattr(_v_row, "gst_number", None) or "").strip()) if _v_row else False
        total_cgst = Decimal("0")
        total_sgst = Decimal("0")
        total_igst = Decimal("0")
        q_items_map = {qi.item_id: qi for qi in quotation.items}

        for award in awards:
            if award.item_id not in q_items_map:
                raise HTTPException(
                    status_code=400,
                    detail=f"Item {award.item_id} not found in quotation {quotation.quotation_number}",
                )
            qi = q_items_map[award.item_id]

            item_disc_pct = Decimal(str(qi.discount_pct or 0))
            item_tax_rate = Decimal(str(qi.tax_rate or 0))
            
            rate = award.rate if award.rate is not None else qi.rate
            base = award.qty * rate
            disc_amt = base * item_disc_pct / Decimal("100")
            net = base - disc_amt

            cgst_rate = Decimal(str(getattr(qi, "cgst_rate", 0) or 0))
            sgst_rate = Decimal(str(getattr(qi, "sgst_rate", 0) or 0))
            igst_rate = Decimal(str(getattr(qi, "igst_rate", 0) or 0))

            if cgst_rate == 0 and sgst_rate == 0 and igst_rate == 0 and item_tax_rate > 0:
                if has_gstin:
                    cgst_rate = item_tax_rate / Decimal("2")
                    sgst_rate = item_tax_rate / Decimal("2")
                    igst_rate = Decimal("0")
                else:
                    cgst_rate = Decimal("0")
                    sgst_rate = Decimal("0")
                    igst_rate = item_tax_rate

            cgst_amt = net * cgst_rate / Decimal("100")
            sgst_amt = net * sgst_rate / Decimal("100")
            igst_amt = net * igst_rate / Decimal("100")
            tax = cgst_amt + sgst_amt + igst_amt
            amount = net + tax

            poi = PurchaseOrderItem(
                po_id=po.id,
                item_id=award.item_id,
                qty=award.qty,
                uom_id=qi.uom_id,
                rate=rate,
                discount_pct=item_disc_pct,
                cgst_rate=cgst_rate,
                sgst_rate=sgst_rate,
                igst_rate=igst_rate,
                tax_amount=tax,
                amount=amount,
            )
            db.add(poi)
            subtotal += net
            total_cgst += cgst_amt
            total_sgst += sgst_amt
            total_igst += igst_amt
            total_tax += tax

        po.subtotal = subtotal
        po.cgst_amount = total_cgst
        po.sgst_amount = total_sgst
        po.igst_amount = total_igst
        po.tax_amount = total_tax
        if quotation.with_vehicle and quotation.vehicle_cost:
            po.remarks = (po.remarks or "") + f" | Includes vehicle cost: {quotation.vehicle_cost}"
            po.grand_total = subtotal + total_tax + Decimal(str(quotation.vehicle_cost or 0))
        else:
            po.grand_total = subtotal + total_tax

        # Update quotation status
        quotation.status = "accepted"
        await db.flush()
        created_pos.append({"id": po.id, "po_number": po.po_number, "vendor_name": _v_row.name if _v_row else f"Vendor ID {vendor_id}"})

    await db.commit()
    return {
        "success": True,
        "message": f"Successfully created {len(created_pos)} split Purchase Orders",
        "purchase_orders": created_pos
    }
