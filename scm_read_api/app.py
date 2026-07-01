"""
SCM Read API — for AIMS
=======================
A small, read-only REST service that exposes the SCM tables the AIMS asset
module needs. AIMS points at this instead of querying the SCM database directly,
so AIMS can run on its own database.

How it's meant to be used:
  1. AIMS team runs this against the current SCM DB and integrates against it.
  2. Hand this folder to the SCM team. They point SCM_DATABASE_URL at their DB
     and run it on their infra (or reimplement the same endpoints).
  3. AIMS updates its SCM_API_BASE_URL to the URL they give back. Done.

Contract (every resource the same shape):
  GET  /scm/v1/resources                       -> list of available resources
  GET  /scm/v1/{resource}?page=&page_size=...   -> {items, total, page, page_size}
       optional filters: id=, ids=1,2,3, updated_since=ISO8601, <column>=<value>
  GET  /scm/v1/{resource}/{id}                  -> single row

Read-only. Only the whitelisted tables below are exposed. Filters are validated
against real columns and fully parameterised (no SQL injection).
Auth: optional — set SCM_API_KEY and callers send `X-API-Key`.

Run:  uvicorn app:app --host 0.0.0.0 --port 8020
Docs: http://localhost:8020/docs   (auto Swagger — great for the SCM team)
"""
import os
from typing import Optional

try:  # load .env if python-dotenv is installed (SCM team just edits .env)
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

from fastapi import FastAPI, HTTPException, Query, Request, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine, text, MetaData, Table

# --- config (env) ----------------------------------------------------------
DB_URL = os.getenv("SCM_DATABASE_URL", "mysql+pymysql://root:@localhost:3306/scm_v1")
API_KEY = os.getenv("SCM_API_KEY")  # optional; if set, callers must send X-API-Key

# Clean resource name -> real table name. ONLY these are exposed (read-only).
# This is exactly the set AIMS reads from SCM.
RESOURCES = {
    # core lookups
    "items": "items",
    "item-categories": "item_categories",
    "users": "users",
    "roles": "roles",
    "user-roles": "user_roles",
    "user-warehouses": "user_warehouses",
    "vendors": "vendors",
    "warehouses": "warehouses",
    "warehouse-bins": "warehouse_bins",
    "warehouse-racks": "warehouse_racks",
    "warehouse-lines": "warehouse_lines",
    "warehouse-locations": "warehouse_locations",
    "positions": "positions",
    "employees": "employees",
    "offices": "offices",
    "serial-numbers": "serial_numbers",
    "batches": "batches",
    # item enrichment (specs / attributes / features / vendor offers) — master-trace + catalogue
    "vendor-items": "vendor_items",
    "item-attributes": "item_attributes",
    "item-attribute-values": "item_attribute_values",
    "spec-categories": "spec_categories",
    "specs": "specs",
    "item-spec-values": "item_spec_values",
    "item-features": "item_features",
    "features": "features",
    "uom": "uom",
    "item-packaging": "item_packaging",
    "packaging-level": "packaging_level",
    # asset intake flow (indent -> issue -> acknowledge -> asset)
    "indents": "indents",
    "indent-items": "indent_items",
    "indent-acknowledgements": "indent_acknowledgements",
    "indent-acknowledgement-items": "indent_acknowledgement_items",
    "material-issues": "material_issues",
    "material-issue-items": "material_issue_items",
    "goods-receipt-notes": "goods_receipt_notes",
    "grn-items": "grn_items",
    "purchase-orders": "purchase_orders",
    "purchase-order-items": "purchase_order_items",
    # stock & finance (read-only references)
    "stock-balance": "stock_balance",
    "stock-ledger": "stock_ledger",
    "invoices": "invoices",
    "invoice-items": "invoice_items",
    # asset master FK references
    "projects": "projects",
    "organizations": "organizations",
    "consignment_packages": "consignment_packages",
    "consignment_package_items": "consignment_package_items"
    
}

# Columns never returned, regardless of table (credentials / secrets). AIMS
# has its own auth and never needs these.
SENSITIVE_COLUMNS = {
    "password_hash", "password", "reset_token", "refresh_token", "api_key",
    "secret", "otp", "mfa_secret", "tokens_revoked_after",
}

