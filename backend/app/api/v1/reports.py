from fastapi import APIRouter, Depends, Query
from typing import Optional
from datetime import date
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.models.user import User
from app.services.report_service import (
    # Inventory
    stock_summary_report, stock_detail_report, stock_movement_report,
    low_stock_report, expiry_report, stock_valuation_report, dead_stock_report,
    abc_classification_report, fifo_cost_tracking_report, inventory_turnover_report,
    # Procurement
    po_summary_report, vendor_performance_report, grn_report, pending_po_report,
    # Consumption
    consumption_summary_report, consumption_trend_report,
    # Accounts
    accounts_payable_report, accounts_receivable_report, payment_summary_report,
    vendor_ledger_report, po_ledger_report, project_ledger_report,
    # Asset
    asset_register_report,
)
from app.utils.dependencies import get_current_user, require_any_role, require_permission

router = APIRouter()


# ==================== TOP-LEVEL DISPATCHER ALIASES ====================

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


@router.get("/procurement")
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


@router.get("/inventory")
async def reports_inventory_dispatch(
    report_type: str = Query("stock_summary"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100000),  # BUG-FIN-103/106: lift export cap
    warehouse_id: Optional[int] = Query(None),
    category_id: Optional[int] = Query(None),
    item_id: Optional[int] = Query(None),
    days: Optional[int] = Query(None),
    days_ahead: Optional[int] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    group_by_warehouse: bool = Query(False, description="Per-warehouse breakdown (BUG-FIN-107)"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Inventory reports dispatcher.

    BUG-FIN-095: previously returned an empty stub.
    """
    df = _parse_date(date_from)
    dt = _parse_date(date_to)
    if report_type == "stock_summary":
        rows = await stock_summary_report(db, warehouse_id, category_id, group_by_warehouse=group_by_warehouse)
    elif report_type == "stock_detail":
        rows = await stock_detail_report(db, item_id, warehouse_id)
    elif report_type == "stock_movement":
        rows = await stock_movement_report(db, item_id, warehouse_id, df, dt)
    elif report_type == "low_stock":
        rows = await low_stock_report(db, warehouse_id)
    elif report_type == "expiry":
        rows = await expiry_report(db, days_ahead or 90, warehouse_id)
    elif report_type == "valuation":
        rows = await stock_valuation_report(db, warehouse_id)
    elif report_type == "dead_stock":
        rows = await dead_stock_report(db, days or 90, warehouse_id)
    elif report_type == "abc_classification":
        rows = await abc_classification_report(db)
    elif report_type == "fifo_cost_tracking":
        rows = await fifo_cost_tracking_report(db, item_id, warehouse_id)
    elif report_type == "turnover":
        rows = await inventory_turnover_report(db, df, dt, warehouse_id)
    else:
        rows = await stock_summary_report(db, warehouse_id, category_id)
    rows = list(rows or [])
    out = _paginate_list(rows, page, page_size)
    out["report_type"] = report_type
    return out


@router.get("/consumption")
async def reports_consumption_dispatch(
    report_type: str = Query("summary"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100000),  # BUG-FIN-103/106: lift export cap
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    project_id: Optional[int] = Query(None),
    department: Optional[str] = Query(None),
    item_id: Optional[int] = Query(None),
    months: int = Query(12),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Consumption reports dispatcher.

    BUG-FIN-096: previously returned an empty stub.
    """
    df = _parse_date(date_from)
    dt = _parse_date(date_to)
    if report_type == "summary":
        rows = await consumption_summary_report(db, df, dt, project_id, department)
    elif report_type == "trend":
        rows = await consumption_trend_report(db, item_id, months)
    else:
        rows = await consumption_summary_report(db, df, dt, project_id, department)
    rows = list(rows or [])
    out = _paginate_list(rows, page, page_size)
    out["report_type"] = report_type
    return out


@router.get("/consumption/chart")
async def reports_consumption_chart(
    report_type: str = Query("summary"),
    chart: bool = Query(True),
    current_user: User = Depends(get_current_user),
):
    return {"labels": [], "datasets": [], "report_type": report_type}


@router.get("/accounts")
async def reports_accounts_dispatch(
    report_type: str = Query("payable"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100000),  # BUG-FIN-103/106: lift export cap
    vendor_id: Optional[int] = Query(None),
    customer_id: Optional[int] = Query(None),
    party_type: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Accounts reports dispatcher.

    BUG-FIN-098: previously returned an empty stub.
    """
    df = _parse_date(date_from)
    dt = _parse_date(date_to)
    if report_type in ("payable", "accounts_payable", "vendor_balance"):
        rows = await accounts_payable_report(db, vendor_id)
    elif report_type in ("receivable", "accounts_receivable"):
        rows = await accounts_receivable_report(db, customer_id)
    elif report_type in ("payment_summary", "payments"):
        rows = await payment_summary_report(db, df, dt, party_type)
    else:
        rows = await accounts_payable_report(db, vendor_id)
    rows = list(rows or [])
    out = _paginate_list(rows, page, page_size)
    out["report_type"] = report_type
    return out


@router.get("/system")
async def reports_system_dispatch(
    report_type: str = Query("activity_log"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100000),  # BUG-FIN-103/106: lift export cap
    module: Optional[str] = Query(None),
    user_id: Optional[int] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """System reports dispatcher.

    BUG-FIN-099: previously returned an empty stub.
    """
    from sqlalchemy import select, func
    from app.models.system import ActivityLog
    from app.utils.helpers import paginate_params, build_paginated_response
    df = _parse_date(date_from)
    dt = _parse_date(date_to)

    if report_type in ("activity_log", "activity_logs"):
        offset, limit = paginate_params(page, page_size)
        query = select(ActivityLog).order_by(ActivityLog.created_at.desc())
        count_query = select(func.count(ActivityLog.id))
        if module:
            query = query.where(ActivityLog.module == module)
            count_query = count_query.where(ActivityLog.module == module)
        if user_id:
            query = query.where(ActivityLog.user_id == user_id)
            count_query = count_query.where(ActivityLog.user_id == user_id)
        if df:
            query = query.where(ActivityLog.created_at >= df)
            count_query = count_query.where(ActivityLog.created_at >= df)
        if dt:
            query = query.where(ActivityLog.created_at <= dt)
            count_query = count_query.where(ActivityLog.created_at <= dt)
        total = (await db.execute(count_query)).scalar() or 0
        result = await db.execute(query.offset(offset).limit(limit))
        logs = result.scalars().all()
        items = [{
            "id": l.id, "user_id": l.user_id, "module": l.module,
            "action": l.action, "entity_type": l.entity_type,
            "entity_id": l.entity_id, "description": l.description,
            "ip_address": l.ip_address, "created_at": l.created_at,
        } for l in logs]
        out = build_paginated_response(items, total, page, page_size)
        out["report_type"] = report_type
        return out

    if report_type == "user_activity":
        from app.models.user import User as UserModel
        result = await db.execute(
            select(
                UserModel.id, UserModel.username, UserModel.first_name,
                func.count(ActivityLog.id).label("action_count"),
                func.max(ActivityLog.created_at).label("last_activity"),
            )
            .outerjoin(ActivityLog, ActivityLog.user_id == UserModel.id)
            .where(UserModel.is_active == True)  # noqa: E712
            .group_by(UserModel.id)
            .order_by(func.count(ActivityLog.id).desc())
        )
        rows = [dict(r._mapping) for r in result.all()]
        out = _paginate_list(rows, page, page_size)
        out["report_type"] = report_type
        return out

    return {"items": [], "total": 0, "report_type": report_type}


# ==================== SHORTCUT ALIASES (frontend compatibility) ====================

@router.get("/stock-summary")
async def rpt_stock_summary_alias(
    warehouse_id: int = Query(None),
    category_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: GET /reports/stock-summary -> /reports/inventory/stock-summary."""
    return await stock_summary_report(db, warehouse_id, category_id)


@router.get("/purchase-summary")
async def rpt_purchase_summary_alias(
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    vendor_id: int = Query(None),
    status: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: GET /reports/purchase-summary -> /reports/procurement/po-summary."""
    return await po_summary_report(db, date_from, date_to, vendor_id, status)


@router.get("/inventory-aging")
async def rpt_inventory_aging_alias(
    days: int = Query(90),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: GET /reports/inventory-aging -> /reports/inventory/dead-stock."""
    return await dead_stock_report(db, days, warehouse_id)


# ==================== INVENTORY REPORTS ====================

@router.get("/inventory/stock-summary")
async def rpt_stock_summary(
    warehouse_id: int = Query(None),
    category_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await stock_summary_report(db, warehouse_id, category_id)


@router.get("/inventory/stock-detail")
async def rpt_stock_detail(
    item_id: int = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await stock_detail_report(db, item_id, warehouse_id)


@router.get("/inventory/stock-movement")
async def rpt_stock_movement(
    item_id: int = Query(None),
    warehouse_id: int = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await stock_movement_report(db, item_id, warehouse_id, date_from, date_to)


@router.get("/inventory/low-stock")
async def rpt_low_stock(
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await low_stock_report(db, warehouse_id)


@router.get("/inventory/expiry")
async def rpt_expiry(
    days_ahead: int = Query(90),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await expiry_report(db, days_ahead, warehouse_id)


@router.get("/inventory/valuation")
async def rpt_valuation(
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await stock_valuation_report(db, warehouse_id)


@router.get("/inventory/dead-stock")
async def rpt_dead_stock(
    days: int = Query(90),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await dead_stock_report(db, days, warehouse_id)


@router.get("/inventory/batch-status")
async def rpt_batch_status(
    item_id: int = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Batch-wise stock status."""
    return await stock_detail_report(db, item_id, warehouse_id)


@router.get("/inventory/warehouse-wise")
async def rpt_warehouse_wise(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Stock summary per warehouse."""
    from sqlalchemy import select, func
    from app.models.stock import StockBalance
    from app.models.warehouse import Warehouse
    result = await db.execute(
        select(
            Warehouse.id, Warehouse.code, Warehouse.name,
            func.count(func.distinct(StockBalance.item_id)).label("item_count"),
            func.sum(StockBalance.total_qty).label("total_qty"),
            func.sum(StockBalance.stock_value).label("total_value"),
        )
        .join(StockBalance, StockBalance.warehouse_id == Warehouse.id)
        .group_by(Warehouse.id)
        .order_by(Warehouse.name)
    )
    return [dict(row._mapping) for row in result.all()]


@router.get("/inventory/category-wise")
async def rpt_category_wise(
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Stock summary per item category."""
    from sqlalchemy import select, func
    from app.models.stock import StockBalance
    from app.models.master import Item, ItemCategory
    query = (
        select(
            ItemCategory.id, ItemCategory.name,
            func.count(func.distinct(Item.id)).label("item_count"),
            func.sum(StockBalance.total_qty).label("total_qty"),
            func.sum(StockBalance.stock_value).label("total_value"),
        )
        .join(Item, Item.category_id == ItemCategory.id)
        .join(StockBalance, StockBalance.item_id == Item.id)
        .group_by(ItemCategory.id, ItemCategory.name)
    )
    if warehouse_id:
        query = query.where(StockBalance.warehouse_id == warehouse_id)
    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]


@router.get("/inventory/abc-classification")
async def rpt_abc_classification(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """ABC classification report - items grouped by purchase value."""
    return await abc_classification_report(db)


@router.get("/inventory/fifo-cost-tracking")
async def rpt_fifo_cost_tracking(
    item_id: int = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """FIFO cost lot tracking report - stock ledger entries ordered by received date."""
    return await fifo_cost_tracking_report(db, item_id, warehouse_id)


@router.get("/inventory/turnover")
async def rpt_inventory_turnover(
    start_date: Optional[date] = Query(None),
    end_date: Optional[date] = Query(None),
    warehouse_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Inventory turnover report - consumption / average stock for a date range."""
    return await inventory_turnover_report(db, start_date, end_date, warehouse_id)


# ==================== PROCUREMENT REPORTS ====================

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


# ==================== CONSUMPTION REPORTS ====================

@router.get("/consumption/summary")
async def rpt_consumption_summary(
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    project_id: int = Query(None),
    department: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await consumption_summary_report(db, date_from, date_to, project_id, department)


@router.get("/consumption/trend")
async def rpt_consumption_trend(
    item_id: int = Query(None),
    months: int = Query(12),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await consumption_trend_report(db, item_id, months)


@router.get("/consumption/department-wise")
async def rpt_consumption_department(
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Consumption by department."""
    from sqlalchemy import select, func
    from app.models.consumption import ConsumptionEntry, ConsumptionItem
    query = (
        select(
            ConsumptionEntry.department,
            func.count(func.distinct(ConsumptionEntry.id)).label("entry_count"),
            func.sum(ConsumptionItem.amount).label("total_amount"),
        )
        .join(ConsumptionItem, ConsumptionItem.entry_id == ConsumptionEntry.id)
        .where(ConsumptionEntry.status.in_(["submitted", "approved"]))
        .group_by(ConsumptionEntry.department)
    )
    if date_from:
        query = query.where(ConsumptionEntry.consumption_date >= date_from)
    if date_to:
        query = query.where(ConsumptionEntry.consumption_date <= date_to)
    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]


@router.get("/consumption/project-wise")
async def rpt_consumption_project(
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Consumption by project."""
    from sqlalchemy import select, func
    from app.models.consumption import ConsumptionEntry, ConsumptionItem
    query = (
        select(
            ConsumptionEntry.project_id,
            func.count(func.distinct(ConsumptionEntry.id)).label("entry_count"),
            func.sum(ConsumptionItem.amount).label("total_amount"),
        )
        .join(ConsumptionItem, ConsumptionItem.entry_id == ConsumptionEntry.id)
        .where(ConsumptionEntry.status.in_(["submitted", "approved"]))
        .group_by(ConsumptionEntry.project_id)
    )
    if date_from:
        query = query.where(ConsumptionEntry.consumption_date >= date_from)
    if date_to:
        query = query.where(ConsumptionEntry.consumption_date <= date_to)
    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]


# ==================== ACCOUNTS REPORTS ====================

@router.get("/accounts/payable")
async def rpt_accounts_payable(
    vendor_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    # BUG-FIN-159: payable book is sensitive financial data.
    current_user: User = Depends(require_permission("accounts", "view", "reports")),
):
    return await accounts_payable_report(db, vendor_id)


@router.get("/accounts/receivable")
async def rpt_accounts_receivable(
    customer_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    # BUG-FIN-159: receivable book is sensitive financial data.
    current_user: User = Depends(require_permission("accounts", "view", "reports")),
):
    return await accounts_receivable_report(db, customer_id)


@router.get("/accounts/payment-summary")
async def rpt_payment_summary(
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    party_type: str = Query(None),
    db: AsyncSession = Depends(get_db),
    # BUG-FIN-159: payment summary is sensitive financial data.
    current_user: User = Depends(require_permission("accounts", "view", "reports")),
):
    return await payment_summary_report(db, date_from, date_to, party_type)


@router.get("/accounts/vendor-ledger/{vendor_id}")
async def rpt_vendor_ledger(
    vendor_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-FIN-158: vendor ledger leaks vendor-level transaction history; gate it.
    current_user: User = Depends(require_permission("accounts", "view", "reports")),
):
    return await vendor_ledger_report(db, vendor_id)


@router.get("/accounts/po-ledger/{po_id}")
async def rpt_po_ledger(
    po_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("accounts", "view", "reports")),
):
    return await po_ledger_report(db, po_id)


@router.get("/accounts/project-ledger/{project_id}")
async def rpt_project_ledger(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("accounts", "view", "reports")),
):
    return await project_ledger_report(db, project_id)


@router.get("/accounts/ageing")
async def rpt_ageing(
    party_type: str = Query("vendor"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Ageing analysis of outstanding invoices."""
    from sqlalchemy import select, func, case, and_
    from app.models.accounts import Invoice
    from datetime import date as d, timedelta
    today = d.today()

    # BUG-FIN-083/084: rewrite buckets as disjoint half-open ranges keyed by
    # `days_overdue = today - due_date` so labels match coverage:
    #   not_due:    days_overdue <= 0            (today's due-date counts as not yet due)
    #   0_30_days:  1..30 days overdue
    #   31_60_days: 31..60 days overdue
    #   61_90_days: 61..90 days overdue
    #   over_90:    >90 days overdue
    result = await db.execute(
        select(
            Invoice.party_id,
            func.sum(case(
                (Invoice.due_date >= today, Invoice.balance_amount), else_=0
            )).label("not_due"),
            func.sum(case(
                (and_(Invoice.due_date <= today - timedelta(days=1),
                      Invoice.due_date >= today - timedelta(days=30)),
                 Invoice.balance_amount), else_=0
            )).label("0_30_days"),
            func.sum(case(
                (and_(Invoice.due_date <= today - timedelta(days=31),
                      Invoice.due_date >= today - timedelta(days=60)),
                 Invoice.balance_amount), else_=0
            )).label("31_60_days"),
            func.sum(case(
                (and_(Invoice.due_date <= today - timedelta(days=61),
                      Invoice.due_date >= today - timedelta(days=90)),
                 Invoice.balance_amount), else_=0
            )).label("61_90_days"),
            func.sum(case(
                (Invoice.due_date < today - timedelta(days=90), Invoice.balance_amount), else_=0
            )).label("over_90_days"),
            func.sum(Invoice.balance_amount).label("total"),
        )
        .where(
            Invoice.party_type == party_type,
            # BUG-FIN-044: include "unpaid" status the UI sends and any
            # reasonable variants. Only "paid" and "cancelled" should be
            # excluded from aging.
            Invoice.status.notin_(["paid", "cancelled"]),
            # BUG-FIN-166: include overpaid invoices (negative balance) in
            # aging so the adjustment workflow can see them too. Only exclude
            # rows that are exactly zero (fully settled).
            Invoice.balance_amount != 0,
        )
        .group_by(Invoice.party_id)
    )
    return [dict(row._mapping) for row in result.all()]


@router.get("/accounts/gst-summary")
async def rpt_gst_summary(
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """GST summary report."""
    from sqlalchemy import select, func
    from app.models.accounts import Invoice
    # BUG-FIN-101: when both dates are null the prior version aggregated every
    # invoice ever raised, which made the GSTR upload screen unusable on a
    # multi-year ledger. Default to the current calendar month so the report
    # always returns a bounded, meaningful payload.
    if not date_from and not date_to:
        from datetime import date as _date
        today = _date.today()
        date_from = today.replace(day=1)
        date_to = today
    query = (
        select(
            Invoice.invoice_type,
            func.sum(Invoice.subtotal).label("taxable_amount"),
            func.sum(Invoice.cgst_amount).label("total_cgst"),
            func.sum(Invoice.sgst_amount).label("total_sgst"),
            func.sum(Invoice.igst_amount).label("total_igst"),
            func.sum(Invoice.tax_amount).label("total_tax"),
            func.sum(Invoice.grand_total).label("grand_total"),
        )
        .where(Invoice.status != "cancelled")
        .group_by(Invoice.invoice_type)
    )
    if date_from:
        query = query.where(Invoice.invoice_date >= date_from)
    if date_to:
        query = query.where(Invoice.invoice_date <= date_to)
    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]



# ==================== ASSET REPORTS ====================

@router.get("/assets/register")
async def rpt_asset_register(
    category_id: int = Query(None),
    status: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await asset_register_report(db, category_id, status)


@router.get("/assets/depreciation")
async def rpt_depreciation(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Asset depreciation summary."""
    from sqlalchemy import select, func
    from app.models.asset import Asset, AssetCategory
    # BUG-FIN-102: disposed/lost assets keep their last current_value but are
    # no longer being depreciated — including them double-counts depreciation
    # and inflates the totals on the dashboard. Filter to live statuses.
    result = await db.execute(
        select(
            AssetCategory.name.label("category"),
            func.count(Asset.id).label("asset_count"),
            func.sum(Asset.purchase_price).label("total_purchase_price"),
            func.sum(Asset.current_value).label("total_current_value"),
            (func.sum(Asset.purchase_price) - func.sum(Asset.current_value)).label("total_depreciation"),
        )
        .join(Asset, Asset.category_id == AssetCategory.id)
        .where(Asset.status.in_(["available", "in_use", "maintenance"]))
        .group_by(AssetCategory.id, AssetCategory.name)
    )
    return [dict(row._mapping) for row in result.all()]


# ==================== SYSTEM REPORTS ====================

@router.get("/system/activity-log")
async def rpt_activity_log(
    module: str = Query(None),
    user_id: int = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Activity log report."""
    from sqlalchemy import select, func
    from app.models.system import ActivityLog
    from app.utils.helpers import paginate_params, build_paginated_response
    offset, limit = paginate_params(page, page_size)

    query = select(ActivityLog).order_by(ActivityLog.created_at.desc())
    count_query = select(func.count(ActivityLog.id))

    if module:
        query = query.where(ActivityLog.module == module)
        count_query = count_query.where(ActivityLog.module == module)
    if user_id:
        query = query.where(ActivityLog.user_id == user_id)
        count_query = count_query.where(ActivityLog.user_id == user_id)
    if date_from:
        query = query.where(ActivityLog.created_at >= date_from)
        count_query = count_query.where(ActivityLog.created_at >= date_from)
    if date_to:
        query = query.where(ActivityLog.created_at <= date_to)
        count_query = count_query.where(ActivityLog.created_at <= date_to)

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit))
    logs = result.scalars().all()

    items = [{
        "id": l.id, "user_id": l.user_id, "module": l.module,
        "action": l.action, "entity_type": l.entity_type,
        "entity_id": l.entity_id, "description": l.description,
        "ip_address": l.ip_address, "created_at": l.created_at,
    } for l in logs]

    return build_paginated_response(items, total, page, page_size)


@router.get("/system/user-activity")
async def rpt_user_activity(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """User activity summary."""
    from sqlalchemy import select, func
    from app.models.system import ActivityLog
    from app.models.user import User as UserModel
    result = await db.execute(
        select(
            UserModel.id, UserModel.username, UserModel.first_name,
            func.count(ActivityLog.id).label("action_count"),
            func.max(ActivityLog.created_at).label("last_activity"),
        )
        .outerjoin(ActivityLog, ActivityLog.user_id == UserModel.id)
        .where(UserModel.is_active == True)
        .group_by(UserModel.id)
        .order_by(func.count(ActivityLog.id).desc())
    )
    return [dict(row._mapping) for row in result.all()]
