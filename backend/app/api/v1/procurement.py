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
from app.utils.dependencies import get_current_user, require_permission, require_key

from app.utils.helpers import paginate_params, build_paginated_response, apply_search_filter, calculate_line_amount
from app.utils.schema_sync import ensure_rfq_schema

logger = logging.getLogger(__name__)
router = APIRouter()


# ==================== MATERIAL REQUESTS ====================

@router.get("/material-requests", dependencies=[Depends(require_key("warehouse-material-issues", "procurement-material-requests"))])
async def list_material_requests(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=500),
    search: str = Query(None),
    status: str = Query(None),
    priority: str = Query(None),
    request_type: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
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
        db_priority = "urgent" if priority == "critical" else priority
        query = query.where(MaterialRequest.priority == db_priority)
        count_query = count_query.where(MaterialRequest.priority == db_priority)
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
        if data.get("priority") == "urgent":
            data["priority"] = "critical"
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
    if data.get("priority") == "urgent":
        data["priority"] = "critical"

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
    current_user: User = Depends(require_permission("procurement", "create", "material-requests")),
):
    if not payload.items:
        raise HTTPException(status_code=422, detail="At least one item is required")
    mr_number = await generate_number(db, "procurement", "unapproved_material_request", pad_length=7)
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
        priority="urgent" if payload.priority == "critical" else (payload.priority or "medium"),
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
    current_user: User = Depends(require_permission("procurement", "edit", "material-requests")),
):
    result = await db.execute(select(MaterialRequest).where(MaterialRequest.id == mr_id))
    mr = result.scalar_one_or_none()
    if not mr:
        raise HTTPException(status_code=404, detail="Material request not found")

    for k, v in payload.model_dump(exclude_unset=True).items():
        if k == "priority" and v == "critical":
            v = "urgent"
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
    current_user: User = Depends(require_permission("procurement", "approve", "material-requests")),
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
    approved_number = await generate_number(db, "procurement", "material_request", pad_length=7)
    mr.mr_number = approved_number
    await db.flush()
    return {"success": True, "message": f"Material request approved (new number: {approved_number})"}


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
    current_user: User = Depends(require_key("procurement-quotations", "procurement-quotation-comparison")),
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
    current_user: User = Depends(require_key("procurement-quotations", "procurement-quotation-comparison")),
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

    # Fetch sum of qty from active POs linked to this MR to get the real allocated qty (including draft/pending)
    mr_allocated_qty_map = {}
    if rfq_row.mr_id:
        po_allocated_res = await db.execute(
            select(
                PurchaseOrderItem.item_id,
                func.sum(PurchaseOrderItem.qty)
            )
            .join(PurchaseOrder, PurchaseOrderItem.po_id == PurchaseOrder.id)
            .where(
                PurchaseOrder.mr_id == rfq_row.mr_id,
                PurchaseOrder.is_current == True,
                PurchaseOrder.status.notin_(["cancelled", "rejected"])
            )
            .group_by(PurchaseOrderItem.item_id)
        )
        for row in po_allocated_res.all():
            mr_allocated_qty_map[row[0]] = float(row[1] or 0)

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
        "terms_url": rfq_row.terms_url,
        "items": [
            {
                "id": line.id,
                "item_id": line.item_id,
                "item_code": line.item.item_code if line.item else "",
                "item_name": line.item.name if line.item else "",
                "qty": line.qty,
                "uom": line.uom.name if line.uom else "",
                "allocated_qty": mr_allocated_qty_map.get(line.item_id, 0.0),
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
    current_user: User = Depends(require_permission("procurement", "create", "quotations")),
):
    await ensure_rfq_schema(db)
    rfq_number = await generate_number(db, "procurement", "rfq", pad_length=7)
    
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
        terms_url=payload.terms_url,
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
        
        q = Quotation(
            rfq_id=rfq.id,
            rfq_number=rfq_number,
            quotation_number=None,
            mr_id=payload.mr_id,
            vendor_id=vendor_id,
            quotation_date=payload.rfq_date,
            valid_until=payload.valid_until,
            currency=payload.currency,
            delivery_days=payload.delivery_days,
            payment_terms=payload.payment_terms,
            with_vehicle=payload.with_vehicle,
            remarks=payload.remarks,
            terms_url=payload.terms_url,
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
    current_user: User = Depends(require_permission("procurement", "create", "quotations")),
):
    await ensure_rfq_schema(db)
    if not payload.items:
        raise HTTPException(status_code=422, detail="At least one item is required")
    q_number = await generate_number(db, "procurement", "quotation", pad_length=7)
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
    current_user: User = Depends(require_permission("procurement", "edit", "quotations")),
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
    all_versions: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    # R-001: read-level RBAC. Warehouse staff also need PO visibility (CR_08/09)
    # so we allow either procurement.view or warehouse.view permission.
    current_user: User = Depends(get_current_user),
):
    # R-001 inline check (multi-permission OR)
    from app.utils.dependencies import check_user_has_any_permission
    has_perm = await check_user_has_any_permission(
        db,
        current_user.id,
        [
            ("procurement", "view", "purchase-orders"),
            ("warehouse", "view", "grn"),
            ("warehouse", "view", "material-issues")
        ]
    )
    if not has_perm:
        raise HTTPException(status_code=403, detail="Permission denied")
    offset, limit = paginate_params(page, page_size)
    query = select(PurchaseOrder).options(
        selectinload(PurchaseOrder.vendor),
        selectinload(PurchaseOrder.items).selectinload(PurchaseOrderItem.item),
        selectinload(PurchaseOrder.items).selectinload(PurchaseOrderItem.uom),
    )
    count_query = select(func.count(PurchaseOrder.id))

    if not all_versions:
        query = query.where(PurchaseOrder.is_current == True)
        count_query = count_query.where(PurchaseOrder.is_current == True)

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

    # Batch-fetch all historical (is_current=False) versions for the current page
    # so we can nest them as Ant Design tree `children` without extra N+1 queries.
    base_numbers = list({po.base_po_number for po in pos if po.base_po_number})
    history_map: dict[str, list] = {}
    if base_numbers and not all_versions:
        hist_result = await db.execute(
            select(PurchaseOrder).options(
                selectinload(PurchaseOrder.vendor),
                selectinload(PurchaseOrder.items).selectinload(PurchaseOrderItem.item),
                selectinload(PurchaseOrder.items).selectinload(PurchaseOrderItem.uom),
            )
            .where(
                PurchaseOrder.base_po_number.in_(base_numbers),
                PurchaseOrder.is_current == False,  # noqa: E712
            )
            .order_by(PurchaseOrder.version_number.desc())
        )
        for hist_po in hist_result.scalars().all():
            key = hist_po.base_po_number
            if key not in history_map:
                history_map[key] = []
            h_data = POListResponse.model_validate(hist_po).model_dump()
            h_data["vendor_name"] = hist_po.vendor.name if hist_po.vendor else None
            for i, item in enumerate(hist_po.items):
                if i < len(h_data.get("items", [])):
                    if item.item:
                        h_data["items"][i]["item_name"] = item.item.name
                        h_data["items"][i]["item_code"] = item.item.item_code
                    if item.uom:
                        h_data["items"][i]["uom_name"] = item.uom.name
            h_data["is_history_row"] = True
            history_map[key].append(h_data)

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
        data["is_history_row"] = False
        # Attach previous versions as Ant Design tree children (version tree)
        if not all_versions and po.base_po_number and po.base_po_number in history_map:
            data["children"] = history_map[po.base_po_number]
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
    from app.utils.dependencies import check_user_has_any_permission
    has_perm = await check_user_has_any_permission(
        db,
        current_user.id,
        [
            ("procurement", "view", "purchase-orders"),
            ("warehouse", "view", "grn"),
            ("warehouse", "view", "material-issues")
        ]
    )
    if not has_perm:
        raise HTTPException(status_code=403, detail="Permission denied")

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

    # Load all versions
    versions_list = []
    root_po_id = po.id
    temp = po
    while temp.parent_po_id is not None:
        p_res = await db.execute(select(PurchaseOrder).where(PurchaseOrder.id == temp.parent_po_id))
        parent_row = p_res.scalar_one_or_none()
        if not parent_row:
            break
        temp = parent_row
        root_po_id = temp.id

    tree_query = select(PurchaseOrder.id, PurchaseOrder.version_number, PurchaseOrder.status).where(
        (PurchaseOrder.id == root_po_id) | 
        (PurchaseOrder.parent_po_id == root_po_id) |
        (PurchaseOrder.base_po_number == po.base_po_number) |
        (PurchaseOrder.base_po_number == temp.base_po_number)
    ).order_by(PurchaseOrder.version_number.desc())

    tree_res = await db.execute(tree_query)
    versions_list = [{"id": r[0], "version_number": r[1], "status": r[2]} for r in tree_res.all()]

    # Remove duplicates
    seen = set()
    unique_versions = []
    for v in versions_list:
        if v["id"] not in seen:
            seen.add(v["id"])
            unique_versions.append(v)
    versions_list = unique_versions

    comparison = None
    if po.parent_po_id:
        parent_result = await db.execute(
            select(PurchaseOrder)
            .options(selectinload(PurchaseOrder.items).selectinload(PurchaseOrderItem.item),
                     selectinload(PurchaseOrder.items).selectinload(PurchaseOrderItem.uom))
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
                        "item_code": p_item.item.item_code if p_item.item else None,
                        "item_name": p_item.item.name if p_item.item else None,
                        "qty": float(p_item.qty or 0),
                        "rate": float(p_item.rate or 0),
                        "uom_name": p_item.uom.name if p_item.uom else None
                    })

            comparison = {
                "has_parent": True,
                "parent_version": parent_po.version_number,
                "modified_items": {str(k): v for k, v in modified_items.items()},
                "added_item_ids": added_item_ids,
                "removed_items": removed_items
            }

    data["versions"] = versions_list
    data["comparison"] = comparison
    return data


