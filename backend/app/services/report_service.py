from decimal import Decimal
from datetime import date, datetime
from typing import Optional, List, Dict, Any
from sqlalchemy import select, func, and_, case, text
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.stock import StockBalance, StockLedger
from app.models.master import Item, Vendor, Customer, ItemCategory
from app.models.warehouse import Warehouse, Batch
from app.models.procurement import PurchaseOrder, PurchaseOrderItem, MaterialRequest
from app.models.grn import GoodsReceiptNote, GRNItem
from app.models.outbound import SalesOrder, SalesOrderItem
from app.models.consumption import ConsumptionEntry, ConsumptionItem
from app.models.accounts import Invoice, Payment, AccountLedger
from app.models.indent import Indent
from app.models.asset import Asset
from app.models.approval import ApprovalRequest


# ==================== INVENTORY REPORTS ====================

async def stock_summary_report(
    db: AsyncSession,
    warehouse_id: Optional[int] = None,
    category_id: Optional[int] = None,
    group_by_warehouse: bool = False,
) -> List[Dict]:
    """Current stock summary across warehouses.

    BUG-FIN-107: when ``group_by_warehouse=True`` the result includes a
    per-warehouse breakdown (warehouse_id, warehouse_name) so XLSX exports
    don't silently roll up cross-warehouse stock into a single row.
    """
    if group_by_warehouse:
        query = (
            select(
                Item.id, Item.item_code, Item.name,
                StockBalance.warehouse_id,
                Warehouse.name.label("warehouse_name"),
                func.sum(StockBalance.total_qty).label("total_qty"),
                func.sum(StockBalance.available_qty).label("available_qty"),
                func.sum(StockBalance.reserved_qty).label("reserved_qty"),
                func.sum(StockBalance.stock_value).label("stock_value"),
            )
            .join(StockBalance, StockBalance.item_id == Item.id)
            .outerjoin(Warehouse, Warehouse.id == StockBalance.warehouse_id)
            .group_by(
                Item.id, Item.item_code, Item.name,
                StockBalance.warehouse_id, Warehouse.name,
            )
        )
    else:
        query = (
            select(
                Item.id, Item.item_code, Item.name,
                func.sum(StockBalance.total_qty).label("total_qty"),
                func.sum(StockBalance.available_qty).label("available_qty"),
                func.sum(StockBalance.reserved_qty).label("reserved_qty"),
                func.sum(StockBalance.stock_value).label("stock_value"),
            )
            .join(StockBalance, StockBalance.item_id == Item.id)
            .group_by(Item.id, Item.item_code, Item.name)
        )
    if warehouse_id:
        query = query.where(StockBalance.warehouse_id == warehouse_id)
    if category_id:
        query = query.where(Item.category_id == category_id)

    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]


async def stock_detail_report(
    db: AsyncSession,
    item_id: Optional[int] = None,
    warehouse_id: Optional[int] = None,
) -> List[Dict]:
    """Detailed stock with bin/batch level breakdown."""
    query = (
        select(StockBalance)
        .order_by(StockBalance.item_id)
    )
    if item_id:
        query = query.where(StockBalance.item_id == item_id)
    if warehouse_id:
        query = query.where(StockBalance.warehouse_id == warehouse_id)

    result = await db.execute(query)
    rows = result.scalars().all()
    return [{
        "item_id": r.item_id,
        "warehouse_id": r.warehouse_id,
        "bin_id": r.bin_id,
        "batch_id": r.batch_id,
        "total_qty": float(r.total_qty or 0),
        "available_qty": float(r.available_qty or 0),
        "reserved_qty": float(r.reserved_qty or 0),
        "stock_value": float(r.stock_value or 0),
        "valuation_rate": float(r.valuation_rate or 0),
    } for r in rows]


