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
    'lms', 'launcher',
    # 1. Warehouse
    'warehouse', 'warehouse-dashboard', 'warehouse-reports', 'warehouse-notifications',
    'warehouse-masters', 'warehouse-masters-warehouses', 'warehouse-masters-floor-plan', 'warehouse-masters-floor-plan-3d',
    'warehouse-floor-plan',
    'warehouse-gate-entry', 'logistics-gate-entry', 'warehouse-grn', 'warehouse-quality-inspection',
    'warehouse-putaway', 'warehouse-purchase-returns',
    'warehouse-material-issues', 'warehouse-vehicle-material-issues', 'warehouse-material-inward',
    'warehouse-material-issues-template',
    'warehouse-dispatch',
    # 2. Inventory
    'inventory', 'inventory-dashboard', 'inventory-reports', 'inventory-notifications',
    'inventory-masters', 'inventory-masters-items', 'inventory-masters-packaging', 'inventory-masters-categories',
    'inventory-masters-features',
    'inventory-masters-user-material-mapping', 'inventory-masters-uom', 'inventory-masters-brands', 'inventory-masters-item-types',
    'inventory-masters-item-attributes', 'inventory-masters-category-attribute-mapping', 'inventory-masters-specs',
    'inventory-masters-boms', 'inventory-masters-price-lists', 'inventory-masters-project-templates',
    'inventory-stock-balance', 'inventory-vehicle-stock-balance', 'inventory-stock-ledger', 'inventory-vehicle-stock-ledger',
    'inventory-stock-transfer', 'inventory-stock-audit',
    'inventory-replenishment',
    # 3. Procurement
    'procurement', 'procurement-dashboard', 'procurement-reports', 'procurement-notifications',
    'procurement-masters', 'procurement-masters-vendors', 'procurement-masters-vendor-material-mapping',
    'procurement-demand-pool',
    'procurement-material-requests', 'procurement-quotations',
    'procurement-quotation-comparison',
    'procurement-purchase-orders',
    # 4. Indent
    'indent', 'indent-dashboard', 'indent-reports', 'indent-notifications',
    'indent-indents', 'indent-template-indents', 'indent-acknowledgement', 'indent-material-acknowledgement',
    # Consumption
    'consumption', 'consumption-entry', 'consumption-reports',
    # Approvals
    'approvals', 'approvals-pending', 'approvals-workflow-config',
    # Accounts
    'accounts',
    'accounts-invoices', 'accounts-payments', 'accounts-ledger',
    'accounts-credit-notes',
    # Assets
    'assets', 'assets-register', 'assets-movement', 'assets-spare-mapping',
    # Healthcare
    'healthcare', 'healthcare-dashboard',
    # Settings & Admin
    'settings', 'settings-users', 'settings-roles', 'settings-system',
    'settings-masters-users', 'settings-masters-user-groups', 'settings-masters-organization-structure',
    'settings-reports-v2', 'settings-reports-system',
    # Logistics
    'logistics', 'logistics-dashboard', 'logistics-master', 'logistics-dispatch', 'logistics-rfq', 'logistics-so', 'logistics-gate-entry', 'logistics-consignments',
    'inventory-masters-ap104-consumables', 'inventory-masters-ap104-install',
    'indent-ap104-consumables', 'indent-ap104-install',
}