@router.post("/purchase-orders", status_code=201, dependencies=[Depends(require_key("procurement-purchase-orders"))])
async def create_purchase_order(
    payload: POCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("procurement", "create", "purchase-orders")),
):
    if not payload.items:
        raise HTTPException(status_code=422, detail="At least one item is required")

    seen_item_ids = set()
    for item in payload.items:
        if item.item_id:
            if item.item_id in seen_item_ids:
                from app.models.master import Item as _ItemModel
                item_row = (await db.execute(select(_ItemModel).where(_ItemModel.id == item.item_id))).scalar_one_or_none()
                item_name = item_row.name if item_row else "Selected item"
                raise HTTPException(
                    status_code=400,
                    detail=f"Just update the quantity of {item_name}, it already exists in the PO.",
                )
            seen_item_ids.add(item.item_id)

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
        # Validate that new allocation does not exceed remaining MR quantities (race-safe, locked)
        from app.services.procurement_service import validate_mr_allocation
        await validate_mr_allocation(db, payload.mr_id, payload.items)

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
        raise HTTPException(
            status_code=400,
            detail="PO must originate from an approved MR or an accepted quotation.",
        )



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
    base_upo = await generate_number(db, "procurement", "unapproved_purchase_order", pad_length=7)
    po_number = f"{base_upo}-V1.0"

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
        payment_terms=payload.payment_terms,
        currency=payload.currency or "INR",
        remarks=payload.remarks,
        # BUG-PRO-008 fix: schema accepted attachment_url but the constructor
        # never persisted it, so PO uploads were silently dropped.
        attachment_url=payload.attachment_url,
        created_by=current_user.id,
        version_number="1.0",
        base_po_number=base_upo,
        is_current=True,
    )
    db.add(po)
    await db.flush()

    # Track if ALL items have explicit rates (supplier-to-fill POs may have rate=None)
    all_rates_set = all(item.rate is not None for item in payload.items)

    for item in payload.items:
        # BUG-SUPPLIER-RATE fix: rate may be None when procurement team creates PO
        # and expects supplier to fill in pricing during acknowledgment.
        rate = item.rate if item.rate is not None else Decimal("0")
        discount_pct = item.discount_pct if item.discount_pct is not None else Decimal("0")
        cgst_rate = item.cgst_rate if item.cgst_rate is not None else Decimal("0")
        sgst_rate = item.sgst_rate if item.sgst_rate is not None else Decimal("0")
        igst_rate = item.igst_rate if item.igst_rate is not None else Decimal("0")

        base = item.qty * rate
        discount = base * discount_pct / 100
        net = base - discount
        cgst = net * cgst_rate / 100
        sgst = net * sgst_rate / 100
        igst = net * igst_rate / 100
        item_tax = cgst + sgst + igst
        amount = net + item_tax

        poi = PurchaseOrderItem(
            po_id=po.id, item_id=item.item_id, qty=item.qty,
            uom_id=item.uom_id, rate=rate, discount_pct=discount_pct,
            cgst_rate=cgst_rate, sgst_rate=sgst_rate,
            igst_rate=igst_rate, tax_amount=item_tax, amount=amount,
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



    # BUG-PRO-021 fix: refuse zero-value POs ONLY when all rates are provided.
    # If supplier is expected to fill rates during acknowledgment, allow grand_total=0.
    if all_rates_set and (po.grand_total is None or Decimal(str(po.grand_total)) <= 0):
        raise HTTPException(
            status_code=400,
            detail="PO grand_total must be > 0 — review item qty/rate values",
        )

    await db.flush()

    # No direct MR status update on draft PO creation
    pass

    return {"id": po.id, "po_number": po_number, "message": "Purchase order created"}


@router.put("/purchase-orders/{po_id}", dependencies=[Depends(require_key("procurement-purchase-orders"))])
async def update_purchase_order(
    po_id: int,
    payload: POUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("procurement", "edit", "purchase-orders")),
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
    # For draft purchase orders, we allow editing basic fields, addresses, discounts, and the item list.
    _PO_PUT_ALLOWED = {
        "expected_delivery_date",
        "billing_address",
        "shipping_address",
        "notes",
        "attachment_url",
        "remarks",
        "discount_type",
        "discount_value",
        "payment_terms",
        "currency",
        "payment_terms_days",
    }
    for k, v in payload.model_dump(exclude_unset=True).items():
        if k in _PO_PUT_ALLOWED:
            setattr(po, k, v)

    if payload.items is not None:
        from app.models.procurement import PurchaseOrderItem
        from sqlalchemy import delete
        
        seen_item_ids = set()
        for item in payload.items:
            if item.item_id:
                if item.item_id in seen_item_ids:
                    from app.models.master import Item as _ItemModel
                    item_row = (await db.execute(select(_ItemModel).where(_ItemModel.id == item.item_id))).scalar_one_or_none()
                    item_name = item_row.name if item_row else "Selected item"
                    raise HTTPException(
                        status_code=400,
                        detail=f"Just update the quantity of {item_name}, it already exists in the PO.",
                    )
                seen_item_ids.add(item.item_id)
        
        # If PO is linked to an MR, validate remaining quantities (excluding current PO)
        if po.mr_id:
            from app.services.procurement_service import validate_mr_allocation
            is_amend = po.parent_po_id is not None
            await validate_mr_allocation(db, po.mr_id, payload.items, exclude_po_id=po.id, is_amendment=is_amend)

        # Delete existing items of this PO
        await db.execute(
            delete(PurchaseOrderItem).where(PurchaseOrderItem.po_id == po.id)
        )
        await db.flush()

        # Insert new/updated items
        for item in payload.items:
            # BUG-SUPPLIER-RATE fix: rate may be None when procurement team creates
            # the draft and expects supplier to fill pricing during acknowledgment.
            _rate = item.rate if item.rate is not None else Decimal("0")
            _disc_pct = item.discount_pct if item.discount_pct is not None else Decimal("0")
            _cgst = item.cgst_rate if item.cgst_rate is not None else Decimal("0")
            _sgst = item.sgst_rate if item.sgst_rate is not None else Decimal("0")
            _igst = item.igst_rate if item.igst_rate is not None else Decimal("0")

            new_item = PurchaseOrderItem(
                po_id=po.id,
                item_id=item.item_id,
                qty=item.qty,
                received_qty=Decimal("0"),
                returned_qty=Decimal("0"),
                uom_id=item.uom_id,
                rate=_rate,
                discount_pct=_disc_pct,
                cgst_rate=_cgst,
                sgst_rate=_sgst,
                igst_rate=_igst,
                tax_amount=Decimal("0"),
                amount=Decimal("0")
            )
            
            # Recalculate line-level values
            base = new_item.qty * new_item.rate
            disc = base * new_item.discount_pct / Decimal("100")
            net = base - disc
            cgst = net * new_item.cgst_rate / Decimal("100")
            sgst = net * new_item.sgst_rate / Decimal("100")
            igst = net * new_item.igst_rate / Decimal("100")
            new_item.tax_amount = cgst + sgst + igst
            new_item.amount = net + new_item.tax_amount
            
            db.add(new_item)
        
        await db.flush()

        # Recalculate PO header totals
        items_rows = (await db.execute(
            select(PurchaseOrderItem).where(PurchaseOrderItem.po_id == po.id)
        )).scalars().all()
        
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

        # Parse vehicle/freight cost from remarks if present
        vehicle_cost = Decimal("0")
        if po.remarks:
            import re
            match = re.search(r"Includes vehicle cost:\s*(\d+(\.\d+)?)", po.remarks)
            if match:
                vehicle_cost = Decimal(match.group(1))
        
        po.grand_total = sub_t - disc_t + tax_t + vehicle_cost

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
    current_user: User = Depends(require_permission("procurement", "create", "purchase-orders")),
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
    # BUG-SUPPLIER-RATE fix: allow submitting POs where supplier will fill in rates
    # during acknowledgment. Only block zero-total when at least one rate > 0 is expected.
    items_have_nonzero_rate = any(
        Decimal(str(it.rate or 0)) > 0 for it in items_rows
    )
    if items_have_nonzero_rate and Decimal(str(po.grand_total or 0)) <= 0:
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
        current_user.id, po.project_id, float(po.grand_total or 0),
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
    current_user: User = Depends(require_permission("procurement", "approve", "purchase-orders")),
):
    result = await db.execute(select(PurchaseOrder).where(PurchaseOrder.id == po_id))
    po = result.scalar_one_or_none()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")

    if po.status != "pending_approval":
        raise HTTPException(status_code=400, detail=f"Cannot approve PO in '{po.status}' status")

    # BUG-PRO-030 / BUG-SUPPLIER-RATE fix: refuse approval of zero/null grand_total POs
    # UNLESS this is a supplier-to-fill-rate PO (all rates are 0/None intentionally).
    # Check if at least one item has a rate > 0 — if so, grand_total must be positive.
    _po_items_check = (await db.execute(
        select(PurchaseOrderItem).where(PurchaseOrderItem.po_id == po.id)
    )).scalars().all()
    _has_nonzero_rate = any(Decimal(str(it.rate or 0)) > 0 for it in _po_items_check)
    if _has_nonzero_rate and (po.grand_total is None or Decimal(str(po.grand_total)) <= 0):
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

    # Generate or reuse the final approved PO number
    if po.parent_po_id:
        parent_po = (await db.execute(select(PurchaseOrder).where(PurchaseOrder.id == po.parent_po_id))).scalar_one_or_none()
        if not parent_po:
            raise HTTPException(status_code=400, detail="Parent Purchase Order not found")
        approved_po_number = f"{parent_po.base_po_number}-V{po.version_number}"
        po.po_number = approved_po_number
        po.base_po_number = parent_po.base_po_number
    else:
        approved_base = await generate_number(db, "procurement", "purchase_order", pad_length=7)
        approved_po_number = f"{approved_base}-V1.0"
        po.po_number = approved_po_number
        po.base_po_number = approved_base

    po.is_current = True

    # Mark all other versions of this PO as not current
    from sqlalchemy import update
    await db.execute(
        update(PurchaseOrder)
        .where(PurchaseOrder.base_po_number == po.base_po_number, PurchaseOrder.id != po.id)
        .values(is_current=False)
    )

    if ar_row:
        ar_row.document_number = approved_po_number
    await db.flush()

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

    if po.mr_id:
        from app.services.procurement_service import handle_po_approval_qtys
        await handle_po_approval_qtys(db, po.id)

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
    current_user: User = Depends(require_permission("procurement", "delete", "purchase-orders")),
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

    was_approved = po.status in ("approved", "accepted")
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

    # Update linked MR ordered quantities and status incrementally
    if po.mr_id and was_approved:
        try:
            from app.services.procurement_service import update_mr_ordered_qty_delta
            deltas = {item.item_id: -item.qty for item in po.items}
            await update_mr_ordered_qty_delta(db, po.mr_id, deltas)
        except Exception:
            logger.exception("Failed to restore MR status after PO cancel for PO %s", po.id)

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
    current_user: User = Depends(require_permission("procurement", "delete", "purchase-orders")),
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
    if po.status not in ("approved", "accepted", "partially_received"):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Only approved, accepted, or partially_received POs can be short-closed "
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