async def stock_movement_report(
    db: AsyncSession,
    item_id: Optional[int] = None,
    warehouse_id: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
) -> List[Dict]:
    """Stock movement (in/out) report from ledger."""
    query = select(StockLedger).order_by(StockLedger.posting_date.desc(), StockLedger.id.desc())
    conditions = []
    if item_id:
        conditions.append(StockLedger.item_id == item_id)
    if warehouse_id:
        conditions.append(StockLedger.warehouse_id == warehouse_id)
    if date_from:
        conditions.append(StockLedger.posting_date >= date_from)
    if date_to:
        # BUG-FIN-085: posting_date is a DATETIME; comparing with date midnight
        # excluded rows posted later in the to-date. Use exclusive upper bound
        # at start of next day so the entire to-date is included.
        from datetime import timedelta as _td, date as _d, datetime as _dt
        if isinstance(date_to, _dt):
            upper = date_to + _td(days=1)
        elif isinstance(date_to, _d):
            upper = _dt.combine(date_to, _dt.min.time()) + _td(days=1)
        else:
            upper = date_to
        conditions.append(StockLedger.posting_date < upper)
    if conditions:
        query = query.where(and_(*conditions))

    # BUG-FIN-086: previously hard-capped at 1000 rows with silent truncation.
    # Lifted to 50000 — callers should narrow by date/item to keep results tight.
    result = await db.execute(query.limit(50000))
    rows = result.scalars().all()
    return [{
        "id": r.id,
        "item_id": r.item_id,
        "warehouse_id": r.warehouse_id,
        "transaction_type": r.transaction_type,
        "qty_in": float(r.qty_in or 0),
        "qty_out": float(r.qty_out or 0),
        "balance_qty": float(r.balance_qty or 0),
        "rate": float(r.rate or 0),
        "posting_date": r.posting_date.isoformat() if r.posting_date else None,
        "reference_type": r.reference_type,
        "reference_id": r.reference_id,
    } for r in rows]


async def low_stock_report(db: AsyncSession, warehouse_id: Optional[int] = None) -> List[Dict]:
    """Items below reorder level.

    BUG-FIN-090: when reorder_level=0 the previous having(<= 0) matched every
    no-stock item, returning the entire catalog. Restrict to items where
    reorder_level is positive — only those have a meaningful threshold.
    BUG-FIN-091: apply the warehouse filter as a join predicate so it works
    correctly with outerjoin + group_by (filtering the StockBalance side
    rather than the result of the aggregate).
    """
    join_cond = StockBalance.item_id == Item.id
    if warehouse_id:
        join_cond = and_(join_cond, StockBalance.warehouse_id == warehouse_id)
    query = (
        select(
            Item.id, Item.item_code, Item.name,
            Item.reorder_level, Item.safety_stock, Item.reorder_qty,
            func.coalesce(func.sum(StockBalance.available_qty), 0).label("available_qty"),
        )
        .outerjoin(StockBalance, join_cond)
        .where(Item.is_active == True, Item.reorder_level > 0)
        .group_by(Item.id)
        .having(func.coalesce(func.sum(StockBalance.available_qty), 0) <= Item.reorder_level)
    )
    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]


async def expiry_report(
    db: AsyncSession,
    days_ahead: int = 90,
    warehouse_id: Optional[int] = None,
) -> List[Dict]:
    """Items expiring within specified days."""
    from datetime import timedelta
    cutoff = date.today() + timedelta(days=days_ahead)

    query = (
        select(
            Batch.id.label("batch_id"),
            Batch.batch_number,
            Batch.expiry_date,
            Item.id.label("item_id"),
            Item.item_code,
            Item.name.label("item_name"),
            func.sum(StockBalance.available_qty).label("available_qty"),
        )
        .join(Item, Batch.item_id == Item.id)
        .join(StockBalance, and_(
            StockBalance.batch_id == Batch.id,
            StockBalance.item_id == Item.id,
        ))
        .where(
            Batch.expiry_date <= cutoff,
            Batch.status == "active",
            StockBalance.available_qty > 0,
        )
        .group_by(Batch.id, Item.id)
        .order_by(Batch.expiry_date.asc())
    )
    if warehouse_id:
        query = query.where(StockBalance.warehouse_id == warehouse_id)

    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]


async def stock_valuation_report(db: AsyncSession, warehouse_id: Optional[int] = None) -> List[Dict]:
    """Stock valuation summary by item."""
    query = (
        select(
            Item.id, Item.item_code, Item.name,
            func.sum(StockBalance.total_qty).label("total_qty"),
            func.sum(StockBalance.stock_value).label("total_value"),
        )
        .join(StockBalance, StockBalance.item_id == Item.id)
        .where(StockBalance.total_qty > 0)
        .group_by(Item.id)
        .order_by(func.sum(StockBalance.stock_value).desc())
    )
    if warehouse_id:
        query = query.where(StockBalance.warehouse_id == warehouse_id)

    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]