engine = create_engine(DB_URL, pool_pre_ping=True, pool_recycle=1800)
_cols_cache: dict = {}


def _clean(row: dict) -> dict:
    return {k: v for k, v in row.items() if k.lower() not in SENSITIVE_COLUMNS}


def table_columns(table: str) -> set:
    """Reflected column names for a table (cached) — used to validate filters."""
    if table not in _cols_cache:
        md = MetaData()
        t = Table(table, md, autoload_with=engine)
        _cols_cache[table] = {c.name for c in t.columns}
    return _cols_cache[table]


def require_key(x_api_key: Optional[str] = Header(None)):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key")


app = FastAPI(
    title="SCM Read API (for AIMS)",
    version="1.0.0",
    description="Read-only access to the SCM tables AIMS depends on. See /docs.",
)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"],
)


@app.get("/health", tags=["meta"])
def health():
    """Liveness + which database/host this API is actually connected to, so the
    AIMS team can verify the source. No credentials are exposed."""
    try:
        with engine.connect() as conn:
            dbname = conn.execute(text("SELECT DATABASE()")).scalar()
            ver = conn.execute(text("SELECT VERSION()")).scalar()
        url = engine.url  # SQLAlchemy strips the password in str(url)
        return {
            "ok": True, "db": "up",
            "database": dbname,
            "host": url.host,
            "port": url.port,
            "db_user": url.username,
            "server_version": ver,
        }
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"DB error: {e}")


@app.get("/scm/v1/resources", tags=["meta"])
def resources(_: None = Depends(require_key)):
    """Every resource this API exposes (clean name -> backing table)."""
    return {"resources": RESOURCES}


@app.get("/scm/v1/{resource}", tags=["data"])
def list_resource(
    resource: str,
    request: Request,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=1000),
    updated_since: Optional[str] = Query(None, description="ISO datetime — rows changed on/after this (if table has updated_at)"),
    _: None = Depends(require_key),
):
    """List rows. Add any `column=value` query param to filter (exact match),
    `ids=1,2,3` for a set of ids, or `updated_since=` for incremental sync."""
    table = RESOURCES.get(resource)
    if not table:
        raise HTTPException(status_code=404, detail=f"Unknown resource '{resource}' — see GET /scm/v1/resources")
    cols = table_columns(table)
    where, params = [], {}
    for k, v in request.query_params.items():
        if k in ("page", "page_size", "updated_since"):
            continue
        if k == "ids":
            id_list = [x for x in v.split(",") if x.strip()]
            if id_list and "id" in cols:
                ph = ",".join(f":id{i}" for i in range(len(id_list)))
                where.append(f"id IN ({ph})")
                for i, val in enumerate(id_list):
                    params[f"id{i}"] = val
            continue
        if k in cols:  # validated against real columns — safe
            where.append(f"`{k}` = :f_{k}")
            params[f"f_{k}"] = v
    if updated_since and "updated_at" in cols:
        where.append("updated_at >= :usince")
        params["usince"] = updated_since
    wsql = (" WHERE " + " AND ".join(where)) if where else ""
    offset = (page - 1) * page_size
    with engine.connect() as conn:
        total = conn.execute(text(f"SELECT COUNT(*) FROM `{table}`{wsql}"), params).scalar()
        rows = conn.execute(
            text(f"SELECT * FROM `{table}`{wsql} LIMIT :lim OFFSET :off"),
            {**params, "lim": page_size, "off": offset},
        ).mappings().all()
    return {"items": [_clean(dict(r)) for r in rows], "total": int(total or 0),
            "page": page, "page_size": page_size}


@app.get("/scm/v1/{resource}/{row_id}", tags=["data"])
def get_one(resource: str, row_id: str, _: None = Depends(require_key)):
    """A single row by primary id."""
    table = RESOURCES.get(resource)
    if not table:
        raise HTTPException(status_code=404, detail=f"Unknown resource '{resource}'")
    with engine.connect() as conn:
        r = conn.execute(text(f"SELECT * FROM `{table}` WHERE id = :id LIMIT 1"),
                         {"id": row_id}).mappings().first()
    if not r:
        raise HTTPException(status_code=404, detail="Not found")
    return _clean(dict(r))