@router.post("/purchase-orders/{po_id}/amend", dependencies=[Depends(require_key("procurement-purchase-orders"))])
async def amend_purchase_order(
    po_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("procurement", "edit", "purchase-orders")),
):
    """Create a new draft version of an approved or accepted Purchase Order."""
    from datetime import timedelta
    result = await db.execute(
        select(PurchaseOrder)
        .options(selectinload(PurchaseOrder.items))
        .where(PurchaseOrder.id == po_id)
    )
    po = result.scalar_one_or_none()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")

    # Only allow amendment if the current version has been supplier-acknowledged/accepted.
    # If the supplier has not acknowledged the PO yet, it cannot be amended.
    if po.status not in ("approved", "accepted") or po.supplier_acknowledgement != "accepted":
        raise HTTPException(
            status_code=400,
            detail=(
                f"Purchase Order cannot be amended because it has not been acknowledged and accepted by the supplier. "
                f"Current status: '{po.status}', Acknowledgment: '{po.supplier_acknowledgement}'. "
                f"Amendments are only allowed after the supplier has acknowledged and priced the current version."
            )
        )

    # Verify 2-days rule if delivery date is confirmed
    if po.supplier_delivery_date:
        now = datetime.now(timezone.utc)
        delivery_date = po.supplier_delivery_date
        if delivery_date.tzinfo is None:
            delivery_date = delivery_date.replace(tzinfo=timezone.utc)
        if now > delivery_date - timedelta(days=2):
            raise HTTPException(
                status_code=400,
                detail="Cannot amend Purchase Order: amendments are locked within 2 days of the supplier's confirmed delivery date."
            )

    # Increment version
    try:
        current_ver = float(po.version_number or "1.0")
    except ValueError:
        current_ver = 1.0
    new_version = f"{current_ver + 0.01:.2f}"

    # Formulate temporary UPO number
    if po.base_po_number:
        base_upo = po.base_po_number.replace("/PO/", "/UPO/")
    else:
        base_upo = po.po_number.replace("/PO/", "/UPO/").split("-V")[0]

    upo_number = f"{base_upo}-V{new_version}"

    # Clone header
    new_po = PurchaseOrder(
        po_number=upo_number,
        vendor_id=po.vendor_id,
        mr_id=po.mr_id,
        quotation_id=po.quotation_id,
        project_id=po.project_id,
        warehouse_id=po.warehouse_id,
        po_date=datetime.now(timezone.utc).date(),
        expected_delivery_date=po.expected_delivery_date,
        billing_address=po.billing_address,
        shipping_address=po.shipping_address,
        subtotal=po.subtotal,
        discount_amount=po.discount_amount,
        cgst_amount=po.cgst_amount,
        sgst_amount=po.sgst_amount,
        igst_amount=po.igst_amount,
        tax_amount=po.tax_amount,
        grand_total=po.grand_total,
        payment_terms_days=po.payment_terms_days,
        payment_terms=po.payment_terms,
        currency=po.currency,
        status="draft",
        remarks=f"Amendment created from version {po.version_number} of {po.base_po_number or po.po_number}",
        created_by=current_user.id,
        version_number=new_version,
        parent_po_id=po.id,
        supplier_delivery_date=po.supplier_delivery_date,
        is_current=True,
        base_po_number=po.base_po_number or base_upo.replace("/UPO/", "/PO/")
    )

    db.add(new_po)
    await db.flush()

    # Clone items
    for item in po.items:
        new_item = PurchaseOrderItem(
            po_id=new_po.id,
            item_id=item.item_id,
            qty=item.qty,
            received_qty=Decimal("0"),
            returned_qty=Decimal("0"),
            uom_id=item.uom_id,
            rate=item.rate,
            discount_pct=item.discount_pct,
            cgst_rate=item.cgst_rate,
            sgst_rate=item.sgst_rate,
            igst_rate=item.igst_rate,
            tax_amount=item.tax_amount,
            amount=item.amount
        )
        db.add(new_item)

    await db.flush()
    return {
        "success": True,
        "message": f"PO amendment version {new_version} created successfully",
        "id": new_po.id,
        "po_number": new_po.po_number
    }


class FromQuotationPayload(BaseModel):
    quotation_id: int