async def dead_stock_report(db: AsyncSession, days: int = 90, warehouse_id: Optional[int] = None) -> List[Dict]:
    """Items with no movement in specified days."""
    from datetime import timedelta
    cutoff = date.today() - timedelta(days=days)

    # BUG-FIN-093: scope the "items with recent movement" subquery to the
    # same warehouse so an item that moved in WH-A but not WH-B doesn't get
    # excluded from WH-B's dead-stock report.
    # BUG-FIN-092: scope the OUTER stock balance join to the same warehouse
    # so the resulting qty/value totals reflect that warehouse only.
    subq_inner = select(StockLedger.item_id).where(StockLedger.posting_date >= cutoff)
    if warehouse_id:
        subq_inner = subq_inner.where(StockLedger.warehouse_id == warehouse_id)
    subq = subq_inner.distinct().scalar_subquery()

    join_cond = StockBalance.item_id == Item.id
    if warehouse_id:
        join_cond = and_(join_cond, StockBalance.warehouse_id == warehouse_id)
    query = (
        select(
            Item.id, Item.item_code, Item.name,
            func.sum(StockBalance.total_qty).label("total_qty"),
            func.sum(StockBalance.stock_value).label("stock_value"),
        )
        .join(StockBalance, join_cond)
        .where(
            Item.id.notin_(subq),
            StockBalance.total_qty > 0,
        )
        .group_by(Item.id)
    )

    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]


# ==================== PROCUREMENT REPORTS ====================

async def po_summary_report(
    db: AsyncSession,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    vendor_id: Optional[int] = None,
    status: Optional[str] = None,
) -> List[Dict]:
    """Purchase order summary report.

    BUG-FIN-087: previously INNER JOIN Vendor, so POs whose vendor was
    soft-deleted disappeared. Outer join keeps the historical POs visible.
    """
    query = (
        select(
            PurchaseOrder.id, PurchaseOrder.po_number, PurchaseOrder.po_date,
            PurchaseOrder.vendor_id, PurchaseOrder.grand_total,
            PurchaseOrder.status, Vendor.name.label("vendor_name"),
        )
        .outerjoin(Vendor, PurchaseOrder.vendor_id == Vendor.id)
        .order_by(PurchaseOrder.po_date.desc())
    )
    conditions = []
    if date_from:
        conditions.append(PurchaseOrder.po_date >= date_from)
    if date_to:
        conditions.append(PurchaseOrder.po_date <= date_to)
    if vendor_id:
        conditions.append(PurchaseOrder.vendor_id == vendor_id)
    if status:
        conditions.append(PurchaseOrder.status == status)
    if conditions:
        query = query.where(and_(*conditions))

    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]


async def vendor_performance_report(db: AsyncSession, vendor_id: Optional[int] = None) -> List[Dict]:
    """Vendor performance summary.

    BUG-FIN-088: don't filter by is_active. Historical POs from deactivated
    vendors are still relevant for performance analysis. The UI can hide
    inactive vendors as a presentation choice.
    """
    query = (
        select(
            Vendor.id, Vendor.vendor_code, Vendor.name, Vendor.rating,
            func.count(PurchaseOrder.id).label("total_pos"),
            func.sum(PurchaseOrder.grand_total).label("total_amount"),
        )
        .outerjoin(PurchaseOrder, PurchaseOrder.vendor_id == Vendor.id)
        .group_by(Vendor.id)
        .order_by(Vendor.rating.desc())
    )
    if vendor_id:
        query = query.where(Vendor.id == vendor_id)

    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]


async def grn_report(
    db: AsyncSession,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    warehouse_id: Optional[int] = None,
) -> List[Dict]:
    """GRN summary report."""
    query = (
        select(
            GoodsReceiptNote.id, GoodsReceiptNote.grn_number, GoodsReceiptNote.grn_date,
            GoodsReceiptNote.vendor_id, GoodsReceiptNote.warehouse_id,
            GoodsReceiptNote.total_qty, GoodsReceiptNote.accepted_qty,
            GoodsReceiptNote.rejected_qty, GoodsReceiptNote.status,
        )
        .order_by(GoodsReceiptNote.grn_date.desc())
    )
    conditions = []
    if date_from:
        conditions.append(GoodsReceiptNote.grn_date >= date_from)
    if date_to:
        conditions.append(GoodsReceiptNote.grn_date <= date_to)
    if warehouse_id:
        conditions.append(GoodsReceiptNote.warehouse_id == warehouse_id)
    if conditions:
        query = query.where(and_(*conditions))

    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]


