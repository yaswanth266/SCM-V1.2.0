from typing import List, Optional
from functools import wraps
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials, APIKeyHeader
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.database import get_db
from app.models.user import User, UserRole, Role, RolePermission, Permission, ApiKey
from app.services.auth_service import verify_access_token
import hashlib
import json
from datetime import datetime, timezone
import time


class SimpleTTLCache:
    def __init__(self, ttl_seconds: float = 30.0):
        self.ttl = ttl_seconds
        self.cache = {}

    def get(self, key):
        if key in self.cache:
            val, expiry = self.cache[key]
            if time.time() < expiry:
                return val
            else:
                del self.cache[key]
        return None

    def set(self, key, value):
        self.cache[key] = (value, time.time() + self.ttl)

    def invalidate(self, key):
        self.cache.pop(key, None)

    def clear(self):
        self.cache.clear()


_PERMISSIONS_CACHE = SimpleTTLCache(ttl_seconds=30.0)
_USER_WAREHOUSES_CACHE = SimpleTTLCache(ttl_seconds=30.0)
_WAREHOUSE_DESCENDANTS_CACHE = SimpleTTLCache(ttl_seconds=60.0)

# Carrier model is imported lazily inside get_current_carrier_user to avoid
# import-cycles between dependencies and the carrier router.

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

    # Carrier tokens must NOT be usable as employee tokens. They carry an
    # explicit ``carrier_portal=True`` claim minted by /carrier-auth/login; refuse
    # them here so the employee surface stays segregated.
    if payload.get("carrier_portal"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="This token is for the carrier portal and cannot be used here",
            headers={"WWW-Authenticate": "Bearer"},
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

    If User.active_role_id is set, only retrieve permissions for that active role.

    BUG-AUTH-079 fix: filter on Role.is_active so deactivated roles do not
    silently keep granting permissions.

    BUG-AUTH-083 fix: a module / action / resource value containing a dot
    would corrupt the canonical "module.action.resource" permission string
    (downstream `.split('.')` matched the wrong fragment). We strip dots
    before joining; permission seeds should not contain them in the first
    place but defensive normalisation prevents silent privilege drift.
    """
    role_codes = await get_user_role_codes(db, user_id)
    if not role_codes:
        return []

    cache_key = (user_id, tuple(role_codes))
    cached = _PERMISSIONS_CACHE.get(cache_key)
    if cached is not None:
        return cached

    result = await db.execute(
        select(Permission.module, Permission.action, Permission.resource)
        .join(RolePermission, RolePermission.permission_id == Permission.id)
        .join(Role, Role.id == RolePermission.role_id)
        .where(Role.code.in_(role_codes))
        .where(Role.is_active == True)  # noqa: E712
    )
    permissions = result.all()

    def _clean(s):
        # Replace any dot inside a single segment so the canonical string
        # has exactly two separator dots.
        return (s or "").replace(".", "_")

    res = [f"{_clean(p[0])}.{_clean(p[1])}.{_clean(p[2])}" for p in permissions]
    _PERMISSIONS_CACHE.set(cache_key, res)
    return res


async def get_user_role_codes(db: AsyncSession, user_id: int) -> List[str]:
    """Get role codes for a user.

    If User.active_role_id is set, only return that role's code.

    BUG-AUTH-080 fix: filter on Role.is_active.
    """
    from sqlalchemy import inspect
    user = db.identity_map.get((User, user_id))
    
    raw_codes = None
    if user is not None:
        active_role_id = user.active_role_id
        if 'roles' not in inspect(user).unloaded:
            if active_role_id is not None:
                for ur in user.roles:
                    if ur.role and ur.role.id == active_role_id and ur.role.is_active:
                        raw_codes = [ur.role.code]
                        break
            else:
                raw_codes = [ur.role.code for ur in user.roles if ur.role and ur.role.is_active]

    if raw_codes is None:
        user_res = await db.execute(select(User.active_role_id).where(User.id == user_id))
        active_role_id = user_res.scalar_one_or_none()

        if active_role_id is not None:
            result = await db.execute(
                select(Role.code)
                .where(Role.id == active_role_id)
                .where(Role.is_active == True)  # noqa: E712
            )
        else:
            result = await db.execute(
                select(Role.code)
                .join(UserRole, UserRole.role_id == Role.id)
                .where(UserRole.user_id == user_id)
                .where(Role.is_active == True)  # noqa: E712
            )
        raw_codes = [row[0] for row in result.all()]

    normalized_codes = []
    for code in raw_codes:
        normalized_codes.append(code)
        if code == "storekeeper":
            normalized_codes.append("store_keeper")
        elif code == "store_keeper":
            normalized_codes.append("storekeeper")
    return normalized_codes


def require_permission(module: str, action: str, resource: str):
    """Dependency to check if user has a specific permission."""
    async def check_permission(
        current_user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> User:
        role_codes = await get_user_role_codes(db, current_user.id)

        if "super_admin" in role_codes:
            return current_user

        permissions = set(await get_user_permissions(db, current_user.id))
        
        allowed = set()
        action_keys = {action}
        if action in ("edit", "update"):
            action_keys.update(("edit", "update"))
            
        resource_key = (resource or "").replace("_", "-")
        resource_keys = {resource_key}
        if resource_key.endswith("s"):
            resource_keys.add(resource_key[:-1])
        else:
            resource_keys.add(resource_key + "s")
        if resource_key.endswith("y"):
            resource_keys.add(resource_key[:-1] + "ies")
        elif resource_key.endswith("ies"):
            resource_keys.add(resource_key[:-3] + "y")
            
        for act in action_keys:
            allowed.add(f"{module}.{act}.{resource}")
            for r_key in resource_keys:
                allowed.add(f"{module}.{act}.{r_key}")
                allowed.add(f"{module}-{r_key}.{act}.{module}-{r_key}")
                allowed.add(f"{module}-masters-{r_key}.{act}.{module}-masters-{r_key}")
                allowed.add(f"{module}-transactions-{r_key}.{act}.{module}-transactions-{r_key}")
                allowed.add(f"{module}-reports-{r_key}.{act}.{module}-reports-{r_key}")
                allowed.add(f"{module}-notifications-{r_key}.{act}.{module}-notifications-{r_key}")
                allowed.add(f"{module}-dashboard-{r_key}.{act}.{module}-dashboard-{r_key}")
                
                # Support nested sub-modules under other modules (e.g. procurement-masters-vendors)
                if module == "masters":
                    for system_module in ("procurement", "warehouse", "inventory", "logistics", "outbound", "indent", "consumption", "approvals", "accounts", "assets", "settings"):
                        allowed.add(f"{system_module}-masters-{r_key}.{act}.{system_module}-masters-{r_key}")
                
            if module.startswith("warehouse-") or module == "warehouse":
                allowed.add(f"warehouse-transactions.{act}.warehouse-transactions")
            if module.startswith("inventory-") or module == "inventory":
                allowed.add(f"inventory-transactions.{act}.inventory-transactions")
            if module.startswith("indent-") or module == "indent":
                allowed.add(f"indent-transactions.{act}.indent-transactions")

        if not (allowed & permissions):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permission denied: {module}.{action}.{resource}",
            )

        return current_user

    return check_permission


async def check_user_has_any_permission(db: AsyncSession, user_id: int, permission_tuples: list) -> bool:
    """Check if the user has any of the specified permission tuples (module, action, resource)."""
    role_codes = await get_user_role_codes(db, user_id)
    if "super_admin" in role_codes:
        return True

    permissions = set(await get_user_permissions(db, user_id))
    
    for module, action, resource in permission_tuples:
        allowed = set()
        action_keys = {action}
        if action in ("edit", "update"):
            action_keys.update(("edit", "update"))
            
        resource_key = (resource or "").replace("_", "-")
        resource_keys = {resource_key}
        if resource_key.endswith("s"):
            resource_keys.add(resource_key[:-1])
        else:
            resource_keys.add(resource_key + "s")
        if resource_key.endswith("y"):
            resource_keys.add(resource_key[:-1] + "ies")
        elif resource_key.endswith("ies"):
            resource_keys.add(resource_key[:-3] + "y")
            
        for act in action_keys:
            allowed.add(f"{module}.{act}.{resource}")
            for r_key in resource_keys:
                allowed.add(f"{module}.{act}.{r_key}")
                allowed.add(f"{module}-{r_key}.{act}.{module}-{r_key}")
                allowed.add(f"{module}-masters-{r_key}.{act}.{module}-masters-{r_key}")
                allowed.add(f"{module}-transactions-{r_key}.{act}.{module}-transactions-{r_key}")
                allowed.add(f"{module}-reports-{r_key}.{act}.{module}-reports-{r_key}")
                allowed.add(f"{module}-notifications-{r_key}.{act}.{module}-notifications-{r_key}")
                allowed.add(f"{module}-dashboard-{r_key}.{act}.{module}-dashboard-{r_key}")
                
                # Support nested sub-modules under other modules (e.g. procurement-masters-vendors)
                if module == "masters":
                    for system_module in ("procurement", "warehouse", "inventory", "logistics", "outbound", "indent", "consumption", "approvals", "accounts", "assets", "settings"):
                        allowed.add(f"{system_module}-masters-{r_key}.{act}.{system_module}-masters-{r_key}")
                
            if module.startswith("warehouse-") or module == "warehouse":
                allowed.add(f"warehouse-transactions.{act}.warehouse-transactions")
            if module.startswith("inventory-") or module == "inventory":
                allowed.add(f"inventory-transactions.{act}.inventory-transactions")
            if module.startswith("indent-") or module == "indent":
                allowed.add(f"indent-transactions.{act}.indent-transactions")
                
        if allowed & permissions:
            return True
            
    return False


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
        request: Request,
        current_user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> User:
        user_roles = await get_user_role_codes(db, current_user.id)

        if "super_admin" in user_roles:
            return current_user

        if any(r in user_roles for r in role_codes):
            return current_user

        # Dynamic permission check fallback: parse module/action/resource from request path
        try:
            path = request.url.path
            method = request.method.upper()
            
            parts = [p for p in path.split("/") if p]
            if len(parts) >= 2 and parts[0] == "api":
                if parts[1] == "v1":
                    parts = parts[2:]
                else:
                    parts = parts[1:]
                    
            if parts:
                module = parts[0]
                resource = parts[1] if len(parts) > 1 else module
                
                # If resource is digit or UUID-like, treat it as module
                if len(parts) > 1 and (parts[1].isdigit() or (len(parts[1]) > 8 and "-" in parts[1])):
                    resource = module
                    
                # Action mapping
                action = "view"
                if method == "POST":
                    action = "create"
                    if parts[-1] in ("approve", "reject", "cancel", "submit", "finalize"):
                        action = "approve" if parts[-1] in ("approve", "finalize") else "delete" if parts[-1] == "cancel" else "create"
                elif method in ("PUT", "PATCH"):
                    action = "edit"
                elif method == "DELETE":
                    action = "delete"
                
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
                    if module.startswith("warehouse-"):
                        allowed.add(f"warehouse-transactions.{act}.warehouse-transactions")
                    if module.startswith("inventory-"):
                        allowed.add(f"inventory-transactions.{act}.inventory-transactions")
                    if module.startswith("indent-"):
                        allowed.add(f"indent-transactions.{act}.indent-transactions")
                
                if allowed & permissions:
                    return current_user
        except Exception:
            pass

        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient role privileges",
        )

    return check_role

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

def require_api_key_scope(required_scope: str):
    async def get_api_key_user(
        request: Request = None,
        api_key: str = Depends(api_key_header),
        db: AsyncSession = Depends(get_db),
    ) -> User:
        if not api_key:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Missing X-API-Key header",
            )
        
        key_hash = hashlib.sha256(api_key.encode("utf-8")).hexdigest()
        
        result = await db.execute(select(ApiKey).where(ApiKey.key_hash == key_hash))
        api_key_record = result.scalar_one_or_none()
        
        if not api_key_record:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid API Key",
            )
            
        if not api_key_record.is_active:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="API Key is inactive",
            )
            
        if api_key_record.expires_at and api_key_record.expires_at < datetime.now(timezone.utc).replace(tzinfo=None):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="API Key has expired",
            )
            
        scopes = json.loads(api_key_record.scopes) if api_key_record.scopes else []
        if required_scope not in scopes:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"API Key missing required scope: {required_scope}",
            )
            
        # Update last used
        api_key_record.last_used_at = datetime.now(timezone.utc).replace(tzinfo=None)
        await db.commit()
        
        # Get user
        user_result = await db.execute(select(User).where(User.id == api_key_record.user_id))
        user = user_result.scalar_one_or_none()
        
        if not user or not user.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="User account is deactivated or missing",
            )
            
        user.used_api_key = api_key_record
        return user
        
    return get_api_key_user


def require_stock_balance_scope():
    async def get_api_key_user(
        request: Request = None,
        api_key: str = Depends(api_key_header),
        db: AsyncSession = Depends(get_db),
    ) -> User:
        if not api_key:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Missing X-API-Key header",
            )
        
        key_hash = hashlib.sha256(api_key.encode("utf-8")).hexdigest()
        
        result = await db.execute(select(ApiKey).where(ApiKey.key_hash == key_hash))
        api_key_record = result.scalar_one_or_none()
        
        if not api_key_record:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid API Key",
            )
            
        if not api_key_record.is_active:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="API Key is inactive",
            )
            
        if api_key_record.expires_at and api_key_record.expires_at < datetime.now(timezone.utc).replace(tzinfo=None):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="API Key has expired",
            )
            
        scopes = json.loads(api_key_record.scopes) if api_key_record.scopes else []
        
        has_access = "inventory:stock-balance:read" in scopes
        if not has_access:
            for s in scopes:
                if s.startswith("inventory:stock-balance:"):
                    has_access = True
                    break
                    
        if not has_access:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="API Key missing required scope: inventory:stock-balance:read or granular stock balance scope",
            )
            
        # Update last used
        api_key_record.last_used_at = datetime.now(timezone.utc).replace(tzinfo=None)
        await db.commit()
        
        # Get user
        user_result = await db.execute(select(User).where(User.id == api_key_record.user_id))
        user = user_result.scalar_one_or_none()
        
        if not user or not user.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="User account is deactivated or missing",
            )
            
        user.used_api_key = api_key_record
        return user
        
    return get_api_key_user


def require_items_scope():
    async def get_api_key_user(
        request: Request = None,
        api_key: str = Depends(api_key_header),
        db: AsyncSession = Depends(get_db),
    ) -> User:
        if not api_key:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Missing X-API-Key header",
            )
        
        key_hash = hashlib.sha256(api_key.encode("utf-8")).hexdigest()
        
        result = await db.execute(select(ApiKey).where(ApiKey.key_hash == key_hash))
        api_key_record = result.scalar_one_or_none()
        
        if not api_key_record:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid API Key",
            )
            
        if not api_key_record.is_active:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="API Key is inactive",
            )
            
        if api_key_record.expires_at and api_key_record.expires_at < datetime.now(timezone.utc).replace(tzinfo=None):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="API Key has expired",
            )
            
        scopes = json.loads(api_key_record.scopes) if api_key_record.scopes else []
        
        has_access = "masters:items:read" in scopes
        if not has_access:
            for s in scopes:
                if s.startswith("masters:items:"):
                    has_access = True
                    break
                    
        if not has_access:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="API Key missing required scope: masters:items:read or granular items scope",
            )
            
        # Update last used
        api_key_record.last_used_at = datetime.now(timezone.utc).replace(tzinfo=None)
        await db.commit()
        
        # Get user
        user_result = await db.execute(select(User).where(User.id == api_key_record.user_id))
        user = user_result.scalar_one_or_none()
        
        if not user or not user.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="User account is deactivated or missing",
            )
            
        user.used_api_key = api_key_record
        return user
        
    return get_api_key_user



# Roles that see every indent/PO/MR regardless of warehouse mapping.
# Anyone NOT in this set is scoped down to:
#  - documents they personally raised/created
#  - documents for warehouses listed in their user_warehouses mapping
MANAGERIAL_ROLES = frozenset({
    "super_admin", "admin",
    "warehouse_manager", "purchase_manager", "accounts_manager",
    "project_manager",
    "purchase_officer", "accounts_officer",
})


async def user_is_managerial(db: AsyncSession, user_id: int) -> bool:
    """True if user has any role that grants visibility across all warehouses."""
    codes = set(await get_user_role_codes(db, user_id))
    return bool(codes & MANAGERIAL_ROLES)


async def user_warehouse_ids(db: AsyncSession, user_id: int) -> List[int]:
    """Return the warehouse ids mapped to this user (possibly empty).
    Filters by user's active_role_id if set, including global (null role_id) assignments.
    Bypasses the active_role_id filter for STOREKEEPER position-based users.
    """
    from app.models.user import User, UserWarehouse
    from app.models.settings_master import Employee, Position
    from sqlalchemy import or_

    user = db.identity_map.get((User, user_id))
    if user is not None:
        active_role_id = user.active_role_id
    else:
        user_res = await db.execute(select(User.active_role_id).where(User.id == user_id))
        active_role_id = user_res.scalar_one_or_none()

    cache_key = (user_id, active_role_id)
    cached = _USER_WAREHOUSES_CACHE.get(cache_key)
    if cached is not None:
        return cached

    # Check if the user holds a STOREKEEPER position
    pos_res = await db.execute(
        select(Position.role_name)
        .join(Employee, Employee.position_id == Position.id)
        .join(User, User.employee_id == Employee.id)
        .where(User.id == user_id)
    )
    pos_role_name = pos_res.scalar_one_or_none()

    stmt = select(UserWarehouse.warehouse_id).where(UserWarehouse.user_id == user_id)
    if pos_role_name in ("STOREKEEPER", "LAB TECHNICIAN"):
        # Bypass active role filter to show all their mapped warehouses (their own warehouses)
        pass
    elif active_role_id is not None:
        stmt = stmt.where(or_(UserWarehouse.role_id == active_role_id, UserWarehouse.role_id.is_(None)))

    # Fetch raw role codes to check for "store_keeper" without the "storekeeper" normalisation collision
    if active_role_id is not None:
        r_res = await db.execute(
            select(Role.code)
            .where(Role.id == active_role_id)
            .where(Role.is_active == True)
        )
    else:
        r_res = await db.execute(
            select(Role.code)
            .join(UserRole, UserRole.role_id == Role.id)
            .where(UserRole.user_id == user_id)
            .where(Role.is_active == True)
        )
    raw_role_codes = [row[0] for row in r_res.all()]

    if "store_keeper" in raw_role_codes:
        from app.models.warehouse import Warehouse as _WhModel
        c_res = await db.execute(
            select(_WhModel.id).where(
                (_WhModel.name == "CENTRAL") | (_WhModel.code == "20070")
            )
        )
        central_wh_id = c_res.scalar_one_or_none()
        if central_wh_id is None:
            central_wh_id = 18  # default fallback
        
        result = await db.execute(stmt)
        mapped = [row[0] for row in result.all()]
        if central_wh_id not in mapped:
            mapped.append(central_wh_id)
        _USER_WAREHOUSES_CACHE.set(cache_key, mapped)
        return mapped

    result = await db.execute(stmt)
    mapped = [row[0] for row in result.all()]
    _USER_WAREHOUSES_CACHE.set(cache_key, mapped)
    return mapped


async def get_warehouse_and_descendants(db: AsyncSession, warehouse_ids: List[int]) -> List[int]:
    """Retrieve the given warehouse IDs along with all their child/descendant warehouse IDs recursively."""
    if not warehouse_ids:
        return []
    
    cache_key = tuple(sorted(warehouse_ids))
    cached = _WAREHOUSE_DESCENDANTS_CACHE.get(cache_key)
    if cached is not None:
        return cached

    from app.models.warehouse import Warehouse
    # Load active parent-child relationships
    result = await db.execute(
        select(Warehouse.id, Warehouse.parent_id).where(Warehouse.is_active == True)
    )
    all_whs = result.all()
    
    parent_to_children = {}
    for wh_id, parent_id in all_whs:
        if parent_id is not None:
            if parent_id not in parent_to_children:
                parent_to_children[parent_id] = []
            parent_to_children[parent_id].append(wh_id)
            
    descendants = set(warehouse_ids)
    queue = list(warehouse_ids)
    while queue:
        curr = queue.pop(0)
        children = parent_to_children.get(curr, [])
        for child in children:
            if child not in descendants:
                descendants.add(child)
                queue.append(child)
                
    res = list(descendants)
    _WAREHOUSE_DESCENDANTS_CACHE.set(cache_key, res)
    return res


async def get_user_warehouse_scope_ids(
    db: AsyncSession,
    user_id: int,
    *,
    super_admin_all: bool = True,
    exclude_virtual: bool = False,
) -> List[int]:
    """Return warehouse visibility for stock/transaction views.

    The list contains the user's mapped warehouses plus every active descendant
    warehouse. When enabled, super_admin gets every active warehouse.
    """
    from app.models.warehouse import Warehouse

    role_codes = set(await get_user_role_codes(db, user_id))
    if super_admin_all and "super_admin" in role_codes:
        stmt = select(Warehouse.id).where(Warehouse.is_active == True)  # noqa: E712
        if exclude_virtual:
            stmt = stmt.where(Warehouse.type != "virtual")
        result = await db.execute(stmt)
        return [row[0] for row in result.all()]

    assigned_whs = await user_warehouse_ids(db, user_id)
    scoped_whs = await get_warehouse_and_descendants(db, assigned_whs)

    # Always include top-level main warehouses (parent_id IS NULL, e.g. Mallavalli Main Warehouse)
    top_wh_res = await db.execute(
        select(Warehouse.id).where(Warehouse.is_active == True, Warehouse.parent_id.is_(None))
    )
    top_wh_ids = [row[0] for row in top_wh_res.all()]
    all_scoped = list(set(scoped_whs + top_wh_ids))

    if exclude_virtual and all_scoped:
        result = await db.execute(
            select(Warehouse.id).where(
                Warehouse.id.in_(all_scoped),
                Warehouse.type != "virtual",
            )
        )
        return [row[0] for row in result.all()]

    return all_scoped


# =============================================================
# Carrier portal authentication
# =============================================================
async def get_current_carrier_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db),
):
    """Extract the logged-in transport carrier (carrier_users row) from a
    JWT minted by /carrier-auth/login. Refuses regular employee tokens."""
    from app.models.carrier import CarrierUser

    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Carrier authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    payload = verify_access_token(credentials.credentials)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    # Check server-side token blocklist
    try:
        from app.models.user import TokenBlocklist
        token = credentials.credentials
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
        pass

    if not payload.get("carrier_portal"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="This token is not a carrier token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    carrier_id = payload.get("sub")
    if not carrier_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload")
    res = await db.execute(select(CarrierUser).where(CarrierUser.id == int(carrier_id)))
    cu = res.scalar_one_or_none()
    if not cu or not cu.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Carrier user not found or inactive")
    if cu.vendor is None or not cu.vendor.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Carrier vendor account is inactive")
    return cu


# =============================================================
# Vendor (material supplier) portal authentication
# =============================================================
async def get_current_vendor_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db),
):
    """Extract the logged-in material supplier (vendor_users row) from a
    JWT minted by /vendor-auth/login. Refuses employee and carrier tokens."""
    from app.models.vendor_portal import VendorUser

    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Supplier portal authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    payload = verify_access_token(credentials.credentials)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    # Check server-side token blocklist
    try:
        from app.models.user import TokenBlocklist
        token = credentials.credentials
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
        pass

    if not payload.get("vendor_portal"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="This token is not a supplier portal token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    vendor_user_id = payload.get("sub")
    if not vendor_user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload")
    res = await db.execute(select(VendorUser).where(VendorUser.id == int(vendor_user_id)))
    vu = res.scalar_one_or_none()
    if not vu or not vu.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Supplier user not found or inactive")
    if vu.vendor is None or not vu.vendor.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Supplier vendor account is inactive")
    return vu