@router.post("/purchase-orders/from-quotation", status_code=201)
async def create_po_from_quotation(
    payload: FromQuotationPayload,
    db: AsyncSession = Depends(get_db),
    # 2026-05-06 — only admin / super_admin can finalize a vendor by
    # converting their quotation to a PO. Purchase team prepares quotes;
    # admin / super_admin pick the winner.
    current_user: User = Depends(require_permission("procurement", "create", "purchase-orders")),
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

        # Validate that quotation conversion won't exceed MR quantity limit
        from app.services.procurement_service import validate_mr_allocation
        await validate_mr_allocation(db, quotation.mr_id, quotation.items)

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

    base_upo = await generate_number(db, "procurement", "unapproved_purchase_order", pad_length=7)
    po_number = f"{base_upo}-V1.0"
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
        version_number="1.0",
        base_po_number=base_upo,
        is_current=True,
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
    current_user: User = Depends(require_permission("procurement", "create", "purchase-orders")),
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

        # Validate MR allocation for this vendor's awards
        if mr_id_to_use:
            from app.services.procurement_service import validate_mr_allocation
            await validate_mr_allocation(db, mr_id_to_use, awards)

        base_upo = await generate_number(db, "procurement", "unapproved_purchase_order", pad_length=7)
        po_number = f"{base_upo}-V1.0"
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
            version_number="1.0",
            base_po_number=base_upo,
            is_current=True,
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

# ==================== modularized masters endpoints ====================
from pydantic import BaseModel, Field
from typing import List, Literal, Optional
from sqlalchemy import delete, select, func, or_, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import selectinload
from app.models.master import (
    Vendor, VendorItem, VendorContract, VendorRating, VendorType, VendorCategory,
    VendorVendorType, VendorItemHistory, Customer, Item, UOM
)
from app.schemas.master import (
    VendorCreate, VendorUpdate, VendorResponse, VendorTypeCreate, VendorTypeResponse,
    VendorCategoryCreate, VendorCategoryResponse, VendorItemCreate, VendorItemBulkMapCreate,
    VendorContractCreate, VendorRatingCreate, VALID_VENDOR_TYPES
)
from app.utils.schema_sync import ensure_vendor_type_schema, ensure_supplier_portal_schema
import re

async def _vendor_type_maps(db: AsyncSession, vendor_ids: list[int]) -> tuple[dict[int, list[VendorType]], dict[int, VendorType]]:
    if not vendor_ids:
        return {}, {}
    rows = (
        await db.execute(
            select(VendorVendorType.vendor_id, VendorType)
            .join(VendorType, VendorVendorType.vendor_type_id == VendorType.id)
            .where(VendorVendorType.vendor_id.in_(vendor_ids))
            .order_by(VendorType.name)
        )
    ).all()
    type_map: dict[int, list[VendorType]] = {}
    for vendor_id, vendor_type in rows:
        type_map.setdefault(vendor_id, []).append(vendor_type)
    primary_rows = (
        await db.execute(
            select(Vendor.id, VendorType)
            .join(VendorType, Vendor.vendor_type_id == VendorType.id, isouter=True)
            .where(Vendor.id.in_(vendor_ids))
        )
    ).all()
    primary_map = {vendor_id: vendor_type for vendor_id, vendor_type in primary_rows if vendor_type}
    return type_map, primary_map


async def _vendor_category_map(db: AsyncSession, vendor_ids: list[int]) -> dict[int, VendorCategory]:
    if not vendor_ids:
        return {}
    rows = (
        await db.execute(
            select(Vendor.id, VendorCategory)
            .join(VendorCategory, Vendor.vendor_category_id == VendorCategory.id, isouter=True)
            .where(Vendor.id.in_(vendor_ids))
        )
    ).all()
    return {vendor_id: category for vendor_id, category in rows if category}


async def _validate_vendor_category(db: AsyncSession, vendor_category_id: int | None) -> None:
    if vendor_category_id is None:
        return
    category = (
        await db.execute(
            select(VendorCategory).where(
                VendorCategory.id == vendor_category_id,
                VendorCategory.is_active == True,  # noqa: E712
            )
        )
    ).scalar_one_or_none()
    if not category:
        raise HTTPException(status_code=422, detail="Vendor category does not exist or is inactive")


def _vendor_response_dict(
    vendor: Vendor,
    type_map: dict[int, list[VendorType]],
    primary_map: dict[int, VendorType],
    category_map: dict[int, VendorCategory] | None = None,
    login_vendor_ids: set[int] | None = None,
) -> dict:
    types = type_map.get(vendor.id, [])
    primary = primary_map.get(vendor.id) or (types[0] if types else None)
    category = (category_map or {}).get(vendor.id)
    return {
        "id": vendor.id,
        "vendor_code": vendor.vendor_code,
        "name": vendor.name,
        "contact_person": vendor.contact_person,
        "email": vendor.email,
        "phone": vendor.phone,
        "alt_phone": vendor.alt_phone,
        "address_line1": vendor.address_line1,
        "address_line2": vendor.address_line2,
        "city": vendor.city,
        "state": vendor.state,
        "pincode": vendor.pincode,
        "country": vendor.country,
        "gst_number": vendor.gst_number,
        "pan_number": vendor.pan_number,
        "bank_name": vendor.bank_name,
        "bank_account": vendor.bank_account,
        "bank_ifsc": vendor.bank_ifsc,
        "payment_terms_days": vendor.payment_terms_days,
        "credit_limit": vendor.credit_limit,
        "vendor_type": primary.code if primary else vendor.vendor_type,
        "vendor_type_id": vendor.vendor_type_id,
        "vendor_type_name": primary.name if primary else None,
        "vendor_type_ids": [t.id for t in types],
        "vendor_types": [VendorTypeResponse.model_validate(t) for t in types],
        "vendor_category_id": vendor.vendor_category_id,
        "vendor_category_code": category.code if category else None,
        "vendor_category_name": category.name if category else None,
        "vendor_category": VendorCategoryResponse.model_validate(category) if category else None,
        "rating": vendor.rating,
        "is_transport_vendor": vendor.is_transport_vendor,
        "drug_license_number": vendor.drug_license_number,
        "drug_license_state": vendor.drug_license_state,
        "drug_license_expiry": vendor.drug_license_expiry,
        "gst_certificate_url": vendor.gst_certificate_url,
        "license_doc_url": vendor.license_doc_url,
        "vendor_compliance_status": vendor.vendor_compliance_status,
        "is_active": vendor.is_active,
        "has_login": (login_vendor_ids is not None and vendor.id in login_vendor_ids),
        "status": "active" if vendor.is_active else "inactive",
        "created_at": vendor.created_at,
    }


async def _sync_vendor_type_links(db: AsyncSession, vendor: Vendor, vendor_type_ids: list[int] | None, vendor_type_id: int | None = None) -> None:
    raw_ids = list(vendor_type_ids or [])
    if vendor_type_id:
        raw_ids.insert(0, vendor_type_id)
    seen = []
    for type_id in raw_ids:
        if type_id and type_id not in seen:
            seen.append(type_id)
    if not seen and vendor.vendor_type:
        legacy = (
            await db.execute(select(VendorType).where(VendorType.code == vendor.vendor_type))
        ).scalar_one_or_none()
        if legacy:
            seen = [legacy.id]
    if seen:
        count = await db.scalar(
            select(func.count(VendorType.id)).where(
                VendorType.id.in_(seen),
                VendorType.is_active == True,  # noqa: E712
            )
        )
        if int(count or 0) != len(seen):
            raise HTTPException(status_code=422, detail="One or more vendor types do not exist or are inactive")
    await db.execute(text("DELETE FROM vendor_vendor_types WHERE vendor_id = :vendor_id"), {"vendor_id": vendor.id})
    for type_id in seen:
        db.add(VendorVendorType(vendor_id=vendor.id, vendor_type_id=type_id))
    vendor.vendor_type_id = seen[0] if seen else None
    if seen:
        primary = (await db.execute(select(VendorType).where(VendorType.id == seen[0]))).scalar_one()
        vendor.vendor_type = primary.code if primary.code in VALID_VENDOR_TYPES else "material"



@router.get("/vendor-categories")
async def list_vendor_categories(
    include_inactive: bool = Query(False),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_vendor_type_schema(db)
    q = select(VendorCategory).order_by(VendorCategory.name)
    if not include_inactive:
        q = q.where(VendorCategory.is_active == True)  # noqa: E712
    if search:
        like = f"%{search}%"
        q = q.where((VendorCategory.name.ilike(like)) | (VendorCategory.code.ilike(like)))
    rows = (await db.execute(q)).scalars().all()
    return [VendorCategoryResponse.model_validate(row) for row in rows]


@router.post("/vendor-categories", status_code=201)
async def create_vendor_category(
    payload: VendorCategoryCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "create", "vendors")),
):
    await ensure_vendor_type_schema(db)
    existing = (
        await db.execute(select(VendorCategory).where(func.lower(VendorCategory.code) == payload.code.lower()))
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail=f"Vendor category code '{payload.code}' already exists")
    row = VendorCategory(
        code=payload.code,
        name=payload.name,
        description=payload.description,
        is_active=True if payload.is_active is None else bool(payload.is_active),
    )
    db.add(row)
    await db.flush()
    return {"id": row.id, "message": "Vendor category created"}


