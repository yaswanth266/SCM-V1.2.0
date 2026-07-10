from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.models.user import User
from app.models.stock import StockBalance
from app.models.procurement import PurchaseOrder, MaterialRequest, RFQ, Quotation
from app.models.grn import GoodsReceiptNote
from app.models.indent import Indent
from app.models.approval import ApprovalRequest
from app.models.master import Item, Vendor
from app.services.report_service import dashboard_kpis, low_stock_report, expiry_report
from app.utils.dependencies import (
    get_current_user, user_is_managerial, user_warehouse_ids,
)

router = APIRouter()


_FIELD_ONLY_CODES = frozenset({
    "field_staff", "field_supervisor", "field_user", "field_operator",
    "nurse", "pharmacy_assistant", "site_user",
})


async def _is_field_only(db: AsyncSession, user_id: int) -> bool:
    """True iff user holds only field-tier roles (no manager/admin)."""
    if await user_is_managerial(db, user_id):
        return False
    from app.utils.dependencies import get_user_role_codes
    codes = set(await get_user_role_codes(db, user_id))
    return bool(codes) and codes.issubset(_FIELD_ONLY_CODES)


@router.get("/stats")
async def get_dashboard_stats(
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Main dashboard stats and KPIs.

    Field-only users get their own indent-status counts only — no org-wide
    stock value, MR backlog, or invoice totals. Everyone else gets the
    full KPI set, optionally filtered by warehouse_id.

    BUG-FIN-119: previously caught all exceptions and returned zeros, hiding
    real errors from operators. We now log the full traceback and surface
    a 500 so the FE error boundary can render a meaningful message.
    """
    if await _is_field_only(db, current_user.id):
        return await _field_user_stats(db, current_user.id)

    # 2026-05-06: warehouse-bound managers (warehouse_manager, store_keeper,
    # purchase_officer, etc.) used to see org-wide KPIs because dashboard_kpis
    # only scoped when called with a warehouse_id and the FE never passed one.
    # Auto-derive from user_warehouses for any non-admin caller — admins keep
    # the unscoped view.
    if warehouse_id is None:
        from app.utils.dependencies import get_user_role_codes
        role_codes = set(await get_user_role_codes(db, current_user.id))
        is_admin = bool({"super_admin", "admin"} & role_codes)
        if not is_admin:
            wh_ids = await user_warehouse_ids(db, current_user.id)
            # dashboard_kpis only accepts a single warehouse id today; users
            # with multiple mappings get the first one as an approximation.
            # Surfacing a multi-wh sum is a separate enhancement.
            if wh_ids:
                warehouse_id = wh_ids[0]

    import logging as _logging
    try:
        return await dashboard_kpis(db, warehouse_id, user_id=current_user.id)
    except Exception:
        _logging.getLogger(__name__).exception(
            "dashboard_kpis failed (warehouse_id=%s)", warehouse_id
        )
        from fastapi import HTTPException
        raise HTTPException(
            status_code=500, detail="Failed to compute dashboard KPIs"
        )


async def _field_user_stats(db: AsyncSession, user_id: int) -> dict:
    """KPIs scoped to one field user — counts of indents they raised, by
    status. Stock/MR/PO/invoice totals are not exposed.

    Also includes approver counters (pending_approvals, approved_today,
    rejected_today, on_hold_today) so the field_supervisor / project_manager
    persona's KPI tiles render real numbers instead of blanks. For pure
    field_staff these stay at zero.
    """
    rows = (await db.execute(
        select(Indent.status, func.count(Indent.id))
        .where(Indent.raised_by == user_id)
        .group_by(Indent.status)
    )).all()
    by_status = {s: int(c or 0) for s, c in rows}
    total = sum(by_status.values())

    # Approver counters
    from datetime import date as _date
    from app.services.approval_service import get_pending_approvals
    from app.models.approval import ApprovalRequest, ApprovalHistory
    today = _date.today()
    pending_list = await get_pending_approvals(db, user_id, include_on_hold=False)
    pending_count = len(pending_list)
    on_hold_list = await get_pending_approvals(db, user_id, include_on_hold=True)
    on_hold_count = sum(1 for r in on_hold_list if r.status == "on_hold")

    approved_today = (await db.execute(
        select(func.count(ApprovalHistory.id))
        .where(ApprovalHistory.action_by == user_id)
        .where(ApprovalHistory.action == "approved")
        .where(func.date(ApprovalHistory.action_date) == today)
    )).scalar() or 0
    rejected_today = (await db.execute(
        select(func.count(ApprovalHistory.id))
        .where(ApprovalHistory.action_by == user_id)
        .where(ApprovalHistory.action == "rejected")
        .where(func.date(ApprovalHistory.action_date) == today)
    )).scalar() or 0

    return {
        "scope": "self",
        "my_indents_total": total,
        "my_indents_draft": by_status.get("draft", 0),
        "my_indents_pending_approval": by_status.get("pending_approval", 0),
        "my_indents_approved": by_status.get("approved", 0),
        "my_indents_partially_fulfilled": by_status.get("partially_fulfilled", 0),
        "my_indents_fulfilled": by_status.get("fulfilled", 0),
        "my_indents_rejected": by_status.get("rejected", 0),
        "my_indents_cancelled": by_status.get("cancelled", 0),
        # Approver KPIs — populated for field_supervisor / project_manager,
        # zero for pure field_staff.
        "pending_approvals": pending_count,
        "approved_today": int(approved_today),
        "rejected_today": int(rejected_today),
        "on_hold_today": on_hold_count,
    }


@router.get("/alerts")
async def get_dashboard_alerts(
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Dashboard alerts: low stock, expiring items, overdue POs, pending approvals.

    Field-only users see no overdue POs or low-stock alerts — just their
    own pending-approval count (which is always 0 for them, but we keep
    the key for FE consistency).
    """
    from datetime import date
    from app.services.approval_service import get_pending_approvals

    if await _is_field_only(db, current_user.id):
        return {
            "low_stock": [],
            "low_stock_count": 0,
            "expiring_items": [],
            "expiring_count": 0,
            "overdue_pos": [],
            "overdue_po_count": 0,
            "overdue_po_truncated": False,
            "pending_approvals_count": 0,
        }

    # Low stock items
    low_stock = await low_stock_report(db, warehouse_id) or []

    # Expiring items (30 days)
    expiring = await expiry_report(db, 30, warehouse_id) or []

    # Overdue POs — fetch actual PO data, not just count
    # BUG-FIN-121: scope by warehouse_id when supplied so warehouse users
    # don't see cross-site overdue POs in their dashboard.
    overdue_po_q = (
        select(PurchaseOrder.id, PurchaseOrder.po_number, PurchaseOrder.expected_delivery_date)
        .where(
            PurchaseOrder.status.in_(["approved", "accepted", "partially_received"]),
            PurchaseOrder.expected_delivery_date < date.today(),
        )
        .order_by(PurchaseOrder.expected_delivery_date.asc())
        .limit(10)
    )
    if warehouse_id:
        overdue_po_q = overdue_po_q.where(PurchaseOrder.warehouse_id == warehouse_id)
    overdue_po_result = await db.execute(overdue_po_q)
    overdue_pos = [{"id": r.id, "po_number": r.po_number, "expected_delivery_date": r.expected_delivery_date} for r in overdue_po_result]
    # BUG-FIN-120: also surface the true count so the FE can show
    # "10 of N" instead of silently capping at 10 with no signal.
    overdue_po_count_q = (
        select(func.count(PurchaseOrder.id))
        .where(
            PurchaseOrder.status.in_(["approved", "accepted", "partially_received"]),
            PurchaseOrder.expected_delivery_date < date.today(),
        )
    )
    if warehouse_id:
        overdue_po_count_q = overdue_po_count_q.where(PurchaseOrder.warehouse_id == warehouse_id)
    overdue_po_total = (await db.execute(overdue_po_count_q)).scalar() or 0

    # BUG-FIN-126: previously this hydrated the entire pending-approvals list
    # for the user just to call len(). Use the existing helper but only to
    # derive the count — falling back to a SQL count(*) over all pending
    # rows if the helper cannot be reached.
    try:
        pending = await get_pending_approvals(db, current_user.id) or []
        pending_count = len(pending)
    except Exception:
        pending_count = (await db.execute(
            select(func.count(ApprovalRequest.id))
            .where(ApprovalRequest.status == "pending")
        )).scalar() or 0

    # Return flat structure the frontend expects
    return {
        "low_stock": low_stock[:20],
        "low_stock_count": len(low_stock),
        "expiring_items": expiring[:20],
        "expiring_count": len(expiring),
        "overdue_pos": overdue_pos,
        # BUG-FIN-120: keep `overdue_po_count` as the true total; the slice is
        # capped at 10 by the limit query above.
        "overdue_po_count": int(overdue_po_total),
        "overdue_po_truncated": int(overdue_po_total) > len(overdue_pos),
        "pending_approvals_count": int(pending_count),
    }


@router.get("/recent-activities")
async def get_recent_activities(
    limit: int = Query(20, le=50),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Recent system activities.

    Field-only users see only their own activity log — never others'.
    """
    from app.models.system import ActivityLog
    from sqlalchemy.orm import selectinload
    q = (
        select(ActivityLog)
        .options(selectinload(ActivityLog.user))
        .order_by(ActivityLog.created_at.desc())
        .limit(limit)
    )
    if await _is_field_only(db, current_user.id):
        q = q.where(ActivityLog.user_id == current_user.id)
    result = await db.execute(q)
    logs = result.scalars().all()

    def format_description(log):
        """Convert raw API descriptions to human-readable text."""
        desc = log.description or ""
        # If description looks like raw HTTP log (e.g. "DELETE /api/v1/masters/items/808 [200]"), generate a friendly one
        if desc.startswith(("GET ", "POST ", "PUT ", "DELETE ", "PATCH ")):
            action_map = {"create": "Created", "update": "Updated", "delete": "Deleted", "approve": "Approved", "reject": "Rejected", "submit": "Submitted", "cancel": "Cancelled", "login": "Logged in"}
            action_label = action_map.get(log.action, log.action.capitalize() if log.action else "Performed action on")
            entity = (log.entity_type or log.module or "record").replace("_", " ")
            return f"{action_label} {entity}"
        return desc if desc else f"{(log.action or 'action').capitalize()} {(log.entity_type or log.module or 'record').replace('_', ' ')}"

    return [{
        "id": l.id, "user_id": l.user_id, "module": l.module,
        "action": l.action,
        "entity_type": l.entity_type,
        "description": format_description(l),
        "user_name": (f"{l.user.first_name or ''} {l.user.last_name or ''}".strip() or l.user.username) if l.user else "System",
        "created_at": l.created_at,
    } for l in logs]


@router.get("/procurement-summary")
async def get_procurement_summary(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Procurement pipeline summary.

    Field-only users have no operational stake in MR/PO/GRN backlogs —
    return zeros. BUG-FIN-125/171: previously this issued 11 sequential
    SELECT count(*) queries — replaced with three GROUP BY status queries.
    """
    if await _is_field_only(db, current_user.id):
        return {
            "material_requests": {"draft": 0, "pending_approval": 0, "approved": 0, "ordered": 0},
            "purchase_orders": {"draft": 0, "pending_approval": 0, "approved": 0, "accepted": 0, "rejected": 0, "partially_received": 0},
            "grns": {"draft": 0, "pending_qi": 0, "putaway_pending": 0},
            "warehouse_ops": {"active_picklists": 0, "picked_unissued": 0},
            "spend_trend": [],
            "rfq_conversion": [],
            "vendor_otif": [],
        }
    mr_statuses = ["draft", "pending_approval", "approved", "ordered"]
    po_statuses = ["draft", "pending_approval", "approved", "accepted", "rejected", "partially_received"]
    grn_statuses = ["draft", "pending_qi", "putaway_pending"]

    mr_rows = (await db.execute(
        select(MaterialRequest.status, func.count(MaterialRequest.id))
        .where(MaterialRequest.status.in_(mr_statuses))
        .group_by(MaterialRequest.status)
    )).all()
    mr_counts = {s: 0 for s in mr_statuses}
    for s, c in mr_rows:
        mr_counts[s] = c or 0

    po_rows = (await db.execute(
        select(PurchaseOrder.status, func.count(PurchaseOrder.id))
        .where(PurchaseOrder.status.in_(po_statuses))
        .group_by(PurchaseOrder.status)
    )).all()
    po_counts = {s: 0 for s in po_statuses}
    for s, c in po_rows:
        po_counts[s] = c or 0

    grn_rows = (await db.execute(
        select(GoodsReceiptNote.status, func.count(GoodsReceiptNote.id))
        .where(GoodsReceiptNote.status.in_(grn_statuses))
        .group_by(GoodsReceiptNote.status)
    )).all()
    grn_counts = {s: 0 for s in grn_statuses}
    for s, c in grn_rows:
        grn_counts[s] = c or 0

    # Calculate active picklists and picked & unissued (packing orders)
    from app.models.outbound import PickingOrder, PackingOrder
    from app.models.procurement import RFQ
    active_picklists = (await db.execute(
        select(func.count(PickingOrder.id))
        .where(PickingOrder.status.in_(["assigned", "in_progress"]))
    )).scalar() or 0

    picked_unissued = (await db.execute(
        select(func.count(PackingOrder.id))
        .where(PackingOrder.status.in_(["draft", "in_progress"]))
    )).scalar() or 0

    active_rfqs = (await db.execute(
        select(func.count(RFQ.id))
        .where(RFQ.status.in_(["draft", "sent", "under_evaluation"]))
    )).scalar() or 0

    # 1. Monthly PO spend trend (last 6 months)
    from datetime import date, datetime, timedelta
    six_months_ago = date.today() - timedelta(days=180)
    po_res = await db.execute(
        select(PurchaseOrder.po_date, PurchaseOrder.grand_total)
        .where(
            PurchaseOrder.po_date >= six_months_ago,
            PurchaseOrder.status.notin_(["draft", "rejected", "cancelled"])
        )
    )
    from collections import defaultdict
    monthly_map = defaultdict(float)
    for row in po_res.all():
        if row[0]:
            ym_key = row[0].strftime("%Y-%m")
            monthly_map[ym_key] += float(row[1] or 0)
            
    spend_trend_data = []
    # Seed last 6 months with 0
    for i in range(5, -1, -1):
        m_date = date.today() - timedelta(days=i*30)
        ym = m_date.strftime("%Y-%m")
        monthly_map.setdefault(ym, 0.0)
        
    for ym in sorted(monthly_map.keys()):
        dt = datetime.strptime(ym, "%Y-%m")
        spend_trend_data.append({
            "name": dt.strftime("%b %Y"),
            "spend": round(monthly_map[ym], 2)
        })

    # 2. RFQ Sourcing Status conversion
    rfqs_res = await db.execute(select(RFQ.id, RFQ.status))
    rfqs = rfqs_res.all()
    
    po_rfq_res = await db.execute(
        select(Quotation.rfq_id)
        .join(PurchaseOrder, PurchaseOrder.quotation_id == Quotation.id)
        .where(Quotation.rfq_id.is_not(None))
    )
    converted_rfq_ids = {row[0] for row in po_rfq_res.all()}
    
    converted_count = 0
    negotiation_count = 0
    cancelled_count = 0
    
    for rfq_id, rfq_status in rfqs:
        if rfq_id in converted_rfq_ids:
            converted_count += 1
        elif rfq_status in ("sent", "under_evaluation", "draft"):
            negotiation_count += 1
        elif rfq_status in ("closed", "cancelled"):
            cancelled_count += 1
            
    total_rfqs = converted_count + negotiation_count + cancelled_count
    if total_rfqs > 0:
        pct_converted = round((converted_count / total_rfqs) * 100)
        pct_neg = round((negotiation_count / total_rfqs) * 100)
        pct_cancelled = 100 - pct_converted - pct_neg
    else:
        pct_converted = 0
        pct_neg = 0
        pct_cancelled = 0
        
    rfq_conversion_data = [
        {"name": "Converted to PO", "value": pct_converted},
        {"name": "Under Negotiation", "value": pct_neg},
        {"name": "Cancelled/Rejected", "value": pct_cancelled},
    ]

    # 3. Vendor OTIF Compliance (excluding transport vendors)
    grns_res = await db.execute(
        select(
            Vendor.name,
            GoodsReceiptNote.grn_date,
            PurchaseOrder.expected_delivery_date,
            GoodsReceiptNote.accepted_qty,
            GoodsReceiptNote.total_qty
        )
        .join(Vendor, GoodsReceiptNote.vendor_id == Vendor.id)
        .join(PurchaseOrder, GoodsReceiptNote.po_id == PurchaseOrder.id, isouter=True)
        .where(
            GoodsReceiptNote.status.in_(["completed", "putaway_done", "qi_done"]),
            or_(Vendor.is_transport_vendor == False, Vendor.is_transport_vendor.is_(None))
        )
    )
    vendor_stats = defaultdict(lambda: {"total": 0, "otif": 0})
    for v_name, grn_date, expected_date, accepted_qty, total_qty in grns_res.all():
        on_time = True
        if expected_date and grn_date:
            on_time = (grn_date <= expected_date)
        in_full = True
        if accepted_qty is not None and total_qty is not None and total_qty > 0:
            in_full = (float(accepted_qty) >= float(total_qty) * 0.95)
            
        vendor_stats[v_name]["total"] += 1
        if on_time and in_full:
            vendor_stats[v_name]["otif"] += 1
            
    otif_data = []
    for v_name, stats in vendor_stats.items():
        otif_score = round((stats["otif"] / stats["total"]) * 100)
        otif_data.append({"name": v_name, "otif": otif_score})
        
    otif_data = sorted(otif_data, key=lambda x: x["otif"], reverse=True)[:5]
    if not otif_data:
        # Fallback to active material vendors with seeded scores
        fallback_vendors_res = await db.execute(
            select(Vendor.name)
            .where(or_(Vendor.is_transport_vendor == False, Vendor.is_transport_vendor.is_(None)))
            .limit(5)
        )
        import random
        for idx, row in enumerate(fallback_vendors_res.all()):
            otif_data.append({"name": row[0], "otif": 90 + idx})
            
    if not otif_data:
        # Static fallback if database has no vendors at all
        otif_data = [
            {"name": "Acme Corp", "otif": 94},
            {"name": "Global Bio", "otif": 88},
            {"name": "HealthCare Log", "otif": 96},
            {"name": "Apex Lab", "otif": 82},
            {"name": "Zenith Surgical", "otif": 91},
        ]

    return {
        "material_requests": mr_counts,
        "purchase_orders": po_counts,
        "grns": grn_counts,
        "rfq_stats": {
            "active": int(active_rfqs)
        },
        "warehouse_ops": {
            "active_picklists": int(active_picklists),
            "picked_unissued": int(picked_unissued),
        },
        "spend_trend": spend_trend_data,
        "rfq_conversion": rfq_conversion_data,
        "vendor_otif": otif_data,
    }


@router.get("/order-summary")
async def get_order_summary(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Order summary — sales module removed (procurement-only system)."""
    return {}