# Per-role allowed keys derived from BHSPL_SCM_Workflow.pdf (Flow 1 + Flow 2).
# Each role gets its top-level entries AND the specific child pages it needs.
# A key is hidden iff it is not in this set for the active role.
_ROLE_KEYS = {
    'field_staff': {
        'lms',
        'indent', 'indent-dashboard', 'indent-indents', 'indent-template-indents', 'indent-acknowledgement', 'indent-notifications',
        'consumption', 'consumption-entry',
        'inventory', 'inventory-dashboard', 'inventory-stock-balance', 'inventory-stock-ledger', 'inventory-notifications',
    },
    'lab_technician': {
        'lms',
        'indent', 'indent-dashboard', 'indent-indents', 'indent-template-indents', 'indent-acknowledgement', 'indent-notifications',
        'consumption', 'consumption-entry',
        'inventory', 'inventory-dashboard', 'inventory-stock-balance', 'inventory-stock-ledger', 'inventory-notifications',
    },
    'field_supervisor': {
        'lms',
        'approvals', 'approvals-pending',
        'inventory', 'inventory-dashboard', 'inventory-stock-balance', 'inventory-stock-ledger', 'inventory-notifications',
    },
    'warehouse_manager': {
        'lms',
        'approvals', 'approvals-pending',
        'procurement', 'procurement-demand-pool',
        'warehouse', 'warehouse-dashboard', 'warehouse-reports', 'warehouse-notifications',
        'warehouse-masters', 'warehouse-masters-warehouses', 'warehouse-masters-floor-plan', 'warehouse-masters-floor-plan-3d',
        'warehouse-floor-plan',
        'warehouse-gate-entry', 'warehouse-grn',
        'warehouse-quality-inspection', 'warehouse-putaway',
        'warehouse-material-issues', 'warehouse-material-issues-template', 'warehouse-material-inward',
        'warehouse-dispatch',
        'inventory', 'inventory-dashboard', 'inventory-reports', 'inventory-notifications',
        'inventory-masters', 'inventory-masters-items', 'inventory-masters-packaging', 'inventory-masters-categories',
        'inventory-masters-features',
        'inventory-masters-user-material-mapping', 'inventory-masters-uom', 'inventory-masters-brands', 'inventory-masters-item-types',
        'inventory-masters-item-attributes', 'inventory-masters-category-attribute-mapping', 'inventory-masters-specs',
        'inventory-masters-boms', 'inventory-masters-price-lists', 'inventory-masters-project-templates',
        'inventory-stock-balance', 'inventory-stock-ledger',
        'inventory-stock-transfer', 'inventory-stock-audit',
        'inventory-replenishment',
        'indent-template-indents',
        'logistics', 'logistics-dashboard', 'logistics-master', 'logistics-dispatch', 'logistics-rfq', 'logistics-so', 'logistics-gate-entry', 'logistics-consignments',
    },
    'warehouse_operator': {
        'lms',
        'warehouse', 'warehouse-dashboard', 'warehouse-gate-entry', 'warehouse-purchase-returns',
        'warehouse-material-inward', 'warehouse-dispatch', 'warehouse-notifications',
        'warehouse-material-issues', 'warehouse-material-issues-template',
        'inventory', 'inventory-dashboard', 'inventory-stock-balance', 'inventory-stock-ledger', 'inventory-notifications',
        'procurement-material-requests',
        'logistics', 'logistics-gate-entry', 'logistics-dashboard', 'logistics-master',
        'logistics-dispatch', 'logistics-consignments', 'logistics-rfq', 'logistics-so',
    },
    'store_keeper': {
        'lms',
        'indent', 'indent-dashboard', 'indent-indents', 'indent-template-indents',
        'warehouse', 'warehouse-dashboard', 'warehouse-gate-entry', 'warehouse-grn', 'warehouse-putaway',
        'warehouse-material-issues', 'warehouse-material-issues-template', 'warehouse-material-inward',
        'warehouse-dispatch', 'warehouse-notifications',
        'inventory', 'inventory-dashboard', 'inventory-stock-balance', 'inventory-stock-ledger', 'inventory-stock-transfer', 'inventory-notifications',
        'inventory-masters-project-templates',
        'procurement-material-requests',
        'logistics', 'logistics-gate-entry', 'logistics-dashboard', 'logistics-master',
        'logistics-dispatch', 'logistics-consignments', 'logistics-rfq', 'logistics-so',
    },
    'storekeeper': {
        'lms',
        'indent', 'indent-dashboard', 'indent-indents', 'indent-template-indents',
        'warehouse', 'warehouse-dashboard', 'warehouse-gate-entry', 'warehouse-grn', 'warehouse-putaway',
        'warehouse-material-issues', 'warehouse-material-issues-template', 'warehouse-material-inward',
        'warehouse-dispatch', 'warehouse-notifications',
        'inventory', 'inventory-dashboard', 'inventory-stock-balance', 'inventory-stock-ledger', 'inventory-stock-transfer', 'inventory-notifications',
        'inventory-masters-project-templates',
        'procurement-material-requests',
        'logistics', 'logistics-gate-entry', 'logistics-dashboard', 'logistics-master',
        'logistics-dispatch', 'logistics-consignments', 'logistics-rfq', 'logistics-so',
    },
    'quality_inspector': {
        'lms',
        'warehouse', 'warehouse-dashboard', 'warehouse-quality-inspection', 'warehouse-notifications',
    },
    'purchase_officer': {
        'lms',
        'procurement', 'procurement-dashboard', 'procurement-demand-pool', 'procurement-material-requests',
        'procurement-quotations', 'procurement-quotation-comparison',
        'procurement-purchase-orders', 'procurement-notifications',
        'procurement-masters', 'procurement-masters-vendors', 'procurement-masters-vendor-material-mapping',
    },
    'purchase_manager': {
        'lms',
        'approvals', 'approvals-pending',
        'procurement', 'procurement-dashboard', 'procurement-demand-pool', 'procurement-material-requests',
        'procurement-quotations', 'procurement-quotation-comparison',
        'procurement-purchase-orders', 'procurement-reports', 'procurement-notifications',
        'procurement-masters', 'procurement-masters-vendors', 'procurement-masters-vendor-material-mapping',
    },
    'viewer': {
        'lms',
        'warehouse', 'warehouse-dashboard', 'warehouse-reports', 'warehouse-notifications',
        'inventory', 'inventory-dashboard', 'inventory-reports', 'inventory-notifications',
        'procurement', 'procurement-dashboard', 'procurement-reports', 'procurement-notifications',
        'indent', 'indent-dashboard', 'indent-reports', 'indent-notifications',
        'indent-template-indents',
        'consumption', 'consumption-reports',
    },
    'accounts_manager': {
        'lms',
        'accounts', 'accounts-invoices', 'accounts-payments',
        'accounts-ledger', 'accounts-credit-notes',
        'approvals', 'approvals-pending',
    },
    'accounts_officer': {
        'lms',
        'accounts', 'accounts-invoices', 'accounts-payments',
        'accounts-credit-notes',
    },
    'project_manager': {
        'lms',
        'approvals', 'approvals-pending',
        'inventory', 'inventory-dashboard', 'inventory-stock-balance', 'inventory-stock-ledger', 'inventory-reports', 'inventory-notifications',
        'inventory-masters-project-templates',
        'indent-template-indents',
        'procurement', 'procurement-dashboard', 'procurement-reports', 'procurement-notifications',
        'consumption', 'consumption-reports',
    },
    'vendor_portal': {
        'lms',
        'procurement', 'procurement-dashboard', 'procurement-quotations',
        'procurement-purchase-orders', 'procurement-notifications',
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
            'settings-system',
            'accounts', 'accounts-invoices', 'accounts-payments',
            'accounts-ledger', 'accounts-credit-notes',
        }
        return sorted(_ALL_KEYS - admin_excluded)
    return sorted(_ROLE_KEYS.get(role_code, set()))


async def allowed_keys_for_role(db: AsyncSession, role: Role) -> List[str]:
    if role.code == "super_admin":
        return sorted(_allowed_for_role(role.code))

    role_codes = [role.code]
    if role.code == "storekeeper":
        role_codes.append("store_keeper")
    elif role.code == "store_keeper":
        role_codes.append("storekeeper")

    result = await db.execute(
        select(Permission.module, Permission.action)
        .join(RolePermission, RolePermission.permission_id == Permission.id)
        .join(Role, Role.id == RolePermission.role_id)
        .where(Role.code.in_(role_codes))
    )
    dynamic_keys = set()
    for module, action in result.all():
        key = (module or "").strip().lower()
        act = (action or "").strip().lower()
        if not key or act not in {"view", "manage"}:
            continue
        
        # Map DB permission names to frontend menu keys if they differ
        mapped_keys = [key]
        if key == "masters-users":
            mapped_keys.extend([
                "settings-masters-users",
            ])
        elif key == "masters-user-groups":
            mapped_keys.extend([
                "settings-masters-user-groups",
            ])
        elif key == "masters-organization-structure":
            mapped_keys.extend([
                "settings-masters-organization-structure",
            ])
        elif key == "warehouse-material-issues":
            mapped_keys.extend([
                "warehouse-vehicle-material-issues",
                "warehouse-material-issues-template",
            ])
        elif key == "warehouse-vehicle-material-issues":
            mapped_keys.extend([
                "warehouse-material-issues",
            ])
        elif key == "inventory-masters":
            mapped_keys.extend([
                "inventory-masters-project-templates",
            ])
        elif key == "inventory-masters-project-templates":
            mapped_keys.extend([
                "inventory-masters",
            ])
        elif key == "indent-transactions" or key == "indent-indents" or key == "indent":
            mapped_keys.extend([
                "indent-template-indents",
            ])
        elif key == "inventory-stock-balance":
            mapped_keys.extend([
                "inventory-vehicle-stock-balance",
            ])
        elif key == "inventory-stock-ledger":
            mapped_keys.extend([
                "inventory-vehicle-stock-ledger",
            ])
        elif key == "indent-acknowledgement":
            mapped_keys.extend([
                "indent-material-acknowledgement",
            ])
        elif key == "indent-material-acknowledgement":
            mapped_keys.extend([
                "indent-acknowledgement",
            ])
            
        for k in mapped_keys:
            dynamic_keys.add(k)
            if "-" in k:
                dynamic_keys.add(k.split("-", 1)[0])

    # Dynamic parent filtering: prevent rendering empty navigation structures
    parents = {"inventory", "warehouse", "procurement", "indent", "logistics", "settings", "accounts", "approvals"}
    section_headers = {
        f"{p}-{suffix}" for p in parents for suffix in ["transactions", "masters", "reports", "notifications"]
    }
    
    actual_subkeys = {k for k in dynamic_keys if "-" in k and k not in section_headers}
    allowed_parents = {k.split("-", 1)[0] for k in actual_subkeys}
    
    filtered_keys = set()
    for k in dynamic_keys:
        if k in parents:
            if k in allowed_parents:
                filtered_keys.add(k)
        elif k in section_headers:
            parent = k.split("-", 1)[0]
            if parent in allowed_parents:
                filtered_keys.add(k)
        else:
            filtered_keys.add(k)

    keys = list(filtered_keys)
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


@router.post('/active-position/{position_id}', response_model=SidebarResponse)
async def switch_active_position(
        position_id: int,
        current_user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db)) -> SidebarResponse:
    if not current_user.employee_id:
        raise HTTPException(400, 'User is not linked to any employee')

    from app.models.master import Employee, Position
    from sqlalchemy.orm import selectinload

    employee = (await db.execute(
        select(Employee).where(Employee.id == current_user.employee_id)
    )).scalar_one_or_none()
    if not employee:
        raise HTTPException(404, 'Linked employee profile not found')

    # Verify position belongs to employee (either primary position or one of the multiple positions)
    pos_res = (await db.execute(
        select(Position)
        .options(selectinload(Position.role))
        .where(Position.id == position_id)
        .where((Position.employee_id == employee.id) | (Position.id == employee.position_id))
    )).scalar_one_or_none()
    if not pos_res:
        raise HTTPException(403, 'Requested position is not associated with this employee')

    # Update active position
    employee.position_id = position_id
    db.add(employee)

    # Sync role and user active_role_id
    role = await sync_user_position_role(db, current_user)
    if not role:
        raise HTTPException(422, 'The selected position does not have an active role')

    # Activity log
    db.add(ActivityLog(
        user_id=current_user.id,
        organization_id=getattr(current_user, 'organization_id', None),
        module='auth',
        action='position_switch',
        entity_type='position',
        entity_id=position_id,
        description=f'User switched active position to {pos_res.code} (role {role.code})',
    ))
    await db.flush()

    return SidebarResponse(
        active_role_id=role.id,
        active_role_code=role.code,
        allowed_keys=await allowed_keys_for_role(db, role),
    )
