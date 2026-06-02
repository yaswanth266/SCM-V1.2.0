from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.models.carrier import CarrierUser
from app.models.master import Vendor
from app.schemas.carrier_auth import (
    CarrierLoginRequest, CarrierTokenResponse, CarrierUserResponse, CarrierChangePassword,
)
from app.services.auth_service import (
    hash_password, verify_password, create_access_token,
)
from app.utils.dependencies import get_current_carrier_user
from app.config import settings

router = APIRouter()

_LOCKOUT_THRESHOLD = 5
_LOCKOUT_MINUTES = 15
_DUMMY_BCRYPT = "$2b$12$CwTycUXWue0Thq9StjUM0uJ8wW3GtsKzgYBWvP9oKzqW1xk9pqH8."


def _build_carrier_user_response(cu: CarrierUser) -> CarrierUserResponse:
    return CarrierUserResponse(
        id=cu.id,
        vendor_id=cu.vendor_id,
        vendor_name=cu.vendor.name if cu.vendor else None,
        vendor_code=cu.vendor.vendor_code if cu.vendor else None,
        username=cu.username,
        email=cu.email,
        full_name=cu.full_name,
        phone=cu.phone,
        is_active=cu.is_active,
        must_change_password=cu.must_change_password,
        last_login=cu.last_login,
        created_at=cu.created_at,
    )


@router.post("/login", response_model=CarrierTokenResponse)
async def carrier_login(
    request: Request,
    payload: CarrierLoginRequest,
    db: AsyncSession = Depends(get_db),
):
    identifier = payload.username.strip()
    ident_lower = identifier.lower()
    res = await db.execute(
        select(CarrierUser).where(
            (func.lower(CarrierUser.username) == ident_lower)
            | (func.lower(CarrierUser.email) == ident_lower)
        )
    )
    cu = res.scalar_one_or_none()

    if cu is None:
        try:
            verify_password(payload.password, _DUMMY_BCRYPT)
        except Exception:
            pass

    # Account lockout check
    if cu is not None and cu.locked_until is not None:
        cutoff = cu.locked_until
        if cutoff.tzinfo is None:
            cutoff = cutoff.replace(tzinfo=timezone.utc)
        if cutoff > datetime.now(timezone.utc):
            raise HTTPException(status_code=401, detail="Invalid username or password")

    if not cu or not cu.is_active or not verify_password(payload.password, cu.password_hash):
        # Vendor must also be active
        if cu is not None and cu.vendor is not None and not cu.vendor.is_active:
            raise HTTPException(status_code=401, detail="Invalid username or password")
        if cu is not None:
            cu.failed_login_attempts = (cu.failed_login_attempts or 0) + 1
            if cu.failed_login_attempts >= _LOCKOUT_THRESHOLD:
                cu.locked_until = datetime.now(timezone.utc) + timedelta(minutes=_LOCKOUT_MINUTES)
            try:
                await db.commit()
            except Exception:
                await db.rollback()
        raise HTTPException(status_code=401, detail="Invalid username or password")

    # Vendor must be active to allow login
    if cu.vendor is None or not cu.vendor.is_active:
        raise HTTPException(status_code=403, detail="Carrier account is inactive")

    cu.failed_login_attempts = 0
    cu.locked_until = None
    cu.last_login = datetime.now(timezone.utc)
    await db.flush()

    token_data = {
        "sub": str(cu.id),
        "username": cu.username,
        "carrier_portal": True,
        "vendor_id": cu.vendor_id,
    }
    access_token = create_access_token(token_data)
    await db.commit()

    return CarrierTokenResponse(
        access_token=access_token,
        expires_in=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        user=_build_carrier_user_response(cu),
    )


@router.get("/me", response_model=CarrierUserResponse)
async def carrier_me(
    current_carrier: CarrierUser = Depends(get_current_carrier_user),
):
    return _build_carrier_user_response(current_carrier)


@router.post("/logout")
async def carrier_logout(
    current_carrier: CarrierUser = Depends(get_current_carrier_user),
):
    # Stateless logout — frontend drops the token. (No blocklist for carrier
    # tokens to keep this simple; tokens have a short TTL.)
    return {"success": True, "message": "Logged out"}


@router.post("/change-password")
async def carrier_change_password(
    payload: CarrierChangePassword,
    current_carrier: CarrierUser = Depends(get_current_carrier_user),
    db: AsyncSession = Depends(get_db),
):
    if not verify_password(payload.current_password, current_carrier.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    if verify_password(payload.new_password, current_carrier.password_hash):
        raise HTTPException(status_code=400, detail="New password must differ from the current password")
    current_carrier.password_hash = hash_password(payload.new_password)
    current_carrier.password_changed_at = datetime.now(timezone.utc)
    current_carrier.must_change_password = False
    await db.commit()
    return {"success": True, "message": "Password changed successfully"}
