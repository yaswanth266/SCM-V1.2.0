from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel, EmailStr, field_validator
import re


class CarrierLoginRequest(BaseModel):
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


class CarrierUserResponse(BaseModel):
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


class CarrierTokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: CarrierUserResponse


class CarrierChangePassword(BaseModel):
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


# ---------- Carrier (Vendor) CRUD schemas (coordinator-side) ----------

class CarrierCreate(BaseModel):
    vendor_code: Optional[str] = None
    name: str
    contact_person: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    rating: Optional[float] = 4.0
    payment_terms_days: Optional[int] = 30
    vehicle_types: Optional[List[str]] = None

    @field_validator("name")
    @classmethod
    def _name_required(cls, v):
        if not v or not v.strip():
            raise ValueError("Carrier name is required")
        return v.strip()[:255]


class CarrierUpdate(BaseModel):
    name: Optional[str] = None
    contact_person: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    rating: Optional[float] = None
    payment_terms_days: Optional[int] = None
    is_active: Optional[bool] = None


class CarrierLoginCreate(BaseModel):
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


class CarrierLoginUpdate(BaseModel):
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


# ---------- Carrier-side quote (portal) ----------

class CarrierQuoteSubmit(BaseModel):
    """Slim carrier-portal quote payload. Vehicle/SDO breakdown is
    auto-derived from the RFQ's mappings — carriers only set price &
    fleet primary fields."""
    totalQuotedPrice: float
    paymentTerms: Optional[str] = "30 days credit"
    advancePercentage: Optional[float] = 0
    remarks: Optional[str] = None
    vehicleType: Optional[str] = None
    registrationNo: Optional[str] = None
    driverName: Optional[str] = None
    driverMobile: Optional[str] = None
    driverLicense: Optional[str] = None
    capacityKg: Optional[float] = 10000
    capacityCft: Optional[float] = 750
    gpsEnabled: Optional[bool] = True


class CarrierDeclineRfq(BaseModel):
    reason: Optional[str] = "Fleet unavailable"
