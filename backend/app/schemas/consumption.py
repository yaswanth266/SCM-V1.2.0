from pydantic import BaseModel, field_validator
from typing import List, Literal, Optional
from datetime import datetime, date
from decimal import Decimal
import re


# BUG-ISS-035 — `source` was a free `str`; arbitrary values caused 500s when the
# DB enum rejected them. BUG-ISS-039 — web client must not be able to fake
# `mobile_app` source. Constrain to the canonical set + use `web` default.
ConsumptionSource = Literal["web", "mobile_app"]


def _verhoeff_check(num: str) -> bool:
    """BUG-ISS-038 — Verhoeff checksum used by UIDAI for Aadhaar.

    Returns True if `num` (12 digits, no separators) passes the Verhoeff
    check. Pure-Python implementation; no external dependency.
    """
    if not num or not num.isdigit() or len(num) != 12:
        return False
    d_table = (
        (0,1,2,3,4,5,6,7,8,9),
        (1,2,3,4,0,6,7,8,9,5),
        (2,3,4,0,1,7,8,9,5,6),
        (3,4,0,1,2,8,9,5,6,7),
        (4,0,1,2,3,9,5,6,7,8),
        (5,9,8,7,6,0,4,3,2,1),
        (6,5,9,8,7,1,0,4,3,2),
        (7,6,5,9,8,2,1,0,4,3),
        (8,7,6,5,9,3,2,1,0,4),
        (9,8,7,6,5,4,3,2,1,0),
    )
    p_table = (
        (0,1,2,3,4,5,6,7,8,9),
        (1,5,7,6,2,8,3,0,9,4),
        (5,8,0,3,7,9,6,1,4,2),
        (8,9,1,6,0,4,3,5,2,7),
        (9,4,5,3,1,2,6,8,7,0),
        (4,2,8,6,5,7,3,9,0,1),
        (2,7,9,3,8,0,6,4,1,5),
        (7,0,4,6,9,1,3,2,5,8),
    )
    c = 0
    for i, ch in enumerate(reversed(num)):
        c = d_table[c][p_table[i % 8][int(ch)]]
    return c == 0


class ConsumptionItemCreate(BaseModel):
    item_id: int
    batch_id: Optional[int] = None
    qty: Decimal
    uom_id: int
    rate: Decimal = Decimal("0")
    remarks: Optional[str] = None

    @field_validator("qty")
    @classmethod
    def val_qty(cls, v):
        if v is not None and v <= 0:
            raise ValueError("Consumption quantity must be greater than zero")
        return v

    @field_validator("rate")
    @classmethod
    def val_rate(cls, v):
        if v is not None and v < 0:
            raise ValueError("Rate cannot be negative")
        return v

class ConsumptionCreate(BaseModel):
    project_id: Optional[int] = None
    warehouse_id: Optional[int] = None
    consumption_date: date
    department: Optional[str] = None
    cost_center: Optional[str] = None
    # BUG-ISS-035 — constrain to known enum values so DB doesn't 500.
    source: ConsumptionSource = "web"
    case_id: Optional[str] = None
    patient_name: Optional[str] = None
    patient_aadhaar: Optional[str] = None
    remarks: Optional[str] = None
    items: List[ConsumptionItemCreate]

    @field_validator("items")
    @classmethod
    def val_items(cls, v):
        if not v or len(v) == 0:
            raise ValueError("At least one item is required")
        return v

    @field_validator("consumption_date")
    @classmethod
    def val_date(cls, v):
        # Allow +1 day slack so IST clients (UTC+5:30) don't hit false
        # "future" errors when the server is running in UTC.
        from datetime import timedelta
        if v is not None and v > date.today() + timedelta(days=1):
            raise ValueError("Consumption date cannot be in the future")
        # BUG-ISS-026 — block arbitrary back-dating. 90 days lower bound matches
        # MaterialIssue policy and prevents fraudulent retro-entries.
        if v is not None and v < date.today() - timedelta(days=90):
            raise ValueError("Consumption date cannot be more than 90 days in the past")
        return v

    @field_validator("patient_aadhaar", mode="before")
    @classmethod
    def validate_aadhaar(cls, v):
        if v is not None:
            cleaned = re.sub(r"[\s-]", "", str(v))
            if not re.match(r"^\d{12}$", cleaned):
                raise ValueError("Aadhaar must be a 12-digit number")
            # BUG-ISS-038 — also reject obviously invalid sequences (000.., or
            # numbers failing the Verhoeff checksum that UIDAI mandates).
            if cleaned == "000000000000" or not _verhoeff_check(cleaned):
                raise ValueError("Aadhaar number failed checksum validation")
            return cleaned
        return v

