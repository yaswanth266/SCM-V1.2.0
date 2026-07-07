# SCM Read API (for AIMS)

A tiny **read-only** REST service that exposes the SCM tables the AIMS asset
module needs. AIMS calls this instead of querying the SCM database directly — so
AIMS can run on its own database.

## Why this exists
AIMS currently reads ~30 SCM tables directly (items, users, indents, GRNs…). To
decouple the databases, SCM needs to serve those reads over HTTP. This service
**is that API** — already implemented. You can:

1. Run it as-is (it reads the SCM DB) and let AIMS integrate against it now.
2. Hand this folder to the **SCM team**: they point `SCM_DATABASE_URL` at their
   DB and run it on their infra (or reimplement the same contract). They give
   back a base URL; AIMS sets `SCM_API_BASE_URL` to it. Done — no code change.

> Read-only by design. Only the whitelisted tables in `app.py` (`RESOURCES`) are
> exposed. All filters are validated against real columns and parameterised.

## Run it
```bash
cd scm_read_api
python -m venv .venv && .venv/Scripts/activate   # (Windows)  or  source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env        # then edit .env  (cp on mac/linux)
uvicorn app:app --host 0.0.0.0 --port 8020
```
- Interactive docs (Swagger): **http://localhost:8020/docs**
- Health: **http://localhost:8020/health**

## The contract (every resource, same shape)
| Method & path | Returns |
|---|---|
| `GET /scm/v1/resources` | the list of available resources → table names |
| `GET /scm/v1/{resource}` | `{ items: [...], total, page, page_size }` |
| `GET /scm/v1/{resource}/{id}` | a single row |

**List query params (all optional):**
- `page` (default 1), `page_size` (default 100, max 1000)
- `id=123` or `ids=1,2,3` — fetch specific rows
- `updated_since=2026-06-01T00:00:00` — only rows changed since (if the table has `updated_at`) — for incremental sync
- any `column=value` — exact-match filter (e.g. `?item_type=asset`, `?position_id=446`)

**Examples**
```
GET /scm/v1/items?item_type=asset&page=1&page_size=200
GET /scm/v1/users?employee_code=HR-EMP-09440
GET /scm/v1/indent-acknowledgements?indent_id=55
GET /scm/v1/items/93
```

## Resources exposed (clean name → table)
**Lookups:** items, item-categories, users, roles, user-roles, user-warehouses,
vendors, warehouses, warehouse-bins, positions, employees, offices,
serial-numbers, batches, asset-categories
**Intake flow:** indents, indent-items, indent-acknowledgements,
indent-acknowledgement-items, material-issues, material-issue-items,
goods-receipt-notes, grn-items, purchase-orders, purchase-order-items
**Stock & finance:** stock-balance, stock-ledger, invoices, invoice-items
**Master FKs:** projects, organizations

## Auth (optional)
Set `SCM_API_KEY` in `.env`. Then every request must send header `X-API-Key: <that value>`.
Leave blank on a trusted internal network.

## Notes for the SCM team
- This only does `SELECT`. Safe to point a read-only DB user at it.
- If your column or table names differ, edit the `RESOURCES` map in `app.py`
  (clean-name → your-table-name). The endpoints and shapes stay identical.
- Pagination is offset-based; add `updated_since` support is already wired for
  any table that has an `updated_at` column.