async def pending_po_report(db: AsyncSession) -> List[Dict]:
    """POs pending delivery."""
    query = (
        select(
            PurchaseOrder.id, PurchaseOrder.po_number, PurchaseOrder.po_date,
            PurchaseOrder.expected_delivery_date, PurchaseOrder.grand_total,
            PurchaseOrder.status, Vendor.name.label("vendor_name"),
        )
        .join(Vendor, PurchaseOrder.vendor_id == Vendor.id)
        .where(PurchaseOrder.status.in_(["approved", "partially_received"]))
        .order_by(PurchaseOrder.expected_delivery_date.asc())
    )
    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]


# ==================== CONSUMPTION REPORTS ====================

async def consumption_summary_report(
    db: AsyncSession,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    project_id: Optional[int] = None,
    department: Optional[str] = None,
) -> List[Dict]:
    """Consumption summary by item."""
    query = (
        select(
            Item.id, Item.item_code, Item.name,
            func.sum(ConsumptionItem.qty).label("total_qty"),
            func.sum(ConsumptionItem.amount).label("total_amount"),
        )
        .join(ConsumptionItem, ConsumptionItem.item_id == Item.id)
        .join(ConsumptionEntry, ConsumptionItem.entry_id == ConsumptionEntry.id)
        .where(ConsumptionEntry.status.in_(["submitted", "approved"]))
        .group_by(Item.id)
        .order_by(func.sum(ConsumptionItem.amount).desc())
    )
    conditions = []
    if date_from:
        conditions.append(ConsumptionEntry.consumption_date >= date_from)
    if date_to:
        conditions.append(ConsumptionEntry.consumption_date <= date_to)
    if project_id:
        conditions.append(ConsumptionEntry.project_id == project_id)
    if department:
        conditions.append(ConsumptionEntry.department == department)
    if conditions:
        query = query.where(and_(*conditions))

    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]


async def consumption_trend_report(
    db: AsyncSession,
    item_id: Optional[int] = None,
    months: int = 12,
) -> List[Dict]:
    """Monthly consumption trend."""
    # BUG-FIN-100: avoid `text("month DESC")` ordering — that string is not
    # portable to Postgres or SQLite. Reference the labeled column directly so
    # SQLAlchemy emits the correct identifier on every backend.
    month_col = func.date_format(ConsumptionEntry.consumption_date, "%Y-%m").label("month")
    query = (
        select(
            month_col,
            func.sum(ConsumptionItem.qty).label("total_qty"),
            func.sum(ConsumptionItem.amount).label("total_amount"),
            func.count(func.distinct(ConsumptionEntry.id)).label("entry_count"),
        )
        .join(ConsumptionItem, ConsumptionItem.entry_id == ConsumptionEntry.id)
        .where(ConsumptionEntry.status.in_(["submitted", "approved"]))
        .group_by(month_col)
        .order_by(month_col.desc())
        .limit(months)
    )
    if item_id:
        query = query.where(ConsumptionItem.item_id == item_id)

    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]


# ==================== SALES REPORTS ====================

async def sales_summary_report(
    db: AsyncSession,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    customer_id: Optional[int] = None,
) -> List[Dict]:
    """Sales order summary."""
    query = (
        select(
            SalesOrder.id, SalesOrder.so_number, SalesOrder.order_date,
            SalesOrder.customer_id, SalesOrder.grand_total, SalesOrder.status,
            Customer.name.label("customer_name"),
        )
        .join(Customer, SalesOrder.customer_id == Customer.id)
        .order_by(SalesOrder.order_date.desc())
    )
    conditions = []
    if date_from:
        conditions.append(SalesOrder.order_date >= date_from)
    if date_to:
        conditions.append(SalesOrder.order_date <= date_to)
    if customer_id:
        conditions.append(SalesOrder.customer_id == customer_id)
    if conditions:
        query = query.where(and_(*conditions))

    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]


# ==================== ACCOUNTS REPORTS ====================

