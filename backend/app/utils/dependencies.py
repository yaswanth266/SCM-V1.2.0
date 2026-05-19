from typing import List, Optional
from functools import wraps
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.database import get_db
from app.models.user import User, UserRole, Role, RolePermission, Permission
from app.services.auth_service import verify_access_token

# BUG-AUTH-040 fix: HTTPBearer defaults to raising 403 when no Authorization
# header is present. The frontend axios refresh interceptor only retries on
# 401, so a missing-header case (e.g. token expiry race) used to surface as a
# permanent 403 instead of triggering the refresh flow. ``auto_error=False``
# lets us return 401 explicitly below.
security = HTTPBearer(auto_error=False)


async def get_current_user(
    request: Request = None,  # type: ignore[assignment]
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Get the current authenticated user from JWT token."""
    # BUG-AUTH-040 fix: when the Authorization header is absent we now return
    # 401 (matching the JWT-expired path) so the frontend refresh interceptor
    # can drive its retry/login flow uniformly.
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = credentials.credentials
    payload = verify_access_token(token)

    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )

    # BUG-AUTH-017/019 (Wave 5): server-side token blocklist. We hash the
    # raw bearer token so we don't store plaintext credentials. A presence
    # check in token_blocklist is enough to invalidate a token regardless
    # of jti.
    try:
        import hashlib
        from app.models.user import TokenBlocklist
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        bl_res = await db.execute(
            select(TokenBlocklist.id).where(TokenBlocklist.token_hash == token_hash).limit(1)
        )
        if bl_res.scalar_one_or_none() is not None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token has been revoked",
                headers={"WWW-Authenticate": "Bearer"},
            )
    except HTTPException:
        raise
    except Exception:
        # Blocklist availability problems should not lock everyone out.
        pass

    result = await db.execute(
        select(User)
        .options(selectinload(User.roles).selectinload(UserRole.role))
        .where(User.id == int(user_id))
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is deactivated",
        )

    # BUG-AUTH-019/029 (Wave 5): if the user has been forcibly logged out
    # of all devices (deactivation, password change, admin action), every
    # token issued before tokens_revoked_after is rejected.
    if user.tokens_revoked_after is not None:
        iat = payload.get("iat")
        if iat is not None:
            try:
                from datetime import timezone as _tz
                cutoff = user.tokens_revoked_after
                if cutoff.tzinfo is None:
                    cutoff = cutoff.replace(tzinfo=_tz.utc)
                if int(iat) < cutoff.timestamp():
                    raise HTTPException(
                        status_code=status.HTTP_401_UNAUTHORIZED,
                        detail="Token revoked",
                        headers={"WWW-Authenticate": "Bearer"},
                    )
            except HTTPException:
                raise
            except Exception:
                pass

    # BUG-AUTH-137 fix: stash the user id on request.state so AuditMiddleware
    # can avoid decoding the JWT a second time per request. The attribute is
    # optional — middleware tolerates its absence.
    if request is not None:
        try:
            request.state.user_id = user.id
        except Exception:
            pass

    return user


async def get_user_permissions(db: AsyncSession, user_id: int) -> List[str]:
    """Get all permissions for a user based on their roles.

    BUG-AUTH-079 fix: filter on Role.is_active so deactivated roles do not
    silently keep granting permissions.

    BUG-AUTH-083 fix: a module / action / resource value containing a dot
    would corrupt the canonical "module.action.resource" permission string
    (downstream `.split('.')` matched the wrong fragment). We strip dots
    before joining; permission seeds should not contain them in the first
    place but defensive normalisation prevents silent privilege drift.
    """
    result = await db.execute(
        select(Permission.module, Permission.action, Permission.resource)
        .join(RolePermission, RolePermission.permission_id == Permission.id)
        .join(UserRole, UserRole.role_id == RolePermission.role_id)
        .join(Role, Role.id == UserRole.role_id)
        .where(UserRole.user_id == user_id)
        .where(Role.is_active == True)  # noqa: E712
    )
    permissions = result.all()

    def _clean(s):
        # Replace any dot inside a single segment so the canonical string
        # has exactly two separator dots.
        return (s or "").replace(".", "_")

    return [f"{_clean(p[0])}.{_clean(p[1])}.{_clean(p[2])}" for p in permissions]


async def get_user_role_codes(db: AsyncSession, user_id: int) -> List[str]:
    """Get role codes for a user.

    BUG-AUTH-080 fix: filter on Role.is_active.
    """
    result = await db.execute(
        select(Role.code)
        .join(UserRole, UserRole.role_id == Role.id)
        .where(UserRole.user_id == user_id)
        .where(Role.is_active == True)  # noqa: E712
    )
    return [row[0] for row in result.all()]


def require_permission(module: str, action: str, resource: str):
    """Dependency to check if user has a specific permission."""
    async def check_permission(
        current_user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> User:
        role_codes = await get_user_role_codes(db, current_user.id)

        # BUG-AUTH-082 fix: only super_admin gets the global bypass. The
        # plain `admin` role must satisfy permission checks via its actual
        # permission rows (i.e. an admin without the relevant module
        # permission no longer passes silently).
        if "super_admin" in role_codes:
            return current_user

        permissions = set(await get_user_permissions(db, current_user.id))
        required = f"{module}.{action}.{resource}"
        resource_key = (resource or "").replace("_", "-")
        action_keys = {action}
        if action == "update":
            action_keys.add("edit")
        if action == "edit":
            action_keys.add("update")
        allowed = {required}
        for act in action_keys:
            allowed.add(f"{module}.{act}.{resource}")
            allowed.add(f"{module}-{resource_key}.{act}.{module}-{resource_key}")

        if not (allowed & permissions):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permission denied: {required}",
            )

        return current_user

    return check_permission


def require_key(*allowed_keys: str):
    """FastAPI dependency that ensures the current user's active role
    grants at least one of the listed allowed-keys.

    Mirrors the per-page granularity used by the sidebar (so an endpoint
    protected by ``require_key('procurement-purchase-orders')`` stays
    consistent with the frontend ``KeyRoute`` and the ``/me/sidebar``
    response). super_admin / admin pass through unchanged via
    ``_allowed_for_role`` (which returns the full key set for them).

    Defense-in-depth layer added 2026-05-05 alongside frontend KeyRoute
    gating to close audit-confirmed leaks where roles bypassed the SPA
    and called the endpoints directly with curl.
    """
    async def _dep(
        current_user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> User:
        # Imported lazily to avoid circular import: sidebar.py imports
        # get_current_user from this module at module load time.
        from app.api.v1.sidebar import allowed_keys_for_role, _resolve_active_role
        role = await _resolve_active_role(db, current_user)
        granted = set(await allowed_keys_for_role(db, role))
        if not (set(allowed_keys) & granted):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    f"Active role '{role.code}' lacks key(s): "
                    f"{','.join(allowed_keys)}"
                ),
            )
        return current_user

    return _dep


def require_any_role(*role_codes: str):
    """Dependency to check if user has any of the specified roles."""
    async def check_role(
        current_user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> User:
        user_roles = await get_user_role_codes(db, current_user.id)

        if "super_admin" in user_roles:
            return current_user

        if not any(r in user_roles for r in role_codes):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient role privileges",
            )

        return current_user

    return check_role


# Roles that see every indent/PO/MR regardless of warehouse mapping.
# Anyone NOT in this set is scoped down to:
#  - documents they personally raised/created
#  - documents for warehouses listed in their user_warehouses mapping
MANAGERIAL_ROLES = frozenset({
    "super_admin", "admin",
    "warehouse_manager", "purchase_manager", "accounts_manager",
    "logistics_manager", "project_manager",
    "purchase_officer", "accounts_officer",
})


async def user_is_managerial(db: AsyncSession, user_id: int) -> bool:
    """True if user has any role that grants visibility across all warehouses."""
    codes = set(await get_user_role_codes(db, user_id))
    return bool(codes & MANAGERIAL_ROLES)


async def user_warehouse_ids(db: AsyncSession, user_id: int) -> List[int]:
    """Return the warehouse ids mapped to this user (possibly empty)."""
    from app.models.user import UserWarehouse
    result = await db.execute(
        select(UserWarehouse.warehouse_id).where(UserWarehouse.user_id == user_id)
    )
    return [row[0] for row in result.all()]
