from datetime import datetime, timezone
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Body
from sqlalchemy import select, func, delete, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.database import get_db
from app.models.user import User, UserRole, UserWarehouse, UserProject, Role
from app.models.master import Employee, Position
from app.schemas.auth import UserResponse, UserCreate, UserUpdate, AssignRoles, AssignWarehouses, AssignProjects, ResetPassword, RoleInfo
from app.utils.dependencies import get_current_user, require_any_role, require_permission
from app.utils.helpers import paginate_params, build_paginated_response, apply_search_filter
from app.utils.schema_sync import ensure_organization_structure_schema
import asyncio
import uuid

router = APIRouter()


# BUG-AUTH-062 / BUG-AUTH-093 fix: vendor / partner user-types must not be
# able to enumerate the full employee directory through /users/lookup. We
# hard-block these user_types from the lookup so dropdowns continue to work
# for staff while denying vendors/partners.
_LOOKUP_BLOCKED_USER_TYPES = {"vendor", "partner", "external"}


async def _sync_employee_link(db: AsyncSession, user: User, employee_id=None) -> None:
    if employee_id:
        employee = (await db.execute(select(Employee).where(Employee.id == employee_id))).scalar_one_or_none()
        if not employee:
            raise HTTPException(status_code=422, detail="Employee does not exist")
        user.employee_id = employee.id
        if employee.employee_code:
            user.employee_code = employee.employee_code
        return

    if not user.employee_code:
        user.employee_id = None
        return

    employee = (
        await db.execute(select(Employee).where(Employee.employee_code == user.employee_code))
    ).scalar_one_or_none()
    full_name = f"{user.first_name or ''} {user.last_name or ''}".strip() or user.username
    if not employee:
        employee = Employee(
            employee_code=user.employee_code,
            name=full_name,
            status="Active" if user.is_active else "Inactive",
            email=user.email,
            phone=(user.phone or "")[:15] or None,
        )
        db.add(employee)
        await db.flush()
    else:
        employee.name = employee.name or full_name
        employee.status = "Active" if user.is_active else "Inactive"
        employee.email = employee.email or user.email
        employee.phone = employee.phone or ((user.phone or "")[:15] or None)
    user.employee_id = employee.id


# BUG-AUTH-059 / BUG-AUTH-060: privileged role codes that may only be
# granted by a super_admin. A regular admin trying to assign these is a
# privilege-escalation attempt and must be rejected.
_PRIVILEGED_ROLE_CODES = {"super_admin", "admin"}


async def _is_super_admin(db: AsyncSession, user_id: int) -> bool:
    """Return True if the user has the super_admin role code."""
    res = await db.execute(
        select(Role.code).join(UserRole, UserRole.role_id == Role.id)
        .where(UserRole.user_id == user_id)
    )
    return "super_admin" in {c for (c,) in res.all()}


async def _guard_cross_tenant(db: AsyncSession, current_user: User, target_user: User):
    """BUG-AUTH-103/104/105/106 fix: a non-super-admin admin must not be able
    to act on users that belong to a different organisation. super_admins are
    treated as global so we explicitly let them through."""
    if target_user.organization_id == current_user.organization_id:
        return
    if await _is_super_admin(db, current_user.id):
        return
    raise HTTPException(
        status_code=403,
        detail="You cannot manage users outside your organization",
    )


async def _guard_role_assignment(db: AsyncSession, current_user: User, role_ids):
    """Reject attempts to grant super_admin / admin unless the caller is super_admin.

    Raises HTTP 403 on escalation attempt; returns silently otherwise.
    Treats ``None`` and empty lists as no-op.
    """
    if not role_ids:
        return

    # Caller's own role codes
    caller_roles = await db.execute(
        select(Role.code).join(UserRole, UserRole.role_id == Role.id)
        .where(UserRole.user_id == current_user.id)
    )
    caller_codes = {c for (c,) in caller_roles.all()}

    if "super_admin" in caller_codes:
        return  # super_admins may grant anything

    # Look up the requested roles' codes
    requested = await db.execute(
        select(Role.code).where(Role.id.in_(list(role_ids)))
    )
    requested_codes = {c for (c,) in requested.all()}
    illegal = requested_codes & _PRIVILEGED_ROLE_CODES
    if illegal:
        raise HTTPException(
            status_code=403,
            detail=f"Only super_admin can grant privileged roles: {sorted(illegal)}",
        )


class StatusPayload(BaseModel):
    status: str


async def _build_user_response(db: AsyncSession, u, roles_loaded=True):
    """Build a UserResponse from a User model instance."""
    from app.schemas.auth import WarehouseInfo, ProjectInfo
    full_name = u.first_name
    if u.last_name:
        full_name = f"{u.first_name} {u.last_name}"

    role_list = []
    if roles_loaded and u.roles:
        for ur in u.roles:
            if ur.role:
                role_list.append(RoleInfo(id=ur.role.id, code=ur.role.code, name=ur.role.name))

    # Ensure employee is loaded/resolved
    employee_position_id = None
    if u.employee_id:
        try:
            employee = u.employee
        except Exception:
            employee = None
        if employee is None:
            employee = (await db.execute(
                select(Employee).where(Employee.id == u.employee_id)
            )).scalar_one_or_none()
        if employee:
            employee_position_id = employee.position_id

    # Fetch positions list and resolve project/warehouse lists via position-based lookup helpers
    from app.api.v1.auth import get_user_positions, get_user_projects_info, get_user_warehouses_info
    positions_list = await get_user_positions(db, u.employee_id, employee_position_id)
    project_list = await get_user_projects_info(db, u.id, u.employee_id, employee_position_id)
    warehouse_list = await get_user_warehouses_info(db, u.id, u.employee_id, employee_position_id)

    return UserResponse(
        id=u.id, organization_id=u.organization_id, employee_id=u.employee_id, employee_code=u.employee_code,
        position_id=employee_position_id,
        username=u.username, email=u.email, first_name=u.first_name, last_name=u.last_name,
        full_name=full_name, phone=u.phone, user_type=u.user_type, department=u.department,
        designation=u.designation, is_active=u.is_active,
        status="active" if u.is_active else "inactive",
        last_login=u.last_login, created_at=u.created_at,
        roles=role_list, warehouses=warehouse_list, projects=project_list,
        positions=positions_list, permissions=[],
    )


async def _position_role_for_employee(db: AsyncSession, employee: Employee) -> Role | None:
    if not employee.position_id:
        return None
    return (
        await db.execute(
            select(Role)
            .join(Position, Position.role_id == Role.id)
            .where(Position.id == employee.position_id, Role.is_active == True)  # noqa: E712
        )
    ).scalar_one_or_none()


async def _apply_employee_position_role(db: AsyncSession, employee: Employee, current_user: User) -> int:
    role = await _position_role_for_employee(db, employee)
    if not role:
        return 0
    position = None
    if employee.position_id:
        position = (await db.execute(select(Position).where(Position.id == employee.position_id))).scalar_one_or_none()
    await _guard_role_assignment(db, current_user, [role.id])
    users = (
        await db.execute(select(User).where(User.employee_id == employee.id))
    ).scalars().all()
    for user in users:
        await _guard_cross_tenant(db, current_user, user)
        await db.execute(delete(UserRole).where(UserRole.user_id == user.id))
        db.add(UserRole(user_id=user.id, role_id=role.id))
        user.active_role_id = role.id
        user.department = position.department if position else user.department
        user.designation = position.name if position else user.designation
    await db.flush()
    return len(users)


def _employee_directory_payload(employee, position=None, role=None, login_user=None):
    if employee:
        name_parts = (employee.name or employee.employee_code or "").split()
        first_name = name_parts[0] if name_parts else employee.employee_code
        last_name = " ".join(name_parts[1:]) if len(name_parts) > 1 else None
        is_active = str(employee.status or "Active").lower() == "active"
        emp_id = employee.id
        emp_code = employee.employee_code
        emp_email = employee.email or (login_user.email if login_user else None)
        emp_name = employee.name
        emp_phone = employee.phone
        created_at = employee.created_at
        pos_id = employee.position_id
    else:
        first_name = (login_user.first_name if login_user else "") or ""
        last_name = (login_user.last_name if login_user else "") or ""
        is_active = login_user.is_active if login_user else True
        emp_id = None
        emp_code = login_user.employee_code if login_user else None
        emp_email = login_user.email if login_user else None
        emp_name = f"{first_name} {last_name}".strip() or (login_user.username if login_user else "")
        emp_phone = login_user.phone if login_user else None
        created_at = login_user.created_at if login_user else None
        pos_id = None

    role_list = []
    if login_user and login_user.roles:
        for ur in login_user.roles:
            if ur.role:
                role_list.append({
                    "id": ur.role.id,
                    "code": ur.role.code,
                    "name": ur.role.name
                })
    if not role_list and role:
        role_list.append({
            "id": role.id,
            "code": role.code,
            "name": role.name
        })

    warehouse_list = []
    if login_user and login_user.warehouses:
        for uw in login_user.warehouses:
            warehouse_list.append({
                "id": uw.warehouse_id,
                "warehouse_id": uw.warehouse_id
            })

    project_list = []
    if login_user and login_user.projects:
        for up in login_user.projects:
            if up.project:
                project_list.append({
                    "id": up.project.id,
                    "name": up.project.name
                })

    return {
        "id": emp_id or (login_user.id if login_user else None),
        "employee_id": emp_id,
        "auth_user_id": login_user.id if login_user else None,
        "user_id": login_user.id if login_user else None,
        "employee_code": emp_code,
        "username": login_user.username if login_user else emp_code,
        "email": emp_email,
        "first_name": first_name,
        "last_name": last_name,
        "full_name": emp_name,
        "phone": emp_phone,
        "user_type": login_user.user_type if login_user else "employee",
        "department": (position.department if position else None) or (login_user.department if login_user else None),
        "designation": (position.name if position else None) or (login_user.designation if login_user else None),
        "position_id": pos_id,
        "position_code": position.code if position else None,
        "position_name": position.name if position else None,
        "role_id": role_list[0]["id"] if role_list else (role.id if role else None),
        "role_name": role_list[0]["name"] if role_list else (role.name if role else (position.role_name if position else None)),
        "role_code": role_list[0]["code"] if role_list else (role.code if role else None),
        "roles": role_list,
        "warehouses": warehouse_list,
        "projects": project_list,
        "is_active": is_active,
        "status": "active" if is_active else "inactive",
        "login_enabled": bool(login_user and login_user.is_active),
        "has_login": bool(login_user),
        "last_login": login_user.last_login if login_user else None,
        "created_at": created_at,
    }


