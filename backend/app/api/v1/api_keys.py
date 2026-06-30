from datetime import datetime, timezone
import secrets
import string
import hashlib
import json
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status, Request
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User, ApiKey, UserRole
from app.schemas.api_key import ApiKeyCreate, ApiKeyResponse, ApiKeyReveal
from app.utils.dependencies import get_current_user

router = APIRouter()

def generate_api_key() -> str:
    """Generate a random 32-character API key"""
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for i in range(32))

def hash_api_key(key: str) -> str:
    """Hash the API key using SHA-256"""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()

@router.post("", response_model=ApiKeyReveal)
async def create_api_key(
    payload: ApiKeyCreate,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Create a new API Key for the current user.
    The raw key is returned ONLY once in the response.
    """
    raw_key = generate_api_key()
    key_hash = hash_api_key(raw_key)

    linked_user_ids = list(payload.linked_user_ids or [])
    if payload.linked_role_ids:
        result = await db.execute(
            select(UserRole.user_id).where(UserRole.role_id.in_(payload.linked_role_ids))
        )
        role_user_ids = {row[0] for row in result.all()}
        linked_user_ids = list(set(linked_user_ids) | role_user_ids)

    # Auto-generate URL endpoints based on scopes
    # Full mapping: every scope offered in the UI → its external route path
    SCOPE_TO_PATH = {
        "masters:items:read":           "/api/v1/external/masters/items",
        "masters:vendors:read":         "/api/v1/external/masters/vendors",
        "masters:warehouses:read":      "/api/v1/external/masters/warehouses",
        "masters:packaging:read":        "/api/v1/external/masters/packaging",
        "masters:categories:read":      "/api/v1/external/masters/categories",
        "masters:uom:read":             "/api/v1/external/masters/uom",
        "masters:brands:read":          "/api/v1/external/masters/brands",
        "masters:features:read":        "/api/v1/external/masters/features",
        "masters:item-types:read":      "/api/v1/external/masters/item-types",
        "masters:attributes:read":      "/api/v1/external/masters/attributes",
        "masters:users:read":           "/api/v1/external/masters/users",
        "masters:vendor-mapping:read":  "/api/v1/external/masters/vendors",
        "masters:user-mapping:read":    "/api/v1/external/masters/users",
        "inventory:stock-balance:read": "/api/v1/external/inventory/stock",
        "inventory:stock-ledger:read":  "/api/v1/external/inventory/stock-ledger",
        "indent:acknowledgement:read":  "/api/v1/external/indent/acknowledgements",
    }

    scopes_list = payload.scopes or []
    seen_paths = set()
    deduped_paths = []
    for scope in scopes_list:
        # Exact match
        path = SCOPE_TO_PATH.get(scope)
        if path is None:
            # Granular items scope (e.g. masters:items:CONSUMABLE:read)
            if scope.startswith("masters:items:") and scope.endswith(":read"):
                path = "/api/v1/external/masters/items"
            # Granular stock-balance scope
            elif scope.startswith("inventory:stock-balance:") and scope.endswith(":read"):
                path = "/api/v1/external/inventory/stock"
        if path and path not in seen_paths:
            seen_paths.add(path)
            deduped_paths.append(path)

    base_url = str(request.base_url).rstrip("/")
    generated_endpoint = ", ".join(f"{base_url}{p}" for p in deduped_paths) if deduped_paths else None

    new_key = ApiKey(
        user_id=current_user.id,
        name=payload.name,
        key_hash=key_hash,
        scopes=json.dumps(payload.scopes) if payload.scopes else "[]",
        linked_user_ids=linked_user_ids,
        endpoint=generated_endpoint,
        expires_at=payload.expires_at,
        is_active=True,
    )

    db.add(new_key)

    await db.commit()
    await db.refresh(new_key)
    
    # Parse scopes back to list for response
    parsed_scopes = json.loads(new_key.scopes) if new_key.scopes else []

    linked_ids = new_key.linked_user_ids
    if isinstance(linked_ids, str):
        try:
            linked_ids = json.loads(linked_ids)
        except Exception:
            linked_ids = []
    return ApiKeyReveal(
        id=new_key.id,
        name=new_key.name,
        scopes=parsed_scopes,
        linked_user_ids=linked_ids or [],
        endpoint=new_key.endpoint,
        expires_at=new_key.expires_at,
        is_active=new_key.is_active,
        last_used_at=new_key.last_used_at,
        created_at=new_key.created_at,
        raw_key=raw_key,
    )

@router.get("", response_model=List[ApiKeyResponse])
async def list_api_keys(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List all API keys for the current user."""
    result = await db.execute(
        select(ApiKey).where(ApiKey.user_id == current_user.id).order_by(ApiKey.created_at.desc())
    )
    keys = result.scalars().all()
    
    response_keys = []
    for key in keys:
        parsed_scopes = json.loads(key.scopes) if key.scopes else []
        linked_ids = key.linked_user_ids
        if isinstance(linked_ids, str):
            try:
                linked_ids = json.loads(linked_ids)
            except Exception:
                linked_ids = []
        response_keys.append(
            ApiKeyResponse(
                id=key.id,
                name=key.name,
                scopes=parsed_scopes,
                linked_user_ids=linked_ids or [],
                endpoint=key.endpoint,
                expires_at=key.expires_at,
                is_active=key.is_active,
                last_used_at=key.last_used_at,
                created_at=key.created_at,
            )
        )
        
    return response_keys

@router.delete("/{key_id}")
async def revoke_api_key(
    key_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Revoke (delete) an API key."""
    result = await db.execute(
        select(ApiKey).where(ApiKey.id == key_id, ApiKey.user_id == current_user.id)
    )
    key = result.scalar_one_or_none()

    if not key:
        raise HTTPException(status_code=404, detail="API Key not found")

    await db.delete(key)
    await db.commit()
    return {"success": True, "message": "API Key revoked successfully"}


# Shared helper: compute endpoint string from a list of scope strings + base URL
def _compute_endpoint(scopes_list: list, base_url: str) -> str | None:
    SCOPE_TO_PATH = {
        "masters:items:read":           "/api/v1/external/masters/items",
        "masters:vendors:read":         "/api/v1/external/masters/vendors",
        "masters:warehouses:read":      "/api/v1/external/masters/warehouses",
        "masters:packaging:read":       "/api/v1/external/masters/packaging",
        "masters:categories:read":      "/api/v1/external/masters/categories",
        "masters:uom:read":             "/api/v1/external/masters/uom",
        "masters:brands:read":          "/api/v1/external/masters/brands",
        "masters:features:read":        "/api/v1/external/masters/features",
        "masters:item-types:read":      "/api/v1/external/masters/item-types",
        "masters:attributes:read":      "/api/v1/external/masters/attributes",
        "masters:users:read":           "/api/v1/external/masters/users",
        "masters:vendor-mapping:read":  "/api/v1/external/masters/vendors",
        "masters:user-mapping:read":    "/api/v1/external/masters/users",
        "inventory:stock-balance:read": "/api/v1/external/inventory/stock",
        "inventory:stock-ledger:read":  "/api/v1/external/inventory/stock-ledger",
        "indent:acknowledgement:read":  "/api/v1/external/indent/acknowledgements",
    }
    seen = set()
    paths = []
    for scope in scopes_list:
        path = SCOPE_TO_PATH.get(scope)
        if path is None:
            if scope.startswith("masters:items:") and scope.endswith(":read"):
                path = "/api/v1/external/masters/items"
            elif scope.startswith("inventory:stock-balance:") and scope.endswith(":read"):
                path = "/api/v1/external/inventory/stock"
        if path and path not in seen:
            seen.add(path)
            paths.append(path)
    return ", ".join(f"{base_url}{p}" for p in paths) if paths else None


@router.patch("/{key_id}/refresh-endpoint")
async def refresh_api_key_endpoint(
    key_id: int,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Recompute and save the URL endpoint for an existing API key.

    Useful for keys created before all scopes had a mapped external URL —
    calling this will populate the 'URL Endpoint' column without revoking/re-generating.
    """
    result = await db.execute(
        select(ApiKey).where(ApiKey.id == key_id, ApiKey.user_id == current_user.id)
    )
    key = result.scalar_one_or_none()
    if not key:
        raise HTTPException(status_code=404, detail="API Key not found")

    scopes_list = json.loads(key.scopes) if key.scopes else []
    base_url = str(request.base_url).rstrip("/")
    key.endpoint = _compute_endpoint(scopes_list, base_url)
    await db.commit()
    return {"success": True, "endpoint": key.endpoint}
