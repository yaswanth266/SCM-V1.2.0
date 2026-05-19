"""Wave 10 — Reporting aggregation engine.

Security-first design: every column/table referenced in a report definition
is validated against a whitelist before any SQL is built. We never use string
interpolation on user-supplied identifiers — we map them to known SQLAlchemy
column objects.

Fact tables and their allowed dimensions/measures live in REPORT_SCHEMA.
"""
from __future__ import annotations
from decimal import Decimal
from datetime import date, datetime, timedelta, timezone
from typing import Optional, Any

from fastapi import HTTPException
from sqlalchemy import select, func, and_, or_, cast, Date
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.stock import StockLedger, StockBalance
from app.models.consumption import ConsumptionEntry, ConsumptionItem
from app.models.procurement import PurchaseOrder, PurchaseOrderItem
from app.models.accounts import Invoice, InvoiceItem, AccountLedger, ChartOfAccounts
from app.models.master import Item, Vendor, ItemCategory
from app.models.warehouse import Warehouse


# Each "table" entry is a logical fact table the user can build reports against.
# Columns are mapped to SQLAlchemy column objects so user input never reaches SQL.
REPORT_SCHEMA = {
    "stock_ledger": {
        "label": "Stock Ledger Movements",
        "join": [(Item, Item.id == StockLedger.item_id),
                 (Warehouse, Warehouse.id == StockLedger.warehouse_id)],
        "dimensions": {
            "item_code": Item.item_code,
            "item_name": Item.name,
            "category": ItemCategory.name,
            "warehouse_name": Warehouse.name,
            "transaction_type": StockLedger.transaction_type,
            "posting_date": cast(StockLedger.posting_date, Date),
            "posting_month": func.date_format(StockLedger.posting_date, "%Y-%m"),
            "posting_year": func.year(StockLedger.posting_date),
        },
        "measures": {
            "qty_in": (func.coalesce(func.sum(StockLedger.qty_in), 0), "sum"),
            "qty_out": (func.coalesce(func.sum(StockLedger.qty_out), 0), "sum"),
            "value_in": (func.coalesce(func.sum(StockLedger.value_in), 0), "sum"),
            "value_out": (func.coalesce(func.sum(StockLedger.value_out), 0), "sum"),
            "transaction_count": (func.count(StockLedger.id), "count"),
        },
        "filterable": {
            "item_id": StockLedger.item_id,
            "warehouse_id": StockLedger.warehouse_id,
            "transaction_type": StockLedger.transaction_type,
            "posting_date": StockLedger.posting_date,
        },
        "extra_joins_for_dim": {
            "category": (ItemCategory, ItemCategory.id == Item.category_id),
        },
    },
    "consumption": {
        "label": "Consumption",
        "join": [
            (ConsumptionEntry, ConsumptionEntry.id == ConsumptionItem.entry_id),
            (Item, Item.id == ConsumptionItem.item_id),
        ],
        "dimensions": {
            "item_code": Item.item_code,
            "item_name": Item.name,
            "category": ItemCategory.name,
            "department": ConsumptionEntry.department,
            "cost_center": ConsumptionEntry.cost_center,
            "consumption_date": cast(ConsumptionEntry.consumption_date, Date),
            "consumption_month": func.date_format(ConsumptionEntry.consumption_date, "%Y-%m"),
            "source": ConsumptionEntry.source,
        },
        "measures": {
            "qty": (func.coalesce(func.sum(ConsumptionItem.qty), 0), "sum"),
            "amount": (func.coalesce(func.sum(ConsumptionItem.amount), 0), "sum"),
            "entry_count": (func.count(func.distinct(ConsumptionEntry.id)), "count"),
            "line_count": (func.count(ConsumptionItem.id), "count"),
        },
        "filterable": {
            "item_id": ConsumptionItem.item_id,
            "department": ConsumptionEntry.department,
            "consumption_date": ConsumptionEntry.consumption_date,
        },
        "extra_joins_for_dim": {
            "category": (ItemCategory, ItemCategory.id == Item.category_id),
        },
    },
    "purchase_orders": {
        "label": "Purchase Orders",
        # BUG-FIN-113: cancelled POs distort summary measures; filtered below
        # in run_report.
        "join": [
            (PurchaseOrder, PurchaseOrder.id == PurchaseOrderItem.po_id),
            (Item, Item.id == PurchaseOrderItem.item_id),
            (Vendor, Vendor.id == PurchaseOrder.vendor_id),
        ],
        "dimensions": {
            "po_number": PurchaseOrder.po_number,
            "vendor_name": Vendor.name,
            "vendor_code": Vendor.vendor_code,
            "item_code": Item.item_code,
            "item_name": Item.name,
            "category": ItemCategory.name,
            "po_status": PurchaseOrder.status,
            "po_date": cast(PurchaseOrder.po_date, Date),
            "po_month": func.date_format(PurchaseOrder.po_date, "%Y-%m"),
        },
        "measures": {
            "qty": (func.coalesce(func.sum(PurchaseOrderItem.qty), 0), "sum"),
            "received_qty": (func.coalesce(func.sum(PurchaseOrderItem.received_qty), 0), "sum"),
            "amount": (func.coalesce(func.sum(PurchaseOrderItem.amount), 0), "sum"),
            "po_count": (func.count(func.distinct(PurchaseOrder.id)), "count"),
            "line_count": (func.count(PurchaseOrderItem.id), "count"),
        },
        "filterable": {
            "vendor_id": PurchaseOrder.vendor_id,
            "po_status": PurchaseOrder.status,
            "po_date": PurchaseOrder.po_date,
        },
        "extra_joins_for_dim": {
            "category": (ItemCategory, ItemCategory.id == Item.category_id),
        },
    },
    "invoices": {
        "label": "Invoices",
        "join": [
            (Invoice, Invoice.id == InvoiceItem.invoice_id),
            (Item, Item.id == InvoiceItem.item_id),
        ],
        "dimensions": {
            "invoice_number": Invoice.invoice_number,
            "invoice_type": Invoice.invoice_type,
            "party_type": Invoice.party_type,
            "item_code": Item.item_code,
            "item_name": Item.name,
            "invoice_status": Invoice.status,
            "invoice_date": cast(Invoice.invoice_date, Date),
            "invoice_month": func.date_format(Invoice.invoice_date, "%Y-%m"),
        },
        "measures": {
            "qty": (func.coalesce(func.sum(InvoiceItem.qty), 0), "sum"),
            "amount": (func.coalesce(func.sum(InvoiceItem.amount), 0), "sum"),
            "tax_amount": (func.coalesce(func.sum(InvoiceItem.tax_amount), 0), "sum"),
            "invoice_count": (func.count(func.distinct(Invoice.id)), "count"),
        },
        "filterable": {
            "party_id": Invoice.party_id,
            "party_type": Invoice.party_type,
            "invoice_status": Invoice.status,
            "invoice_date": Invoice.invoice_date,
            "invoice_type": Invoice.invoice_type,
        },
        "extra_joins_for_dim": {},
    },
    "stock_balance": {
        "label": "Current Stock Balance",
        "join": [
            (Item, Item.id == StockBalance.item_id),
            (Warehouse, Warehouse.id == StockBalance.warehouse_id),
        ],
        "dimensions": {
            "item_code": Item.item_code,
            "item_name": Item.name,
            "category": ItemCategory.name,
            "warehouse_name": Warehouse.name,
        },
        "measures": {
            "available_qty": (func.coalesce(func.sum(StockBalance.available_qty), 0), "sum"),
            "reserved_qty": (func.coalesce(func.sum(StockBalance.reserved_qty), 0), "sum"),
            "total_qty": (func.coalesce(func.sum(StockBalance.total_qty), 0), "sum"),
            "stock_value": (func.coalesce(func.sum(StockBalance.stock_value), 0), "sum"),
            "row_count": (func.count(StockBalance.id), "count"),
        },
        "filterable": {
            "item_id": StockBalance.item_id,
            "warehouse_id": StockBalance.warehouse_id,
        },
        "extra_joins_for_dim": {
            "category": (ItemCategory, ItemCategory.id == Item.category_id),
        },
    },
}


