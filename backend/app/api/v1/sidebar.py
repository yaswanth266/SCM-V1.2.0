"""Server-driven sidebar permissions + active-role switching.

Created 2026-04-30 as part of the SCM workflow rebuild (Task 6).
Revised 2026-05-01: returns a per-role allowed-keys whitelist instead of
re-rendering the menu tree, so the frontend keeps the existing MENU_CONFIG
visual structure (same look as scm.bhspl.in) and just hides keys the active
role can't see.
"""
from typing import List, Set
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User, UserRole, Role, RolePermission, Permission
from app.models.system import ActivityLog
from app.schemas.sidebar import SidebarResponse
from app.utils.dependencies import get_current_user
from app.utils.position_role_sync import sync_user_position_role


router = APIRouter(prefix='/me', tags=['me'])


# Every key MENU_CONFIG knows about (top-level + every `parent-child`).
# Used for super_admin's "see everything" bucket and as the source list for
# the admin bucket which excludes admin-only system pages.
_ALL_KEYS: Set[str] = {
    'dashboard', 'lms', 'launcher',
    'masters',
    'masters-items', 'masters-categories', 'masters-brands', 'masters-features',
    'masters-item-types', 'masters-item-attributes', 'masters-attribute-mapping',
    'masters-specs', 'masters-vendors', 'masters-warehouses',
    'masters-uom', 'masters-price-lists', 'masters-user-groups',
    'procurement',
    'procurement-demand-pool',
    'procurement-material-requests', 'procurement-quotations',
    'procurement-quotation-comparison',
    'procurement-purchase-orders',
    'warehouse',
    'warehouse-floor-plan',
    'logistics-gate-entry', 'warehouse-grn', 'warehouse-quality-inspection',
    'warehouse-putaway', 'warehouse-purchase-returns',
    'warehouse-material-issues', 'warehouse-material-inward',
    'warehouse-dispatch',
    'inventory',
    'inventory-stock-balance', 'inventory-stock-ledger',
    'inventory-stock-transfer', 'inventory-stock-audit',
    'inventory-replenishment',
    'indent', 'indent-indents', 'indent-acknowledgement',
    'consumption', 'consumption-entry', 'consumption-reports',
    'approvals', 'approvals-pending', 'approvals-workflow-config',
    'accounts',
    'accounts-invoices', 'accounts-payments', 'accounts-ledger',
    'accounts-credit-notes',
    'assets', 'assets-register', 'assets-movement',
    'healthcare', 'healthcare-dashboard',
    'reports',
    'reports-inventory', 'reports-procurement', 'reports-consumption',
    'reports-accounts', 'reports-system',
    'settings', 'settings-users', 'settings-roles', 'settings-system',
    'logistics', 'logistics-dashboard', 'logistics-master', 'logistics-dispatch', 'logistics-rfq', 'logistics-so', 'logistics-gate-entry',
}