@router.post("", response_model=UserResponse, status_code=201)
async def create_user(
    payload: UserCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    """Create a new user (admin only)."""
    from app.services.auth_service import hash_password

    # Check if username or email already exists (case-insensitive check)
    existing = await db.execute(
        select(User).where(
            (func.lower(User.username) == payload.username.lower())
            | (func.lower(User.email) == payload.email.lower())
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Username or email already exists")

    # BUG-AUTH-059: gate privileged role assignment before creating the user
    await _guard_role_assignment(db, current_user, payload.role_ids or [])

    # BUG-AUTH-058 fix: a non-super-admin admin must not be able to create a
    # user inside another organisation. Force the org to the caller's unless
    # the caller is a super_admin.
    if payload.organization_id and payload.organization_id != current_user.organization_id:
        if not await _is_super_admin(db, current_user.id):
            raise HTTPException(
                status_code=403,
                detail="Only super_admin can create users in other organizations",
            )
    org_id = payload.organization_id if payload.organization_id else current_user.organization_id
    user = User(
        organization_id=org_id,
        username=payload.username.lower(),
        email=payload.email.lower(),
        password_hash=hash_password(payload.password),
        first_name=payload.first_name,
        last_name=payload.last_name,
        employee_code=payload.employee_code,
        phone=payload.phone,
        user_type=payload.user_type,
        department=payload.department,
        designation=payload.designation,
    )
    db.add(user)
    await db.flush()
    await _sync_employee_link(db, user, payload.employee_id)

    # Assign roles
    for role_id in (payload.role_ids or []):
        db.add(UserRole(user_id=user.id, role_id=role_id))

    # Assign warehouses with optional per-role mapping
    for assignment in (payload.warehouse_assignments or []):
        db.add(UserWarehouse(
            user_id=user.id,
            warehouse_id=assignment.warehouse_id,
            role_id=assignment.role_id,
        ))

    # Assign projects
    for proj_id in (payload.project_ids or []):
        db.add(UserProject(user_id=user.id, project_id=proj_id))

    await db.flush()

    # Reload with roles, warehouses, and projects
    result = await db.execute(
        select(User).options(
            selectinload(User.roles).selectinload(UserRole.role),
            selectinload(User.warehouses).selectinload(UserWarehouse.role),
            selectinload(User.projects).selectinload(UserProject.project),
            selectinload(User.employee)
        )
        .where(User.id == user.id)
    )
    user = result.scalar_one()
    return await _build_user_response(db, user)


# BUG-AUTH-072 fix: capture an audit row when an admin exports the user
# directory. The frontend posts here right after generating the Excel file.
@router.post("/audit-export")
async def audit_export(
    request: Request,
    payload: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    try:
        from app.models.system import ActivityLog
        ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (
            request.client.host if request.client else None
        )
        ua = request.headers.get("user-agent", "")[:500]
        row_count = int(payload.get("row_count") or 0)
        export_type = str(payload.get("export_type") or "users")[:50]
        db.add(ActivityLog(
            user_id=current_user.id,
            module="users",
            action="export",
            entity_type="user_directory",
            description=(
                f"User directory export by {current_user.username} "
                f"({row_count} rows, type={export_type})"
            ),
            ip_address=ip,
            user_agent=ua,
        ))
        await db.flush()
    except Exception:
        # Audit failure must not break the export client-side flow.
        pass
    return {"success": True}


@router.get("/lookup")
async def lookup_users(
    search: str = Query(None),
    department: str = Query(None),
    page_size: int = Query(200, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Lightweight user list for dropdowns. Open to any authenticated user
    so non-admin forms (Material Issue, Indent, etc.) can populate "Issued To"
    and similar selectors. Returns minimal fields (id, name, dept) — no PII.

    Bug fix: BUG_0064 — non-admin users were hitting `/settings/users` and
    getting 403, leaving the IssuedTo dropdown blank.

    BUG-AUTH-062/093 fix: vendor/partner accounts are blocked from this
    endpoint and results are scoped to the caller's organisation.
    """
    if (current_user.user_type or "").lower() in _LOOKUP_BLOCKED_USER_TYPES:
        raise HTTPException(
            status_code=403,
            detail="Vendor / partner accounts cannot enumerate the user directory",
        )
    q = select(
        User.id,
        User.username,
        User.first_name,
        User.last_name,
        User.email,
        User.department,
        User.is_active,
        User.employee_code,
    ).where(User.is_active == True)  # noqa: E712
    # BUG-AUTH-065/093 fix: scope lookups to the caller's organisation so
    # cross-tenant leakage cannot happen via this dropdown endpoint.
    if current_user.organization_id:
        q = q.where(User.organization_id == current_user.organization_id)
    if search:
        # BUG-AUTH-063 fix: previously the search filter included
        # `User.email.ilike(...)`, which let any caller probe whether a
        # given email address belongs to a user (a PII enumeration vector)
        # despite the docstring promising no PII. Restrict the lookup to
        # username + name fields.
        s = f"%{search}%"
        q = q.where(
            (User.username.ilike(s))
            | (User.first_name.ilike(s))
            | (User.last_name.ilike(s))
        )
    if department:
        q = q.where(User.department == department)
    rows = (await db.execute(q.limit(page_size))).all()
    out = []
    for r in rows:
        first = r.first_name or ""
        last = r.last_name or ""
        full = f"{first} {last}".strip() or r.username or r.email
        out.append({
            "id": r.id,
            "username": r.username,
            "name": full,
            "full_name": full,
            "department": r.department,
            "employee_code": r.employee_code,
        })
    return out


@router.get("")
async def list_users(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=500),
    search: str = Query(None),
    is_active: bool = Query(None),
    status: str = Query(None),
    user_type: str = Query(None),
    department: str = Query(None),
    role_id: int = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    """List HR employees as the Settings user directory.

    The legacy auth `users` table remains for login only. This endpoint now
    presents employees as the main business user table and overlays linked
    login-user metadata when an employee already has a login account.
    """
    await ensure_organization_structure_schema(db)
    offset, limit = paginate_params(page, page_size)

    query = (
        select(Employee, Position, Role, User)
        .select_from(User)
        .join(Employee, User.employee_id == Employee.id, isouter=True)
        .join(Position, Employee.position_id == Position.id, isouter=True)
        .join(Role, Position.role_id == Role.id, isouter=True)
        .options(
            selectinload(User.roles).selectinload(UserRole.role),
            selectinload(User.warehouses).selectinload(UserWarehouse.role),
            selectinload(User.projects).selectinload(UserProject.project),
        )
    )
    count_query = (
        select(func.count(User.id))
        .select_from(User)
        .join(Employee, User.employee_id == Employee.id, isouter=True)
        .join(Position, Employee.position_id == Position.id, isouter=True)
        .join(Role, Position.role_id == Role.id, isouter=True)
    )

    # BUG-AUTH-065 fix: scope user listings to the caller's organisation
    # unless the caller is super_admin (treated as global). Without this
    # filter a tenant admin sees every user across every tenant.
    if not await _is_super_admin(db, current_user.id) and current_user.organization_id:
        query = query.where(User.organization_id == current_user.organization_id)
        count_query = count_query.where(User.organization_id == current_user.organization_id)

    # Support both is_active (bool) and status (string) params.
    # BUG-AUTH-070 fix: previously precedence was undocumented; if a caller
    # accidentally sent BOTH `is_active=true&status=inactive` the response
    # silently followed `is_active`. Reject the conflict so the caller fixes
    # their request rather than getting confusing data.
    if is_active is not None and status:
        active_from_status = status.lower() == 'active'
        if bool(is_active) != active_from_status:
            raise HTTPException(
                status_code=400,
                detail="Conflicting filters: pass either is_active OR status, not both with different values",
            )
    if is_active is not None:
        query = query.where(User.is_active == is_active)
        count_query = count_query.where(User.is_active == is_active)
    elif status:
        active_val = status.lower() == 'active'
        query = query.where(User.is_active == active_val)
        count_query = count_query.where(User.is_active == active_val)
    if user_type:
        query = query.where(User.user_type == user_type)
        count_query = count_query.where(User.user_type == user_type)
    if department:
        query = query.where(Position.department == department)
        count_query = count_query.where(Position.department == department)
    if role_id:
        query = query.where(Position.role_id == role_id)
        count_query = count_query.where(Position.role_id == role_id)

    if search:
        s = f"%{search}%"
        condition = or_(
            Employee.employee_code.ilike(s),
            Employee.name.ilike(s),
            Employee.email.ilike(s),
            Employee.phone.ilike(s),
            Position.name.ilike(s),
            Position.code.ilike(s),
            Role.name.ilike(s),
            Role.code.ilike(s),
            User.username.ilike(s),
            User.first_name.ilike(s),
            User.last_name.ilike(s),
            User.email.ilike(s),
        )
        query = query.where(condition)
        count_query = count_query.where(condition)

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.order_by(User.username.asc()).offset(offset).limit(limit))
    rows = result.all()

    items = [_employee_directory_payload(employee, position, role, login_user) for employee, position, role, login_user in rows]
    return build_paginated_response(items, total, page, page_size)


@router.post("/{employee_id}/apply-position-role")
async def apply_employee_position_role(
    employee_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    await ensure_organization_structure_schema(db)
    employee = (await db.execute(select(Employee).where(Employee.id == employee_id))).scalar_one_or_none()
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")
    applied_users = await _apply_employee_position_role(db, employee, current_user)
    if not applied_users:
        raise HTTPException(status_code=422, detail="Employee has no linked login user or the position has no active role")
    return {"success": True, "message": f"Applied position role to {applied_users} linked login user(s)"}


@router.get("/{user_id:int}", response_model=UserResponse)
async def get_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a specific user by ID.

    BUG-AUTH-102 fix: previously this only allowed the user themselves OR a
    super_admin / admin to view a row. PMs and warehouse / department
    supervisors legitimately need to see their reports' contact details to
    coordinate dispatches and approvals. We now also let project / warehouse
    managers view records inside their organisation.
    """
    # Permission check: user can view own record, or must be in a managerial role
    if user_id != current_user.id:
        from app.utils.dependencies import MANAGERIAL_ROLES
        role_codes = []
        user_roles_result = await db.execute(
            select(UserRole).options(selectinload(UserRole.role)).where(UserRole.user_id == current_user.id)
        )
        for ur in user_roles_result.scalars().all():
            if ur.role:
                role_codes.append(ur.role.code)
        if not any(r in role_codes for r in MANAGERIAL_ROLES):
            raise HTTPException(status_code=403, detail="You can only view your own user profile")

    result = await db.execute(
        select(User).options(
            selectinload(User.roles).selectinload(UserRole.role),
            selectinload(User.warehouses).selectinload(UserWarehouse.role),
            selectinload(User.projects).selectinload(UserProject.project),
            selectinload(User.employee)
        )
        .where(User.id == user_id)
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # BUG-AUTH-064 fix: cross-tenant guard — admins must not see users in
    # other organizations through this endpoint. Skip the check when the
    # caller is looking at their own record (already permitted above).
    if user_id != current_user.id:
        await _guard_cross_tenant(db, current_user, user)

    return await _build_user_response(db, user)


@router.put("/{user_id:int}", response_model=UserResponse)
async def update_user(
    user_id: int,
    payload: UserUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    """Update user details."""
    result = await db.execute(
        select(User).options(selectinload(User.roles).selectinload(UserRole.role))
        .where(User.id == user_id)
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # BUG-AUTH-106 fix: cross-tenant update guard
    await _guard_cross_tenant(db, current_user, user)

    update_data = payload.model_dump(exclude_unset=True)
    employee_id = update_data.pop("employee_id", None)

    # Process username update
    new_username = update_data.pop("username", None)
    if new_username is not None and new_username.strip():
        new_username_lower = new_username.strip().lower()
        if new_username_lower != user.username.lower():
            # Check if this username is already taken by another user
            existing_uname = await db.execute(
                select(User).where(func.lower(User.username) == new_username_lower, User.id != user_id)
            )
            if existing_uname.scalar_one_or_none():
                raise HTTPException(status_code=409, detail="Username already exists")
            user.username = new_username_lower

    # Process password update
    new_password = update_data.pop("password", None)
    if new_password is not None and new_password.strip():
        from app.services.auth_service import hash_password
        user.password_hash = hash_password(new_password)
        user.password_changed_at = datetime.now(timezone.utc)
        user.tokens_revoked_after = user.password_changed_at


    # BUG-AUTH-054 fix: an admin must not be able to demote / disable
    # themselves through the standard update flow — that would risk a
    # last-admin lockout. Self-edits may not toggle privileged fields.
    if user_id == current_user.id:
        for forbidden in ("is_active", "user_type"):
            if forbidden in update_data:
                update_data.pop(forbidden)
        # role_ids handled below
        if update_data.get("__self_role_block_marker__"):
            pass

    # Handle role reassignment
    role_ids = update_data.pop("role_ids", None)
    if role_ids is not None:
        # BUG-AUTH-054: prevent self-demotion (losing super_admin/admin)
        if user_id == current_user.id:
            current_codes_q = await db.execute(
                select(Role.code).join(UserRole, UserRole.role_id == Role.id)
                .where(UserRole.user_id == current_user.id)
            )
            current_codes = {c for (c,) in current_codes_q.all()}
            new_codes_q = await db.execute(
                select(Role.code).where(Role.id.in_(list(role_ids)))
            )
            new_codes = {c for (c,) in new_codes_q.all()}
            if "super_admin" in current_codes and "super_admin" not in new_codes:
                raise HTTPException(status_code=403, detail="You cannot demote yourself from super_admin")
            if "admin" in current_codes and not (new_codes & {"admin", "super_admin"}):
                raise HTTPException(status_code=403, detail="You cannot demote yourself from admin")
        # BUG-AUTH-060: gate privileged role assignment
        await _guard_role_assignment(db, current_user, role_ids)
        await db.execute(delete(UserRole).where(UserRole.user_id == user_id))
        for role_id in role_ids:
            db.add(UserRole(user_id=user_id, role_id=role_id))

    # Handle warehouse reassignment (role-warehouse mapping)
    warehouse_assignments = update_data.pop("warehouse_assignments", None)
    if warehouse_assignments is not None:
        await db.execute(delete(UserWarehouse).where(UserWarehouse.user_id == user_id))
        for assignment in warehouse_assignments:
            db.add(UserWarehouse(
                user_id=user_id,
                warehouse_id=assignment["warehouse_id"] if isinstance(assignment, dict) else assignment.warehouse_id,
                role_id=assignment.get("role_id") if isinstance(assignment, dict) else assignment.role_id,
            ))

    # Handle project reassignment
    project_ids = update_data.pop("project_ids", None)
    if project_ids is not None:
        await db.execute(delete(UserProject).where(UserProject.user_id == user_id))
        for proj_id in project_ids:
            db.add(UserProject(user_id=user_id, project_id=proj_id))

    # BUG-AUTH-053 fix: explicit allow-list prevents future privesc if a
    # /me-style self-update endpoint is added — flat schemas otherwise let
    # `is_active` or `user_type` slip through. Privileged toggles
    # (is_active, user_type) here are admin-only because update_user is
    # already gated by require_any_role(super_admin, admin).
    _ALLOWED_UPDATE_FIELDS = {
        "first_name", "last_name", "email", "phone",
        "department", "designation", "user_type",
        "employee_code", "is_active",
    }
    for key, value in update_data.items():
        if key in _ALLOWED_UPDATE_FIELDS:
            setattr(user, key, value)
    await _sync_employee_link(db, user, employee_id)
    await db.flush()

    # Reload with roles, warehouses, and projects
    result = await db.execute(
        select(User).options(
            selectinload(User.roles).selectinload(UserRole.role),
            selectinload(User.warehouses).selectinload(UserWarehouse.role),
            selectinload(User.projects).selectinload(UserProject.project),
            selectinload(User.employee)
        )
        .where(User.id == user_id)
    )
    user = result.scalar_one()
    return await _build_user_response(db, user)


@router.delete("/{user_id:int}")
async def deactivate_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    """Deactivate a user (soft delete)."""
    # BUG-AUTH-054 fix: prevent admin from deactivating own account
    if user_id == current_user.id:
        raise HTTPException(status_code=403, detail="You cannot deactivate your own account")
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # BUG-AUTH-105 fix: cross-tenant guard
    await _guard_cross_tenant(db, current_user, user)

    user.is_active = False
    # BUG-AUTH-019 (Wave 5): forcibly revoke any access tokens already
    # minted for this user. ``get_current_user`` rejects tokens whose
    # ``iat`` predates ``tokens_revoked_after``.
    user.tokens_revoked_after = datetime.now(timezone.utc)
    # BUG-AUTH-066 fix: clear the user's role / warehouse / project mappings on
    # soft delete. Without this a re-activation would silently restore the
    # original privilege set, and downstream warehouse-scope queries kept
    # returning rows for the "deleted" user.
    await db.execute(delete(UserRole).where(UserRole.user_id == user_id))
    await db.execute(delete(UserWarehouse).where(UserWarehouse.user_id == user_id))
    await db.execute(delete(UserProject).where(UserProject.user_id == user_id))
    await db.flush()
    return {"success": True, "message": "User deactivated"}


# BUG-AUTH-048: import the shared limiter once at module level (lazy import
# inside the handler caused decorator-ordering issues).
from app.api.v1.auth import limiter as _shared_limiter


@router.post("/{user_id:int}/reset-password")
@_shared_limiter.limit("20/minute")
async def reset_user_password(
    request: Request,
    user_id: int,
    payload: ResetPassword,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    """Reset a user's password (admin only).

    BUG-AUTH-048: rate-limited at 20/min/IP to throttle credential-stuffing.
    """
    from app.services.auth_service import hash_password

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # BUG-AUTH-103 fix: cross-tenant org-membership check
    await _guard_cross_tenant(db, current_user, user)

    user.password_hash = hash_password(payload.new_password)
    user.password_changed_at = datetime.now(timezone.utc)
    await db.flush()

    # BUG-AUTH-041 / BUG-AUTH-051 fix: write a semantic audit row that
    # identifies WHICH user had their password reset and which admin did
    # it. The generic AuditMiddleware row only records "POST /users/{id}/
    # reset-password" without the admin or the target identity in the
    # description. Notification emails to the affected user are DEFERRED
    # until an outbound email pipeline exists.
    try:
        from app.models.system import ActivityLog
        ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (
            request.client.host if request.client else None
        )
        ua = request.headers.get("user-agent", "")[:500]
        db.add(ActivityLog(
            user_id=current_user.id,
            module="users",
            action="password_reset",
            entity_type="user",
            entity_id=user.id,
            description=(
                f"Admin {current_user.username} reset the password of "
                f"user '{user.username}' (id={user.id})"
            ),
            ip_address=ip,
            user_agent=ua,
        ))
        await db.flush()
    except Exception:
        pass

    return {"success": True, "message": "Password reset successfully"}


@router.patch("/{user_id:int}/status")
async def toggle_user_status(
    user_id: int,
    payload: StatusPayload,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    # BUG-AUTH-054 fix: prevent admin from disabling own account
    if user_id == current_user.id and payload.status != "active":
        raise HTTPException(status_code=403, detail="You cannot deactivate your own account")
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    # BUG-AUTH-105 fix: cross-tenant guard
    await _guard_cross_tenant(db, current_user, user)
    user.is_active = payload.status == "active"
    await db.flush()
    return {"success": True, "message": f"User {'activated' if user.is_active else 'deactivated'}"}


@router.post("/{user_id:int}/roles")
async def assign_roles(
    user_id: int,
    payload: AssignRoles,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    """Assign roles to a user (replaces existing roles)."""
    result = await db.execute(select(User).where(User.id == user_id))
    target = result.scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    # BUG-AUTH-104 fix: cross-tenant guard
    await _guard_cross_tenant(db, current_user, target)

    # BUG-AUTH-054 fix: self-demotion guard
    if user_id == current_user.id:
        current_codes_q = await db.execute(
            select(Role.code).join(UserRole, UserRole.role_id == Role.id)
            .where(UserRole.user_id == current_user.id)
        )
        current_codes = {c for (c,) in current_codes_q.all()}
        new_codes_q = await db.execute(
            select(Role.code).where(Role.id.in_(list(payload.role_ids)))
        )
        new_codes = {c for (c,) in new_codes_q.all()}
        if "super_admin" in current_codes and "super_admin" not in new_codes:
            raise HTTPException(status_code=403, detail="You cannot demote yourself from super_admin")
        if "admin" in current_codes and not (new_codes & {"admin", "super_admin"}):
            raise HTTPException(status_code=403, detail="You cannot demote yourself from admin")

    # BUG-AUTH-060: gate privileged role assignment
    await _guard_role_assignment(db, current_user, payload.role_ids)

    await db.execute(delete(UserRole).where(UserRole.user_id == user_id))
    for role_id in payload.role_ids:
        db.add(UserRole(user_id=user_id, role_id=role_id))
    await db.flush()

    return {"success": True, "message": "Roles assigned successfully"}


@router.post("/{user_id:int}/warehouses")
async def assign_warehouses(
    user_id: int,
    payload: AssignWarehouses,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    """Assign warehouses to a user."""
    result = await db.execute(select(User).where(User.id == user_id))
    target = result.scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    # BUG-AUTH-104 fix: cross-tenant guard
    await _guard_cross_tenant(db, current_user, target)

    # BUG-AUTH-061 fix: validate that every requested warehouse id actually
    # exists. UserWarehouse has no FK to warehouses (legacy schema), so an
    # admin could otherwise persist phantom mappings that the warehouse
    # scope-filter then silently ignores.
    if payload.warehouse_ids:
        from app.models.warehouse import Warehouse
        unique_ids = list({int(w) for w in payload.warehouse_ids if w is not None})
        existing_q = await db.execute(
            select(Warehouse.id).where(Warehouse.id.in_(unique_ids))
        )
        existing_ids = {row[0] for row in existing_q.all()}
        missing = sorted(set(unique_ids) - existing_ids)
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown warehouse id(s): {missing}",
            )

    await db.execute(delete(UserWarehouse).where(UserWarehouse.user_id == user_id))
    for wh_id in payload.warehouse_ids:
        db.add(UserWarehouse(user_id=user_id, warehouse_id=wh_id))
    await db.flush()

    return {"success": True, "message": "Warehouses assigned successfully"}


@router.post("/{user_id:int}/projects")
async def assign_projects(
    user_id: int,
    payload: AssignProjects,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    """Assign projects to a user."""
    result = await db.execute(select(User).where(User.id == user_id))
    target = result.scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    # BUG-AUTH-104 fix: cross-tenant guard
    await _guard_cross_tenant(db, current_user, target)

    # BUG-AUTH-061 fix: validate that every requested project id exists. We
    # accept missing-table failures gracefully — older deployments without a
    # Project model fall back to the previous behaviour.
    if payload.project_ids:
        try:
            from app.models.user import Project  # type: ignore
        except Exception:
            Project = None  # type: ignore
        if Project is not None:
            unique_ids = list({int(p) for p in payload.project_ids if p is not None})
            existing_q = await db.execute(
                select(Project.id).where(Project.id.in_(unique_ids))
            )
            existing_ids = {row[0] for row in existing_q.all()}
            missing = sorted(set(unique_ids) - existing_ids)
            if missing:
                raise HTTPException(
                    status_code=400,
                    detail=f"Unknown project id(s): {missing}",
                )

    await db.execute(delete(UserProject).where(UserProject.user_id == user_id))
    for proj_id in payload.project_ids:
        db.add(UserProject(user_id=user_id, project_id=proj_id))
    await db.flush()

    return {"success": True, "message": "Projects assigned successfully"}

# ==================== modularized masters endpoints ====================
from pydantic import BaseModel, Field
from typing import List, Literal, Optional
from sqlalchemy import delete, select, func, or_, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import aliased, selectinload
from app.models.master import (
    Office, Position, Employee, UserGroup, UserGroupMember, UserGroupPermission
)
from app.models.user import Organization, Project, Role, UserRole
from app.schemas.master import (
    ProjectMasterCreate, ProjectMasterResponse, OfficeCreate, OfficeResponse,
    PositionCreate, PositionResponse, EmployeeCreate, EmployeeResponse,
    PAN_PATTERN, EMAIL_PATTERN, PHONE_PATTERN
)
from app.utils.schema_sync import ensure_organization_structure_schema
import re
import asyncio
import httpx
from urllib.parse import urljoin
from app.config import settings

def _project_dict(row: Project) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "code": row.code,
        "description": row.description,
        "status": row.status,
    }


@router.get("/org-projects")
async def list_org_projects(
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_organization_structure_schema(db)
    offset, limit = paginate_params(page, page_size)
    q = select(Project).where(Project.organization_id == current_user.organization_id)
    count_q = select(func.count(Project.id)).where(Project.organization_id == current_user.organization_id)
    if search:
        like = f"%{search}%"
        q = q.where(or_(Project.name.ilike(like), Project.code.ilike(like)))
        count_q = count_q.where(or_(Project.name.ilike(like), Project.code.ilike(like)))
    total = (await db.execute(count_q)).scalar() or 0
    rows = (await db.execute(q.order_by(Project.name).offset(offset).limit(limit))).scalars().all()
    return build_paginated_response([_project_dict(row) for row in rows], total, page, page_size)


@router.post("/org-projects", status_code=201)
async def create_org_project(
    payload: ProjectMasterCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "create", "users")),
):
    await ensure_organization_structure_schema(db)
    existing = (await db.execute(select(Project).where(func.lower(Project.code) == payload.code.lower()))).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail=f"Project code '{payload.code}' already exists")
    row = Project(
        organization_id=current_user.organization_id,
        name=payload.name,
        code=payload.code,
        description=payload.description,
        status=payload.status or "active",
    )
    db.add(row)
    await db.flush()
    return {"id": row.id, "message": "Project created"}


@router.put("/org-projects/{project_id}")
async def update_org_project(
    project_id: int,
    payload: ProjectMasterCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "users")),
):
    await ensure_organization_structure_schema(db)
    row = (await db.execute(select(Project).where(Project.id == project_id, Project.organization_id == current_user.organization_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    duplicate = (await db.execute(select(Project).where(func.lower(Project.code) == payload.code.lower(), Project.id != project_id))).scalar_one_or_none()
    if duplicate:
        raise HTTPException(status_code=409, detail=f"Project code '{payload.code}' already exists")
    row.name = payload.name
    row.code = payload.code
    row.description = payload.description
    row.status = payload.status or row.status
    await db.flush()
    return {"id": row.id, "message": "Project updated"}


@router.delete("/org-projects/{project_id}")
async def delete_org_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "delete", "users")),
):
    await ensure_organization_structure_schema(db)
    row = (await db.execute(select(Project).where(Project.id == project_id, Project.organization_id == current_user.organization_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    row.status = "inactive"
    await db.flush()
    return {"message": "Project deactivated"}


@router.get("/offices")
async def list_offices(
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    search: str = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_organization_structure_schema(db)
    offset, limit = paginate_params(page, page_size)
    q = select(Office)
    count_q = select(func.count(Office.id))
    if search:
        like = f"%{search}%"
        condition = or_(Office.name.ilike(like), Office.state.ilike(like), Office.district.ilike(like), Office.cluster.ilike(like))
        q = q.where(condition)
        count_q = count_q.where(condition)
    total = (await db.execute(count_q)).scalar() or 0
    rows = (await db.execute(q.order_by(Office.name).offset(offset).limit(limit))).scalars().all()
    return build_paginated_response([OfficeResponse.model_validate(row).model_dump() for row in rows], total, page, page_size)


@router.post("/offices", status_code=201)
async def create_office(
    payload: OfficeCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "create", "users")),
):
    await ensure_organization_structure_schema(db)
    row = Office(**payload.model_dump())
    db.add(row)
    await db.flush()
    from app.services.office_warehouse_sync import sync_office_to_warehouse
    await sync_office_to_warehouse(db, row, organization_id=current_user.organization_id)
    return {"id": row.id, "message": "Office created"}


@router.put("/offices/{office_id}")
async def update_office(
    office_id: int,
    payload: OfficeCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "users")),
):
    await ensure_organization_structure_schema(db)
    row = (await db.execute(select(Office).where(Office.id == office_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Office not found")
    for key, value in payload.model_dump().items():
        setattr(row, key, value)
    await db.flush()
    from app.services.office_warehouse_sync import sync_office_to_warehouse
    await sync_office_to_warehouse(db, row, organization_id=current_user.organization_id)
    return {"id": row.id, "message": "Office updated"}


@router.delete("/offices/{office_id}")
async def delete_office(
    office_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "delete", "users")),
):
    await ensure_organization_structure_schema(db)
    row = (await db.execute(select(Office).where(Office.id == office_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Office not found")
    in_use = await db.scalar(select(func.count(Position.id)).where(Position.office_id == office_id))
    if in_use:
        raise HTTPException(status_code=409, detail=f"Office is linked to {int(in_use)} position(s)")
    await db.delete(row)
    await db.flush()
    return {"message": "Office deleted"}


def _position_payload(
    row: Position,
    project_name=None,
    office_name=None,
    parent_name=None,
    role_name=None,
    role_code=None,
    employee_name=None,
    employee_code=None,
) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "code": row.code,
        "role_id": row.role_id,
        "role_name": role_name or row.role_name,
        "role_code": role_code,
        "level_name": row.level_name,
        "level_rank": row.level_rank,
        "department": row.department,
        "section": row.section,
        # Wave 11C - HRMS API extra fields
        "job_name": row.job_name,
        "job_family_name": row.job_family_name,
        "job_family_id": row.job_family_id,
        "role_type_id": row.role_type_id,
        "position_status": row.status,
        "start_date": row.start_date.isoformat() if row.start_date else None,
        "project_id": row.project_id,
        "office_id": row.office_id,
        "parent_position_id": row.parent_position_id,
        "project_name": project_name,
        "office_name": office_name,
        "parent_position_name": parent_name,
        "employee_id": row.employee_id,
        "employee_name": employee_name,
        "employee_code": employee_code,
    }


@router.get("/positions")
async def list_positions(
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    search: Optional[str] = None,
    project_id: Optional[int] = None,
    office_id: Optional[int] = None,
    department: Optional[str] = None,
    status: Optional[str] = None,
    employee_code: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_organization_structure_schema(db)
    offset, limit = paginate_params(page, page_size)
    ParentPosition = aliased(Position)
    q = (
        select(Position, Project.name, Office.name, ParentPosition.name, Role.name, Role.code)
        .join(Project, Position.project_id == Project.id, isouter=True)
        .join(Office, Position.office_id == Office.id, isouter=True)
        .join(ParentPosition, Position.parent_position_id == ParentPosition.id, isouter=True)
        .join(Role, Position.role_id == Role.id, isouter=True)
    )
    count_q = select(func.count(Position.id))
    has_employee_join = False
    if search:
        like = f"%{search}%"
        condition = or_(
            Position.name.ilike(like),
            Position.code.ilike(like),
            Position.department.ilike(like),
            Position.role_name.ilike(like),
            Role.name.ilike(like),
            Role.code.ilike(like),
            Employee.name.ilike(like),
            Employee.employee_code.ilike(like)
        )
        q = q.join(Employee, or_(Position.employee_id == Employee.id, Employee.position_id == Position.id), isouter=True).where(condition).distinct()
        has_employee_join = True
        count_q = (
            select(func.count(Position.id.distinct()))
            .join(Role, Position.role_id == Role.id, isouter=True)
            .join(Employee, or_(Position.employee_id == Employee.id, Employee.position_id == Position.id), isouter=True)
            .where(condition)
        )
    if employee_code:
        like = f"%{employee_code}%"
        if not has_employee_join:
            q = q.join(Employee, or_(Position.employee_id == Employee.id, Employee.position_id == Position.id), isouter=True)
            count_q = count_q.join(Employee, or_(Position.employee_id == Employee.id, Employee.position_id == Position.id), isouter=True)
        q = q.where(Employee.employee_code.ilike(like)).distinct()
        count_q = count_q.where(Employee.employee_code.ilike(like))
    if project_id is not None:
        q = q.where(Position.project_id == project_id)
        count_q = count_q.where(Position.project_id == project_id)
    if office_id is not None:
        q = q.where(Position.office_id == office_id)
        count_q = count_q.where(Position.office_id == office_id)
    if department:
        q = q.where(Position.department == department)
        count_q = count_q.where(Position.department == department)
    if status:
        q = q.where(Position.status == status)
        count_q = count_q.where(Position.status == status)
    total = (await db.execute(count_q)).scalar() or 0
    rows = (await db.execute(q.order_by(Position.level_rank.asc(), Position.name.asc()).offset(offset).limit(limit))).all()
    
    parent_names_map = {}
    if rows:
        pos_objs = [r[0] for r in rows]
        position_ids = [p.id for p in pos_objs]
        direct_employee_ids = [p.employee_id for p in pos_objs if p.employee_id is not None]
        
        # Fetch multiple parents if any
        try:
            parents_res = await db.execute(
                text("""
                    SELECT pr.position_id, p.name
                    FROM position_reporting pr
                    JOIN positions p ON pr.parent_position_id = p.id
                    WHERE pr.position_id IN :pos_ids
                """),
                {"pos_ids": tuple(position_ids)}
            )
            for pos_id, p_name in parents_res.all():
                if pos_id not in parent_names_map:
                    parent_names_map[pos_id] = []
                if p_name not in parent_names_map[pos_id]:
                    parent_names_map[pos_id].append(p_name)
        except Exception as exc:
            print(f"Error fetching multiple parents: {exc}")

        emp_q = select(Employee).where(
            or_(
                Employee.position_id.in_(position_ids),
                Employee.id.in_(direct_employee_ids)
            )
        )
        emp_res = await db.execute(emp_q)
        employees = {e.id: e for e in emp_res.scalars().all()}
        
        # Resolve ONE employee per position.
        # Priority: Position.employee_id (direct) > Employee.position_id (reverse).
        # This prevents the same employee from appearing under multiple positions
        # when both mapping directions point to different positions.
        pos_to_employee = {}
        
        # First pass: direct mapping (Position.employee_id)
        for p in pos_objs:
            if p.employee_id and p.employee_id in employees:
                pos_to_employee[p.id] = employees[p.employee_id]
        
        # Second pass: reverse mapping (Employee.position_id) - only for positions
        # that have no direct mapping yet
        for e in employees.values():
            if e.position_id and e.position_id not in pos_to_employee:
                pos_to_employee[e.position_id] = e
    else:
        pos_to_employee = {}

    items = []
    for row, project_name, office_name, parent_name, role_name, role_code in rows:
        pos = row
        emp = pos_to_employee.get(pos.id)
        emp_name = emp.name if emp else None
        emp_code = emp.employee_code if emp else None
        
        p_names = parent_names_map.get(pos.id)
        display_parent_name = ", ".join(p_names) if p_names else parent_name

        items.append(
            _position_payload(
                pos,
                project_name=project_name,
                office_name=office_name,
                parent_name=display_parent_name,
                role_name=role_name,
                role_code=role_code,
                employee_name=emp_name,
                employee_code=emp_code,
            )
        )
        # Add hierarchy chain
        items[-1]["hierarchy"] = await _get_position_hierarchy(db, pos.id)
    return build_paginated_response(items, total, page, page_size)

async def _validate_position_refs(db: AsyncSession, payload: PositionCreate, row_id: int | None = None) -> None:
    if payload.project_id:
        project = (await db.execute(select(Project.id).where(Project.id == payload.project_id))).scalar_one_or_none()
        if not project:
            raise HTTPException(status_code=422, detail="Project does not exist")
    if payload.office_id:
        office = (await db.execute(select(Office.id).where(Office.id == payload.office_id))).scalar_one_or_none()
        if not office:
            raise HTTPException(status_code=422, detail="Office does not exist")
    if payload.role_id:
        role = (await db.execute(select(Role).where(Role.id == payload.role_id, Role.is_active == True))).scalar_one_or_none()  # noqa: E712
        if not role:
            raise HTTPException(status_code=422, detail="Role does not exist or is inactive")
        payload.role_name = role.name
    if payload.parent_position_id:
        if payload.parent_position_id == row_id:
            raise HTTPException(status_code=422, detail="Position cannot be its own parent")
        parent = (await db.execute(select(Position.id).where(Position.id == payload.parent_position_id))).scalar_one_or_none()
        if not parent:
            raise HTTPException(status_code=422, detail="Parent position does not exist")


@router.post("/positions", status_code=201)
async def create_position(
    payload: PositionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "create", "users")),
):
    await ensure_organization_structure_schema(db)
    duplicate = (await db.execute(select(Position).where(func.lower(Position.code) == payload.code.lower()))).scalar_one_or_none()
    if duplicate:
        raise HTTPException(status_code=409, detail=f"Position code '{payload.code}' already exists")
    await _validate_position_refs(db, payload)
    row = Position(**payload.model_dump())
    db.add(row)
    await db.flush()
    from app.services.employee_warehouse_sync import sync_position_employee_to_warehouse
    await sync_position_employee_to_warehouse(db, row)
    return {"id": row.id, "message": "Position created"}


@router.put("/positions/{position_id}")
async def update_position(
    position_id: int,
    payload: PositionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "users")),
):
    await ensure_organization_structure_schema(db)
    row = (await db.execute(select(Position).where(Position.id == position_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Position not found")
    duplicate = (await db.execute(select(Position).where(func.lower(Position.code) == payload.code.lower(), Position.id != position_id))).scalar_one_or_none()
    if duplicate:
        raise HTTPException(status_code=409, detail=f"Position code '{payload.code}' already exists")
    await _validate_position_refs(db, payload, position_id)
    for key, value in payload.model_dump().items():
        setattr(row, key, value)
    await db.flush()
    from app.services.employee_warehouse_sync import sync_position_employee_to_warehouse
    await sync_position_employee_to_warehouse(db, row)
    return {"id": row.id, "message": "Position updated"}


@router.delete("/positions/{position_id}")
async def delete_position(
    position_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "delete", "users")),
):
    await ensure_organization_structure_schema(db)
    row = (await db.execute(select(Position).where(Position.id == position_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Position not found")
    in_use = await db.scalar(select(func.count(Employee.id)).where(Employee.position_id == position_id))
    if in_use:
        raise HTTPException(status_code=409, detail=f"Position is linked to {int(in_use)} employee(s)")
    await db.delete(row)
    await db.flush()
    return {"message": "Position deleted"}

async def _get_position_hierarchy(
    db: AsyncSession,
    position_id: int,
) -> list[dict]:
    """Trace parent_position_id chain upward to the top (COO level)."""
    chain = []
    current_id = position_id
    seen = set()
    while current_id and current_id not in seen:
        seen.add(current_id)
        row = (await db.execute(
            select(Position.id, Position.name, Position.code, Position.role_name, Position.level_name, Position.parent_position_id)
            .where(Position.id == current_id)
        )).one_or_none()
        if not row:
            break
        chain.append({
            "id": row.id,
            "name": row.name,
            "code": row.code,
            "role_name": row.role_name,
            "level_name": row.level_name,
        })
        current_id = row.parent_position_id
    return chain


@router.get("/positions/{position_id}/hierarchy")
async def get_position_hierarchy(
    position_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    chain = await _get_position_hierarchy(db, position_id)
    return chain


@router.get("/employees")
async def list_employees(
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    search: Optional[str] = None,
    position_id: Optional[int] = None,
    status: Optional[str] = None,
    gender: Optional[str] = None,
    employee_code: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await ensure_organization_structure_schema(db)
    offset, limit = paginate_params(page, page_size)
    q = (
        select(Employee, User.id, User.username)
        .join(User, User.employee_id == Employee.id, isouter=True)
        .options(selectinload(Employee.positions), selectinload(Employee.position))
    )
    count_q = select(func.count(Employee.id))
    if search:
        like = f"%{search}%"
        condition = or_(Employee.name.ilike(like), Employee.employee_code.ilike(like), Employee.email.ilike(like), Employee.phone.ilike(like))
        q = q.where(condition)
        count_q = count_q.where(condition)
    if employee_code:
        like = f"%{employee_code}%"
        q = q.where(Employee.employee_code.ilike(like))
        count_q = count_q.where(Employee.employee_code.ilike(like))
    if position_id is not None:
        q = q.where(Employee.position_id == position_id)
        count_q = count_q.where(Employee.position_id == position_id)
    if status:
        q = q.where(Employee.status == status)
        count_q = count_q.where(Employee.status == status)
    if gender:
        q = q.where(Employee.gender == gender)
        count_q = count_q.where(Employee.gender == gender)
    total = (await db.execute(count_q)).scalar() or 0
    rows = (await db.execute(q.order_by(Employee.name).offset(offset).limit(limit))).all()
    items = []
    for employee, user_id, username in rows:
        data = EmployeeResponse.model_validate(employee).model_dump()
        primary_pos = employee.positions[0] if employee.positions else employee.position
        data["position_id"] = primary_pos.id if primary_pos else None
        data["position_name"] = primary_pos.name if primary_pos else None
        data["position_code"] = primary_pos.code if primary_pos else None
        data["user_id"] = user_id
        data["username"] = username
        if primary_pos and primary_pos.id:
            data["hierarchy"] = await _get_position_hierarchy(db, primary_pos.id)
        else:
            data["hierarchy"] = []
        items.append(data)
    return build_paginated_response(items, total, page, page_size)

@router.post("/employees", status_code=201)
async def create_employee(
    payload: EmployeeCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "create", "users")),
):
    await ensure_organization_structure_schema(db)
    duplicate = (await db.execute(select(Employee).where(func.lower(Employee.employee_code) == payload.employee_code.lower()))).scalar_one_or_none()
    if duplicate:
        raise HTTPException(status_code=409, detail=f"Employee code '{payload.employee_code}' already exists")
    if payload.position_id:
        position = (await db.execute(select(Position.id).where(Position.id == payload.position_id))).scalar_one_or_none()
        if not position:
            raise HTTPException(status_code=422, detail="Position does not exist")
    row = Employee(**payload.model_dump())
    db.add(row)
    await db.flush()
    if payload.position_id:
        pos = (await db.execute(select(Position).where(Position.id == payload.position_id))).scalar_one_or_none()
        if pos:
            pos.employee_id = row.id
            await db.flush()
    return {"id": row.id, "message": "Employee created"}


@router.put("/employees/{employee_id}")
async def update_employee(
    employee_id: int,
    payload: EmployeeCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "users")),
):
    await ensure_organization_structure_schema(db)
    row = (await db.execute(select(Employee).where(Employee.id == employee_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Employee not found")
    duplicate = (await db.execute(select(Employee).where(func.lower(Employee.employee_code) == payload.employee_code.lower(), Employee.id != employee_id))).scalar_one_or_none()
    if duplicate:
        raise HTTPException(status_code=409, detail=f"Employee code '{payload.employee_code}' already exists")
    if payload.position_id:
        position = (await db.execute(select(Position.id).where(Position.id == payload.position_id))).scalar_one_or_none()
        if not position:
            raise HTTPException(status_code=422, detail="Position does not exist")
    for key, value in payload.model_dump().items():
        setattr(row, key, value)
    await db.flush()
    if payload.position_id:
        pos = (await db.execute(select(Position).where(Position.id == payload.position_id))).scalar_one_or_none()
        if pos:
            pos.employee_id = row.id
            await db.flush()
    return {"id": row.id, "message": "Employee updated"}


@router.delete("/employees/{employee_id}")
async def delete_employee(
    employee_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "delete", "users")),
):
    await ensure_organization_structure_schema(db)
    row = (await db.execute(select(Employee).where(Employee.id == employee_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Employee not found")
    await db.delete(row)
    await db.flush()
    return {"message": "Employee deleted"}


@router.post("/employees/{employee_id}/create-user", status_code=201)
async def create_user_from_employee(
    employee_id: int,
    payload: dict | None = Body(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "create", "users")),
):
    await ensure_organization_structure_schema(db)
    payload = payload or {}
    employee = (await db.execute(select(Employee).where(Employee.id == employee_id))).scalar_one_or_none()
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")
    existing_link = (await db.execute(select(User).where(User.employee_id == employee.id))).scalar_one_or_none()
    if existing_link:
        raise HTTPException(status_code=409, detail=f"Employee already linked to user '{existing_link.username}'")

    username = str(payload.get("username") or employee.employee_code or "").strip()
    username = re.sub(r"[^A-Za-z0-9_]+", "_", username).strip("_").lower()
    if len(username) < 3:
        username = f"emp_{employee.id}"
    email = str(payload.get("email") or employee.email or f"{username}@bavya-scm.local").strip().lower()
    password = str(payload.get("password") or "").strip()
    if len(password) < 8:
        raise HTTPException(status_code=422, detail="Password is required and must be at least 8 characters")

    duplicate = (await db.execute(select(User).where(or_(func.lower(User.username) == username.lower(), func.lower(User.email) == email.lower())))).scalar_one_or_none()
    if duplicate:
        raise HTTPException(status_code=409, detail="Username or email already exists")

    from app.services.auth_service import hash_password

    position = None
    if employee.position_id:
        position = (await db.execute(select(Position).where(Position.id == employee.position_id))).scalar_one_or_none()
    name_parts = (employee.name or employee.employee_code).split()
    first_name = str(payload.get("first_name") or (name_parts[0] if name_parts else employee.employee_code)).strip()[:100]
    last_name = str(payload.get("last_name") or (" ".join(name_parts[1:]) if len(name_parts) > 1 else "")).strip()[:100] or None
    user = User(
        organization_id=current_user.organization_id,
        employee_id=employee.id,
        employee_code=employee.employee_code,
        username=username,
        email=email,
        password_hash=hash_password(password),
        first_name=first_name,
        last_name=last_name,
        phone=employee.phone,
        user_type=str(payload.get("user_type") or "staff"),
        department=position.department if position else None,
        designation=position.name if position else None,
        is_active=True,
    )
    db.add(user)
    await db.flush()

    # Assign roles from positions mapped to the employee
    pos_result = await db.execute(
        select(Position)
        .options(selectinload(Position.role))
        .where((Position.employee_id == employee.id) | (Position.id == employee.position_id))
    )
    role_ids = set()
    for pos in pos_result.scalars().all():
        if pos.role_id and pos.role and pos.role.is_active:
            role_ids.add(pos.role_id)

    for r_id in role_ids:
        db.add(UserRole(user_id=user.id, role_id=r_id))
    
    await db.flush()

    from app.utils.position_role_sync import sync_user_position_role
    await sync_user_position_role(db, user)

    return {"id": user.id, "username": user.username, "message": "User created from employee"}

def _external_rows(payload) -> list[dict]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        for key in ("employees", "items", "data", "results"):
            rows = payload.get(key)
            if isinstance(rows, list):
                return [row for row in rows if isinstance(row, dict)]
        if payload.get("employee_code") or payload.get("code"):
            return [payload]
    return []


def _external_next_url(payload, current_url: str) -> str | None:
    if not isinstance(payload, dict):
        return None
    next_url = payload.get("next")
    if not next_url:
        return None
    return urljoin(current_url, str(next_url))


async def _robust_get(
    client: httpx.AsyncClient,
    url: str,
    headers: dict,
    label: str = "request",
    page: int = 1,
    sync_logs: dict | None = None,
    max_retries: int = 5,
    initial_backoff: float = 0.5
):
    import time
    import urllib.parse
    
    # Ensure trailing slash on URL path to avoid 301 redirect
    parsed = urllib.parse.urlparse(url)
    if parsed.path and not parsed.path.endswith("/"):
        new_path = parsed.path + "/"
        parsed = parsed._replace(path=new_path)
        url = urllib.parse.urlunparse(parsed)
        
    backoff = initial_backoff
    for attempt in range(max_retries):
        t0 = time.time()
        status_code = None
        try:
            response = await client.get(url, headers=headers)
            t1 = time.time()
            status_code = response.status_code
            response.raise_for_status()
            
            if sync_logs is not None:
                try:
                    payload = response.json()
                    records = len(_external_rows(payload))
                except Exception:
                    records = 0
                sync_logs["page_request_log"].append({
                    "label": label,
                    "page": page,
                    "url": url,
                    "status_code": status_code,
                    "retries": attempt,
                    "response_time": t1 - t0,
                    "records": records
                })
                
            return response
        except Exception as exc:
            duration = time.time() - t0
            if attempt == max_retries - 1:
                if sync_logs is not None:
                    sync_logs["page_request_log"].append({
                        "label": label,
                        "page": page,
                        "url": url,
                        "status_code": status_code or "ERROR",
                        "retries": attempt,
                        "response_time": duration,
                        "records": 0,
                        "error": str(exc)
                    })
                raise exc
            print(f"HTTP request to {url} failed: {exc}. Retrying in {backoff}s... (Attempt {attempt+1}/{max_retries})")
            await asyncio.sleep(backoff)
            backoff *= 2


async def _fetch_external_employee_rows(max_pages: int) -> tuple[list[dict], int | None, int]:
    if not settings.HR_EMPLOYEE_API_URL:
        raise HTTPException(status_code=422, detail="Set HR_EMPLOYEE_API_URL in backend/.env")
    if not settings.HR_API_KEY:
        raise HTTPException(status_code=422, detail="Set HR_API_KEY in backend/.env")

    url = httpx.URL(settings.HR_EMPLOYEE_API_URL)
    if "page_size" not in url.params:
        url = url.copy_add_param("page_size", "500")

    rows: list[dict] = []
    api_total = None
    pages_fetched = 0
    seen_urls: set[str] = set()
    headers = {"X-Api-Key": settings.HR_API_KEY, "Accept": "application/json"}

    try:
        async with httpx.AsyncClient(timeout=settings.HR_API_TIMEOUT, follow_redirects=True) as client:
            next_url = str(url)
            while next_url and pages_fetched < max_pages:
                if next_url in seen_urls:
                    break
                seen_urls.add(next_url)
                try:
                    response = await _robust_get(client, next_url, headers)
                    payload = response.json()
                    pages_fetched += 1
                    if isinstance(payload, dict) and isinstance(payload.get("count"), int):
                        api_total = int(payload["count"])
                    rows.extend(_external_rows(payload))
                    next_url = _external_next_url(payload, str(response.url))
                    await asyncio.sleep(0.05)
                except Exception as exc:
                    raise RuntimeError(f"Failed to fetch employee API on page {pages_fetched + 1}: {exc}") from exc
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:500] if exc.response is not None else str(exc)
        raise HTTPException(status_code=502, detail=f"Employee API returned an error: {detail}")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Unable to fetch employee API: {exc}")

    return rows, api_total, pages_fetched


def _external_text(row: dict, *keys: str, max_len: int = 255) -> str | None:
    for key in keys:
        value = row
        for part in key.split("."):
            if not isinstance(value, dict):
                value = None
                break
            value = value.get(part)
        if value is not None and not isinstance(value, (dict, list)) and str(value).strip():
            return str(value).strip()[:max_len]
    return None


def _external_code(value: str | None, max_len: int = 100) -> str | None:
    if not value:
        return None
    code = re.sub(r"[^A-Za-z0-9]+", "-", value.strip()).strip("-").upper()
    return code[:max_len] or None


def _external_pattern_text(row: dict, keys: tuple[str, ...], pattern, max_len: int, upper: bool = False) -> str | None:
    value = _external_text(row, *keys, max_len=max_len)
    if not value:
        return None
    value = value.upper() if upper else value
    return value if pattern.match(value) else None


def _external_date(row: dict, *keys: str):
    raw = _external_text(row, *keys, max_len=30)
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).date()
    except ValueError:
        try:
            return datetime.strptime(raw[:10], "%Y-%m-%d").date()
        except ValueError:
            return None


async def _employee_unique_value(db: AsyncSession, column, value, employee_id: int | None):
    if not value:
        return None
    q = select(Employee.id).where(column == value)
    if employee_id:
        q = q.where(Employee.id != employee_id)
    exists = (await db.execute(q)).scalar_one_or_none()
    return None if exists else value


async def _project_id_from_external(db: AsyncSession, row: dict, stats: dict[str, int], organization_id: int | None, cache: dict = None) -> int | None:
    project_name = _external_text(row, "project.name", "project_name", "projectName", "project", max_len=255)
    project_code = _external_text(row, "project.code", "project_code", "projectCode", max_len=50) or _external_code(project_name, 50)
    if not project_code:
        return None

    project_id = row.get("project_id")
    if not project_id and isinstance(row.get("project"), dict):
        project_id = row.get("project").get("id") or row.get("project").get("project_id")
    try:
        project_id = int(project_id) if project_id is not None else None
    except (TypeError, ValueError):
        project_id = None
    
    project = None
    if cache is not None:
        if project_id and "projects_by_id" in cache:
            project = cache["projects_by_id"].get(project_id)
        if not project:
            project = cache["projects_by_code"].get(project_code.lower())
        if not project and project_name:
            project = cache["projects_by_name"].get(project_name.lower())
    else:
        if project_id:
            project = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
        if not project:
            project = (await db.execute(select(Project).where(func.lower(Project.code) == project_code.lower()))).scalar_one_or_none()
        if not project and project_name:
            project = (await db.execute(select(Project).where(func.lower(Project.name) == project_name.lower()))).scalar_one_or_none()

    if not project:
        if not organization_id:
            if cache is not None and "org_id" in cache:
                organization_id = cache["org_id"]
            else:
                organization_id = (await db.execute(select(Organization.id).order_by(Organization.id.asc()).limit(1))).scalar_one_or_none()
                if cache is not None and organization_id:
                    cache["org_id"] = organization_id
        if not organization_id:
            raise HTTPException(status_code=422, detail="No organization exists for imported HR projects")
        project = Project(organization_id=organization_id, code=project_code, name=project_name or project_code, status="active")
        if project_id is not None:
            project.id = project_id
        db.add(project)
        await db.flush()
        stats["projects_created"] += 1
        
        if cache is not None:
            if "projects_by_id" not in cache:
                cache["projects_by_id"] = {}
            if project.id:
                cache["projects_by_id"][project.id] = project
            cache["projects_by_code"][project_code.lower()] = project
            if project_name:
                cache["projects_by_name"][project_name.lower()] = project
    else:
        # Avoid duplicate project records if codes differ (e.g. slugified vs explicit) but project name is identical
        explicit_code_provided = _external_text(row, "project.code", "project_code", "projectCode", max_len=50)
        if explicit_code_provided and project.code != explicit_code_provided:
            project.code = explicit_code_provided
            await db.flush()
            if cache is not None:
                cache["projects_by_code"][explicit_code_provided.lower()] = project
        if project_name and project.name != project_name:
            project.name = project_name
            
    return project.id


async def _office_id_from_external(db: AsyncSession, row: dict, stats: dict[str, int], cache: dict = None) -> int | None:
    office_name = _external_text(row, "office.name", "office_name", "officeName", "office", "branch", "location", max_len=255)
    if not office_name:
        return None

    office_id = row.get("office_id")
    if not office_id and isinstance(row.get("office"), dict):
        office_id = row.get("office").get("id") or row.get("office").get("office_id") or row.get("office").get("officeId")
        
    try:
        office_id = int(office_id) if office_id is not None else None
    except (TypeError, ValueError):
        office_id = None

    office = None
    if cache is not None:
        if office_id:
            office = cache["offices_by_id"].get(office_id)
        if not office:
            office = cache["offices_by_name"].get(office_name.lower().strip())
    else:
        if office_id:
            office = (await db.execute(select(Office).where(Office.id == office_id))).scalar_one_or_none()
        if not office:
            office = (await db.execute(select(Office).where(func.lower(Office.name) == office_name.lower()))).scalar_one_or_none()

    if cache is not None and office and office.id:
        if "synced_office_ids" not in cache:
            cache["synced_office_ids"] = set()
        if office.id in cache["synced_office_ids"]:
            return office.id

    level = _external_text(row, "office.level", "office_level", "officeLevel", "level", max_len=50)
    country = _external_text(row, "office.geo_location.country", "office.geoLocation.country", "office.geo_location", "country", max_len=100)
    state = _external_text(row, "office.geo_location.state", "office.geoLocation.state", "state", max_len=100)
    district = _external_text(row, "office.geo_location.district", "office.geoLocation.district", "district", max_len=100)
    mandal = _external_text(row, "office.geo_location.mandal", "office.geoLocation.mandal", "mandal", max_len=100)
    cluster = _external_text(row, "office.geo_location.cluster", "office.geoLocation.cluster", "cluster", max_len=100)
    cluster_type = _external_text(row, "office.geo_location.cluster_type", "office.geo_location.clusterType", "office.geoLocation.clusterType", "cluster_type", "clusterType", max_len=50)
    specific_location = _external_text(row, "office.geo_location.specific_location", "office.geo_location.specificLocation", "office.geoLocation.specificLocation", "specific_location", "specificLocation", max_len=255)
    address = _external_text(row, "office.geo_location.address", "office.geoLocation.address", "address", max_len=5000)

    if not office:
        office = Office(
            name=office_name,
            level=level,
            country=country,
            state=state,
            district=district,
            mandal=mandal,
            cluster=cluster,
            cluster_type=cluster_type,
            specific_location=specific_location,
            address=address,
        )
        if office_id is not None:
            office.id = office_id
        db.add(office)
        await db.flush()
        stats["offices_created"] += 1
        
        if cache is not None:
            if office.id:
                cache["offices_by_id"][office.id] = office
            cache["offices_by_name"][office_name.lower().strip()] = office
    else:
        # Update empty fields on existing offices
        changed = False
        if level and office.level != level:
            office.level = level
            changed = True
        if country and office.country != country:
            office.country = country
            changed = True
        if state and office.state != state:
            office.state = state
            changed = True
        if district and office.district != district:
            office.district = district
            changed = True
        if mandal and office.mandal != mandal:
            office.mandal = mandal
            changed = True
        if cluster and office.cluster != cluster:
            office.cluster = cluster
            changed = True
        if cluster_type and office.cluster_type != cluster_type:
            office.cluster_type = cluster_type
            changed = True
        if specific_location and office.specific_location != specific_location:
            office.specific_location = specific_location
            changed = True
        if address and office.address != address:
            office.address = address
            changed = True
        if changed:
            await db.flush()
            
    from app.services.office_warehouse_sync import sync_office_to_warehouse
    await sync_office_to_warehouse(db, office)
    if cache is not None and office.id:
        if "synced_office_ids" not in cache:
            cache["synced_office_ids"] = set()
        cache["synced_office_ids"].add(office.id)
    return office.id


async def _role_id_from_external(db: AsyncSession, row: dict, cache: dict = None) -> int | None:
    role_code = _external_text(row, "position.role_code", "role_code", "roleCode", max_len=50)
    role_name = _external_text(row, "position.role_name", "role_name", "roleName", "role", max_len=100)
    if cache is not None:
        if role_code:
            role = cache["roles_by_code"].get(role_code.lower())
            if role:
                return role.id
        if role_name:
            role = cache["roles_by_name"].get(role_name.lower())
            if role:
                return role.id
        return None

    if role_code:
        role = (await db.execute(select(Role).where(func.lower(Role.code) == role_code.lower(), Role.is_active == True))).scalar_one_or_none()  # noqa: E712
        if role:
            return role.id
    if role_name:
        role = (await db.execute(select(Role).where(func.lower(Role.name) == role_name.lower(), Role.is_active == True))).scalar_one_or_none()  # noqa: E712
        if role:
            return role.id
    return None


def normalize_position_key(text_val: str) -> str:
    if not text_val:
        return ""
    import re
    # Convert to uppercase
    val = text_val.upper()
    # Replace symbols
    val = val.replace("@", "-").replace("_", "-").replace(" ", "-")
    # Split into words
    words = [w.strip() for w in val.split("-") if w.strip()]
    
    # Normalize roles
    has_district = "DISTRICT" in words
    has_manager = "MANAGER" in words
    has_regional = "REGIONAL" in words
    has_office = "OFFICE" in words
    has_executive = "EXECUTIVE" in words
    has_lab = "LAB" in words
    has_technician = "TECHNICIAN" in words
    has_store = "STORE" in words
    has_keeper = "KEEPER" in words
    has_state = "STATE" in words
    has_project = "PROJECT" in words
    has_head = "HEAD" in words
    
    # Reconstruct words list with normalized roles
    new_words = []
    # Check roles first
    if (has_district and has_manager) or "DM" in words:
        new_words.append("DM")
    elif (has_regional and has_manager) or "RM" in words:
        new_words.append("RM")
    elif (has_office and has_executive) or "OE" in words:
        new_words.append("OE")
    elif (has_lab and has_technician) or "LT" in words:
        new_words.append("LT")
    elif (has_store and has_keeper) or "STOREKEEPER" in words or "SK" in words:
        new_words.append("SK")
    elif (has_state and has_project and has_head) or "SPH" in words:
        new_words.append("SPH")
    elif "COO" in words or ("CHIEF" in words and "OPERATING" in words and "OFFICER" in words):
        new_words.append("COO")
    elif "CO" in words:
        new_words.append("CO")
    
    # Filter words and add location parts
    filler = {
        "AP", "104", "MMU", "MMUS", "SERVICES", "MANAGER", "DISTRICT", "REGIONAL",
        "OFFICE", "EXECUTIVE", "LAB", "TECHNICIAN", "STORE", "KEEPER", "STOREKEEPER",
        "STATE", "PROJECT", "HEAD", "DM", "RM", "OE", "LT", "SK", "SPH", "CO", "COO"
    }
    
    # Spell correction map
    spellings = {
        "VIJAYWADA": "VIJAYAWADA",
        "CHITTO0R": "CHITTOOR",
        "TIRUPATHI": "TIRUPATI",
        "KANDUKUR": "KANDUKURU",
        "MARKAPUR": "MARKAPURAM",
    }
    
    for w in words:
        if w not in filler:
            corrected = spellings.get(w, w)
            new_words.append(corrected)
            
    return "-".join(new_words)


async def _resolve_parent_position_ids(db: AsyncSession, row: dict, cache: dict = None) -> list[int]:
    pos_data = row.get("position")
    if not pos_data:
        return []
    reporting_to = pos_data.get("reporting_to_details") or pos_data.get("reporting_to")
    if not reporting_to or not isinstance(reporting_to, list):
        return []
    
    parent_ids = []
    for parent_item in reporting_to:
        if isinstance(parent_item, (int, float)):
            parent_ids.append(int(parent_item))
            continue
            
        if not isinstance(parent_item, dict):
            continue
            
        parent_name = parent_item.get("position_name") or parent_item.get("name")
        if not parent_name:
            continue
            
        parent_code = parent_item.get("code") or parent_item.get("position_code") or _external_code(parent_name, 100)
        if not parent_code:
            continue
            
        parent_id = None
        if cache is not None:
            # 1. Try exact code matching
            if parent_code.lower() in cache["code_to_id"]:
                parent_id = cache["code_to_id"][parent_code.lower()]
            
            # 2 & 3. Normalized matching (code or name)
            if parent_id is None:
                norm_parent_code = normalize_position_key(parent_code)
                if norm_parent_code and norm_parent_code in cache["norm_code_to_id"]:
                    parent_id = cache["norm_code_to_id"][norm_parent_code]
            
            if parent_id is None:
                norm_parent_name = normalize_position_key(parent_name)
                if norm_parent_name and norm_parent_name in cache["norm_name_to_id"]:
                    parent_id = cache["norm_name_to_id"][norm_parent_name]
        else:
            # 1. Try exact code matching
            parent_pos = (await db.execute(select(Position).where(func.lower(Position.code) == parent_code.lower()))).scalar_one_or_none()
            if parent_pos:
                parent_id = parent_pos.id
            
            # 2 & 3. Normalized matching (code or name)
            if not parent_id:
                norm_parent_code = normalize_position_key(parent_code) if parent_code else None
                norm_parent_name = normalize_position_key(parent_name) if parent_name else None
                
                # Query all existing positions to perform in-memory key normalization mapping
                res = await db.execute(select(Position.id, Position.code, Position.name))
                for pid, pcode, pname in res.all():
                    if norm_parent_code and normalize_position_key(pcode) == norm_parent_code:
                        parent_id = pid
                        break
                    if norm_parent_name and normalize_position_key(pname) == norm_parent_name:
                        parent_id = pid
                        break
                        
        if parent_id and parent_id not in parent_ids:
            parent_ids.append(parent_id)
            
    return parent_ids


async def _resolve_parent_position_id(db: AsyncSession, row: dict, stats: dict[str, int], cache: dict = None) -> int | None:
    pos_data = row.get("position")
    if not pos_data:
        return None
    reporting_to = pos_data.get("reporting_to")
    if not reporting_to or not isinstance(reporting_to, list):
        return None
    
    parent_item = reporting_to[0]
    if not isinstance(parent_item, dict):
        return None
        
    parent_name = parent_item.get("position_name") or parent_item.get("name")
    if not parent_name:
        return None
        
    parent_code = parent_item.get("code") or parent_item.get("position_code") or _external_code(parent_name, 100)
    if not parent_code:
        return None
        
    parent_id = None
    if cache is not None:
        # 1. Try exact code matching
        if parent_code.lower() in cache["code_to_id"]:
            parent_id = cache["code_to_id"][parent_code.lower()]
        
        # 2 & 3. Normalized matching (code or name)
        if parent_id is None:
            norm_parent_code = normalize_position_key(parent_code)
            if norm_parent_code and norm_parent_code in cache["norm_code_to_id"]:
                parent_id = cache["norm_code_to_id"][norm_parent_code]
        
        if parent_id is None:
            norm_parent_name = normalize_position_key(parent_name)
            if norm_parent_name and norm_parent_name in cache["norm_name_to_id"]:
                parent_id = cache["norm_name_to_id"][norm_parent_name]
    else:
        # 1. Try exact code matching
        parent_pos = (await db.execute(select(Position).where(func.lower(Position.code) == parent_code.lower()))).scalar_one_or_none()
        if parent_pos:
            parent_id = parent_pos.id
        
        # 2 & 3. Normalized matching (code or name)
        if not parent_id:
            norm_parent_code = normalize_position_key(parent_code) if parent_code else None
            norm_parent_name = normalize_position_key(parent_name) if parent_name else None
            
            # Query all existing positions to perform in-memory key normalization mapping
            res = await db.execute(select(Position.id, Position.code, Position.name))
            for pid, pcode, pname in res.all():
                if norm_parent_code and normalize_position_key(pcode) == norm_parent_code:
                    parent_id = pid
                    break
                if norm_parent_name and normalize_position_key(pname) == norm_parent_name:
                    parent_id = pid
                    break

    # If no parent is found, log a warning and return None (leaving parent_position_id as NULL)
    if not parent_id:
        child_code = _external_text(row, "position.code", "position_code", "positionCode", "code", max_len=100) or "N/A"
        print(f"""
WARNING: Parent position not found.

Child Position:
{child_code}

Expected Parent Code:
{parent_code or 'N/A'}

Expected Parent Name:
{parent_name or 'N/A'}

No synthetic records were created.
parent_position_id left NULL.
""")
        return None

    return parent_id


async def _position_id_from_external(db: AsyncSession, row: dict, stats: dict[str, int], organization_id: int | None, cache: dict = None):
    position_id = row.get("position_id")
    if not position_id and isinstance(row.get("position"), dict):
        position_id = row.get("position").get("id") or row.get("position").get("position_id")
    if not position_id and "employee_code" not in row and "employee" not in row:
        position_id = row.get("id")
    try:
        position_id = int(position_id) if position_id is not None else None
    except (TypeError, ValueError):
        position_id = None

    position_name = _external_text(
        row,
        "position.name", "position_name", "positionName", "name", "position", "designation", "designation_name", "designationName",
        "role_name", "roleName", "role", max_len=255,
    )
    position_code = _external_text(row, "position.code", "position_code", "positionCode", "designation_code", "designationCode", "role_code", "roleCode", "code", max_len=100)
    position_code = position_code or _external_code(position_name, 100)
    
    if not position_code or not position_name:
        if position_id:
            if cache is not None:
                return position_id if position_id in cache["positions_by_id"] else None
            exists = (await db.execute(select(Position.id).where(Position.id == position_id))).scalar_one_or_none()
            return exists
        return None

    position = None
    if cache is not None:
        if position_id:
            position = cache["positions_by_id"].get(position_id)
        if not position and position_code:
            position = cache["positions_by_code"].get(position_code.lower())
        if not position and position_code:
            norm_code = normalize_position_key(position_code)
            if norm_code and norm_code in cache.get("norm_code_to_id", {}):
                pid = cache["norm_code_to_id"][norm_code]
                position = cache["positions_by_id"].get(pid)
        if not position and position_name:
            norm_name = normalize_position_key(position_name)
            if norm_name and norm_name in cache.get("norm_name_to_id", {}):
                pid = cache["norm_name_to_id"][norm_name]
                position = cache["positions_by_id"].get(pid)
    else:
        if position_id:
            position = (await db.execute(select(Position).where(Position.id == position_id))).scalar_one_or_none()
        if not position and position_code:
            position = (await db.execute(select(Position).where(func.lower(Position.code) == position_code.lower()))).scalar_one_or_none()

    project_id = await _project_id_from_external(db, row, stats, organization_id, cache=cache)
    office_id = await _office_id_from_external(db, row, stats, cache=cache)
    role_id = await _role_id_from_external(db, row, cache=cache)
    parent_position_id = await _resolve_parent_position_id(db, row, stats, cache=cache)
    
    if not position:
        position = Position(
            code=position_code,
            name=position_name,
            role_name=_external_text(row, "position.role_name", "role_name", "roleName", "role", max_len=100),
            role_id=role_id,
            level_name=_external_text(row, "position.level_name", "level_name", "levelName", "position_level", "positionLevel", max_len=50),
            department=_external_text(row, "position.department", "department", "department_name", "departmentName", max_len=100),
            section=_external_text(row, "position.section", "section", "section_name", "sectionName", max_len=100),
            project_id=project_id,
            office_id=office_id,
            parent_position_id=parent_position_id,
        )
        if position_id is not None:
            position.id = position_id
        db.add(position)
        await db.flush()
        stats["positions_created"] += 1
        
        # Add to cache
        if cache is not None:
            cache["positions_by_id"][position.id] = position
            if position.code:
                cache["positions_by_code"][position.code.lower()] = position
                cache["code_to_id"][position.code.lower()] = position.id
                norm_key_code = normalize_position_key(position_code)
                if norm_key_code:
                    cache["norm_code_to_id"][norm_key_code] = position.id
            if position_name:
                norm_key_name = normalize_position_key(position_name)
                if norm_key_name:
                    cache["norm_name_to_id"][norm_key_name] = position.id
    else:
        position.name = position_name or position.name
        position.role_name = _external_text(row, "position.role_name", "role_name", "roleName", "role", max_len=100) or position.role_name
        position.role_id = role_id or position.role_id
        position.level_name = _external_text(row, "position.level_name", "level_name", "levelName", "position_level", "positionLevel", max_len=50) or position.level_name
        position.department = _external_text(row, "position.department", "department", "department_name", "departmentName", max_len=100) or position.department
        position.section = _external_text(row, "position.section", "section", "section_name", "sectionName") or position.section
        position.project_id = project_id or position.project_id
        position.office_id = office_id or position.office_id
        position.parent_position_id = parent_position_id or position.parent_position_id
        
        # Update cache
        if cache is not None:
            cache["positions_by_id"][position.id] = position
            if position.code:
                cache["positions_by_code"][position.code.lower()] = position
                cache["code_to_id"][position.code.lower()] = position.id
                norm_key_code = normalize_position_key(position.code)
                if norm_key_code:
                    cache["norm_code_to_id"][norm_key_code] = position.id
            if position.name:
                norm_key_name = normalize_position_key(position.name)
                if norm_key_name:
                    cache["norm_name_to_id"][norm_key_name] = position.id
            norm_key_code = normalize_position_key(position_code)
            if norm_key_code:
                cache["norm_code_to_id"][norm_key_code] = position.id
            norm_key_name = normalize_position_key(position_name)
            if norm_key_name:
                cache["norm_name_to_id"][norm_key_name] = position.id


async def _upsert_external_employee(db: AsyncSession, row: dict, stats: dict[str, int], organization_id: int | None = None, cache: dict = None) -> tuple[bool, bool]:
    employee_code = _external_text(row, "employee.employee_code", "employee_code", "employeeCode", "code", "emp_code", "empCode", max_len=50)
    if not employee_code:
        return False, False
        
    employee = None
    if cache is not None:
        employee = cache["employees_by_code"].get(employee_code.lower())
    else:
        employee = (
            await db.execute(select(Employee).where(Employee.employee_code == employee_code))
        ).scalar_one_or_none()
        
    created = employee is None
    if employee is None:
        ext_id = None
        emp_dict = row.get("employee")
        if emp_dict and isinstance(emp_dict, dict):
            ext_id = emp_dict.get("id")
        if not ext_id:
            ext_id = row.get("id")
        try:
            ext_id = int(ext_id) if ext_id is not None else None
        except (TypeError, ValueError):
            ext_id = None

        employee = Employee(employee_code=employee_code, name="")
        if ext_id is not None:
            employee.id = ext_id
        db.add(employee)
        await db.flush()
        
        if cache is not None:
            cache["employees_by_code"][employee_code.lower()] = employee
            cache["employees_by_id"][employee.id] = employee

    name = _external_text(row, "employee.name", "name", "employee_name", "employeeName", "full_name", "fullName", max_len=255)
    first_name = _external_text(row, "employee.first_name", "first_name", "firstName", max_len=100)
    last_name = _external_text(row, "employee.last_name", "last_name", "lastName", max_len=100)
    if not name and (first_name or last_name):
        name = f"{first_name or ''} {last_name or ''}".strip()

    employee.name = name or employee.name or employee_code
    employee.photo = _external_text(row, "employee.photo", "photo", "photo_url", "photoUrl", "avatar", max_len=255)
    employee.status = _external_text(row, "employee.status", "status", max_len=20) or employee.status or "Active"
    employee.dob = _external_date(row, "employee.dob", "dob", "date_of_birth", "dateOfBirth") or employee.dob
    employee.gender = _external_text(row, "employee.gender", "gender", max_len=20)
    phone = _external_pattern_text(row, ("employee.phone", "phone", "mobile", "mobile_number", "mobileNumber"), PHONE_PATTERN, 15)
    email = _external_pattern_text(row, ("employee.email", "email"), EMAIL_PATTERN, 100)
    pan_number = _external_pattern_text(row, ("employee.pan_number", "pan_number", "panNumber", "pan"), PAN_PATTERN, 10, upper=True)
    aadhaar_number = _external_pattern_text(
        row,
        ("employee.aadhaar_number", "aadhaar_number", "aadhaarNumber", "aadhaar"),
        re.compile(r"^[0-9]{12}$"),
        12,
    )
    employee.phone = phone or employee.phone
    employee.email = email or employee.email
    employee.pan_number = pan_number or employee.pan_number
    employee.aadhaar_number = aadhaar_number or employee.aadhaar_number
    pos_id = await _position_id_from_external(db, row, stats, organization_id, cache=cache)
    employee.position_id = pos_id or employee.position_id
    if pos_id and employee.id:
        pos = None
        if cache is not None:
            pos = cache["positions_by_id"].get(pos_id)
        else:
            pos = (await db.execute(select(Position).where(Position.id == pos_id))).scalar_one_or_none()
        if pos:
            try:
                async with db.begin_nested():
                    pos.employee_id = employee.id
                    await db.flush()
            except Exception as exc:
                print(f"WARN: Could not set employee_id {employee.id} on position {pos_id}: {exc}")
            if cache is not None:
                if "synced_pos_warehouse" not in cache:
                    cache["synced_pos_warehouse"] = set()
                if pos.id not in cache["synced_pos_warehouse"]:
                    from app.services.employee_warehouse_sync import sync_position_employee_to_warehouse
                    await sync_position_employee_to_warehouse(db, pos)
                    cache["synced_pos_warehouse"].add(pos.id)
            else:
                from app.services.employee_warehouse_sync import sync_position_employee_to_warehouse
                await sync_position_employee_to_warehouse(db, pos)
    return True, created


async def _link_users_to_employees(db: AsyncSession) -> int:
    await db.execute(text("""
        UPDATE users u
        JOIN employees e
          ON e.employee_code COLLATE utf8mb4_unicode_ci = u.employee_code COLLATE utf8mb4_unicode_ci
        SET u.employee_id = e.id
        WHERE u.employee_code IS NOT NULL
          AND u.employee_code <> ''
    """))
    linked = (await db.execute(text("""
        SELECT COUNT(*)
        FROM users
        WHERE employee_code IS NOT NULL
          AND employee_code <> ''
          AND employee_id IS NOT NULL
    """))).scalar() or 0
    return int(linked)


async def _apply_position_roles_to_linked_users(db: AsyncSession) -> int:
    from sqlalchemy import or_
    rows = (await db.execute(
        select(User.id, Position.role_id)
        .join(Employee, User.employee_id == Employee.id)
        .join(Position, or_(Employee.position_id == Position.id, Position.employee_id == Employee.id))
        .where(Position.role_id.is_not(None))
    )).all()
    applied = 0
    for user_id, role_id in rows:
        exists = (await db.execute(
            select(UserRole.id).where(UserRole.user_id == user_id, UserRole.role_id == role_id)
        )).scalar_one_or_none()
        if not exists:
            db.add(UserRole(user_id=user_id, role_id=role_id))
            applied += 1
        user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
        if user and not user.active_role_id:
            user.active_role_id = role_id
    await db.flush()
    return applied


# ── Background sync task tracker ────────────────────────────────────────
# In-memory dict of task_id -> sync status dict.
# Used by the sync-api endpoint to run long syncs without blocking HTTP.
_sync_tasks: dict[str, dict] = {}
_sync_locks: dict[int, asyncio.Lock] = {}


def _prune_old_sync_tasks(max_age_seconds: int = 3600):
    """Remove completed/failed sync tasks older than max_age_seconds."""
    now = datetime.now(timezone.utc)
    expired = [
        tid for tid, t in _sync_tasks.items()
        if t.get("status") in ("completed", "failed")
        and t.get("completed_at")
        and (now - datetime.fromisoformat(t["completed_at"])).total_seconds() > max_age_seconds
    ]
    for tid in expired:
        del _sync_tasks[tid]  # organization_id -> lock


def _get_org_lock(org_id: int) -> asyncio.Lock:
    if org_id not in _sync_locks:
        _sync_locks[org_id] = asyncio.Lock()
    return _sync_locks[org_id]


async def _run_sync_background(task_id: str, max_pages: int, organization_id: int | None):
    """Run the full employee/position sync in a background asyncio task.
    Creates its own DB session so the HTTP response can return immediately.
    """
    from app.database import AsyncSessionLocal

    task = _sync_tasks.get(task_id)
    if task is None:
        return
    task["status"] = "running"
    task["started_at"] = datetime.now(timezone.utc).isoformat()

    async with AsyncSessionLocal() as db:
        try:
            await ensure_organization_structure_schema(db)
            result = await _execute_sync(db, max_pages, organization_id, task)
            task["result"] = result
            task["status"] = "completed"
            task["completed_at"] = datetime.now(timezone.utc).isoformat()
            await db.commit()
        except Exception as exc:
            task["status"] = "failed"
            task["error"] = str(exc)
            task["completed_at"] = datetime.now(timezone.utc).isoformat()
            try:
                await db.rollback()
            except Exception:
                pass
            print(f"Background sync {task_id} failed: {exc}")


def _build_page_url(base_url: str, page: int) -> str:
    import urllib.parse
    if "?" in base_url:
        parts = base_url.split("?", 1)
        path, query = parts[0], parts[1]
        if not path.endswith("/"):
            path += "/"
        params = urllib.parse.parse_qsl(query)
        params = [p for p in params if p[0] != "page"]
        params.append(("page", str(page)))
        new_query = urllib.parse.urlencode(params)
        return f"{path}?{new_query}"
    else:
        path = base_url
        if not path.endswith("/"):
            path += "/"
        return f"{path}?page={page}"


async def _fetch_all_concurrently(
    client: httpx.AsyncClient,
    headers: dict,
    base_url: str,
    label: str,
    sync_logs: dict,
    max_pages: int = 500
) -> tuple[list[dict], int, int]:
    import math
    
    first_url = _build_page_url(base_url, 1)
    response = await _robust_get(client, first_url, headers, label, 1, sync_logs)
    payload = response.json()
    
    first_page_items = _external_rows(payload)
    count = payload.get("count") or len(first_page_items)
    
    # Calculate page size
    page_size = len(first_page_items) if first_page_items else 10
    if page_size == 0 or count <= page_size:
        return first_page_items, count, 1

    total_pages = min(math.ceil(count / page_size), max_pages)
    all_rows = list(first_page_items)
    
    if total_pages <= 1:
        return all_rows, count, 1

    tasks = []
    for page in range(2, total_pages + 1):
        url = _build_page_url(base_url, page)
        tasks.append((page, url))
        
    # Fetch in batches of 5 to avoid rate-limiting/overload
    batch_size = 5
    pages_fetched = 1
    for i in range(0, len(tasks), batch_size):
        if i > 0:
            await asyncio.sleep(0.2)  # Delay between batches to give upstream server breathing room
        batch = tasks[i:i + batch_size]
        futures = [
            _robust_get(client, url, headers, label, page, sync_logs)
            for page, url in batch
        ]
        responses = await asyncio.gather(*futures, return_exceptions=True)
        for resp in responses:
            if isinstance(resp, Exception):
                raise resp
            all_rows.extend(_external_rows(resp.json()))
            pages_fetched += 1
            
    return all_rows, count, pages_fetched


async def _execute_sync(
    db: AsyncSession, max_pages: int, organization_id: int | None,
    task: dict | None = None,
) -> dict:
    """Core sync logic extracted from the endpoint.
    Uses the exact resync_org_structure logic to ensure 100% parity between CLI resync and API sync.
    """
    from scripts.resync_org_structure import fetch_all, sync_all

    headers = {"X-Api-Key": settings.HR_API_KEY, "Accept": "application/json"}
    
    try:
        async with httpx.AsyncClient(timeout=settings.HR_API_TIMEOUT, follow_redirects=True) as client:
            if task is not None:
                task["progress"] = "Fetching employees and positions from HR API..."
            employee_rows, emp_count, position_rows, pos_count = await fetch_all(client, headers)

            if task is not None:
                task["progress"] = f"Fetched {len(employee_rows)} employees and {len(position_rows)} positions. Syncing..."

            stats = await sync_all(
                db, employee_rows, position_rows,
                org_id=organization_id or 1,
                emp_expected=emp_count,
                pos_expected=pos_count
            )

            return {
                "message": "Employee API sync completed",
                "fetched": len(employee_rows),
                "api_total": emp_count,
                "positions_total": len(position_rows),
                "pages_fetched": 1,
                "created": stats.get("employees", 0),
                "updated": 0,
                "skipped": 0,
                "projects_created": stats.get("projects", 0),
                "offices_created": stats.get("offices", 0),
                "positions_created": stats.get("positions", 0),
                "linked_users": 0,
                "role_links_applied": 0,
                "mapped_positions": stats.get("positions", 0),
                "offline": False,
                "page_request_log": [],
                "insertion_failures": []
            }
    except Exception as exc:
        print(f"External SCM HR API connection failed or errored ({exc}). Falling back to offline DB mappings.")
        import traceback
        traceback.print_exc()

        # Fetch local DB counts to report
        db_emp_count = (await db.execute(select(func.count(Employee.id)))).scalar() or 0
        db_pos_count = (await db.execute(select(func.count(Position.id)))).scalar() or 0

        return {
            "message": f"Employee API sync completed (Offline Fallback / Error: {exc})",
            "fetched": db_emp_count,
            "api_total": db_emp_count,
            "positions_total": db_pos_count,
            "pages_fetched": 0,
            "created": 0,
            "updated": 0,
            "skipped": 0,
            "offline": True,
            "page_request_log": [],
            "insertion_failures": []
        }


async def _sync_all_positions(
    db: AsyncSession, stats: dict[str, int], headers: dict[str, str], client: httpx.AsyncClient, organization_id: int | None, sync_logs: dict, cache: dict = None
) -> int:
    base_url = settings.HR_EMPLOYEE_API_URL
    if "/api/employees" in base_url:
        pos_url = base_url.replace("/api/employees", "/api/positions")
    elif "/employees" in base_url:
        pos_url = base_url.replace("/employees", "/positions")
    else:
        pos_url = base_url.replace("employees", "positions")

    all_rows, pos_count, pos_pages = await _fetch_all_concurrently(client, headers, pos_url, "positions", sync_logs)
    
    record_count = 0
    for row in all_rows:
        try:
            async with db.begin_nested():
                pos_row = dict(row)
                pos_row["position"] = {"reporting_to": row.get("reporting_to_details")}
                await _position_id_from_external(db, pos_row, stats, organization_id, cache=cache)
        except Exception as exc:
            err_msg = str(exc)
            print(f"Transient error syncing position row: {err_msg}")
            pos_code = _external_text(row, "code", "position_code", "positionCode", max_len=100) or "UNKNOWN"
            sync_logs["insertion_failures"].append({
                "type": "position",
                "code": pos_code,
                "error": err_msg
            })
        
        record_count += 1
        if record_count % 100 == 0:
            await db.commit()

    await db.commit()

    # Pass 2: Resolve and update parent_position_id for all positions now that all exist in db/cache
    second_record_count = 0
    for row in all_rows:
        try:
            async with db.begin_nested():
                pos_row = dict(row)
                pos_row["position"] = {"reporting_to": row.get("reporting_to_details")}
                
                position_id = row.get("id") or row.get("position_id")
                try:
                    position_id = int(position_id) if position_id is not None else None
                except (TypeError, ValueError):
                    position_id = None
                
                if position_id:
                    position = None
                    if cache is not None:
                        position = cache["positions_by_id"].get(position_id)
                    if not position:
                        position = (await db.execute(select(Position).where(Position.id == position_id))).scalar_one_or_none()
                    
                    if position:
                        parent_ids = await _resolve_parent_position_ids(db, pos_row, cache=cache)
                        position.parent_position_id = parent_ids[0] if parent_ids else None
                        
                        # Clear old relationships for this position
                        await db.execute(text("DELETE FROM position_reporting WHERE position_id = :pos_id"), {"pos_id": position.id})
                        
                        # Insert all resolved parents
                        for p_id in parent_ids:
                            if p_id != position.id:  # Avoid self-loops
                                await db.execute(text("""
                                    INSERT IGNORE INTO position_reporting (position_id, parent_position_id)
                                    VALUES (:pos_id, :p_id)
                                """), {"pos_id": position.id, "p_id": p_id})
        except Exception as exc:
            print(f"Transient error resolving parent in second pass: {exc}")
        
        second_record_count += 1
        if second_record_count % 100 == 0:
            await db.commit()

    await db.commit()
    return len(all_rows)


async def _sync_position_employee_mappings(db: AsyncSession, headers: dict[str, str], client: httpx.AsyncClient, sync_logs: dict, cache: dict = None) -> int:
    base_url = settings.HR_EMPLOYEE_API_URL
    if "/api/employees" in base_url:
        pos_url = base_url.replace("/api/employees", "/api/positions")
    elif "/employees" in base_url:
        pos_url = base_url.replace("/employees", "/positions")
    else:
        pos_url = base_url.replace("employees", "positions")

    all_rows, _, _ = await _fetch_all_concurrently(client, headers, pos_url, "mappings", sync_logs)

    mapped_count = 0
    record_count = 0
    for row in all_rows:
        pos_id = row.get("id") or row.get("position_id")
        try:
            pos_id = int(pos_id) if pos_id is not None else None
        except (TypeError, ValueError):
            pos_id = None

        if not pos_id:
            continue

        assigned_emp = row.get("assigned_employee")
        assigned_emp_id = None
        if assigned_emp and isinstance(assigned_emp, dict):
            assigned_emp_id = assigned_emp.get("id")

        try:
            assigned_emp_id = int(assigned_emp_id) if assigned_emp_id is not None else None
        except (TypeError, ValueError):
            assigned_emp_id = None

        if assigned_emp_id:
            pos = None
            if cache is not None:
                pos = cache["positions_by_id"].get(pos_id)
            else:
                pos = (await db.execute(select(Position).where(Position.id == pos_id))).scalar_one_or_none()
            
            if pos:
                emp_exists = False
                if cache is not None:
                    emp_exists = assigned_emp_id in cache["employees_by_id"]
                else:
                    emp_exists = (await db.execute(select(Employee.id).where(Employee.id == assigned_emp_id))).scalar_one_or_none() is not None
                
                if emp_exists:
                    try:
                        async with db.begin_nested():
                            pos.employee_id = assigned_emp_id
                            await db.flush()
                            mapped_count += 1
                    except Exception as exc:
                        print(f"WARN: Could not map assigned_employee {assigned_emp_id} to position {pos_id}: {exc}")
        
        record_count += 1
        if record_count % 100 == 0:
            await db.commit()

    await db.commit()
    return mapped_count

@router.post("/employees/sync-api")
async def sync_employees_from_external_api(
    max_pages: int = Query(500, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "users")),
):
    """Start employee/position sync from HR API in background.
    Returns immediately with a task_id so the frontend can poll status.
    """
    await ensure_organization_structure_schema(db)
    if not settings.HR_EMPLOYEE_API_URL:
        raise HTTPException(status_code=422, detail="Set HR_EMPLOYEE_API_URL in backend/.env")
    if not settings.HR_API_KEY:
        raise HTTPException(status_code=422, detail="Set HR_API_KEY in backend/.env")

    task_id = str(uuid.uuid4())
    _sync_tasks[task_id] = {"status": "starting", "organization_id": current_user.organization_id}

    asyncio.create_task(
        _run_sync_background(task_id, max_pages, current_user.organization_id)
    )

    return {"task_id": task_id, "status": "started", "message": "Sync started in background"}


@router.get("/employees/sync-status/{task_id}")
async def get_sync_status(task_id: str):
    """Poll status of a background sync task."""
    task = _sync_tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Sync task not found")
    # Clean up completed/failed tasks older than 1 hour
    _prune_old_sync_tasks()
    return {"task_id": task_id, **task}


@router.get("/projects")
async def list_projects(
    search: str = Query(None),
    status: str = Query(None),
    user_id: Optional[int] = Query(None, description="Scope to a specific user's project assignments"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List projects scoped to the calling user.

    Non-managerial users see only their `user_projects` set. Managerial roles
    (super_admin/admin/warehouse_manager/etc.) see everything. Without this
    scope the indent form's project dropdown leaked every project to every
    user, defeating the purpose of user_projects.
    """
    query = select(Project).order_by(Project.name)
    if status:
        query = query.where(Project.status == status)
    if search:
        query = query.where(Project.name.ilike(f"%{search}%") | Project.code.ilike(f"%{search}%"))

    from app.utils.dependencies import user_is_managerial

    # When user_id is provided, scope to that user's assignments so the
    # frontend (e.g. IndentForm) can fetch a scoped list even for managerial
    # roles that would otherwise see every project in the system.
    target_id = user_id if user_id is not None else current_user.id
    if user_id is not None or not await user_is_managerial(db, current_user.id):
        from app.models.user import UserProject
        # 1. Resolve from user_projects table (explicit assignments)
        rows = await db.execute(
            select(UserProject.project_id).where(UserProject.user_id == target_id)
        )
        proj_ids = set(r[0] for r in rows.all())

        # 2. Also resolve from the user's position -> project chain
        #    User.employee_id -> Employee.position_id -> Position.project_id
        proj_q = await db.execute(
            select(Position.project_id)
            .select_from(User)
            .join(Employee, User.employee_id == Employee.id)
            .join(Position, Employee.position_id == Position.id)
            .where(User.id == target_id)
        )
        proj_from_pos = proj_q.scalar_one_or_none()
        if proj_from_pos is not None:
            proj_ids.add(proj_from_pos)

        if not proj_ids:
            return []
        query = query.where(Project.id.in_(list(proj_ids)))

    result = await db.execute(query)
    projects = result.scalars().all()
    return [{
        "id": p.id, "name": p.name, "code": p.code,
        "description": p.description, "status": p.status,
        "start_date": p.start_date, "end_date": p.end_date,
        "organization_id": p.organization_id,
    } for p in projects]




# --- masters_phase1 users/groups items ---
class UserGroupPayload(BaseModel):
    code: str = Field(..., min_length=1, max_length=50)
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    is_active: bool = True


@router.get("/user-groups")
async def list_user_groups(
    search: Optional[str] = None,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    q = select(UserGroup).order_by(UserGroup.id.desc())
    if search:
        like = f"%{search}%"
        q = q.where((UserGroup.code.ilike(like)) | (UserGroup.name.ilike(like)))
    rows = (await db.execute(q)).scalars().all()
    return [
        {"id": g.id, "code": g.code, "name": g.name,
         "description": g.description, "is_active": g.is_active}
        for g in rows
    ]


@router.post("/user-groups", status_code=201)
async def create_user_group(
    payload: UserGroupPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    dup = await db.execute(select(UserGroup).where(UserGroup.code == payload.code))
    if dup.scalar_one_or_none():
        raise HTTPException(409, f"Group '{payload.code}' already exists")
    g = UserGroup(**payload.model_dump())
    db.add(g)
    await db.flush()
    return {"id": g.id, "message": "Group created"}


@router.put("/user-groups/{group_id}")
async def update_user_group(
    group_id: int, payload: UserGroupPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    g = (await db.execute(select(UserGroup).where(UserGroup.id == group_id))).scalar_one_or_none()
    if not g:
        raise HTTPException(404, "Group not found")
    for k, v in payload.model_dump().items():
        setattr(g, k, v)
    await db.flush()
    return {"id": g.id, "message": "Group updated"}


@router.delete("/user-groups/{group_id}")
async def delete_user_group(
    group_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    g = (await db.execute(select(UserGroup).where(UserGroup.id == group_id))).scalar_one_or_none()
    if not g:
        raise HTTPException(404, "Group not found")
    g.is_active = False
    # BUG-FE-074: cascade — drop members and permissions so they don't leak
    # access via a "soft-deleted" group still referenced by permission checks.
    members = (
        await db.execute(select(UserGroupMember).where(UserGroupMember.group_id == group_id))
    ).scalars().all()
    affected_user_ids = []
    for m in members:
        affected_user_ids.append(m.user_id)
        await db.delete(m)
    perms = (
        await db.execute(select(UserGroupPermission).where(UserGroupPermission.group_id == group_id))
    ).scalars().all()
    for p in perms:
        await db.delete(p)
    # BUG-FE-076-adjacent: revoke active sessions for ex-members so cached
    # permission claims don't survive the group deletion.
    if affected_user_ids:
        try:
            from app.models.auth import UserSession  # type: ignore
            sessions = (
                await db.execute(
                    select(UserSession).where(UserSession.user_id.in_(affected_user_ids))
                )
            ).scalars().all()
            for s in sessions:
                if hasattr(s, "is_active"):
                    s.is_active = False
                else:
                    await db.delete(s)
        except Exception:
            pass
    await db.flush()
    return {
        "message": "Group deactivated",
        "members_removed": len(members),
        "permissions_removed": len(perms),
    }


class GroupMemberPayload(BaseModel):
    user_ids: List[int]


@router.get("/user-groups/{group_id}/members")
async def list_group_members(
    group_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    rows = (
        await db.execute(
            select(UserGroupMember, User)
            .join(User, User.id == UserGroupMember.user_id)
            .where(UserGroupMember.group_id == group_id)
        )
    ).all()
    return [
        {
            "id": m.id, "user_id": u.id, "username": u.username,
            "email": u.email,
            "added_at": m.added_at.isoformat() if m.added_at else None,
        }
        for m, u in rows
    ]


@router.put("/user-groups/{group_id}/members")
async def set_group_members(
    group_id: int, payload: GroupMemberPayload,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    # BUG-FE-075: lock the group row so concurrent calls serialize. Combined
    # with the single db.flush() at the end, this gives delete+insert atomicity.
    g = (
        await db.execute(
            select(UserGroup).where(UserGroup.id == group_id).with_for_update()
        )
    ).scalar_one_or_none()
    if not g:
        raise HTTPException(404, "Group not found")
    new_ids = set(payload.user_ids or [])
    existing = (
        await db.execute(select(UserGroupMember).where(UserGroupMember.group_id == group_id))
    ).scalars().all()
    existing_ids = {m.user_id for m in existing}
    removed_ids = existing_ids - new_ids
    for m in existing:
        await db.delete(m)
    for uid in new_ids:
        db.add(UserGroupMember(group_id=group_id, user_id=uid))
    # BUG-FE-076: revoke active sessions for users removed from the group so
    # stale permission claims don't survive the membership change.
    if removed_ids:
        try:
            from app.models.auth import UserSession  # type: ignore
            sessions = (
                await db.execute(
                    select(UserSession).where(UserSession.user_id.in_(list(removed_ids)))
                )
            ).scalars().all()
            for s in sessions:
                if hasattr(s, "is_active"):
                    s.is_active = False
                else:
                    await db.delete(s)
        except Exception:
            pass
    await db.flush()
    return {
        "message": "Members updated",
        "count": len(new_ids),
        "removed": len(removed_ids),
    }


class GroupPermissionPayload(BaseModel):
    entity_type: str
    entity_id: Optional[int] = None
    action: str = "view"


@router.get("/user-groups/{group_id}/permissions")
async def list_group_permissions(
    group_id: int,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    rows = (
        await db.execute(
            select(UserGroupPermission)
            .where(UserGroupPermission.group_id == group_id)
            .order_by(UserGroupPermission.id)
        )
    ).scalars().all()
    return [
        {"id": p.id, "entity_type": p.entity_type,
         "entity_id": p.entity_id, "action": p.action}
        for p in rows
    ]


_VALID_PERM_ENTITY_TYPES = {
    "warehouse", "location", "bin", "category", "item",
    "vendor", "brand", "project", "department", "module",
    "price_list", "uom", "attribute",
}
_VALID_PERM_ACTIONS = {"view", "create", "update", "delete", "approve", "*"}


@router.put("/user-groups/{group_id}/permissions")
async def set_group_permissions(
    group_id: int, payload: List[GroupPermissionPayload],
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    g = (await db.execute(select(UserGroup).where(UserGroup.id == group_id))).scalar_one_or_none()
    if not g:
        raise HTTPException(404, "Group not found")
    # BUG-FE-077: validate entity_type against the supported set so callers
    # can't write arbitrary strings into the permission table.
    for row in payload:
        et = (row.entity_type or "").strip().lower()
        if et not in _VALID_PERM_ENTITY_TYPES:
            raise HTTPException(
                422,
                f"Invalid entity_type '{row.entity_type}'. "
                f"Allowed: {', '.join(sorted(_VALID_PERM_ENTITY_TYPES))}",
            )
        action = (row.action or "view").strip().lower()
        if action not in _VALID_PERM_ACTIONS:
            raise HTTPException(
                422,
                f"Invalid action '{row.action}'. "
                f"Allowed: {', '.join(sorted(_VALID_PERM_ACTIONS))}",
            )
    existing = (
        await db.execute(
            select(UserGroupPermission).where(UserGroupPermission.group_id == group_id)
        )
    ).scalars().all()
    for p in existing:
        await db.delete(p)
    for row in payload:
        db.add(
            UserGroupPermission(
                group_id=group_id,
                entity_type=(row.entity_type or "").strip().lower(),
                entity_id=row.entity_id,
                action=(row.action or "view").strip().lower(),
            )
        )
    await db.flush()
    return {"message": "Permissions updated", "count": len(payload)}


# ==================== modularized reports endpoints ====================
from typing import Optional
from datetime import date

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
        from sqlalchemy.orm import selectinload
        offset, limit = paginate_params(page, page_size)
        query = select(ActivityLog).options(selectinload(ActivityLog.user)).order_by(ActivityLog.created_at.desc())
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
        
        items = []
        for l in logs:
            user_name = None
            if l.user:
                parts = [l.user.first_name, l.user.last_name]
                user_name = " ".join([p for p in parts if p]).strip() or l.user.username
            items.append({
                "id": l.id,
                "user_id": l.user_id,
                "user_name": user_name,
                "module": l.module,
                "action": l.action,
                "entity_type": l.entity_type,
                "entity_id": l.entity_id,
                "description": l.description,
                "ip_address": l.ip_address,
                "created_at": l.created_at,
                "timestamp": l.created_at,
            })
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

    from sqlalchemy.orm import selectinload
    query = select(ActivityLog).options(selectinload(ActivityLog.user)).order_by(ActivityLog.created_at.desc())
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

    items = []
    for l in logs:
        user_name = None
        if l.user:
            parts = [l.user.first_name, l.user.last_name]
            user_name = " ".join([p for p in parts if p]).strip() or l.user.username
        items.append({
            "id": l.id,
            "user_id": l.user_id,
            "user_name": user_name,
            "module": l.module,
            "action": l.action,
            "entity_type": l.entity_type,
            "entity_id": l.entity_id,
            "description": l.description,
            "ip_address": l.ip_address,
            "created_at": l.created_at,
            "timestamp": l.created_at,
        })

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


@router.post("/offices/sync-warehouses", status_code=200)
async def backfill_offices_to_warehouses(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "warehouses")),
):
    """Bulk backfill all offices as SCM warehouses."""
    from app.services.office_warehouse_sync import sync_all_offices_to_warehouses
    stats = await sync_all_offices_to_warehouses(db, organization_id=current_user.organization_id)
    await db.commit()
    return stats


@router.post("/employees/sync-warehouse-mappings", status_code=200)
async def backfill_employee_warehouse_mappings(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("masters", "update", "users")),
):
    """Bulk backfill employee-to-warehouse mappings based on positions."""
    from app.services.employee_warehouse_sync import sync_all_position_employees
    stats = await sync_all_position_employees(db)
    await db.commit()
    return stats


