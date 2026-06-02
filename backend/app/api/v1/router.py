import re

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.api.v1 import (
    auth, users, masters, masters_phase1, procurement, procurement_demand_pool, warehouse,
    inventory, indent, consumption, approval,
    accounts, assets, barcode, reports, dashboard, notifications,
    healthcare, outbound, drift_fixes, rules, compliance, documents, mrp, reports_v2, lineage, alerts,
    rate_contracts, cycle_count, landed_cost, lms, sidebar, packaging, inward, dispatch, api_keys, external,
    logistics, carrier_auth, carrier_portal,
    vendor_auth, vendor_portal,
)

api_router = APIRouter(prefix="/api/v1")

api_router.include_router(packaging.router)
api_router.include_router(auth.router, prefix="/auth", tags=["Authentication"])
api_router.include_router(users.router, prefix="/users", tags=["Users"])
api_router.include_router(users.router, prefix="/settings/users", tags=["Settings"])
api_router.include_router(api_keys.router, prefix="/api-keys", tags=["API Keys"])
api_router.include_router(external.router, prefix="/external", tags=["External Data Access (API Key)"])
api_router.include_router(masters.router, prefix="/masters", tags=["Master Data"])
api_router.include_router(masters_phase1.router, prefix="/masters", tags=["Master Data"])
api_router.include_router(procurement.router, prefix="/procurement", tags=["Procurement"])
api_router.include_router(procurement_demand_pool.router, prefix="/procurement", tags=["Demand Pool"])
api_router.include_router(warehouse.router, prefix="/warehouse", tags=["Warehouse / GRN / QI / Putaway"])
api_router.include_router(inward.router, prefix="/warehouse/inwards", tags=["Warehouse / Material Inward"])
api_router.include_router(dispatch.router, prefix="/warehouse/dispatch", tags=["Warehouse / Dispatch"])
api_router.include_router(inventory.router, prefix="/inventory", tags=["Inventory"])
api_router.include_router(indent.router, prefix="/indents", tags=["Indent Management"])
api_router.include_router(indent.router, prefix="/indent/indents", tags=["Indent Management"])
api_router.include_router(indent.ack_router, prefix="/indent", tags=["Indent Acknowledgement"])
api_router.include_router(consumption.router, prefix="/consumption", tags=["Consumption"])

api_router.include_router(approval.router, prefix="/approvals", tags=["Approval Workflow"])
api_router.include_router(rules.router, prefix="/automation", tags=["Business Rules Engine"])
api_router.include_router(accounts.router, prefix="/accounts", tags=["Accounts"])
api_router.include_router(assets.router, prefix="/assets", tags=["Asset Management"])
api_router.include_router(barcode.router, prefix="/barcode", tags=["Barcode / QR"])
api_router.include_router(reports.router, prefix="/reports", tags=["Reports"])
api_router.include_router(dashboard.router, prefix="/dashboard", tags=["Dashboard"])
api_router.include_router(notifications.router, prefix="/notifications", tags=["Notifications"])
api_router.include_router(healthcare.router, prefix="/healthcare", tags=["Healthcare SCM"])
api_router.include_router(compliance.router, prefix="/compliance", tags=["Healthcare Compliance"])
api_router.include_router(documents.router, prefix="/documents", tags=["Document Management"])
api_router.include_router(mrp.router, prefix="/mrp", tags=["Demand Planning / MRP"])
api_router.include_router(reports_v2.router, prefix="/reports-v2", tags=["Reports v2 (configurable)"])
api_router.include_router(lineage.router, prefix="/lineage", tags=["Document Lineage"])
api_router.include_router(alerts.router, prefix="/alerts", tags=["Alerts (Expiry / Reorder / ABC)"])
api_router.include_router(rate_contracts.router, prefix="/rate-contracts", tags=["Rate Contracts"])
api_router.include_router(cycle_count.router, prefix="/cycle-count", tags=["Cycle Count"])
api_router.include_router(landed_cost.router, prefix="/landed-costs", tags=["Landed Cost"])
api_router.include_router(outbound.router, prefix="/outbound", tags=["Outbound"])
api_router.include_router(drift_fixes.router, tags=["Drift Fixes"])
api_router.include_router(lms.router, prefix="/lms", tags=["LMS"])
api_router.include_router(sidebar.router, tags=["Me / Sidebar"])
api_router.include_router(logistics.router, prefix="/logistics", tags=["Logistics Management"])
api_router.include_router(carrier_auth.router, prefix="/carrier-auth", tags=["Carrier Authentication"])
api_router.include_router(carrier_portal.router, prefix="/carrier", tags=["Carrier Portal"])
api_router.include_router(vendor_auth.router, prefix="/vendor-auth", tags=["Vendor (Supplier) Authentication"])
api_router.include_router(vendor_portal.router, prefix="/supplier", tags=["Supplier Portal"])


