from datetime import datetime, date
from decimal import Decimal
from typing import Optional, List
from pydantic import BaseModel, EmailStr, field_validator
import re


class VendorLoginRequest(BaseModel):
    username: str
    password: str

    @field_validator("username")
    @classmethod
    def _username_nonempty(cls, v):
        if not v or not v.strip():
            raise ValueError("Username is required")
        if len(v) > 100:
            raise ValueError("Username too long")
        return v.strip()

    @field_validator("password")
    @classmethod
    def _password_nonempty(cls, v):
        if not v:
            raise ValueError("Password is required")
        if len(v) > 128:
            raise ValueError("Password too long")
        return v


class VendorUserResponse(BaseModel):
    id: int
    vendor_id: int
    vendor_name: Optional[str] = None
    vendor_code: Optional[str] = None
    username: str
    email: str
    full_name: Optional[str] = None
    phone: Optional[str] = None
    is_active: bool
    must_change_password: bool
    last_login: Optional[datetime] = None
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class VendorTokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: VendorUserResponse


class VendorChangePassword(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def _strength(cls, v):
        if not v or len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        if len(v) > 128:
            raise ValueError("Password too long")
        if not re.search(r"[A-Z]", v):
            raise ValueError("Password must contain at least one uppercase letter")
        if not re.search(r"[a-z]", v):
            raise ValueError("Password must contain at least one lowercase letter")
        if not re.search(r"\d", v):
            raise ValueError("Password must contain at least one digit")
        return v


# ---------- Vendor CRUD schemas (coordinator-side) ----------

class VendorLoginCreate(BaseModel):
    username: str
    email: EmailStr
    password: str
    full_name: Optional[str] = None
    phone: Optional[str] = None

    @field_validator("username")
    @classmethod
    def _username_format(cls, v):
        v = (v or "").strip()
        if len(v) < 3:
            raise ValueError("Username must be at least 3 characters")
        if len(v) > 100:
            raise ValueError("Username too long")
        if not re.match(r"^[a-zA-Z0-9_.\-]+$", v):
            raise ValueError("Username can only contain letters, numbers, dot, dash, underscore")
        return v

    @field_validator("password")
    @classmethod
    def _password_strength(cls, v):
        if not v or len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        if len(v) > 128:
            raise ValueError("Password too long")
        if not re.search(r"[A-Z]", v):
            raise ValueError("Password must contain at least one uppercase letter")
        if not re.search(r"[a-z]", v):
            raise ValueError("Password must contain at least one lowercase letter")
        if not re.search(r"\d", v):
            raise ValueError("Password must contain at least one digit")
        return v


class VendorLoginUpdate(BaseModel):
    is_active: Optional[bool] = None
    new_password: Optional[str] = None
    email: Optional[EmailStr] = None
    full_name: Optional[str] = None
    phone: Optional[str] = None

    @field_validator("new_password")
    @classmethod
    def _password_strength(cls, v):
        if v is None:
            return v
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        if not re.search(r"[A-Z]", v) or not re.search(r"[a-z]", v) or not re.search(r"\d", v):
            raise ValueError("Password must contain upper, lower, and digit")
        return v


# ---------- Supplier-side quotation submission (portal) ----------

class SupplierQuoteItem(BaseModel):
    """Per-item quotation pricing submitted by the supplier."""
    item_id: int
    qty: Decimal
    uom_id: int
    rate: Decimal
    discount_pct: Optional[Decimal] = Decimal("0")
    tax_rate: Optional[Decimal] = Decimal("0")
    cgst_rate: Optional[Decimal] = Decimal("0")
    sgst_rate: Optional[Decimal] = Decimal("0")
    igst_rate: Optional[Decimal] = Decimal("0")
    expected_delivery: Optional[date] = None
    remarks: Optional[str] = None


class SupplierQuoteSubmit(BaseModel):
    """Full quotation payload submitted by supplier from the portal."""
    items: List[SupplierQuoteItem]
    delivery_days: Optional[int] = None
    payment_terms: Optional[str] = None
    valid_until: Optional[date] = None
    remarks: Optional[str] = None
    with_vehicle: Optional[bool] = False
    vehicle_cost: Optional[Decimal] = Decimal("0")


class SupplierDeclineRfq(BaseModel):
    reason: Optional[str] = "Unable to supply at this time"