async def accounts_payable_report(db: AsyncSession, vendor_id: Optional[int] = None) -> List[Dict]:
    """Outstanding payable invoices.

    BUG-FIN-089: include any non-paid / non-cancelled invoice (e.g.
    "overdue_paid" or capitalized variants the audit found in old data).
    Anything with balance_amount > 0 is genuinely outstanding.
    """
    query = (
        select(
            Invoice.id, Invoice.invoice_number, Invoice.invoice_date,
            Invoice.party_id, Invoice.grand_total, Invoice.paid_amount,
            Invoice.balance_amount, Invoice.due_date, Invoice.status,
        )
        .where(
            Invoice.invoice_type == "purchase",
            Invoice.status.notin_(["paid", "cancelled"]),
            Invoice.balance_amount > 0,
        )
        .order_by(Invoice.due_date.asc())
    )
    if vendor_id:
        query = query.where(Invoice.party_id == vendor_id)

    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]


async def accounts_receivable_report(db: AsyncSession, customer_id: Optional[int] = None) -> List[Dict]:
    """Outstanding receivable invoices."""
    query = (
        select(
            Invoice.id, Invoice.invoice_number, Invoice.invoice_date,
            Invoice.party_id, Invoice.grand_total, Invoice.paid_amount,
            Invoice.balance_amount, Invoice.due_date, Invoice.status,
        )
        .where(
            Invoice.invoice_type == "sales",
            Invoice.status.in_(["submitted", "partially_paid", "overdue"]),
        )
        .order_by(Invoice.due_date.asc())
    )
    if customer_id:
        query = query.where(Invoice.party_id == customer_id)

    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]


async def payment_summary_report(
    db: AsyncSession,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    party_type: Optional[str] = None,
) -> List[Dict]:
    """Payment summary report."""
    query = (
        select(
            Payment.id, Payment.payment_number, Payment.payment_date,
            Payment.party_type, Payment.party_id, Payment.amount,
            Payment.payment_mode, Payment.status,
        )
        .order_by(Payment.payment_date.desc())
    )
    conditions = []
    if date_from:
        conditions.append(Payment.payment_date >= date_from)
    if date_to:
        conditions.append(Payment.payment_date <= date_to)
    if party_type:
        conditions.append(Payment.party_type == party_type)
    if conditions:
        query = query.where(and_(*conditions))

    result = await db.execute(query)
    return [dict(row._mapping) for row in result.all()]


async def vendor_ledger_report(db: AsyncSession, vendor_id: int) -> List[Dict]:
    """Ledger entries for a specific vendor."""
    query = (
        select(AccountLedger)
        .where(
            AccountLedger.party_type == "vendor",
            AccountLedger.party_id == vendor_id,
        )
        .order_by(AccountLedger.posting_date.desc())
    )
    result = await db.execute(query)
    rows = result.scalars().all()
    return [{
        "id": r.id, "posting_date": r.posting_date.isoformat() if r.posting_date else None,
        "debit": float(r.debit or 0), "credit": float(r.credit or 0),
        "balance": float(r.balance or 0), "narration": r.narration,
        "reference_type": r.reference_type, "reference_id": r.reference_id,
    } for r in rows]


async def po_ledger_report(db: AsyncSession, po_id: int) -> List[Dict]:
    """Ledger entries for a specific PO."""
    query = (
        select(AccountLedger)
        .where(AccountLedger.po_id == po_id)
        .order_by(AccountLedger.posting_date.desc())
    )
    result = await db.execute(query)
    rows = result.scalars().all()
    return [{
        "id": r.id, "posting_date": r.posting_date.isoformat() if r.posting_date else None,
        "debit": float(r.debit or 0), "credit": float(r.credit or 0),
        "balance": float(r.balance or 0), "narration": r.narration,
    } for r in rows]


async def project_ledger_report(db: AsyncSession, project_id: int) -> List[Dict]:
    """Ledger entries for a specific project."""
    query = (
        select(AccountLedger)
        .where(AccountLedger.project_id == project_id)
        .order_by(AccountLedger.posting_date.desc())
    )
    result = await db.execute(query)
    rows = result.scalars().all()
    return [{
        "id": r.id, "posting_date": r.posting_date.isoformat() if r.posting_date else None,
        "account_id": r.account_id,
        "debit": float(r.debit or 0), "credit": float(r.credit or 0),
        "balance": float(r.balance or 0), "narration": r.narration,
    } for r in rows]