# Per-role allowed keys derived from BHSPL_SCM_Workflow.pdf (Flow 1 + Flow 2).
# Each role gets its top-level entries AND the specific child pages it needs.
# A key is hidden iff it is not in this set for the active role.
_ROLE_KEYS = {
    'field_staff': {
        # Mobile-primary role. Web access kept minimal so the field user
        # can't accidentally land on master-data pages they're not meant to
        # manage — item/warehouse pickers inside indent/consumption forms
        # already give them everything they need.
        'dashboard', 'lms',
        'indent', 'indent-indents', 'indent-acknowledgement',
        'consumption', 'consumption-entry',
        'inventory', 'inventory-stock-balance', 'inventory-stock-ledger',
    },
    'field_supervisor': {
        # Supervisor's only write-action is approval. Indent + consumption
        # detail are reached THROUGH the Approvals inbox (click an item → see
        # its lines) — no separate sidebar entry, so the menu reflects what
        # they actually do.
        'dashboard', 'lms',
        'approvals', 'approvals-pending',
        'inventory', 'inventory-stock-balance', 'inventory-stock-ledger',
    },
    'warehouse_manager': {
        # Orchestrator role: approves indents at L2 (Approvals), then makes
        # the issue-vs-procure call at the Demand Pool. Demand Pool is the
        # warehouse_manager's primary worklist post-approval — granting the
        # procurement parent key + demand-pool sub-key only (other procurement
        # tabs stay gated to purchase roles).
        'dashboard', 'lms',
        'approvals', 'approvals-pending',
        'procurement', 'procurement-demand-pool',
        'warehouse', 'warehouse-floor-plan',
        'warehouse-grn',
        'warehouse-quality-inspection', 'warehouse-putaway',
        'warehouse-material-issues', 'warehouse-material-inward',
        'warehouse-dispatch',
        'inventory', 'inventory-stock-balance', 'inventory-stock-ledger',
        'inventory-stock-transfer', 'inventory-stock-audit',
        'inventory-replenishment',
        'reports', 'reports-inventory',
        'logistics', 'logistics-dashboard', 'logistics-master', 'logistics-dispatch', 'logistics-rfq', 'logistics-so', 'logistics-gate-entry',
    },
    'warehouse_operator': {
        'dashboard', 'lms',
        'warehouse', 'warehouse-purchase-returns',
        'warehouse-material-inward', 'warehouse-dispatch',
        'inventory', 'inventory-stock-balance', 'inventory-stock-ledger',
        'logistics', 'logistics-gate-entry',
    },
    'store_keeper': {
        'dashboard', 'lms',
        'warehouse', 'warehouse-grn', 'warehouse-putaway',
        'warehouse-material-issues', 'warehouse-material-inward',
        'warehouse-dispatch',
        'inventory', 'inventory-stock-balance', 'inventory-stock-ledger', 'inventory-stock-transfer',
    },
    'quality_inspector': {
        'dashboard', 'lms',
        'warehouse', 'warehouse-quality-inspection',
    },
    'purchase_officer': {
        'dashboard', 'lms',
        'procurement', 'procurement-material-requests',
        'procurement-quotations', 'procurement-quotation-comparison',
        'procurement-purchase-orders',
        'masters', 'masters-vendors',
    },
    'purchase_manager': {
        'dashboard', 'lms',
        'approvals', 'approvals-pending',
        'procurement', 'procurement-material-requests',
        'procurement-quotations', 'procurement-quotation-comparison',
        'procurement-purchase-orders',
        'reports', 'reports-procurement',
    },
    'viewer': {
        'dashboard', 'lms',
        'reports', 'reports-inventory', 'reports-procurement',
        'reports-consumption', 'reports-accounts',
    },
    'accounts_manager': {
        'dashboard', 'lms',
        'accounts', 'accounts-invoices', 'accounts-payments',
        'accounts-ledger', 'accounts-credit-notes',
        'approvals', 'approvals-pending',
        'reports', 'reports-accounts',
    },
    'accounts_officer': {
        'dashboard', 'lms',
        'accounts', 'accounts-invoices', 'accounts-payments',
        'accounts-credit-notes',
        'reports', 'reports-accounts',
    },
    'project_manager': {
        # Approves at project level. Reaches indent detail via Approvals
        # inbox; reports give project-wide visibility.
        'dashboard', 'lms',
        'approvals', 'approvals-pending',
        'inventory', 'inventory-stock-balance', 'inventory-stock-ledger',
        'reports', 'reports-inventory', 'reports-procurement',
        'reports-consumption',
    },
    'vendor_portal': {
        'dashboard', 'lms',
        'procurement', 'procurement-quotations',
        'procurement-purchase-orders',
    },
}