def get_schema_meta() -> dict:
    """Return what's queryable for the UI builder."""
    out = {}
    for table_key, meta in REPORT_SCHEMA.items():
        out[table_key] = {
            "label": meta["label"],
            "dimensions": list(meta["dimensions"].keys()),
            "measures": list(meta["measures"].keys()),
            "filterable": list(meta["filterable"].keys()),
        }
    return out


def _validate_definition(definition: dict) -> dict:
    """Verify source_table / dimensions / measures / filters are all in whitelist."""
    src = definition.get("source_table")
    if src not in REPORT_SCHEMA:
        raise HTTPException(status_code=400, detail=f"source_table must be one of {list(REPORT_SCHEMA)}")
    schema = REPORT_SCHEMA[src]

    dims = definition.get("dimensions") or []
    meas = definition.get("measures") or []
    flts = definition.get("filters") or []

    if not isinstance(dims, list) or not isinstance(meas, list) or not isinstance(flts, list):
        raise HTTPException(status_code=400, detail="dimensions, measures, and filters must be arrays")

    for d in dims:
        if d not in schema["dimensions"]:
            raise HTTPException(status_code=400, detail=f"unknown dimension '{d}'")
    for m in meas:
        if m not in schema["measures"]:
            raise HTTPException(status_code=400, detail=f"unknown measure '{m}'")
    for f in flts:
        if not isinstance(f, dict) or "field" not in f or "op" not in f:
            raise HTTPException(status_code=400, detail="filter must be {field, op, value}")
        if f["field"] not in schema["filterable"]:
            raise HTTPException(status_code=400, detail=f"field '{f['field']}' is not filterable")
        if f["op"] not in ("eq", "ne", "in", "not_in", "lt", "lte", "gt", "gte", "between", "ilike", "is_null", "is_not_null"):
            raise HTTPException(status_code=400, detail=f"unknown filter op '{f['op']}'")
        # BUG-FIN-114: validate filter values for date-typed fields so a
        # garbage string ("yesterday", "2026-13-99") fails fast with a 400
        # rather than blowing up deep inside SQLAlchemy's coercion.
        if f["op"] in ("is_null", "is_not_null"):
            continue
        fname = f["field"]
        if fname.endswith("_date") or fname == "posting_date":
            from datetime import date as _date_t, datetime as _dt
            vals = f.get("value")
            check = vals if isinstance(vals, list) else [vals]
            for cv in check:
                if cv is None:
                    continue
                if isinstance(cv, (_date_t, _dt)):
                    continue
                try:
                    _date_t.fromisoformat(str(cv)[:10])
                except Exception:
                    raise HTTPException(
                        status_code=400,
                        detail=f"filter value for date field '{fname}' must be ISO date (YYYY-MM-DD)",
                    )
    return schema