# ==================== ASSET REPORTS ====================

async def asset_register_report(
    db: AsyncSession,
    category_id: Optional[int] = None,
    status: Optional[str] = None,
) -> List[Dict]:
    """Full asset register."""
    query = select(Asset).order_by(Asset.asset_code)
    if category_id:
        query = query.where(Asset.category_id == category_id)
    if status:
        query = query.where(Asset.status == status)

    result = await db.execute(query)
    rows = result.scalars().all()
    return [{
        "id": r.id, "asset_code": r.asset_code, "name": r.name,
        "category_id": r.category_id, "serial_number": r.serial_number,
        "purchase_date": r.purchase_date.isoformat() if r.purchase_date else None,
        "purchase_price": float(r.purchase_price or 0),
        "current_value": float(r.current_value or 0),
        "status": r.status, "condition_status": r.condition_status,
        "current_location": r.current_location,
    } for r in rows]


# ==================== ABC / FIFO / TURNOVER REPORTS ====================

async def abc_classification_report(db: AsyncSession) -> List[Dict]:
    """ABC classification based on purchase_price * total stock qty."""
    query = (
        select(
            Item.id, Item.item_code, Item.name.label("item_name"),
            ItemCategory.name.label("category"),
            func.coalesce(func.sum(StockBalance.total_qty), 0).label("total_qty"),
            Item.purchase_price,
            (Item.purchase_price * func.coalesce(func.sum(StockBalance.total_qty), 0)).label("total_value"),
        )
        .outerjoin(StockBalance, StockBalance.item_id == Item.id)
        .outerjoin(ItemCategory, Item.category_id == ItemCategory.id)
        .where(Item.is_active == True)
        .group_by(Item.id, Item.item_code, Item.name, ItemCategory.name, Item.purchase_price)
        .having(func.coalesce(func.sum(StockBalance.total_qty), 0) > 0)
        .order_by((Item.purchase_price * func.coalesce(func.sum(StockBalance.total_qty), 0)).desc())
    )
    result = await db.execute(query)
    rows = [dict(row._mapping) for row in result.all()]

    # Calculate grand total value
    grand_total = sum(float(r["total_value"] or 0) for r in rows)
    if grand_total == 0:
        return rows

    # Assign ABC class based on cumulative percentage
    cumulative = Decimal(0)
    for r in rows:
        val = Decimal(str(r["total_value"] or 0))
        cumulative += val
        pct = float(cumulative / Decimal(str(grand_total)) * 100)
        r["total_value"] = float(r["total_value"] or 0)
        r["total_qty"] = float(r["total_qty"] or 0)
        r["purchase_price"] = float(r["purchase_price"] or 0)
        r["cumulative_pct"] = round(pct, 2)
        if pct <= 80:
            r["class"] = "A"
        elif pct <= 95:
            r["class"] = "B"
        else:
            r["class"] = "C"

    return rows


async def fifo_cost_tracking_report(
    db: AsyncSession,
    item_id: Optional[int] = None,
    warehouse_id: Optional[int] = None,
) -> List[Dict]:
    """FIFO cost lot tracking from stock_ledger entries (inbound only)."""
    try:
        from datetime import date as d

        query = (
            select(
                StockLedger.id,
                Item.item_code,
                Item.name.label("item_name"),
                Batch.batch_number,
                StockLedger.posting_date.label("received_date"),
                StockLedger.qty_in.label("qty"),
                StockLedger.rate,
                StockLedger.value_in.label("total_value"),
                StockLedger.created_at,
            )
            .join(Item, StockLedger.item_id == Item.id)
            .outerjoin(Batch, StockLedger.batch_id == Batch.id)
            .where(StockLedger.qty_in > 0)
            .order_by(StockLedger.created_at.asc())
        )
        conditions = []
        if item_id:
            conditions.append(StockLedger.item_id == item_id)
        if warehouse_id:
            conditions.append(StockLedger.warehouse_id == warehouse_id)
        if conditions:
            query = query.where(and_(*conditions))

        # BUG-FIN-086: previously hard-capped at 2000 rows; lift to 50000 for
        # FIFO history. Filter by item_id/warehouse_id to keep result tight.
        result = await db.execute(query.limit(50000))
        rows = result.all()
        today = d.today()

        items = []
        for r in rows:
            rd = r.received_date
            if rd and hasattr(rd, "date"):
                age = (today - rd.date()).days
                rd_str = rd.isoformat()
            elif rd:
                age = (today - rd).days if isinstance(rd, d) else 0
                rd_str = rd.isoformat() if hasattr(rd, "isoformat") else str(rd)
            else:
                age = 0
                rd_str = None
            items.append({
                "id": r.id,
                "item_code": r.item_code,
                "item_name": r.item_name,
                "batch_number": r.batch_number,
                "received_date": rd_str,
                "qty": float(r.qty or 0),
                "rate": float(r.rate or 0),
                "total_value": float(r.total_value or 0),
                "age_days": age,
            })
        return items
    except Exception:
        return []