def _allowed_for_role(role_code: str) -> List[str]:
    if role_code == 'super_admin':
        return sorted(_ALL_KEYS)
    if role_code == 'admin':
        # Admin sees everything except: system-internals pages, and modules
        # they don't have backend permissions for (accounts.*: admin role
        # only has approve+credit_notes+chart_of_accounts perms, not view
        # invoices/payments/ledger). Don't expose tiles that 403 on click.
        admin_excluded = {
            'settings-system', 'reports-system',
            'accounts', 'accounts-invoices', 'accounts-payments',
            'accounts-ledger', 'accounts-credit-notes',
            'reports-accounts',
        }
        return sorted(_ALL_KEYS - admin_excluded)
    return sorted(_ROLE_KEYS.get(role_code, set()))


async def allowed_keys_for_role(db: AsyncSession, role: Role) -> List[str]:
    if role.code in {"super_admin", "admin"}:
        return sorted(_allowed_for_role(role.code))

    result = await db.execute(
        select(Permission.module, Permission.action)
        .join(RolePermission, RolePermission.permission_id == Permission.id)
        .where(RolePermission.role_id == role.id)
    )
    dynamic_keys = set()
    for module, action in result.all():
        key = (module or "").strip().lower()
        act = (action or "").strip().lower()
        if not key or act not in {"view", "manage"}:
            continue
        dynamic_keys.add(key)
        if "-" in key:
            dynamic_keys.add(key.split("-", 1)[0])

    keys = list(dynamic_keys) if dynamic_keys else list(_allowed_for_role(role.code))
    if role.code in {"field_staff", "field_supervisor"}:
        # Ensure field staff/supervisors can always access stock balance and stock ledger
        for k in ["inventory", "inventory-stock-balance", "inventory-stock-ledger"]:
            if k not in keys:
                keys.append(k)
    return sorted(keys)


async def _resolve_active_role(db: AsyncSession, user: User) -> Role:
    position_role = await sync_user_position_role(db, user)
    if position_role is not None:
        return position_role

    if user.active_role_id is not None:
        role = (await db.execute(
            select(Role).where(Role.id == user.active_role_id)
        )).scalar_one_or_none()
        if role is not None:
            return role
    ur = (await db.execute(
        select(UserRole).where(UserRole.user_id == user.id).limit(1)
    )).scalar_one_or_none()
    if ur is None:
        raise HTTPException(403, 'user has no roles assigned')
    return (await db.execute(select(Role).where(Role.id == ur.role_id))).scalar_one()


@router.get('/sidebar', response_model=SidebarResponse)
async def get_sidebar(
        current_user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db)) -> SidebarResponse:
    role = await _resolve_active_role(db, current_user)
    return SidebarResponse(
        active_role_id=role.id,
        active_role_code=role.code,
        allowed_keys=await allowed_keys_for_role(db, role),
    )


@router.post('/active-role/{role_id}', response_model=SidebarResponse)
async def switch_active_role(
        role_id: int,
        current_user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db)) -> SidebarResponse:
    ur = (await db.execute(
        select(UserRole).where(
            UserRole.user_id == current_user.id,
            UserRole.role_id == role_id,
        )
    )).scalar_one_or_none()
    if ur is None:
        raise HTTPException(403, 'user does not hold this role')

    role = (await db.execute(
        select(Role).where(Role.id == role_id)
    )).scalar_one_or_none()
    if role is None:
        raise HTTPException(404, 'role not found')

    current_user.active_role_id = role_id
    db.add(current_user)

    # ActivityLog (app/models/system.py): module + action are NOT NULL,
    # entity_type/entity_id describe the target. organization_id is nullable.
    db.add(ActivityLog(
        user_id=current_user.id,
        organization_id=getattr(current_user, 'organization_id', None),
        module='auth',
        action='role_switch',
        entity_type='role',
        entity_id=role_id,
        description=f'User switched active role to {role.code}',
    ))
    await db.flush()

    return SidebarResponse(
        active_role_id=role.id,
        active_role_code=role.code,
        allowed_keys=await allowed_keys_for_role(db, role),
    )