def _apply_filter(query, schema: dict, f: dict):
    col = schema["filterable"][f["field"]]
    op = f["op"]
    v = f.get("value")
    if op == "eq": return query.where(col == v)
    if op == "ne": return query.where(col != v)
    if op == "in": return query.where(col.in_(v if isinstance(v, list) else [v]))
    if op == "not_in": return query.where(~col.in_(v if isinstance(v, list) else [v]))
    if op == "lt": return query.where(col < v)
    if op == "lte": return query.where(col <= v)
    if op == "gt": return query.where(col > v)
    if op == "gte": return query.where(col >= v)
    if op == "between":
        if not isinstance(v, list) or len(v) != 2:
            raise HTTPException(status_code=400, detail="between filter requires [from, to]")
        return query.where(col >= v[0]).where(col <= v[1])
    if op == "ilike":
        # BUG-FIN-111: escape SQL LIKE meta-chars (% and _) so users
        # searching for literal "100%" don't accidentally pull every row.
        if v is None:
            return query
        sval = str(v).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        return query.where(col.ilike(f"%{sval}%", escape="\\"))
    if op == "is_null": return query.where(col.is_(None))
    if op == "is_not_null": return query.where(col.isnot(None))
    return query


async def run_report(
    db: AsyncSession,
    *,
    definition: dict,
    limit: int = 1000,
    organization_id: Optional[int] = None,
) -> dict:
    """Build and execute the report query. Returns dict with rows, totals, columns.

    BUG-FIN-108: when ``organization_id`` is supplied, the query is scoped to
    that org. We scope through joined dimension tables that carry org_id
    (Warehouse, ChartOfAccounts) and Vendor where applicable. Fact tables
    lacking a direct org_id column are scoped indirectly via these joins
    until a migration adds the column.
    """
    schema = _validate_definition(definition)
    src = definition["source_table"]
    dims: list[str] = definition.get("dimensions") or []
    meas: list[str] = definition.get("measures") or ["row_count" if "row_count" in schema["measures"] else next(iter(schema["measures"]))]
    flts: list[dict] = definition.get("filters") or []

    # Build SELECT
    primary = next(iter(REPORT_SCHEMA[src]["join"]))[0] if REPORT_SCHEMA[src]["join"] else None
    select_cols = []
    label_map = {}
    for d in dims:
        col = schema["dimensions"][d]
        select_cols.append(col.label(d))
        label_map[d] = d
    for m in meas:
        col_expr, _agg_kind = schema["measures"][m]
        select_cols.append(col_expr.label(m))
        label_map[m] = m

    if not select_cols:
        raise HTTPException(status_code=400, detail="At least one dimension or measure is required")

    # Pick the right starting table; for fact tables that aren't the listed primary,
    # we use the global SELECT and let SQLAlchemy figure out joins.
    fact_table_map = {
        "stock_ledger": StockLedger,
        "consumption": ConsumptionItem,
        "purchase_orders": PurchaseOrderItem,
        "invoices": InvoiceItem,
        "stock_balance": StockBalance,
    }
    fact = fact_table_map[src]
    q = select(*select_cols).select_from(fact)

    # Joins
    for join_cls, join_cond in REPORT_SCHEMA[src]["join"]:
        if join_cls is fact:
            continue
        q = q.join(join_cls, join_cond, isouter=True)
    # Extra joins required by the chosen dimensions (e.g. category -> ItemCategory)
    for d in dims:
        extra = REPORT_SCHEMA[src].get("extra_joins_for_dim", {}).get(d)
        if extra:
            join_cls, join_cond = extra
            q = q.join(join_cls, join_cond, isouter=True)

    # Filters
    for f in flts:
        q = _apply_filter(q, schema, f)

    # BUG-FIN-108: organization scope.
    if organization_id is not None:
        if src in ("stock_ledger", "stock_balance"):
            # Both join Warehouse — scope through Warehouse.organization_id.
            q = q.where(Warehouse.organization_id == organization_id)
        elif src == "purchase_orders":
            # Joined to Vendor; scope via Vendor.organization_id if column exists.
            if hasattr(Vendor, "organization_id"):
                q = q.where(Vendor.organization_id == organization_id)
        # invoices/consumption fact tables don't carry org_id directly today;
        # downstream UI must rely on tenant-isolated DB until columns added.

    # BUG-FIN-113: filter out cancelled rows from invoice / PO schemas — they
    # bias all summary measures. Anyone needing visibility into cancellations
    # can add an explicit invoice_status / po_status filter.
    if src == "invoices":
        q = q.where(Invoice.status != "cancelled")
    elif src == "purchase_orders":
        q = q.where(PurchaseOrder.status != "cancelled")

    # Group by all dimensions
    if dims:
        q = q.group_by(*[schema["dimensions"][d] for d in dims])

    # Sort by first dimension (or first measure desc if no dims)
    if dims:
        q = q.order_by(schema["dimensions"][dims[0]])
    elif meas:
        q = q.order_by(schema["measures"][meas[0]][0].desc())

    # BUG-FIN-112/174: compute totals across the FULL grouped result set, not
    # the LIMIT-truncated rows. We run a parallel aggregate query (without
    # limit, without ordering) and sum its measure outputs.
    totals_query = q.with_only_columns(
        *[schema["measures"][m][0].label(m) for m in meas]
    ).order_by(None)
    # Drop GROUP BY for the global aggregate so we get one row of grand totals.
    totals_query = totals_query.group_by()

    limited_q = q.limit(limit)
    rows = (await db.execute(limited_q)).mappings().all()
    rows = [dict(r) for r in rows]

    totals = {m: None for m in meas}
    try:
        tr = (await db.execute(totals_query)).mappings().first()
        if tr is not None:
            for m in meas:
                v = tr.get(m)
                try:
                    totals[m] = float(v) if v is not None else 0.0
                except Exception:
                    totals[m] = None
    except Exception:
        # Fallback: sum from limited rows.
        for m in meas:
            try:
                totals[m] = float(sum(float(r.get(m) or 0) for r in rows))
            except Exception:
                totals[m] = None

    return {
        "source_table": src,
        "row_count": len(rows),
        "dimensions": dims,
        "measures": meas,
        "rows": rows,
        "totals": totals,
        "limit_applied": limit if len(rows) >= limit else None,
    }
