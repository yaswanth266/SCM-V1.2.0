# SCM Read API — handoff to the SCM team

The **AIMS** (asset management) app no longer queries the SCM database directly.
Instead it reads the SCM data it needs over a small **read-only HTTP API**. This
folder **is that API, already built and working**. We need you to run it on your
infrastructure (or reimplement the same contract) and give us back a URL.

You can do this two ways — pick one:

---

## Option A — just run this service (fastest)

It's a tiny FastAPI app. It only does `SELECT` on a whitelist of tables. Point it
at the SCM database and run it.

```bash
cd scm_read_api
python -m venv .venv
.venv\Scripts\activate            # Windows   (source .venv/bin/activate on Linux/Mac)
pip install -r requirements.txt

copy .env.example .env            # then edit .env  (cp on Linux/Mac)
#   set SCM_DATABASE_URL to your SCM DB (a READ-ONLY db user is ideal)
#   optionally set SCM_API_KEY to require an api key

uvicorn app:app --host 0.0.0.0 --port 8020
```

- Health check: `GET http://<host>:8020/health` → `{"ok":true,"db":"up"}`
- Interactive docs (auto-generated): `http://<host>:8020/docs`
- Run it behind your normal reverse proxy / HTTPS, same as any internal service.

**.env**
```
SCM_DATABASE_URL=mysql+pymysql://readonly_user:password@your-db-host:3306/your_scm_db
# SCM_API_KEY=optional-shared-secret      # if set, callers must send header X-API-Key
```

> If your column or table names differ from the defaults, just edit the
> `RESOURCES` map in `app.py` (clean-name → your-table-name). Endpoints/shapes stay
> identical. You can also delete any resource from that map you don't want to expose.

---

## Option B — reimplement the contract yourself

If you'd rather build it in your own stack, implement these 3 endpoints. The shape
must match exactly (AIMS depends on it).

| Method & path | Returns |
|---|---|
| `GET /scm/v1/resources` | `{ "resources": { "<clean-name>": "<table>", ... } }` |
| `GET /scm/v1/{resource}` | `{ "items": [ {...row...}, ... ], "total": N, "page": P, "page_size": S }` |
| `GET /scm/v1/{resource}/{id}` | a single row object, or 404 |

**List query params (all optional):**
- `page` (default 1), `page_size` (default 100, max 1000)
- `id=123` or `ids=1,2,3` — fetch specific rows by primary key
- `updated_since=2026-06-01T00:00:00` — rows changed since (if the table has `updated_at`)
- **any `<column>=<value>`** — exact-match filter (validated against real columns).
  AIMS relies on these, e.g. `?item_type=asset`, `?item_id=93`, `?indent_id=55`,
  `?employee_code=HR-EMP-09440`, `?acknowledgement_id=18`.

**Examples**
```
GET /scm/v1/items?item_type=asset&page_size=500
GET /scm/v1/vendor-items?item_id=93
GET /scm/v1/indent-acknowledgement-items?acknowledgement_id=18
GET /scm/v1/items/93
```

Read-only. No write endpoints. Filters must be parameterised (no SQL injection).

---

## Resources to expose (clean-name → table)

These are exactly the tables AIMS reads. Full list is in `app.py` (`RESOURCES`):

**Master:** items, item-categories, vendors, vendor-items, uom, brands(via items),
warehouses, warehouse-bins, warehouse-racks, warehouse-lines, warehouse-locations,
offices, projects, organizations, serial-numbers, batches
**Item enrichment:** item-attributes, item-attribute-values, specs, spec-categories,
item-spec-values, features, item-features, item-packaging, packaging-level
**Procurement / intake:** indents, indent-items, indent-acknowledgements,
indent-acknowledgement-items, material-issues, material-issue-items,
goods-receipt-notes, grn-items, purchase-orders, purchase-order-items,
invoices, invoice-items
**Stock (optional):** stock-balance, stock-ledger

> Credentials/secret columns (`password_hash`, tokens, etc.) are auto-stripped from
> every response — see `SENSITIVE_COLUMNS` in `app.py`.

---

## Keeping AIMS fresh when SCM data changes (webhooks — recommended, optional)

AIMS caches some lookups for ~60s. If you want changes to reflect **instantly**,
POST to AIMS whenever a relevant row is created/updated/deleted:

```
POST  https://<aims-host>/api/v1/assets/scm-hooks/{resource}
Header:  X-SCM-Hook-Secret: <shared secret we agree on>
Body:    {"action": "update", "id": "<row id>"}      # body optional
```
- `{resource}` = the clean name (e.g. `items`, `vendors`). Use `_all` to flush everything.
- We'll give you the secret value to put in the header.
- This is optional — without it, AIMS still picks up changes within ~60 seconds.

---

## What we need back from you

1. The base URL where it's served, e.g. `https://scm.internal.company.com:8020/scm/v1`
2. The `X-API-Key` value, if you enabled one.
3. (Optional) confirmation you'll send the change webhooks above.

We plug your URL into one AIMS setting (`SCM_API_BASE_URL`) and we're done — no AIMS
code change needed.

---

## Security summary
- **Read-only** — only `SELECT`, only the whitelisted tables.
- Point a **read-only DB user** at it.
- All filters validated against real columns + fully parameterised.
- Secret columns redacted from responses.
- Optional `X-API-Key`; keep it on a trusted/internal network or behind your gateway.