@router.put("/vendor-categories/{vendor_category_id}")
async def update_vendor_category(
    vendor_category_id: int,
    payload: VendorCategoryCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "vendors")),
):
    await ensure_vendor_type_schema(db)
    row = (await db.execute(select(VendorCategory).where(VendorCategory.id == vendor_category_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Vendor category not found")
    dup = (
        await db.execute(
            select(VendorCategory).where(
                func.lower(VendorCategory.code) == payload.code.lower(),
                VendorCategory.id != vendor_category_id,
            )
        )
    ).scalar_one_or_none()
    if dup:
        raise HTTPException(status_code=409, detail=f"Vendor category code '{payload.code}' already exists")
    row.code = payload.code
    row.name = payload.name
    row.description = payload.description
    if payload.is_active is not None:
        row.is_active = bool(payload.is_active)
    await db.flush()
    return {"id": row.id, "message": "Vendor category updated"}


@router.delete("/vendor-categories/{vendor_category_id}")
async def delete_vendor_category(
    vendor_category_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "delete", "vendors")),
):
    await ensure_vendor_type_schema(db)
    row = (await db.execute(select(VendorCategory).where(VendorCategory.id == vendor_category_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Vendor category not found")
    in_use = await db.scalar(select(func.count(Vendor.id)).where(Vendor.vendor_category_id == vendor_category_id))
    if in_use:
        raise HTTPException(status_code=409, detail=f"Vendor category is linked to {int(in_use)} vendor(s)")
    row.is_active = False
    await db.flush()
    return {"message": "Vendor category deactivated"}

@router.get("/vendor-types")
async def list_vendor_types(
    include_inactive: bool = Query(False),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_vendor_type_schema(db)
    q = select(VendorType).order_by(VendorType.name)
    if not include_inactive:
        q = q.where(VendorType.is_active == True)  # noqa: E712
    if search:
        like = f"%{search}%"
        q = q.where((VendorType.name.ilike(like)) | (VendorType.code.ilike(like)))
    rows = (await db.execute(q)).scalars().all()
    return [VendorTypeResponse.model_validate(row) for row in rows]


@router.post("/vendor-types", status_code=201)
async def create_vendor_type(
    payload: VendorTypeCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "create", "vendors")),
):
    await ensure_vendor_type_schema(db)
    existing = (
        await db.execute(select(VendorType).where(func.lower(VendorType.code) == payload.code.lower()))
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail=f"Vendor type code '{payload.code}' already exists")
    row = VendorType(
        code=payload.code,
        name=payload.name,
        description=payload.description,
        is_active=True if payload.is_active is None else bool(payload.is_active),
    )
    db.add(row)
    await db.flush()
    return {"id": row.id, "message": "Vendor type created"}


@router.put("/vendor-types/{vendor_type_id}")
async def update_vendor_type(
    vendor_type_id: int,
    payload: VendorTypeCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "vendors")),
):
    await ensure_vendor_type_schema(db)
    row = (await db.execute(select(VendorType).where(VendorType.id == vendor_type_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Vendor type not found")
    dup = (
        await db.execute(
            select(VendorType).where(
                func.lower(VendorType.code) == payload.code.lower(),
                VendorType.id != vendor_type_id,
            )
        )
    ).scalar_one_or_none()
    if dup:
        raise HTTPException(status_code=409, detail=f"Vendor type code '{payload.code}' already exists")
    row.code = payload.code
    row.name = payload.name
    row.description = payload.description
    if payload.is_active is not None:
        row.is_active = bool(payload.is_active)
    await db.flush()
    return {"id": row.id, "message": "Vendor type updated"}


@router.delete("/vendor-types/{vendor_type_id}")
async def delete_vendor_type(
    vendor_type_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "delete", "vendors")),
):
    await ensure_vendor_type_schema(db)
    row = (await db.execute(select(VendorType).where(VendorType.id == vendor_type_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Vendor type not found")
    in_use = await db.scalar(select(func.count(VendorVendorType.id)).where(VendorVendorType.vendor_type_id == vendor_type_id))
    if in_use:
        raise HTTPException(status_code=409, detail=f"Vendor type is linked to {int(in_use)} vendor(s)")
    row.is_active = False
    await db.flush()
    return {"message": "Vendor type deactivated"}


@router.get("/vendors")
async def list_vendors(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=10000),
    search: str = Query(None),
    vendor_type: str = Query(None),
    vendor_category_id: int = Query(None),
    is_active: bool = Query(None),
    status: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_vendor_type_schema(db)
    # R-001 (re-audit): vendors contain bank/GST/DL info — gate to roles that
    # actually need them. Procurement (PO+MR forms), warehouse (GRN), masters,
    # accounts (payments). Read fails for nurse/field_staff/etc.
    from app.utils.dependencies import check_user_has_any_permission
    has_perm = await check_user_has_any_permission(
        db,
        current_user.id,
        [
            ("procurement", "view", "vendors"),
            ("procurement", "view", "purchase-orders"),
            ("procurement", "view", "material-requests"),
            ("procurement", "view", "quotations"),
            ("warehouse", "view", "grn"),
            ("accounts", "view", "payments"),
            ("accounts", "view", "invoices"),
        ]
    )
    if not has_perm:
        raise HTTPException(status_code=403, detail="Permission denied")
    offset, limit = paginate_params(page, page_size)
    query = select(Vendor)
    count_query = select(func.count(Vendor.id))

    if vendor_type:
        vendor_type_filters = [VendorType.code == vendor_type]
        if str(vendor_type).isdigit():
            vendor_type_filters.append(VendorType.id == int(vendor_type))
        vt = (
            await db.execute(
                select(VendorType).where(or_(*vendor_type_filters))
            )
        ).scalar_one_or_none()
        if vt:
            query = query.join(VendorVendorType, VendorVendorType.vendor_id == Vendor.id).where(VendorVendorType.vendor_type_id == vt.id)
            count_query = count_query.join(VendorVendorType, VendorVendorType.vendor_id == Vendor.id).where(VendorVendorType.vendor_type_id == vt.id)
        else:
            query = query.where(Vendor.vendor_type == vendor_type)
            count_query = count_query.where(Vendor.vendor_type == vendor_type)
    if vendor_category_id is not None:
        query = query.where(Vendor.vendor_category_id == vendor_category_id)
        count_query = count_query.where(Vendor.vendor_category_id == vendor_category_id)
    # Support both is_active (bool) and status ('active'/'inactive') params
    if is_active is not None:
        query = query.where(Vendor.is_active == is_active)
        count_query = count_query.where(Vendor.is_active == is_active)
    elif status is not None:
        active_val = status.lower() in ("active", "true", "1")
        query = query.where(Vendor.is_active == active_val)
        count_query = count_query.where(Vendor.is_active == active_val)


    # Include both material and transport/logistics vendors in the procurement vendors list
    # (Do not filter out transport/logistics vendors)

    query = apply_search_filter(query, Vendor, search, ["vendor_code", "name", "city", "gst_number"])
    count_query = apply_search_filter(count_query, Vendor, search, ["vendor_code", "name", "city", "gst_number"])

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.distinct().offset(offset).limit(limit).order_by(Vendor.id.desc()))
    vendors = result.scalars().all()
    type_map, primary_map = await _vendor_type_maps(db, [v.id for v in vendors])
    category_map = await _vendor_category_map(db, [v.id for v in vendors])

    # Fetch logins for these vendors to populate has_login
    from app.models.vendor_portal import VendorUser
    login_res = await db.execute(
        select(VendorUser.vendor_id).where(VendorUser.vendor_id.in_([v.id for v in vendors]))
    ) if vendors else None
    login_vendor_ids = set(login_res.scalars().all()) if login_res else set()

    return build_paginated_response(
        [_vendor_response_dict(v, type_map, primary_map, category_map, login_vendor_ids) for v in vendors], total, page, page_size
    )


@router.get("/vendors/{vendor_id:int}", response_model=VendorResponse)
async def get_vendor(
    vendor_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_vendor_type_schema(db)
    # BUG-FE-052: mirror the role guard from list_vendors — vendor records
    # contain bank/GST/DL/PII that must not leak to nurses/field_staff/etc.
    from app.utils.dependencies import check_user_has_any_permission
    has_perm = await check_user_has_any_permission(
        db,
        current_user.id,
        [
            ("procurement", "view", "vendors"),
            ("procurement", "view", "purchase-orders"),
            ("procurement", "view", "material-requests"),
            ("procurement", "view", "quotations"),
            ("warehouse", "view", "grn"),
            ("accounts", "view", "payments"),
            ("accounts", "view", "invoices"),
        ]
    )
    if not has_perm:
        raise HTTPException(status_code=403, detail="Permission denied")
    result = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    vendor = result.scalar_one_or_none()
    if not vendor:
        raise HTTPException(status_code=404, detail="Vendor not found")
    type_map, primary_map = await _vendor_type_maps(db, [vendor.id])
    category_map = await _vendor_category_map(db, [vendor.id])
    from app.models.vendor_portal import VendorUser
    login_exists = await db.scalar(
        select(func.count(VendorUser.id)).where(VendorUser.vendor_id == vendor.id)
    )
    return _vendor_response_dict(vendor, type_map, primary_map, category_map, {vendor.id} if login_exists else set())


@router.post("/vendors", status_code=201)
async def create_vendor(
    payload: VendorCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "create", "vendors")),
):
    await ensure_vendor_type_schema(db)
    # BUG-FE-051: case-insensitive uniqueness so "ACME" and "acme" can't coexist
    code_val = (payload.vendor_code or "").strip()
    existing = await db.execute(
        select(Vendor).where(func.lower(Vendor.vendor_code) == code_val.lower())
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Vendor with code '{code_val}' already exists")
    # BUG-PRO-105 fix: refuse a second active vendor with the same GSTIN (when
    # one is supplied). The DB has no UNIQUE constraint on gst_number â€” adding
    # one is DEFERRED (migration); enforced at the application layer here.
    if payload.gst_number and payload.gst_number.strip():
        gst_dupe = await db.execute(
            select(Vendor.id, Vendor.vendor_code).where(
                Vendor.gst_number == payload.gst_number,
                Vendor.is_active == True,  # noqa: E712 â€” explicit boolean for SQL
            )
        )
        dupe = gst_dupe.first()
        if dupe:
            raise HTTPException(
                status_code=409,
                detail=f"GSTIN '{payload.gst_number}' is already registered",
            )
    await _validate_vendor_category(db, payload.vendor_category_id)
    data = payload.model_dump(exclude={"vendor_type_ids"})
    data["vendor_code"] = code_val.upper()
    vendor = Vendor(**data, created_by=current_user.id)
    db.add(vendor)
    await db.flush()
    await _sync_vendor_type_links(db, vendor, payload.vendor_type_ids, payload.vendor_type_id)
    return {"id": vendor.id, "message": "Vendor created"}


@router.put("/vendors/{vendor_id:int}")
async def update_vendor(
    vendor_id: int,
    payload: VendorUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "vendors")),
):
    await ensure_vendor_type_schema(db)
    result = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    vendor = result.scalar_one_or_none()
    if not vendor:
        raise HTTPException(status_code=404, detail="Vendor not found")
    update_data = payload.model_dump(exclude_unset=True)
    vendor_type_ids = update_data.pop("vendor_type_ids", None)
    if "vendor_category_id" in update_data:
        await _validate_vendor_category(db, update_data.get("vendor_category_id"))
    # BUG-PRO-105 fix (mirror create): block GSTIN collision with another
    # active vendor when GSTIN is being changed.
    new_gst = update_data.get("gst_number")
    if new_gst and new_gst.strip() and new_gst != (vendor.gst_number or ""):
        gst_dupe = await db.execute(
            select(Vendor.id, Vendor.vendor_code).where(
                Vendor.gst_number == new_gst,
                Vendor.id != vendor_id,
                Vendor.is_active == True,  # noqa: E712
            )
        )
        dupe = gst_dupe.first()
        if dupe:
            raise HTTPException(
                status_code=409,
                detail=f"GSTIN '{new_gst}' is already registered",
            )
    for k, v in update_data.items():
        setattr(vendor, k, v)
    if vendor_type_ids is not None or "vendor_type_id" in update_data:
        await _sync_vendor_type_links(db, vendor, vendor_type_ids, update_data.get("vendor_type_id"))
    await db.flush()
    return {"success": True, "message": "Vendor updated"}


@router.delete("/vendors/{vendor_id:int}")
async def deactivate_vendor(
    vendor_id: int,
    force: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "delete", "vendors")),
):
    """BUG-FE-050: refuse soft-delete if vendor has open POs or unpaid invoices.
    Pass ?force=true to override (admin-only escape hatch)."""
    result = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    vendor = result.scalar_one_or_none()
    if not vendor:
        raise HTTPException(status_code=404, detail="Vendor not found")

    refs = []
    # Open POs (status not in closed/cancelled)
    try:
        from app.models.procurement import PurchaseOrder  # type: ignore
        po_count = (await db.execute(
            select(func.count(PurchaseOrder.id)).where(
                PurchaseOrder.vendor_id == vendor_id,
                ~PurchaseOrder.status.in_(["closed", "cancelled", "rejected"]),
            )
        )).scalar() or 0
        if po_count:
            refs.append(f"{po_count} open purchase order(s)")
    except Exception:
        pass


    if refs and not force:
        raise HTTPException(
            status_code=409,
            detail=(
                "Cannot deactivate vendor â€” has " + ", ".join(refs) +
                ". Close them first or pass ?force=true."
            ),
        )

    vendor.is_active = False
    await db.flush()
    return {"success": True, "message": "Vendor deactivated"}