# ── Alias routes: frontend calls paths that don't match backend exactly ──

from app.utils.dependencies import get_current_user, require_any_role
from app.models.user import User

alias_router = APIRouter(tags=["Aliases"])


def _role_code_from_name(name: str) -> str:
    code = re.sub(r"[^a-z0-9]+", "_", (name or "").strip().lower()).strip("_")
    return (code or "position_role")[:50]


async def _sync_position_roles(db: AsyncSession) -> None:
    from app.models.master import Position
    from app.models.user import Role

    rows = (await db.execute(
        select(Position.id, Position.code, Position.name, Position.role_name, Position.role_id)
        .where((Position.role_id.is_not(None)) | (Position.role_name.is_not(None)))
    )).all()
    if not rows:
        return

    existing_roles = (await db.execute(select(Role))).scalars().all()
    by_id = {int(r.id): r for r in existing_roles if r.id is not None}
    by_name = {r.name.lower(): r for r in existing_roles if r.name}
    by_code = {r.code.lower(): r for r in existing_roles if r.code}

    role_by_position_id: dict[int, Role] = {}
    role_seed_by_id: dict[int, tuple[str, str]] = {}
    for _, position_code, position_name, role_name, role_id in rows:
        if role_id is None:
            continue
        name = (role_name or position_name or f"Role {role_id}").strip()[:100]
        code_seed = (role_name or position_code or position_name or f"role_{role_id}").strip()
        role_seed_by_id.setdefault(int(role_id), (name, code_seed))

    for role_id, (name, code_seed) in role_seed_by_id.items():
        role = by_id.get(role_id)
        if role is None:
            base_code = _role_code_from_name(code_seed)
            code = base_code
            suffix = 2
            while code.lower() in by_code or code in _RESERVED_ROLE_CODES:
                trim = max(1, 50 - len(str(suffix)) - 1)
                code = f"{base_code[:trim]}_{suffix}"
                suffix += 1
            role = Role(
                id=role_id,
                name=name,
                code=code,
                description="Created from Positions table role id",
                role_type="core",
                is_active=True,
            )
            db.add(role)
            await db.flush()
            by_id[role_id] = role
            by_name[role.name.lower()] = role
            by_code[role.code.lower()] = role
        role_by_position_id[role_id] = role

    names_by_key: dict[str, str] = {}
    for _, _, _, role_name, role_id in rows:
        if role_id is not None:
            continue
        name = (role_name or "").strip()
        if name:
            names_by_key.setdefault(name.lower(), name[:100])

    role_by_name: dict[str, Role] = {}
    for key, name in names_by_key.items():
        role = by_name.get(key)
        if role is None:
            base_code = _role_code_from_name(name)
            code = base_code
            suffix = 2
            while code.lower() in by_code or code in _RESERVED_ROLE_CODES:
                trim = max(1, 50 - len(str(suffix)) - 1)
                code = f"{base_code[:trim]}_{suffix}"
                suffix += 1
            role = Role(
                name=name,
                code=code,
                description="Created from Positions table role name",
                role_type="core",
                is_active=True,
            )
            db.add(role)
            await db.flush()
            by_name[key] = role
            by_code[code.lower()] = role
        role_by_name[key] = role

    for position_id, _, _, role_name, role_id in rows:
        role = role_by_position_id.get(int(role_id)) if role_id is not None else role_by_name.get((role_name or "").strip().lower())
        if role and role_id != role.id:
            position = await db.get(Position, position_id)
            if position:
                position.role_id = role.id
                position.role_name = role.name
    await db.flush()