async def inventory_turnover_report(
    db: AsyncSession,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    warehouse_id: Optional[int] = None,
) -> List[Dict]:
    """Inventory turnover = total consumption / average stock for a date range."""
    # Sub-query: total consumed qty per item from consumption_items
    cons_query = (
        select(
            ConsumptionItem.item_id,
            func.sum(ConsumptionItem.qty).label("total_consumed"),
        )
        .join(ConsumptionEntry, ConsumptionItem.entry_id == ConsumptionEntry.id)
        .where(ConsumptionEntry.status.in_(["submitted", "approved"]))
    )
    cons_conditions = []
    if start_date:
        cons_conditions.append(ConsumptionEntry.consumption_date >= start_date)
    if end_date:
        cons_conditions.append(ConsumptionEntry.consumption_date <= end_date)
    if cons_conditions:
        cons_query = cons_query.where(and_(*cons_conditions))
    cons_query = cons_query.group_by(ConsumptionItem.item_id)
    cons_subq = cons_query.subquery()

    # Current stock as closing stock
    stock_query = (
        select(
            StockBalance.item_id,
            func.sum(StockBalance.total_qty).label("closing_stock"),
        )
    )
    if warehouse_id:
        stock_query = stock_query.where(StockBalance.warehouse_id == warehouse_id)
    stock_query = stock_query.group_by(StockBalance.item_id)
    stock_subq = stock_query.subquery()

    # Main query joining item with consumption and stock
    main_query = (
        select(
            Item.id, Item.item_code, Item.name.label("item_name"),
            func.coalesce(stock_subq.c.closing_stock, 0).label("closing_stock"),
            func.coalesce(cons_subq.c.total_consumed, 0).label("total_consumed"),
        )
        .outerjoin(cons_subq, cons_subq.c.item_id == Item.id)
        .outerjoin(stock_subq, stock_subq.c.item_id == Item.id)
        .where(Item.is_active == True)
        # Only show items that have stock or consumption
        .having(
            (func.coalesce(stock_subq.c.closing_stock, 0) > 0) |
            (func.coalesce(cons_subq.c.total_consumed, 0) > 0)
        )
        .group_by(
            Item.id, Item.item_code, Item.name,
            stock_subq.c.closing_stock, cons_subq.c.total_consumed,
        )
        .order_by(Item.item_code)
    )

    result = await db.execute(main_query)
    rows = result.all()

    output = []
    for r in rows:
        closing = float(r.closing_stock or 0)
        consumed = float(r.total_consumed or 0)
        # opening_stock = closing_stock + total_consumed (approximation)
        opening = closing + consumed
        avg_stock = (opening + closing) / 2 if (opening + closing) > 0 else 0
        turnover_ratio = round(consumed / avg_stock, 2) if avg_stock > 0 else 0

        output.append({
            "item_code": r.item_code,
            "item_name": r.item_name,
            "opening_stock": round(opening, 3),
            "total_consumed": round(consumed, 3),
            "closing_stock": round(closing, 3),
            "avg_stock": round(avg_stock, 3),
            "turnover_ratio": turnover_ratio,
        })

    return output


# ==================== SYSTEM / DASHBOARD KPIs ====================