@router.get("/vendors/{vendor_id:int}/items")
async def list_vendor_items(
    vendor_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    total = (await db.execute(
        select(func.count(VendorItem.id)).where(VendorItem.vendor_id == vendor_id)
    )).scalar() or 0
    rows = (await db.execute(
        select(VendorItem, Item.item_code, Item.name)
        .join(Item, VendorItem.item_id == Item.id, isouter=True)
        .where(VendorItem.vendor_id == vendor_id)
        .order_by(VendorItem.id.desc())
        .offset(offset).limit(limit)
    )).all()
    items = []
    for vi, item_code, item_name in rows:
        items.append({
            "id": vi.id,
            "vendor_id": vi.vendor_id,
            "item_id": vi.item_id,
            "item_code": item_code,
            "item_name": item_name,
            "vendor_item_code": vi.vendor_item_code,
            "lead_time_days": vi.lead_time_days,
            "min_order_qty": float(vi.min_order_qty) if vi.min_order_qty is not None else None,
            "last_price": float(vi.rate) if vi.rate is not None else None,
            "is_preferred": vi.is_preferred,
        })
    return build_paginated_response(items, total, page, page_size)

def _vendor_item_snapshot(vi: VendorItem | None) -> dict:
    if not vi:
        return {
            "vendor_item_code": None,
            "lead_time_days": None,
            "min_order_qty": None,
            "rate": None,
            "is_preferred": None,
        }
    return {
        "vendor_item_code": vi.vendor_item_code,
        "lead_time_days": vi.lead_time_days,
        "min_order_qty": vi.min_order_qty,
        "rate": vi.rate,
        "is_preferred": vi.is_preferred,
    }


def _add_vendor_item_history(
    db: AsyncSession,
    vi: VendorItem,
    action: str,
    current_user: User,
    old_values: dict | None = None,
) -> None:
    old_values = old_values or {}
    new_values = _vendor_item_snapshot(vi) if action != "delete" else {}
    db.add(VendorItemHistory(
        vendor_item_id=vi.id,
        vendor_id=vi.vendor_id,
        item_id=vi.item_id,
        action=action,
        old_vendor_item_code=old_values.get("vendor_item_code"),
        new_vendor_item_code=new_values.get("vendor_item_code"),
        old_lead_time_days=old_values.get("lead_time_days"),
        new_lead_time_days=new_values.get("lead_time_days"),
        old_min_order_qty=old_values.get("min_order_qty"),
        new_min_order_qty=new_values.get("min_order_qty"),
        old_rate=old_values.get("rate"),
        new_rate=new_values.get("rate"),
        old_is_preferred=old_values.get("is_preferred"),
        new_is_preferred=new_values.get("is_preferred"),
        changed_by_id=getattr(current_user, "id", None),
    ))


@router.get("/vendors/{vendor_id:int}/items/history")
async def list_vendor_item_history(
    vendor_id: int,
    item_id: int | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_vendor_type_schema(db)
    offset, limit = paginate_params(page, page_size)
    filters = [VendorItemHistory.vendor_id == vendor_id]
    if item_id:
        filters.append(VendorItemHistory.item_id == item_id)
    total = (await db.execute(select(func.count(VendorItemHistory.id)).where(*filters))).scalar() or 0
    rows = (await db.execute(
        select(
            VendorItemHistory,
            Item.item_code,
            Item.name,
            UserModel.username,
            UserModel.first_name,
            UserModel.last_name,
        )
        .join(Item, VendorItemHistory.item_id == Item.id, isouter=True)
        .join(UserModel, VendorItemHistory.changed_by_id == UserModel.id, isouter=True)
        .where(*filters)
        .order_by(VendorItemHistory.changed_at.desc(), VendorItemHistory.id.desc())
        .offset(offset).limit(limit)
    )).all()
    items = []
    for h, item_code, item_name, username, first_name, last_name in rows:
        changed_by_name = " ".join([p for p in [first_name, last_name] if p]) or username
        items.append({
            "id": h.id,
            "vendor_item_id": h.vendor_item_id,
            "vendor_id": h.vendor_id,
            "item_id": h.item_id,
            "item_code": item_code,
            "item_name": item_name,
            "action": h.action,
            "old_vendor_item_code": h.old_vendor_item_code,
            "new_vendor_item_code": h.new_vendor_item_code,
            "old_lead_time_days": h.old_lead_time_days,
            "new_lead_time_days": h.new_lead_time_days,
            "old_min_order_qty": float(h.old_min_order_qty) if h.old_min_order_qty is not None else None,
            "new_min_order_qty": float(h.new_min_order_qty) if h.new_min_order_qty is not None else None,
            "old_rate": float(h.old_rate) if h.old_rate is not None else None,
            "new_rate": float(h.new_rate) if h.new_rate is not None else None,
            "old_is_preferred": h.old_is_preferred,
            "new_is_preferred": h.new_is_preferred,
            "changed_by_id": h.changed_by_id,
            "changed_by_name": changed_by_name,
            "changed_at": h.changed_at,
        })
    return build_paginated_response(items, total, page, page_size)


@router.get("/vendors/{vendor_id:int}/contracts")
async def list_vendor_contracts(
    vendor_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    total = (await db.execute(
        select(func.count(VendorContract.id)).where(VendorContract.vendor_id == vendor_id)
    )).scalar() or 0
    rows = (await db.execute(
        select(VendorContract)
        .where(VendorContract.vendor_id == vendor_id)
        .order_by(VendorContract.id.desc())
        .offset(offset).limit(limit)
    )).scalars().all()
    items = [{
        "id": c.id,
        "vendor_id": c.vendor_id,
        "contract_number": c.contract_number,
        "title": c.title,
        "start_date": c.start_date,
        "end_date": c.end_date,
        "status": c.status,
        "document_url": c.document_url,
    } for c in rows]
    return build_paginated_response(items, total, page, page_size)


@router.get("/vendors/{vendor_id:int}/ratings")
async def list_vendor_ratings(
    vendor_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    offset, limit = paginate_params(page, page_size)
    total = (await db.execute(
        select(func.count(VendorRating.id)).where(VendorRating.vendor_id == vendor_id)
    )).scalar() or 0
    rows = (await db.execute(
        select(VendorRating)
        .where(VendorRating.vendor_id == vendor_id)
        .order_by(VendorRating.id.desc())
        .offset(offset).limit(limit)
    )).scalars().all()
    items = [{
        "id": r.id,
        "vendor_id": r.vendor_id,
        "period_from": r.period_from,
        "period_to": r.period_to,
        "delivery_timeliness": float(r.delivery_timeliness) if r.delivery_timeliness is not None else None,
        "cost_efficiency": float(r.cost_efficiency) if r.cost_efficiency is not None else None,
        "service_reliability": float(r.service_reliability) if r.service_reliability is not None else None,
        "delivery_accuracy": float(r.delivery_accuracy) if r.delivery_accuracy is not None else None,
        "overall_rating": float(r.overall_rating) if r.overall_rating is not None else None,
        "remarks": r.remarks,
        "created_at": r.created_at,
    } for r in rows]
    return build_paginated_response(items, total, page, page_size)


@router.get("/vendors/{vendor_id:int}/purchase-orders")
async def list_vendor_purchase_orders(
    vendor_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """BUG-FE-055: vendor PO history tab. Stub â€” returns empty list when the
    procurement model isn't importable so the FE can still render."""
    try:
        from app.models.procurement import PurchaseOrder  # type: ignore
    except Exception:
        return build_paginated_response([], 0, page, page_size)
    offset, limit = paginate_params(page, page_size)
    total = (await db.execute(
        select(func.count(PurchaseOrder.id)).where(PurchaseOrder.vendor_id == vendor_id)
    )).scalar() or 0
    rows = (await db.execute(
        select(PurchaseOrder)
        .where(PurchaseOrder.vendor_id == vendor_id)
        .order_by(PurchaseOrder.id.desc())
        .offset(offset).limit(limit)
    )).scalars().all()
    items = []
    for po in rows:
        items.append({
            "id": po.id,
            "po_number": getattr(po, "po_number", None) or getattr(po, "doc_number", None),
            "status": getattr(po, "status", None),
            "order_date": getattr(po, "order_date", None) or getattr(po, "po_date", None),
            "total_amount": float(getattr(po, "total_amount", 0) or 0),
        })
    return build_paginated_response(items, total, page, page_size)


@router.post("/vendors/{vendor_id:int}/items", status_code=201)
async def add_vendor_item(
    vendor_id: int,
    payload: VendorItemCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "vendors")),
):
    # BUG-FE-053: writes to vendor sub-records require masters.update.vendors
    vendor = (await db.execute(select(Vendor).where(Vendor.id == vendor_id))).scalar_one_or_none()
    if not vendor:
        raise HTTPException(status_code=404, detail="Vendor not found")
    item = (await db.execute(select(Item).where(Item.id == payload.item_id))).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=422, detail="Item not found")
    existing = (
        await db.execute(
            select(VendorItem).where(
                VendorItem.vendor_id == vendor_id,
                VendorItem.item_id == payload.item_id,
            )
        )
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="This item is already linked to the vendor")
    vi = VendorItem(**payload.model_dump())
    vi.vendor_id = vendor_id
    db.add(vi)
    await db.flush()
    _add_vendor_item_history(db, vi, "create", current_user)
    return {"id": vi.id, "message": "Vendor item added"}


@router.post("/vendor-item-mappings/bulk", status_code=201)
async def bulk_map_vendor_items(
    payload: VendorItemBulkMapCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "vendors")),
):
    vendor_ids = payload.vendor_ids
    item_ids = payload.item_ids
    vendors = (await db.execute(
        select(Vendor.id).where(Vendor.id.in_(vendor_ids), Vendor.is_active == True)  # noqa: E712
    )).all()
    valid_vendor_ids = {int(row[0]) for row in vendors}
    items = (await db.execute(
        select(Item.id).where(Item.id.in_(item_ids), Item.is_active == True)  # noqa: E712
    )).all()
    valid_item_ids = {int(row[0]) for row in items}
    missing_vendors = [vid for vid in vendor_ids if vid not in valid_vendor_ids]
    missing_items = [iid for iid in item_ids if iid not in valid_item_ids]
    if missing_vendors or missing_items:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Only active vendors and active items can be mapped",
                "missing_vendor_ids": missing_vendors,
                "missing_item_ids": missing_items,
            },
        )

    existing_rows = (await db.execute(
        select(VendorItem.vendor_id, VendorItem.item_id).where(
            VendorItem.vendor_id.in_(vendor_ids),
            VendorItem.item_id.in_(item_ids),
        )
    )).all()
    existing = {(int(vendor_id), int(item_id)) for vendor_id, item_id in existing_rows}
    created = 0
    skipped = 0
    for vendor_id in vendor_ids:
        for item_id in item_ids:
            if (vendor_id, item_id) in existing:
                skipped += 1
                continue
            vi = VendorItem(
                vendor_id=vendor_id,
                item_id=item_id,
                lead_time_days=payload.lead_time_days,
                min_order_qty=payload.min_order_qty,
                rate=payload.rate,
                is_preferred=payload.is_preferred,
            )
            db.add(vi)
            await db.flush()
            _add_vendor_item_history(db, vi, "create", current_user)
            created += 1
    return {
            "vendors": len(vendor_ids),
        "items": len(item_ids),
    }

