from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.database import get_db
from app.models.user import User, UserRole, Role, UserProject, UserWarehouse, TokenBlocklist, PasswordHistory
from app.models.warehouse import Warehouse
from app.schemas.auth import (
    LoginRequest, TokenResponse, UserCreate, UserResponse,
    ChangePassword, RefreshTokenRequest, RoleInfo,
)
from app.services.auth_service import (
    hash_password, verify_password, create_access_token,
    create_refresh_token, verify_refresh_token,
)
from app.utils.dependencies import get_current_user, get_user_permissions, require_any_role
from app.utils.position_role_sync import sync_user_position_role
from app.config import settings

router = APIRouter()


def _client_ip(request: Request) -> str:
    """BUG-AUTH-003 fix: behind nginx the request.client.host is always the
    proxy IP (typically 127.0.0.1) which makes a per-IP rate limiter buck
    every login attempt across the whole organisation into one bucket. Honour
    X-Forwarded-For / X-Real-IP when present so each real client gets its
    own bucket."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        # First entry is the original client; trim whitespace and ports.
        return xff.split(",")[0].strip()
    real = request.headers.get("x-real-ip")
    if real:
        return real.strip()
    return get_remote_address(request)


import os as _os
from limits.storage import MemoryStorage

_RATE_LIMIT_STORAGE = settings.RATE_LIMIT_STORAGE_URI or "redis://localhost:6379/0"
# Shared storage so per-IP limits hold across uvicorn workers (in-memory backend
# silently doubled effective limits on multi-worker deploys — Wave 4 verifier V2).
# For local dev without Redis, use memory:// URI scheme
if _RATE_LIMIT_STORAGE.startswith("memory://"):
    # Use memory storage URI that limits library understands
    limiter = Limiter(key_func=_client_ip, storage_uri="memory://")
else:
    limiter = Limiter(key_func=_client_ip, storage_uri=_RATE_LIMIT_STORAGE)


async def _resolve_primary_warehouse(db: AsyncSession, user_id: int):
    """Return (warehouse_id, warehouse_name) of the user's first
    `user_warehouses` assignment, or (None, None) if none.

    Field-staff clients (mobile) need a single warehouse to scope stock and
    indent submissions to. We pick the lowest-id assignment so it's stable
    across logins for users with multiple warehouses (rare).
    """
    row = (await db.execute(
        select(UserWarehouse.warehouse_id, Warehouse.name)
        .join(Warehouse, Warehouse.id == UserWarehouse.warehouse_id)
        .where(UserWarehouse.user_id == user_id)
        .order_by(UserWarehouse.id.asc())
        .limit(1)
    )).first()
    if row is None:
        return None, None
    return row[0], row[1]


# BUG-AUTH-002: tight prod default was 10/min, blew up multi-role UAT testing
# (all 14 audit users from one IP would hit the cap). 200/min = effectively
# no limit during normal use, still rules out hostile credential-stuffing.
# Override via LOGIN_RATE_LIMIT env if a tighter prod stance is needed.
_LOGIN_RATE = _os.getenv("LOGIN_RATE_LIMIT", "200/minute")


@router.post("/login", response_model=TokenResponse)
@limiter.limit(_LOGIN_RATE)
async def login(
    request: Request,
    payload: LoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """Authenticate user and return JWT tokens.

    The login identifier field is called `username` on the request but we
    match against either users.username OR users.email so people can type
    their full bhspl.in address and it still works.
    """
    identifier = (payload.username or "").strip()
    # BUG-AUTH-007 fix: match username/email case-insensitively so users on
    # case-sensitive DB collations can still log in by typing their email or
    # username with different capitalisation than the stored row.
    ident_lower = identifier.lower()
    result = await db.execute(
        select(User)
        .options(selectinload(User.roles).selectinload(UserRole.role))
        .where(
            (func.lower(User.username) == ident_lower)
            | (func.lower(User.email) == ident_lower)
        )
    )
    user = result.scalar_one_or_none()

    # BUG-AUTH-004 fix: always run a bcrypt compare even when the user does
    # not exist so an attacker cannot tell from response timing whether the
    # username/email is valid. (The dummy hash below is a known bcrypt of
    # "x" — verify_password returns False for the real candidate password.)
    _DUMMY_BCRYPT = "$2b$12$CwTycUXWue0Thq9StjUM0uJ8wW3GtsKzgYBWvP9oKzqW1xk9pqH8."
    if user is None:
        # Deliberately ignore the result; we only want the constant-time work.
        try:
            verify_password(payload.password, _DUMMY_BCRYPT)
        except Exception:
            pass

    # BUG-AUTH-001 fix (Wave 5): persistent account lockout after repeated
    # failures. We check the lock window before doing the bcrypt compare so
    # an attacker can't burn CPU on a locked account.
    LOCKOUT_THRESHOLD = 5
    LOCKOUT_MINUTES = 15
    if user is not None and user.locked_until is not None:
        from datetime import timezone as _tz
        cutoff = user.locked_until
        if cutoff.tzinfo is None:
            cutoff = cutoff.replace(tzinfo=_tz.utc)
        if cutoff > datetime.now(timezone.utc):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid username or password",
            )

    # BUG-AUTH-005 fix: do not differentiate "account deactivated" from
    # "invalid credentials" — both must return the same generic 401 so an
    # attacker can't enumerate which accounts merely need re-activating.
    if not user or not user.is_active or not verify_password(payload.password, user.password_hash):
        # BUG-AUTH-009 fix: failed-login audit row now records the attempted
        # identifier so security can see WHICH account was being probed.
        try:
            from app.models.system import ActivityLog
            from app.database import AsyncSessionLocal
            ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (
                request.client.host if request.client else None
            )
            ua = request.headers.get("user-agent", "")[:500]
            async with AsyncSessionLocal() as audit_db:
                audit_db.add(ActivityLog(
                    user_id=user.id if user else None,
                    module="auth",
                    action="login_failed",
                    entity_type="user",
                    entity_id=user.id if user else None,
                    description=f"Failed login attempt for username='{identifier[:100]}'",
                    ip_address=ip,
                    user_agent=ua,
                ))
                await audit_db.commit()
        except Exception:
            pass
        # BUG-AUTH-001 (Wave 5): increment failed counter and lock if we hit
        # the threshold. Use a separate session so the increment commits
        # even though we're about to raise.
        if user is not None:
            try:
                from app.database import AsyncSessionLocal
                async with AsyncSessionLocal() as lock_db:
                    fresh = (await lock_db.execute(select(User).where(User.id == user.id))).scalar_one_or_none()
                    if fresh is not None:
                        fresh.failed_login_attempts = (fresh.failed_login_attempts or 0) + 1
                        if fresh.failed_login_attempts >= LOCKOUT_THRESHOLD:
                            from datetime import timedelta as _td
                            fresh.locked_until = datetime.now(timezone.utc) + _td(minutes=LOCKOUT_MINUTES)
                        await lock_db.commit()
            except Exception:
                pass
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )

    # Successful auth: reset lockout counters and update last login.
    user.failed_login_attempts = 0
    user.locked_until = None
    user.last_login = datetime.now(timezone.utc)
    await db.flush()

    # BUG-AUTH-008 fix: write a `login_success` audit row alongside the
    # existing `login_failed` rows so security can correlate successful
    # sessions with their source IP / user-agent.
    try:
        from app.models.system import ActivityLog
        ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (
            request.client.host if request.client else None
        )
        ua = request.headers.get("user-agent", "")[:500]
        db.add(ActivityLog(
            user_id=user.id,
            module="auth",
            action="login_success",
            entity_type="user",
            entity_id=user.id,
            description=f"User {user.username} logged in",
            ip_address=ip,
            user_agent=ua,
        ))
        await db.flush()
    except Exception:
        # Audit failure must never block login
        pass

    token_data = {"sub": str(user.id), "username": user.username}
    access_token = create_access_token(token_data)
    refresh_token = create_refresh_token(token_data)

    # BUG-AUTH-144 (Wave 5): mint a CSRF token alongside the JWT and stamp it
    # on a non-HTTPOnly cookie so the SPA can echo it via X-CSRF-Token on
    # mutating requests. Bearer-token clients are CSRF-immune and ignore it.
    try:
        from app.middleware.csrf import attach_csrf_cookie
        attach_csrf_cookie(response)
    except Exception:
        # Cookie-set must never break login.
        pass

    await sync_user_position_role(db, user)
    user = (
        await db.execute(
            select(User)
            .options(selectinload(User.roles).selectinload(UserRole.role))
            .where(User.id == user.id)
        )
    ).scalar_one()

    role_list = [RoleInfo(id=ur.role.id, code=ur.role.code, name=ur.role.name) for ur in user.roles if ur.role] if user.roles else []
    # BUG-AUTH-010 fix: previously the login response included every
    # individual "module.action.resource" permission string, leaking the
    # full RBAC inventory (a recon target). De-duplicate to the canonical
    # set actually used by the frontend (`hasPermission` only inspects the
    # module + action) so verbose `resource` strings are not exposed.
    raw_permissions = await get_user_permissions(db, user.id)
    permissions = sorted({
        ".".join(p.split(".")[:2]) for p in raw_permissions if p
    })
    full_name = f"{user.first_name} {user.last_name}".strip() if user.last_name else user.first_name

    # Top-level `role` for clients that consume one role string (mobile).
    login_active_role: Optional[str] = None
    if user.active_role_id is not None:
        for ri in role_list:
            if ri.id == user.active_role_id:
                login_active_role = ri.code
                break
    if login_active_role is None and role_list:
        login_active_role = role_list[0].code
    if login_active_role is None:
        login_active_role = user.user_type

    primary_wh_id, primary_wh_name = await _resolve_primary_warehouse(db, user.id)

    return TokenResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        user=UserResponse(
            id=user.id,
            organization_id=user.organization_id,
            employee_code=user.employee_code,
            username=user.username,
            email=user.email,
            first_name=user.first_name,
            last_name=user.last_name,
            full_name=full_name,
            phone=user.phone,
            user_type=user.user_type,
            role=login_active_role,
            warehouse_id=primary_wh_id,
            warehouse_name=primary_wh_name,
            department=user.department,
            designation=user.designation,
            is_active=user.is_active,
            status="active" if user.is_active else "inactive",
            last_login=user.last_login,
            created_at=user.created_at,
            roles=role_list,
            permissions=permissions,
        ),
    )


@router.post("/register", response_model=UserResponse, status_code=201)
async def register(
    payload: UserCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_role("super_admin", "admin")),
):
    """Register a new user (admin only).

    BUG-AUTH-057 fix: this endpoint and POST /users overlapped, with /users
    later acquiring privesc / cross-tenant guards that /auth/register did
    not have. Delegate to the canonical handler in users.py so both routes
    share the same authorization logic — preventing drift like "admin can
    mint super_admins via /auth/register but not /users".
    """
    from app.api.v1.users import create_user
    return await create_user(payload=payload, db=db, current_user=current_user)


@router.get("/me", response_model=UserResponse)
@limiter.limit("60/minute")  # BUG-AUTH-092: throttle /me to deter scraping
async def get_me(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get current user profile."""
    await sync_user_position_role(db, current_user)
    current_user = (
        await db.execute(
            select(User)
            .options(selectinload(User.roles).selectinload(UserRole.role))
            .where(User.id == current_user.id)
        )
    ).scalar_one()

    role_list = [RoleInfo(id=ur.role.id, code=ur.role.code, name=ur.role.name) for ur in current_user.roles if ur.role] if current_user.roles else []
    # BUG-AUTH-010 fix: dedupe to module.action so /me matches /login output.
    raw_permissions = await get_user_permissions(db, current_user.id)
    permissions = sorted({
        ".".join(p.split(".")[:2]) for p in raw_permissions if p
    })
    full_name = f"{current_user.first_name} {current_user.last_name}".strip() if current_user.last_name else current_user.first_name

    # Pick the active role for the top-level `role` field. Mobile reads this.
    active_role_code: Optional[str] = None
    if current_user.active_role_id is not None:
        for ri in role_list:
            if ri.id == current_user.active_role_id:
                active_role_code = ri.code
                break
    if active_role_code is None and role_list:
        active_role_code = role_list[0].code
    if active_role_code is None:
        active_role_code = current_user.user_type

    primary_wh_id, primary_wh_name = await _resolve_primary_warehouse(db, current_user.id)

    return UserResponse(
        id=current_user.id,
        organization_id=current_user.organization_id,
        employee_code=current_user.employee_code,
        username=current_user.username,
        email=current_user.email,
        first_name=current_user.first_name,
        last_name=current_user.last_name,
        full_name=full_name,
        phone=current_user.phone,
        user_type=current_user.user_type,
        role=active_role_code,
        warehouse_id=primary_wh_id,
        warehouse_name=primary_wh_name,
        department=current_user.department,
        designation=current_user.designation,
        is_active=current_user.is_active,
        status="active" if current_user.is_active else "inactive",
        last_login=current_user.last_login,
        created_at=current_user.created_at,
        roles=role_list,
        permissions=permissions,
    )