class ConsumptionUpdate(BaseModel):
    project_id: Optional[int] = None
    warehouse_id: Optional[int] = None
    consumption_date: Optional[date] = None
    department: Optional[str] = None
    cost_center: Optional[str] = None
    case_id: Optional[str] = None
    patient_name: Optional[str] = None
    # BUG-ISS-053 — was missing entirely so callers had no way to correct
    # an Aadhaar typo on a draft consumption. Same masking + validation
    # rules as ConsumptionCreate apply.
    patient_aadhaar: Optional[str] = None
    # BUG-ISS-035 — same Literal constraint as create.
    source: Optional[ConsumptionSource] = None
    status: Optional[str] = None
    remarks: Optional[str] = None
    # When provided, replaces all existing items on the entry. Only allowed
    # while the entry is still in draft status (handler enforces).
    items: Optional[List[ConsumptionItemCreate]] = None

    @field_validator("patient_aadhaar", mode="before")
    @classmethod
    def validate_aadhaar(cls, v):
        if v is not None:
            cleaned = re.sub(r"[\s-]", "", str(v))
            if not re.match(r"^\d{12}$", cleaned):
                raise ValueError("Aadhaar must be a 12-digit number")
            # BUG-ISS-038 — reject all-zero / non-Verhoeff patterns.
            if cleaned == "000000000000" or not _verhoeff_check(cleaned):
                raise ValueError("Aadhaar number failed checksum validation")
            return cleaned
        return v

class ConsumptionItemResponse(BaseModel):
    id: int
    item_id: int
    batch_id: Optional[int] = None
    qty: Decimal
    uom_id: int
    rate: Decimal
    amount: Decimal
    remarks: Optional[str] = None
    model_config = {"from_attributes": True}

class ConsumptionResponse(BaseModel):
    id: int
    entry_number: str
    project_id: Optional[int] = None
    warehouse_id: Optional[int] = None
    consumption_date: datetime
    department: Optional[str] = None
    cost_center: Optional[str] = None
    consumed_by: int
    source: str
    case_id: Optional[str] = None
    patient_name: Optional[str] = None
    patient_aadhaar: Optional[str] = None
    status: str
    remarks: Optional[str] = None
    created_at: Optional[datetime] = None
    items: List[ConsumptionItemResponse] = []
    model_config = {"from_attributes": True}

    @field_validator("patient_aadhaar", mode="before")
    @classmethod
    def mask_aadhaar(cls, v):
        # BUG-ISS-048 — last-4 leak. Even masked digits enable
        # re-identification when combined with name + DOB + clinic. Show only
        # whether an Aadhaar is on file, not any portion of it.
        if v:
            return "XXXX-XXXX-XXXX"
        return v

    # BUG-ISS-046 — patient_name was returned plain text in list+detail.
    # Mask to first-initial + dot to prevent re-identification while still
    # giving operators enough context to disambiguate. Authorized roles
    # (super_admin/admin/clinical) should use a separate endpoint that
    # exposes the full name.
    @field_validator("patient_name", mode="before")
    @classmethod
    def mask_patient_name(cls, v):
        if not v:
            return v
        s = str(v).strip()
        if not s:
            return s
        first = s.split()[0]
        return f"{first[0].upper()}." if first else s