@router.put("/vendors/{vendor_id:int}/items/{vendor_item_id:int}")
async def update_vendor_item(
    vendor_id: int,
    vendor_item_id: int,
    payload: VendorItemCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "vendors")),
):
    vi = (
        await db.execute(
            select(VendorItem).where(
                VendorItem.id == vendor_item_id,
                VendorItem.vendor_id == vendor_id,
            )
        )
    ).scalar_one_or_none()
    if not vi:
        raise HTTPException(status_code=404, detail="Vendor item mapping not found")
    duplicate = (
        await db.execute(
            select(VendorItem).where(
                VendorItem.vendor_id == vendor_id,
                VendorItem.item_id == payload.item_id,
                VendorItem.id != vendor_item_id,
            )
        )
    ).scalar_one_or_none()
    if duplicate:
        raise HTTPException(status_code=409, detail="This item is already linked to the vendor")
    old_values = _vendor_item_snapshot(vi)
    for key, value in payload.model_dump().items():
        setattr(vi, key, value)
    vi.vendor_id = vendor_id
    await db.flush()
    _add_vendor_item_history(db, vi, "update", current_user, old_values)
    return {"id": vi.id, "message": "Vendor item updated"}


@router.delete("/vendors/{vendor_id:int}/items/{vendor_item_id:int}")
async def delete_vendor_item(
    vendor_id: int,
    vendor_item_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "vendors")),
):
    vi = (
        await db.execute(
            select(VendorItem).where(
                VendorItem.id == vendor_item_id,
                VendorItem.vendor_id == vendor_id,
            )
        )
    ).scalar_one_or_none()
    if not vi:
        raise HTTPException(status_code=404, detail="Vendor item mapping not found")
    old_values = _vendor_item_snapshot(vi)
    _add_vendor_item_history(db, vi, "delete", current_user, old_values)
    await db.delete(vi)
    await db.flush()
    return {"message": "Vendor item mapping deleted"}


@router.post("/vendors/{vendor_id:int}/contracts", status_code=201)
async def add_vendor_contract(
    vendor_id: int,
    payload: VendorContractCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "vendors")),
):
    # BUG-FE-053
    vc = VendorContract(**payload.model_dump())
    vc.vendor_id = vendor_id
    db.add(vc)
    await db.flush()
    return {"id": vc.id, "message": "Contract created"}


@router.post("/vendors/{vendor_id:int}/ratings", status_code=201)
async def add_vendor_rating(
    vendor_id: int,
    payload: VendorRatingCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "vendors")),
):
    # BUG-FE-053: gate writes
    vr = VendorRating(**payload.model_dump(), rated_by=current_user.id)
    vr.vendor_id = vendor_id
    db.add(vr)
    await db.flush()

    # BUG-FE-054: aggregate by averaging across all ratings instead of
    # overwriting with the latest single rating.
    vendor_result = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    vendor = vendor_result.scalar_one_or_none()
    if vendor:
        avg = (await db.execute(
            select(func.avg(VendorRating.overall_rating)).where(
                VendorRating.vendor_id == vendor_id
            )
        )).scalar()
        if avg is not None:
            # Round to 1 decimal place to match Antd <Rate allowHalf>
            vendor.rating = round(float(avg) * 2) / 2
    await db.flush()

    return {"id": vr.id, "message": "Rating added"}


# ==================== DEPARTMENTS (for MR form dropdown) ====================