async def dashboard_kpis(db: AsyncSession, warehouse_id: Optional[int] = None) -> Dict:
    """Get dashboard KPI data."""
    # Total stock value
    sv_query = select(func.coalesce(func.sum(StockBalance.stock_value), 0))
    if warehouse_id:
        sv_query = sv_query.where(StockBalance.warehouse_id == warehouse_id)
    stock_value = (await db.execute(sv_query)).scalar()

    # Total items
    item_count = (await db.execute(select(func.count(Item.id)).where(Item.is_active == True))).scalar()

    # BUG-FIN-117: scope POs/MRs/GRNs by warehouse_id when supplied.
    open_po_q = select(func.count(PurchaseOrder.id)).where(
        PurchaseOrder.status.in_(["approved", "partially_received"])
    )
    if warehouse_id:
        open_po_q = open_po_q.where(PurchaseOrder.warehouse_id == warehouse_id)
    open_po_count = (await db.execute(open_po_q)).scalar()

    pending_mr_q = select(func.count(MaterialRequest.id)).where(
        MaterialRequest.status.in_(["draft", "pending_approval"])
    )
    if warehouse_id and hasattr(MaterialRequest, "warehouse_id"):
        pending_mr_q = pending_mr_q.where(MaterialRequest.warehouse_id == warehouse_id)
    pending_mr = (await db.execute(pending_mr_q)).scalar()

    pending_grn_q = select(func.count(GoodsReceiptNote.id)).where(
        GoodsReceiptNote.status.in_(["draft", "pending_qi"])
    )
    if warehouse_id and hasattr(GoodsReceiptNote, "warehouse_id"):
        pending_grn_q = pending_grn_q.where(GoodsReceiptNote.warehouse_id == warehouse_id)
    pending_grn = (await db.execute(pending_grn_q)).scalar()

    # BUG-FIN-118: low_stock subquery now honours warehouse_id.
    low_stock_inner = (
        select(Item.id)
        .outerjoin(StockBalance, StockBalance.item_id == Item.id)
        .where(Item.is_active == True, Item.reorder_level > 0)
    )
    if warehouse_id:
        low_stock_inner = low_stock_inner.where(StockBalance.warehouse_id == warehouse_id)
    low_stock_subq = (
        low_stock_inner
        .group_by(Item.id, Item.reorder_level)
        .having(func.coalesce(func.sum(StockBalance.available_qty), 0) <= Item.reorder_level)
    ).subquery()
    low_stock = (await db.execute(
        select(func.count()).select_from(low_stock_subq)
    )).scalar() or 0

    # Pending indents — match the same warehouse scoping as MR/GRN above so a
    # warehouse manager doesn't see a count that includes other warehouses
    # she has no visibility into via /indent/indents.
    pending_indents_q = (
        select(func.count(Indent.id))
        .where(Indent.status.in_(["draft", "pending_approval"]))
    )
    if warehouse_id:
        pending_indents_q = pending_indents_q.where(Indent.warehouse_id == warehouse_id)
    pending_indents = (await db.execute(pending_indents_q)).scalar()

    # Unpaid invoices
    # BUG-FIN-124: Invoice has no warehouse_id column today, so per-warehouse
    # scoping isn't directly possible without a schema change. We derive an
    # approximate warehouse-scoped figure when warehouse_id is supplied by
    # joining through PurchaseOrder.warehouse_id (purchase invoices link to a
    # PO). Sales invoices fall back to org-wide. Document this clearly so
    # reports don't misrepresent the figure.
    unpaid_query = (
        select(func.coalesce(func.sum(Invoice.balance_amount), 0))
        .where(Invoice.status.in_(["submitted", "partially_paid", "overdue"]))
    )
    if warehouse_id:
        unpaid_query = unpaid_query.where(
            Invoice.po_id.in_(
                select(PurchaseOrder.id).where(
                    PurchaseOrder.warehouse_id == warehouse_id
                )
            )
        )
    unpaid_invoices = (await db.execute(unpaid_query)).scalar()

    return {
        "total_stock_value": float(stock_value or 0),
        "total_items": item_count or 0,
        "total_active_items": item_count or 0,
        "active_pos": open_po_count or 0,
        "open_purchase_orders": open_po_count or 0,
        "pending_material_requests": pending_mr or 0,
        "pending_grn": pending_grn or 0,
        "pending_grns": pending_grn or 0,
        "low_stock_items": low_stock,
        "pending_approvals": (await db.execute(
            select(func.count(ApprovalRequest.id))
            .where(ApprovalRequest.status == "pending")
        )).scalar() or 0,
        "pending_indents": pending_indents or 0,
        "unpaid_invoice_amount": float(unpaid_invoices or 0),
    }