@router.post("/change-password")
@limiter.limit("5/minute")  # BUG-AUTH-047: throttle credential-stuffing of current_password
async def change_password(
    request: Request,
    payload: ChangePassword,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Change current user's password."""
    if not verify_password(payload.current_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")

    # BUG-AUTH-045 fix: refuse a no-op change. Reusing the current password
    # silently looks like success but doesn't actually rotate the credential
    # (and bypasses BUG-AUTH-046 password-history protections once they ship).
    if verify_password(payload.new_password, current_user.password_hash):
        raise HTTPException(
            status_code=400,
            detail="New password must differ from the current password",
        )

    # BUG-AUTH-046 fix (Wave 5): reject re-use of any of the last N hashes.
    PASSWORD_HISTORY_DEPTH = 5
    try:
        prior = await db.execute(
            select(PasswordHistory.password_hash)
            .where(PasswordHistory.user_id == current_user.id)
            .order_by(PasswordHistory.changed_at.desc())
            .limit(PASSWORD_HISTORY_DEPTH)
        )
        for (old_hash,) in prior.all():
            if old_hash and verify_password(payload.new_password, old_hash):
                raise HTTPException(
                    status_code=400,
                    detail=f"New password must differ from your last {PASSWORD_HISTORY_DEPTH} passwords",
                )
    except HTTPException:
        raise
    except Exception:
        # If the table is somehow unavailable, fail-open on history (no-op)
        # — the immediate-reuse check above still applies.
        pass

    new_hash = hash_password(payload.new_password)
    # Record the OLD hash in history before overwriting.
    try:
        db.add(PasswordHistory(user_id=current_user.id, password_hash=current_user.password_hash))
    except Exception:
        pass
    current_user.password_hash = new_hash
    current_user.password_changed_at = datetime.now(timezone.utc)
    # BUG-AUTH-029 fix (Wave 5): bump tokens_revoked_after so any token
    # issued before this moment is rejected by get_current_user. iat-based
    # check in refresh-token already covers refresh tokens; this column
    # closes the access-token gap.
    current_user.tokens_revoked_after = current_user.password_changed_at
    await db.flush()

    # BUG-AUTH-051 fix: write a semantic audit row so a "password changed"
    # event is searchable in activity_logs (the generic AuditMiddleware row
    # only records "POST /auth/change-password"). Notification emails are
    # DEFERRED until an outbound email pipeline exists.
    try:
        from app.models.system import ActivityLog
        ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (
            request.client.host if request.client else None
        )
        ua = request.headers.get("user-agent", "")[:500]
        db.add(ActivityLog(
            user_id=current_user.id,
            module="auth",
            action="password_changed",
            entity_type="user",
            entity_id=current_user.id,
            description=f"User {current_user.username} changed their password",
            ip_address=ip,
            user_agent=ua,
        ))
        await db.flush()
    except Exception:
        pass

    return {"success": True, "message": "Password changed successfully"}


@router.post("/logout")
async def logout(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Log the current user out.

    BUG-AUTH-017/018 fix: blocklist the bearer token so subsequent calls
    with the same access token fail at ``get_current_user``. Wave 5 added
    the ``token_blocklist`` table; the bearer-token hash is stored along
    with the token's ``exp`` so a periodic janitor can prune expired rows.
    """
    import hashlib
    auth_header = request.headers.get("authorization", "")
    raw_token = auth_header.split(" ", 1)[1].strip() if auth_header.lower().startswith("bearer ") else ""
    if raw_token:
        from app.services.auth_service import decode_token
        token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        payload = decode_token(raw_token) or {}
        exp_ts = payload.get("exp")
        exp_dt = None
        if exp_ts:
            try:
                exp_dt = datetime.fromtimestamp(int(exp_ts), tz=timezone.utc).replace(tzinfo=None)
            except Exception:
                exp_dt = None
        try:
            db.add(TokenBlocklist(
                jti=payload.get("jti"),
                token_hash=token_hash,
                user_id=current_user.id,
                token_type=payload.get("type", "access"),
                expires_at=exp_dt,
                reason="logout",
            ))
            await db.flush()
        except IntegrityError:
            # Already blocklisted — fine.
            await db.rollback()
        except Exception:
            # Never let blocklist failure block logout. The activity-log
            # below still records the logout.
            await db.rollback()

    try:
        from app.models.system import ActivityLog
        ip = request.client.host if request.client else None
        ua = request.headers.get("user-agent", "")[:500]
        db.add(ActivityLog(
            user_id=current_user.id,
            module="auth",
            action="logout",
            entity_type="user",
            entity_id=current_user.id,
            description=f"User {current_user.username} logged out",
            ip_address=ip,
            user_agent=ua,
        ))
        await db.flush()
    except Exception:
        # Audit failure must not block logout
        pass
    return {"success": True, "message": "Logged out"}


@router.post("/refresh-token", response_model=dict)
@limiter.limit("10/minute")
async def refresh_token(request: Request, payload: RefreshTokenRequest, db: AsyncSession = Depends(get_db)):
    """Refresh access token using refresh token."""
    # BUG-AUTH-039 fix: distinguish "expired" from "malformed/invalid" so the
    # client can decide between forcing a re-login vs surfacing a generic
    # error. We don't leak detail beyond the existing two states.
    from app.services.auth_service import inspect_refresh_token
    token_payload, reason = inspect_refresh_token(payload.refresh_token)
    if not token_payload:
        if reason == "expired":
            raise HTTPException(status_code=401, detail="Refresh token has expired")
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    user_id = token_payload.get("sub")
    result = await db.execute(select(User).where(User.id == int(user_id)))
    user = result.scalar_one_or_none()

    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or inactive")

    # BUG-AUTH-023 fix: if a user was hard-deleted and a new user happens to
    # be re-created with the same numeric id, the old refresh token must not
    # be reusable. Compare the username embedded in the token with the
    # current row's username — mismatches mean the token belongs to a
    # different user-row and must be rejected.
    token_username = token_payload.get("username")
    if token_username and user.username != token_username:
        raise HTTPException(
            status_code=401,
            detail="Refresh token does not match current user",
        )

    # BUG-AUTH-020/022 partial fix: if a token was issued before the user's
    # last password change, reject it. Full per-jti reuse detection requires a
    # token_blocklist table (DEFERRED). The `iat` claim is now stamped by
    # auth_service.create_*_token; older tokens without `iat` are accepted to
    # avoid logging everyone out on deploy.
    iat = token_payload.get("iat")
    if iat and user.password_changed_at:
        from datetime import timezone as _tz
        pwd_changed = user.password_changed_at
        if pwd_changed.tzinfo is None:
            pwd_changed = pwd_changed.replace(tzinfo=_tz.utc)
        if iat < pwd_changed.timestamp():
            raise HTTPException(status_code=401, detail="Refresh token revoked by password change")

    # BUG-AUTH-019/029 (Wave 5): same cutoff applies for explicit revocation
    # (admin "log out everywhere", deactivation).
    if iat and user.tokens_revoked_after:
        from datetime import timezone as _tz
        cutoff = user.tokens_revoked_after
        if cutoff.tzinfo is None:
            cutoff = cutoff.replace(tzinfo=_tz.utc)
        if iat < cutoff.timestamp():
            raise HTTPException(status_code=401, detail="Refresh token revoked")

    token_data = {"sub": str(user.id), "username": user.username}
    new_access_token = create_access_token(token_data)

    return {
        "access_token": new_access_token,
        "token_type": "bearer",
        "expires_in": settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    }