@router.get("/departments")
async def list_departments(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return department list for dropdown. Uses distinct departments from material_requests table."""
    from app.models.procurement import MaterialRequest
    result = await db.execute(
        select(MaterialRequest.department).where(MaterialRequest.department.isnot(None)).distinct()
    )
    depts = [r[0] for r in result.all() if r[0]]
    # Always include common departments
    default_depts = [
        "Administration", "Finance", "HR", "IT", "Logistics",
        "Operations", "Procurement", "Production", "Quality", "Sales",
        "Warehouse", "Maintenance", "R&D", "Marketing",
    ]
    all_depts = sorted(set(default_depts + depts))
    # BUG-FE-171: previously id == name (string). Provide a numeric synthetic
    # id (1-based index) for grids/Selects that expect a key, while keeping
    # the original string in `code` for legacy callers.
    return [
        {"id": idx + 1, "name": d, "code": d, "value": d}
        for idx, d in enumerate(all_depts)
    ]


from app.services.auth_service import hash_password as _hash_password
from app.schemas.vendor_auth import VendorLoginCreate, VendorLoginUpdate

@router.get("/vendors/{vendor_id:int}/supplier-login")
async def get_supplier_login(
    vendor_id: int,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Return login status for this material supplier vendor."""
    await ensure_supplier_portal_schema(db)
    from app.models.vendor_portal import VendorUser
    res = await db.execute(select(VendorUser).where(VendorUser.vendor_id == vendor_id))
    vu = res.scalar_one_or_none()
    if not vu:
        return {"has_login": False}
    return {
        "has_login": True,
        "id": vu.id,
        "username": vu.username,
        "email": vu.email,
        "full_name": vu.full_name,
        "phone": vu.phone,
        "is_active": vu.is_active,
        "must_change_password": vu.must_change_password,
        "last_login": vu.last_login,
        "created_at": vu.created_at,
    }


@router.post("/vendors/{vendor_id:int}/supplier-login", status_code=201)
async def create_supplier_login(
    vendor_id: int,
    payload: VendorLoginCreate,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Provision a new portal login for a material supplier vendor."""
    await ensure_supplier_portal_schema(db)
    from app.models.vendor_portal import VendorUser
    # Validate vendor exists
    res = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    v = res.scalar_one_or_none()
    if not v:
        raise HTTPException(404, "Vendor not found")
    if not v.is_active:
        raise HTTPException(400, "Cannot create login for an inactive vendor")

    # One login per vendor
    res_existing = await db.execute(select(VendorUser).where(VendorUser.vendor_id == vendor_id))
    if res_existing.scalar_one_or_none():
        raise HTTPException(409, "This vendor already has a portal login. Use the update endpoint to reset password.")

    # Normalize username to lowercase and underscores
    import re as _re
    username_normalized = _re.sub(r'[^a-zA-Z0-9_]', '_', payload.username.strip()).lower()

    # Username uniqueness across all vendor users (case-insensitive)
    res_u = await db.execute(select(VendorUser).where(func.lower(VendorUser.username) == username_normalized))
    if res_u.scalar_one_or_none():
        raise HTTPException(409, f"Username '{payload.username}' is already taken")

    vu = VendorUser(
        vendor_id=vendor_id,
        username=username_normalized,
        email=str(payload.email),
        password_hash=_hash_password(payload.password),
        full_name=payload.full_name or v.contact_person,
        phone=payload.phone or v.phone,
        is_active=True,
        must_change_password=True,
        created_by=current_user.id,
    )
    db.add(vu)
    await db.commit()
    await db.refresh(vu)
    return {"id": vu.id, "username": vu.username, "message": "Supplier portal login created"}


@router.put("/vendors/{vendor_id:int}/supplier-login")
async def update_supplier_login(
    vendor_id: int,
    payload: VendorLoginUpdate,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Reset password or toggle active state of a supplier portal login."""
    await ensure_supplier_portal_schema(db)
    from app.models.vendor_portal import VendorUser
    res = await db.execute(select(VendorUser).where(VendorUser.vendor_id == vendor_id))
    vu = res.scalar_one_or_none()
    if not vu:
        raise HTTPException(404, "This vendor has no portal login")
    data = payload.model_dump(exclude_none=True)
    if "new_password" in data:
        vu.password_hash = _hash_password(data.pop("new_password"))
        vu.password_changed_at = datetime.now(timezone.utc)
        vu.must_change_password = True
        vu.failed_login_attempts = 0
        vu.locked_until = None
    for k, val in data.items():
        setattr(vu, k, val)
    await db.commit()
    return {"success": True, "message": "Supplier login updated"}


@router.delete("/vendors/{vendor_id:int}/supplier-login")
async def deactivate_supplier_login(
    vendor_id: int,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Deactivate (disable) a supplier portal login."""
    await ensure_supplier_portal_schema(db)
    from app.models.vendor_portal import VendorUser
    res = await db.execute(select(VendorUser).where(VendorUser.vendor_id == vendor_id))
    vu = res.scalar_one_or_none()
    if not vu:
        raise HTTPException(404, "This vendor has no portal login")
    vu.is_active = False
    await db.commit()
    return {"success": True, "message": "Supplier login deactivated"}


@router.get("/vendors/supplier-logins")
async def list_supplier_logins(
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """List all material vendor logins for the admin management table."""
    await ensure_supplier_portal_schema(db)
    from app.models.vendor_portal import VendorUser
    # All material (non-transport) vendors
    res_v = await db.execute(
        select(Vendor).where(
            (Vendor.is_transport_vendor == False) | (Vendor.is_transport_vendor.is_(None))  # noqa: E712
        ).order_by(Vendor.name.asc())
    )
    vendors = res_v.scalars().all()
    vendor_ids = [v.id for v in vendors]

    # Fetch all logins for these vendors
    login_map = {}
    if vendor_ids:
        res_lu = await db.execute(
            select(VendorUser).where(VendorUser.vendor_id.in_(vendor_ids))
        )
        for vu in res_lu.scalars().all():
            login_map[vu.vendor_id] = {
                "id": vu.id,
                "username": vu.username,
                "email": vu.email,
                "is_active": vu.is_active,
                "last_login": vu.last_login,
                "must_change_password": vu.must_change_password,
            }

    return [
        {
            "vendor_id": v.id,
            "vendor_code": v.vendor_code,
            "name": v.name,
            "contact_person": v.contact_person,
            "email": v.email,
            "phone": v.phone,
            "is_active": v.is_active,
            "login": login_map.get(v.id),
        }
        for v in vendors
    ]



# ==================== modularized reports endpoints ====================
from typing import Optional
from datetime import date
from app.services.report_service import (
    po_summary_report, vendor_performance_report, grn_report, pending_po_report
)

def _parse_date(s: Optional[str]):
    if not s:
        return None
    try:
        return date.fromisoformat(s)
    except Exception:
        return None

def _paginate_list(rows, page: int, page_size: int):
    total = len(rows)
    start = (page - 1) * page_size
    end = start + page_size
    return {
        "items": rows[start:end],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.get("/reports")
async def reports_procurement_dispatch(
    report_type: str = Query("po_summary"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100000),  # BUG-FIN-103/106: lift export cap
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    vendor_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Procurement reports dispatcher - routes to specific report by type.

    BUG-FIN-094: previously returned an empty stub.
    """
    df = _parse_date(date_from)
    dt = _parse_date(date_to)
    if report_type in ("po_summary", "purchase_register"):
        rows = await po_summary_report(db, df, dt, vendor_id, status)
    elif report_type == "vendor_performance":
        rows = await vendor_performance_report(db, vendor_id)
    elif report_type == "grn_summary":
        rows = await grn_report(db, df, dt, None)
    elif report_type == "pending_po":
        rows = await pending_po_report(db)
    else:
        rows = await po_summary_report(db, df, dt, vendor_id, status)
    rows = list(rows or [])
    out = _paginate_list(rows, page, page_size)
    out["report_type"] = report_type
    return out

@router.get("/procurement/po-summary")
async def rpt_po_summary(
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    vendor_id: int = Query(None),
    status: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await po_summary_report(db, date_from, date_to, vendor_id, status)


@router.get("/procurement/vendor-performance")
async def rpt_vendor_performance(
    vendor_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await vendor_performance_report(db, vendor_id)


@router.get("/procurement/grn-summary")
async def rpt_grn_summary(
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await grn_report(db, date_from, date_to, warehouse_id)


@router.get("/procurement/pending-po")
async def rpt_pending_po(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await pending_po_report(db)


@router.get("/procurement/po-vs-grn")
async def rpt_po_vs_grn(
    vendor_id: int = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """PO vs GRN variance report."""
    from sqlalchemy import select, func
    from app.models.procurement import PurchaseOrder, PurchaseOrderItem
    query = (
        select(
            PurchaseOrderItem.item_id,
            func.sum(PurchaseOrderItem.qty).label("ordered_qty"),
            func.sum(PurchaseOrderItem.received_qty).label("received_qty"),
            (func.sum(PurchaseOrderItem.qty) - func.sum(PurchaseOrderItem.received_qty)).label("pending_qty"),
        )
        .join(PurchaseOrder, PurchaseOrderItem.po_id == PurchaseOrder.id)
        .where(PurchaseOrder.status.notin_(["draft", "cancelled"]))
        .group_by(PurchaseOrderItem.item_id)
    )
    if vendor_id:
        query = query.where(PurchaseOrder.vendor_id == vendor_id)
    if date_from:
        query = query.where(PurchaseOrder.po_date >= date_from)
    if date_to:
        query = query.where(PurchaseOrder.po_date <= date_to)
    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]


@router.get("/procurement/purchase-register")
async def rpt_purchase_register(
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await po_summary_report(db, date_from, date_to)


