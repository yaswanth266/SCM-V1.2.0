from datetime import datetime, timezone
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select, func, delete, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.database import get_db
from app.models.user import User, UserRole, UserWarehouse, UserProject, Role
from app.models.master import Employee, Position
from app.schemas.auth import UserResponse, UserCreate, UserUpdate, AssignRoles, AssignWarehouses, AssignProjects, ResetPassword, RoleInfo
from app.utils.dependencies import get_current_user, require_any_role
from app.utils.helpers import paginate_params, build_paginated_response, apply_search_filter
from app.utils.schema_sync import ensure_organization_structure_schema

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


def _build_user_response(u, roles_loaded=True):
    """Build a UserResponse from a User model instance."""
    full_name = u.first_name
    if u.last_name:
        full_name = f"{u.first_name} {u.last_name}"

    role_list = []
    if roles_loaded and u.roles:
        for ur in u.roles:
            if ur.role:
                role_list.append(RoleInfo(id=ur.role.id, code=ur.role.code, name=ur.role.name))

    return UserResponse(
        id=u.id, organization_id=u.organization_id, employee_id=u.employee_id, employee_code=u.employee_code,
        username=u.username, email=u.email, first_name=u.first_name, last_name=u.last_name,
        full_name=full_name, phone=u.phone, user_type=u.user_type, department=u.department,
        designation=u.designation, is_active=u.is_active,
        status="active" if u.is_active else "inactive",
        last_login=u.last_login, created_at=u.created_at,
        roles=role_list, permissions=[],
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

    # Check if username or email already exists
    existing = await db.execute(
        select(User).where(
            (User.username == payload.username) | (User.email == payload.email)
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
        username=payload.username,
        email=payload.email,
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

    # Assign warehouses
    for wh_id in (payload.warehouse_ids or []):
        db.add(UserWarehouse(user_id=user.id, warehouse_id=wh_id))

    # Assign projects
    for proj_id in (payload.project_ids or []):
        db.add(UserProject(user_id=user.id, project_id=proj_id))

    await db.flush()

    # Reload with roles
    result = await db.execute(
        select(User).options(selectinload(User.roles).selectinload(UserRole.role))
        .where(User.id == user.id)
    )
    user = result.scalar_one()
    return _build_user_response(user)


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
            selectinload(User.warehouses),
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


@router.get("/{user_id}", response_model=UserResponse)
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
        select(User).options(selectinload(User.roles).selectinload(UserRole.role))
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

    return _build_user_response(user)


@router.put("/{user_id}", response_model=UserResponse)
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

    # Handle warehouse reassignment
    warehouse_ids = update_data.pop("warehouse_ids", None)
    if warehouse_ids is not None:
        await db.execute(delete(UserWarehouse).where(UserWarehouse.user_id == user_id))
        for wh_id in warehouse_ids:
            db.add(UserWarehouse(user_id=user_id, warehouse_id=wh_id))

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

    # Reload with roles
    result = await db.execute(
        select(User).options(selectinload(User.roles).selectinload(UserRole.role))
        .where(User.id == user_id)
    )
    user = result.scalar_one()
    return _build_user_response(user)


@router.delete("/{user_id}")
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


@router.post("/{user_id}/reset-password")
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


@router.patch("/{user_id}/status")
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


@router.post("/{user_id}/roles")
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


@router.post("/{user_id}/warehouses")
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


@router.post("/{user_id}/projects")
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