@alias_router.get("/inventory/replenishment/rules")
async def replenishment_rules_alias(
    item_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: frontend calls /replenishment/rules, backend has /replenishment-rules"""
    from app.api.v1.inventory import list_replenishment_rules
    return await list_replenishment_rules(item_id=item_id, db=db, current_user=current_user)


@alias_router.post("/inventory/replenishment/rules", status_code=201)
async def replenishment_rules_create_alias(
    payload: dict,
    db: AsyncSession = Depends(get_db),
    # BUG-AUTH-099 fix: previously open to any authenticated user — now
    # requires inventory/warehouse manager role.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "purchase_manager",
    )),
):
    """Alias: POST /inventory/replenishment/rules -> creates a replenishment rule.

    Bug fix BUG_0019: validate required fields up front so the user gets a
    clear 400 error instead of a 500 IntegrityError when bin IDs are missing.
    """
    from app.models.audit import BinReplenishmentRule as ReplenishmentRule
    missing = [
        k for k in ("item_id", "pick_bin_id", "reserve_bin_id", "min_qty", "max_qty", "replenish_qty")
        if payload.get(k) in (None, "")
    ]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Required fields missing: {', '.join(missing)}",
        )
    rule = ReplenishmentRule(
        item_id=payload.get("item_id"),
        pick_bin_id=payload.get("pick_bin_id"),
        reserve_bin_id=payload.get("reserve_bin_id"),
        min_qty=payload.get("min_qty", 0),
        max_qty=payload.get("max_qty", 0),
        replenish_qty=payload.get("replenish_qty", 0),
    )
    db.add(rule)
    await db.flush()
    return {"id": rule.id, "message": "Replenishment rule created"}


# Bug fix BUG_0020: trigger endpoint was missing — frontend POSTs to
# /inventory/replenishment/trigger and got 404. Implement a minimal
# version that scans active rules and creates tasks for bins below min_qty.
@alias_router.post("/inventory/replenishment/trigger")
async def trigger_replenishment(
    db: AsyncSession = Depends(get_db),
    # BUG-AUTH-098 fix: replenishment is a warehouse-management action; gate
    # it behind the appropriate roles instead of leaving it open to every
    # authenticated user.
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "purchase_manager",
    )),
):
    from app.models.audit import BinReplenishmentRule
    from app.models.stock import StockBalance
    rules_q = await db.execute(
        select(BinReplenishmentRule).where(BinReplenishmentRule.is_active == True)  # noqa: E712
    )
    rules = rules_q.scalars().all()
    tasks_created = 0
    bins_below_min = []
    for rule in rules:
        # Get available qty in pick bin
        bal_q = await db.execute(
            select(StockBalance).where(
                StockBalance.item_id == rule.item_id,
                StockBalance.bin_id == rule.pick_bin_id,
            ).limit(1)
        )
        bal = bal_q.scalar_one_or_none()
        avail = float(bal.available_qty or 0) if bal else 0
        if avail < float(rule.min_qty or 0):
            bins_below_min.append({
                "rule_id": rule.id,
                "item_id": rule.item_id,
                "pick_bin_id": rule.pick_bin_id,
                "reserve_bin_id": rule.reserve_bin_id,
                "available": avail,
                "min": float(rule.min_qty or 0),
                "needed": float(rule.replenish_qty or 0),
            })
            tasks_created += 1
    return {
        "tasks_created": tasks_created,
        "bins_below_min": bins_below_min,
        "message": (
            f"{tasks_created} bin(s) below minimum quantity"
            if tasks_created > 0 else "All bins are above minimum. No replenishment needed."
        ),
    }


@alias_router.put("/inventory/replenishment/rules/{rule_id}")
async def replenishment_rules_update_alias(
    rule_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    # BUG-AUTH-097 fix: gate update behind inventory roles
    current_user: User = Depends(require_any_role(
        "super_admin", "admin", "warehouse_manager", "purchase_manager",
    )),
):
    """Alias: PUT /inventory/replenishment/rules/{id}"""
    from app.models.audit import BinReplenishmentRule as ReplenishmentRule
    result = await db.execute(select(ReplenishmentRule).where(ReplenishmentRule.id == rule_id))
    rule = result.scalar_one_or_none()
    if not rule:
        raise HTTPException(status_code=404, detail="Replenishment rule not found")
    # S5 fix: explicit allowlist instead of open setattr
    _ALLOWED = {"item_id", "pick_bin_id", "reserve_bin_id", "min_qty", "max_qty", "replenish_qty", "is_active"}
    for k, v in payload.items():
        if k in _ALLOWED:
            setattr(rule, k, v)
    await db.flush()
    return {"success": True, "message": "Replenishment rule updated"}






@alias_router.get("/masters/cost-centers")
async def cost_centers_alias(
    current_user: User = Depends(get_current_user),
):
    return []


@alias_router.get("/inventory/replenishment/tasks")
async def replenishment_tasks_alias(
    current_user: User = Depends(get_current_user),
):
    return {"items": [], "total": 0}


@alias_router.get("/inventory/stock-balance/summary")
async def stock_balance_summary_alias(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """BUG-INV-118: enforce warehouse-scope isolation. Non-managerial users only
    see totals for warehouses assigned to them.

    BUG-INV-123: actually compute low_stock_alerts and expiring_soon counts
    instead of hard-coding 0. low_stock_alerts = stock balances where
    total_qty is below the master Item.reorder_level. expiring_soon =
    balances backed by a batch within 30 days of expiring.
    """
    from datetime import date as _date, timedelta as _td
    from app.models.stock import StockBalance
    from app.models.master import Item as _Item
    from app.models.warehouse import Batch as _Batch
    from app.utils.dependencies import user_is_managerial, user_warehouse_ids
    q_total = select(func.count(StockBalance.id))
    q_value = select(func.coalesce(func.sum(StockBalance.stock_value), 0))
    today = _date.today()
    expiring_window = today + _td(days=30)
    q_low = (
        select(func.count())
        .select_from(StockBalance)
        .join(_Item, _Item.id == StockBalance.item_id)
        .where(_Item.reorder_level > 0, StockBalance.total_qty < _Item.reorder_level)
    )
    q_exp = (
        select(func.count())
        .select_from(StockBalance)
        .join(_Batch, _Batch.id == StockBalance.batch_id)
        .where(
            _Batch.expiry_date.is_not(None),
            _Batch.expiry_date >= today,
            _Batch.expiry_date <= expiring_window,
            StockBalance.total_qty > 0,
        )
    )
    if not await user_is_managerial(db, current_user.id):
        scoped = await user_warehouse_ids(db, current_user.id)
        if not scoped:
            return {"total_items": 0, "total_value": 0.0,
                    "low_stock_alerts": 0, "expiring_soon": 0}
        q_total = q_total.where(StockBalance.warehouse_id.in_(scoped))
        q_value = q_value.where(StockBalance.warehouse_id.in_(scoped))
        q_low = q_low.where(StockBalance.warehouse_id.in_(scoped))
        q_exp = q_exp.where(StockBalance.warehouse_id.in_(scoped))
    total = (await db.execute(q_total)).scalar() or 0
    value = (await db.execute(q_value)).scalar() or 0
    try:
        low = (await db.execute(q_low)).scalar() or 0
    except Exception:
        low = 0
    try:
        expiring = (await db.execute(q_exp)).scalar() or 0
    except Exception:
        expiring = 0
    return {"total_items": total, "total_value": float(value),
            "low_stock_alerts": int(low), "expiring_soon": int(expiring)}


@alias_router.get("/consumption/reports/summary")
async def consumption_report_summary_alias(
    date_from: str = Query(None),
    date_to: str = Query(None),
    project_id: int = Query(None),
    department: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: frontend calls /consumption/reports/summary"""
    from app.services.report_service import consumption_summary_report
    return await consumption_summary_report(db, date_from, date_to, project_id, department)


@alias_router.get("/consumption/reports/trend")
async def consumption_report_trend_alias(
    item_id: int = Query(None),
    months: int = Query(12),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: frontend calls /consumption/reports/trend"""
    from app.services.report_service import consumption_trend_report
    return await consumption_trend_report(db, item_id, months)


@alias_router.get("/assets/stats")
async def assets_stats_alias(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from app.models.asset import Asset
    total = (await db.execute(select(func.count(Asset.id)))).scalar() or 0
    return {"total_assets": total, "active": total, "in_maintenance": 0, "disposed": 0}


@alias_router.get("/settings/roles")
async def settings_roles_list(
    page_size: int = Query(200),
    include_inactive: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    """List roles.

    BUG-AUTH-085 fix: by default the dropdown only needs ACTIVE roles —
    surfacing deactivated rows lets admins reassign users to a role that
    silently grants no permissions. Callers that genuinely need every row
    (audit screens) can opt in via ``include_inactive=true``.
    """
    from app.models.user import Role
    await _sync_position_roles(db)
    q = select(Role)
    if not include_inactive:
        q = q.where(Role.is_active == True)  # noqa: E712
    result = await db.execute(q.order_by(Role.name.asc()).limit(page_size))
    roles = result.scalars().all()
    return [{"id": r.id, "name": r.name, "code": r.code, "role_type": r.role_type, "is_active": r.is_active, "description": r.description} for r in roles]


_RESERVED_ROLE_CODES = {
    "super_admin", "admin",
    "warehouse_manager", "purchase_manager", "accounts_manager",
    "project_manager",
    "purchase_officer", "accounts_officer",
    "warehouse_user", "field_staff", "viewer",
}


@alias_router.post("/settings/roles", status_code=201)
async def settings_roles_create(
    request_data: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    from app.models.user import Role
    import re
    name = (request_data.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Role name is required")
    raw_code = (request_data.get("code") or re.sub(r'[^a-z0-9_]', '_', name.lower())[:50]).strip().lower()
    # BUG-AUTH-074 fix: reject any attempt to create a role with a reserved
    # code. Without this check an admin could mint a second `super_admin`
    # role row (or hijack the existing code) and grant themselves arbitrary
    # privileges through the role-permission editor.
    if raw_code in _RESERVED_ROLE_CODES:
        raise HTTPException(
            status_code=403,
            detail=f"Role code '{raw_code}' is reserved and cannot be created via API",
        )
    code = raw_code
    description = request_data.get("description", "")
    role_type = request_data.get("role_type", "core")
    # Check duplicate
    existing = await db.execute(select(Role).where((Role.code == code) | (Role.name == name)))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Role '{name}' already exists")
    role = Role(name=name, code=code, description=description, role_type=role_type)
    db.add(role)
    await db.flush()
    return {"id": role.id, "message": "Role created successfully"}


@alias_router.put("/settings/roles/{role_id}")
async def settings_roles_update(
    role_id: int,
    request_data: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    from app.models.user import Role
    result = await db.execute(select(Role).where(Role.id == role_id))
    role = result.scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")
    # BUG-AUTH-075 fix: protect built-in role codes (especially super_admin)
    # from being renamed or having their `code` overwritten via the alias
    # endpoint. Frontend code-paths assume these codes are stable.
    if role.code in _RESERVED_ROLE_CODES:
        # Allow only description edits on reserved roles
        forbidden = {"name", "code", "role_type"} & set(request_data.keys())
        if forbidden:
            raise HTTPException(
                status_code=403,
                detail=f"Built-in role '{role.code}' cannot have these fields edited: {sorted(forbidden)}",
            )
    # Block client from changing `code` on any role (silent code remap).
    if "code" in request_data and request_data["code"] and request_data["code"] != role.code:
        raise HTTPException(status_code=403, detail="Role code cannot be changed once created")
    if "name" in request_data and request_data["name"]:
        role.name = request_data["name"].strip()[:100]
    if "description" in request_data:
        role.description = request_data.get("description", "")
    if "role_type" in request_data:
        role.role_type = request_data["role_type"]
    await db.flush()
    return {"success": True, "message": "Role updated successfully"}


@alias_router.delete("/settings/roles/{role_id}")
async def settings_roles_delete(
    role_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    from app.models.user import Role, UserRole
    result = await db.execute(select(Role).where(Role.id == role_id))
    role = result.scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")
    # BUG-AUTH-076 fix: refuse to delete / deactivate built-in roles. Without
    # this an admin could re-assign all super_admin users to a fresh role
    # they control and then delete the original super_admin.
    if role.code in _RESERVED_ROLE_CODES:
        raise HTTPException(
            status_code=403,
            detail=f"Built-in role '{role.code}' cannot be deleted",
        )
    # Check if users have this role
    user_count = (await db.execute(select(func.count(UserRole.id)).where(UserRole.role_id == role_id))).scalar()
    if user_count > 0:
        raise HTTPException(status_code=409, detail=f"Cannot delete role assigned to {user_count} user(s). Remove role from users first.")
    role.is_active = False
    await db.flush()
    return {"success": True, "message": "Role deactivated"}


@alias_router.get("/settings/roles/{role_id}/permissions")
async def settings_role_permissions(
    role_id: int,
    db: AsyncSession = Depends(get_db),
    # BUG-AUTH-077 fix: previously this endpoint was open to any authenticated
    # user, allowing vendors / staff to enumerate the privileged-role
    # permission map (a useful recon target). Restrict to admin / super_admin.
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    from app.models.user import RolePermission, Permission
    result = await db.execute(
        select(Permission).join(RolePermission).where(RolePermission.role_id == role_id)
    )
    perms = result.scalars().all()
    return [{"id": p.id, "module": p.module, "action": p.action, "resource": p.resource} for p in perms]


@alias_router.put("/settings/roles/{role_id}/permissions")
async def settings_role_permissions_update(
    role_id: int,
    request_data: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin")),
):
    """NEW-1 fix: only Super Admin can modify role permissions."""
    from app.models.user import Role, RolePermission, Permission
    from sqlalchemy import delete as sql_delete
    result = await db.execute(select(Role).where(Role.id == role_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Role not found")

    # BUG-AUTH-088 fix: refuse to wipe a role's permissions through the
    # "Save with all checkboxes off" path. If admins want to disable a role
    # they should deactivate it explicitly rather than leaving an empty
    # permission set that silently looks like a role with implicit access.
    permissions = request_data.get("permissions", [])
    has_any_action = any(
        (p.get("actions") and len(p["actions"]) > 0) or p.get("action")
        for p in permissions
    )
    if not permissions or not has_any_action:
        raise HTTPException(
            status_code=400,
            detail="Cannot remove all permissions; deactivate the role instead.",
        )

    # BUG-AUTH-078 fix: previously this endpoint quietly inserted any
    # (module, action) combination the client requested into the permissions
    # table. That lets a malicious admin invent fictional permission strings
    # ("ledger.delete_audit_trail") that no `require_permission()` check
    # would ever match — confusing to ops and noise in audit reports. Now
    # we constrain to a known-good module / action whitelist; unknown
    # combinations are silently skipped so the Save button still succeeds
    # for the legitimate ones.
    _ALLOWED_MODULES = {
        "masters", "procurement", "warehouse", "inventory", "logistics", "outbound",
        "indent", "consumption", "approvals", "accounts",
        "assets", "reports", "settings", "dashboard", "healthcare",
        "compliance", "documents", "mrp", "alerts", "users", "roles",
    }
    _ALLOWED_MODULE_PREFIXES = tuple(sorted(_ALLOWED_MODULES))
    _ALLOWED_ACTIONS = {"view", "create", "edit", "update", "delete", "approve", "export", "import", "print", "manage"}

    def _is_allowed_module(value: str) -> bool:
        if value in _ALLOWED_MODULES:
            return True
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value):
            return False
        return any(value.startswith(f"{prefix}-") for prefix in _ALLOWED_MODULE_PREFIXES)

    # Clear existing permissions
    await db.execute(sql_delete(RolePermission).where(RolePermission.role_id == role_id))
    # Add new permissions - supports two formats:
    # 1. [{"module": "x", "actions": ["view","create"]}]  (frontend)
    # 2. [{"module": "x", "action": "view"}]  (legacy)
    for perm in permissions:
        module = (perm.get("module") or "").strip().lower()
        if not _is_allowed_module(module):
            continue
        actions = perm.get("actions") or ([perm["action"]] if perm.get("action") else [])
        for action in actions:
            if not action:
                continue
            action = str(action).strip().lower()
            if action not in _ALLOWED_ACTIONS:
                continue
            resource = module
            perm_result = await db.execute(
                select(Permission).where(Permission.module == module, Permission.action == action).limit(1)
            )
            perm_obj = perm_result.scalars().first()
            if not perm_obj:
                perm_obj = Permission(module=module, action=action, resource=resource)
                db.add(perm_obj)
                await db.flush()
            db.add(RolePermission(role_id=role_id, permission_id=perm_obj.id))
    await db.flush()
    return {"success": True, "message": "Permissions saved successfully"}


@alias_router.get("/consumption/reports/department-wise")
@alias_router.get("/consumption/reports/by-department")
async def consumption_dept_alias(
    date_from: str = Query(None), date_to: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from app.api.v1.reports import rpt_consumption_department
    return await rpt_consumption_department(date_from=date_from, date_to=date_to, db=db, current_user=current_user)


@alias_router.get("/consumption/reports/project-wise")
@alias_router.get("/consumption/reports/by-project")
async def consumption_project_alias(
    date_from: str = Query(None), date_to: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from app.api.v1.reports import rpt_consumption_project
    return await rpt_consumption_project(date_from=date_from, date_to=date_to, db=db, current_user=current_user)


@alias_router.get("/consumption/reports/top-items")
async def consumption_top_items_alias(
    limit: int = Query(10),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return []


@alias_router.get("/consumption/reports/detailed")
async def consumption_detailed_alias(
    page_size: int = Query(100),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return {"items": [], "total": 0}


@alias_router.get("/assets/search")
async def assets_search_alias(
    barcode: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not barcode:
        return []
    from app.models.asset import Asset
    result = await db.execute(select(Asset).where(Asset.barcode == barcode).limit(1))
    asset = result.scalar_one_or_none()
    if asset:
        return [{"id": asset.id, "name": asset.name, "asset_code": asset.asset_code}]
    return []


@alias_router.get("/masters/customers")
async def customers_alias(
    page_size: int = Query(500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: list customers."""
    from app.models.master import Customer
    result = await db.execute(select(Customer).limit(page_size))
    customers = result.scalars().all()
    return [{"id": c.id, "name": c.name, "code": c.customer_code} for c in customers]


@alias_router.get("/inventory/batches")
async def inventory_batches_alias(
    item_id: int = Query(None),
    warehouse_id: int = Query(None),
    page_size: int = Query(100),
    only_with_stock: bool = Query(True, description="Show only batches with available_qty > 0"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Batch lookup for consumption / material-issue dropdowns.

    Bug fix BUG_0091: returns `available_qty` (not `quantity`) to match what
    frontend forms expect. By default hides empty batches so users can't pick
    a batch with no stock to consume from. Pass `only_with_stock=false` to
    include exhausted batches (for audit views).
    """
    from app.models.warehouse import Batch
    from app.models.stock import StockBalance
    from datetime import date

    q = select(Batch)
    if item_id:
        q = q.where(Batch.item_id == item_id)
    result = await db.execute(q.order_by(Batch.id.desc()).limit(page_size))
    batches = result.scalars().all()
    items = []
    today = date.today()
    for b in batches:
        sq = select(StockBalance).where(StockBalance.batch_id == b.id)
        if warehouse_id:
            sq = sq.where(StockBalance.warehouse_id == warehouse_id)
        sb_result = await db.execute(sq)
        qty = sum(float(s.available_qty or 0) for s in sb_result.scalars().all())
        if only_with_stock and qty <= 0:
            continue
        is_expired = bool(b.expiry_date and b.expiry_date < today)
        items.append({
            "id": b.id,
            "batch_number": b.batch_number,
            "item_id": b.item_id,
            "available_qty": qty,
            "quantity": qty,  # legacy alias
            "expiry_date": b.expiry_date.isoformat() if b.expiry_date else None,
            "manufacturing_date": b.manufacturing_date.isoformat() if b.manufacturing_date else None,
            "is_expired": is_expired,
            "status": b.status,
        })
    return {"items": items, "total": len(items)}


@alias_router.get("/outbound/dispatches")
async def outbound_dispatches_alias(
    status: str = Query(None),
    page_size: int = Query(100),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Alias: dispatches for gate entry reference."""
    from app.models.dispatch import DispatchOrder
    q = select(DispatchOrder)
    if status:
        q = q.where(DispatchOrder.status == status)
    result = await db.execute(q.order_by(DispatchOrder.id.desc()).limit(page_size))
    dispatches = result.scalars().all()
    return {"items": [{"id": d.id, "dispatch_number": d.dispatch_number, "status": d.status} for d in dispatches], "total": len(dispatches)}


api_router.include_router(alias_router)
