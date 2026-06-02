from pydantic import BaseModel, Field, field_validator, model_validator
from typing import List, Optional
from datetime import datetime, date
from decimal import Decimal
import re

# VALID_ITEM_TYPES removed — item types are now managed via the item_types table
VALID_VENDOR_TYPES = ("material", "transport", "service", "both")
VALID_BARCODE_TYPES = ("qrcode", "barcode_128", "barcode_ean13", "auto")
VALID_VALUATION_METHODS = ("fifo", "lifo", "weighted_average", "moving_average")
VALID_WAREHOUSE_TYPES = ("main", "sub", "transit", "quarantine", "returns")
VALID_PRICE_LIST_TYPES = ("buying", "selling")

GST_PATTERN = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$")
PHONE_PATTERN = re.compile(r"^[0-9+\-\s()]{6,20}$")
EMAIL_PATTERN = re.compile(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$")
PINCODE_PATTERN = re.compile(r"^[0-9]{5,10}$")
# BUG-PRO-104 fix: format-validate PAN (Indian Permanent Account Number).
# 5 letters + 4 digits + 1 letter, e.g. ABCDE1234F.
PAN_PATTERN = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]{1}$")


def _strip_or_none(v, max_len=255):
    if v is None:
        return None
    v = str(v).strip()
    return v[:max_len] if v else None


def _require_non_empty(v, field_name):
    if not v or not str(v).strip():
        raise ValueError(f"{field_name} is required and cannot be empty")
    return str(v).strip()


def _legacy_vendor_type(v):
    if v is None:
        return v
    raw = str(v).strip().lower()
    if not raw:
        return raw
    if raw in VALID_VENDOR_TYPES:
        return raw
    if raw == "both" or "both" in raw:
        return "both"
    if raw.startswith("trans") or "transport" in raw or "logistics" in raw:
        return "transport"
    if raw.startswith("serv") or "service" in raw:
        return "service"
    return "material"


# ===================== UOM =====================

class UOMCategoryCreate(BaseModel):
    name: str
    description: Optional[str] = None
    base_uom_id: Optional[int] = None
    is_active: Optional[bool] = None

    @field_validator("name")
    @classmethod
    def val_name(cls, v):
        v = _require_non_empty(v, "UOM category name")
        if len(v) > 100:
            raise ValueError("UOM category name cannot exceed 100 characters")
        return v

    @field_validator("description")
    @classmethod
    def val_desc(cls, v):
        return _strip_or_none(v, 500)


class UOMCategoryResponse(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    base_uom_id: Optional[int] = None
    base_uom_name: Optional[str] = None
    base_uom_abbreviation: Optional[str] = None
    is_active: bool
    status: Optional[str] = None
    model_config = {"from_attributes": True}

    @model_validator(mode="after")
    def compute_status(self):
        self.status = "active" if self.is_active else "inactive"
        base_uom = getattr(self, "base_uom", None)
        if base_uom:
            self.base_uom_name = base_uom.name
            self.base_uom_abbreviation = base_uom.abbreviation
        return self


class UOMCreate(BaseModel):
    name: str
    abbreviation: str
    category_id: Optional[int] = None
    # BUG-FE-085: accept is_active so the UI Status toggle actually persists.
    is_active: Optional[bool] = None

    @field_validator("name")
    @classmethod
    def val_name(cls, v):
        v = _require_non_empty(v, "UOM name")
        if len(v) > 100:
            raise ValueError("UOM name cannot exceed 100 characters")
        return v

    @field_validator("abbreviation")
    @classmethod
    def val_abbr(cls, v):
        v = _require_non_empty(v, "Abbreviation")
        if len(v) > 50:
            raise ValueError("Abbreviation cannot exceed 50 characters")
        return v


class UOMResponse(BaseModel):
    id: int
    category_id: Optional[int] = None
    category_name: Optional[str] = None
    name: str
    abbreviation: str
    is_active: bool
    status: Optional[str] = None
    model_config = {"from_attributes": True}

    @model_validator(mode="after")
    def compute_status(self):
        self.status = "active" if self.is_active else "inactive"
        category = getattr(self, "category", None)
        if category and not self.category_name:
            self.category_name = category.name
        return self


class UOMConversionCreate(BaseModel):
    from_uom_id: int
    to_uom_id: int
    category_id: Optional[int] = None
    factor_num: Optional[Decimal] = None
    factor_den: Optional[Decimal] = None
    conversion_factor: Optional[Decimal] = None
    valid_from: Optional[datetime] = None
    valid_to: Optional[datetime] = None
    is_system: Optional[bool] = None

    @field_validator("conversion_factor")
    @classmethod
    def val_factor(cls, v):
        if v is None:
            return v
        if v <= 0:
            raise ValueError("Conversion factor must be greater than 0")
        return v

    @model_validator(mode="after")
    def val_fraction(self):
        if self.factor_num is None and self.conversion_factor is None:
            raise ValueError("Either factor_num/factor_den or conversion_factor is required")
        if self.factor_num is not None and self.factor_num <= 0:
            raise ValueError("factor_num must be greater than 0")
        if self.factor_den is not None and self.factor_den <= 0:
            raise ValueError("factor_den must be greater than 0")
        return self


class ItemUOMConversionCreate(BaseModel):
    item_id: int
    from_uom_id: int
    to_uom_id: int
    conversion_type: Optional[str] = None
    factor_num: Optional[Decimal] = None
    factor_den: Optional[Decimal] = None
    conversion_factor: Optional[Decimal] = None
    valid_from: Optional[datetime] = None
    valid_to: Optional[datetime] = None
    is_active: Optional[bool] = None

    @model_validator(mode="after")
    def val_factor(self):
        if self.from_uom_id == self.to_uom_id:
            raise ValueError("from_uom and to_uom must be different")
        if self.factor_num is None and self.conversion_factor is None:
            raise ValueError("Either factor_num/factor_den or conversion_factor is required")
        if self.factor_num is not None and self.factor_num <= 0:
            raise ValueError("factor_num must be greater than 0")
        if self.factor_den is not None and self.factor_den <= 0:
            raise ValueError("factor_den must be greater than 0")
        if self.conversion_factor is not None and self.conversion_factor <= 0:
            raise ValueError("conversion_factor must be greater than 0")
        return self


# ===================== CATEGORY =====================

class CategoryCreate(BaseModel):
    name: str
    code: Optional[str] = None
    short_code: Optional[str] = None
    parent_id: Optional[int] = None
    description: Optional[str] = None
    level: int = 0

    @field_validator("name")
    @classmethod
    def val_name(cls, v):
        return _require_non_empty(v, "Category name")[:255]

    @field_validator("short_code")
    @classmethod
    def val_short_code(cls, v):
        if v is None:
            return v
        v = _require_non_empty(v, "Short code")
        if not re.match(r"^[1-9][0-9]$", v):
            raise ValueError("Short code must be a two-digit number from 10 to 99")
        return v

    @field_validator("description")
    @classmethod
    def val_desc(cls, v):
        return _strip_or_none(v, 500)


class CategoryResponse(BaseModel):
    id: int
    parent_id: Optional[int] = None
    name: str
    code: str
    short_code: Optional[str] = None
    full_code: Optional[str] = None
    description: Optional[str] = None
    level: int
    is_active: bool
    status: Optional[str] = None
    model_config = {"from_attributes": True}

    @model_validator(mode="after")
    def compute_status(self):
        self.status = "active" if self.is_active else "inactive"
        return self


# ===================== ITEM TYPE =====================

class ItemTypeCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = None
    is_active: bool = True

    @field_validator("name")
    @classmethod
    def val_name(cls, v):
        return _require_non_empty(v, "Item type name")[:100]


class ItemTypeResponse(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    is_active: bool
    status: Optional[str] = None
    model_config = {"from_attributes": True}

    @model_validator(mode="after")
    def compute_status(self):
        self.status = "active" if self.is_active else "inactive"
        return self


# ===================== FEATURE =====================

class FeatureCreate(BaseModel):
    category_id: int
    name: str = Field(..., min_length=1, max_length=255)
    is_active: bool = True

    @field_validator("name")
    @classmethod
    def val_name(cls, v):
        return _require_non_empty(v, "Feature name")[:255]


class FeatureResponse(BaseModel):
    id: int
    category_id: int
    name: str
    is_active: bool
    status: Optional[str] = None
    model_config = {"from_attributes": True}

    @model_validator(mode="after")
    def compute_status(self):
        self.status = "active" if self.is_active else "inactive"
        return self


# ===================== ITEM =====================

class ItemCreate(BaseModel):
    category_id: Optional[int] = None
    feature_id: Optional[int] = None
    feature_ids: Optional[List[int]] = None
    item_code: Optional[str] = None  # Wave 11A — blank/AUTO triggers BHSPL-PH-MED-T-0001 generation
    name: str
    # Bug fix D-006 — Wave 7 columns must be in Create schema or they're dropped.
    # Without these the H1 prescriber gate cannot identify restricted items.
    drug_schedule: Optional[str] = None  # X / H / H1 / G / OTC / none
    is_schedule_h1: bool = False
    is_narcotic: bool = False
    requires_prescription: bool = False
    requires_cold_chain: bool = False
    min_storage_temp_c: Optional[Decimal] = None
    max_storage_temp_c: Optional[Decimal] = None
    regulatory_notes: Optional[str] = None
    description: Optional[str] = None
    item_type: str
    uom_category_id: Optional[int] = None
    primary_uom_id: int
    secondary_uom_id: Optional[int] = None
    hsn_code: Optional[str] = None
    sku: Optional[str] = None
    barcode_type: str = "auto"
    has_batch: bool = False
    has_serial: bool = False
    has_expiry: bool = False
    shelf_life_days: int = 0
    safety_stock: Decimal = Decimal("0")
    reorder_level: Decimal = Decimal("0")
    reorder_qty: Decimal = Decimal("0")
    lead_time_days: int = 0
    min_order_qty: Decimal = Decimal("0")
    max_order_qty: Decimal = Decimal("0")
    tax_rate: Decimal = Decimal("0")
    cgst_rate: Decimal = Decimal("0")
    sgst_rate: Decimal = Decimal("0")
    igst_rate: Decimal = Decimal("0")
    purchase_price: Decimal = Decimal("0")
    selling_price: Decimal = Decimal("0")
    mrp: Decimal = Decimal("0")
    image_url: Optional[str] = None
    brand: Optional[str] = None
    manufacturer: Optional[str] = None
    marketer: Optional[str] = None
    distributor: Optional[str] = None

    dosage_form: Optional[str] = None
    valuation_method: str = "fifo"
    is_active: bool = True

    @field_validator("item_code")
    @classmethod
    def val_code(cls, v):
        # Wave 11A — blank or 'AUTO' is allowed (server generates the code)
        if v is None or not str(v).strip() or str(v).strip().upper() == "AUTO":
            return None
        return str(v).strip()[:50]

    @field_validator("name")
    @classmethod
    def val_name(cls, v):
        return _require_non_empty(v, "Item name")[:255]



    @field_validator("barcode_type")
    @classmethod
    def val_barcode(cls, v):
        v = v.strip().lower()
        if v not in VALID_BARCODE_TYPES:
            raise ValueError(f"Invalid barcode type '{v}'. Must be one of: {', '.join(VALID_BARCODE_TYPES)}")
        return v

    @field_validator("valuation_method")
    @classmethod
    def val_method(cls, v):
        v = v.strip().lower()
        if v not in VALID_VALUATION_METHODS:
            raise ValueError(f"Invalid valuation method. Must be one of: {', '.join(VALID_VALUATION_METHODS)}")
        return v

    @field_validator("purchase_price", "selling_price", "mrp", "tax_rate", "cgst_rate", "sgst_rate", "igst_rate",
                     "safety_stock", "reorder_level", "reorder_qty", "min_order_qty", "max_order_qty")
    @classmethod
    def val_non_negative(cls, v):
        if v is not None and v < 0:
            raise ValueError("Value cannot be negative")
        return v

    @field_validator("hsn_code")
    @classmethod
    def val_hsn(cls, v):
        if v is None or v == "":
            return None
        v = str(v).strip()
        if not v:
            return None
        # HSN codes are 4, 6, or 8 digits (Indian GST standard)
        if not re.match(r"^[0-9]{4,8}$", v):
            raise ValueError("Invalid HSN code — must be 4, 6, or 8 digits")
        return v[:20]

    @model_validator(mode="after")
    def check_min_max(self):
        if (self.min_order_qty and self.max_order_qty
                and self.min_order_qty > 0 and self.max_order_qty > 0
                and self.min_order_qty >= self.max_order_qty):
            raise ValueError("Min order qty must be less than max order qty")
        
        # Automatically set has_serial = True for asset/equipment types
        item_type_lower = (self.item_type or "").lower()
        asset_keywords = ['asset', 'equipment', 'laptop', 'computer', 'it', 'fixed']
        if any(kw in item_type_lower for kw in asset_keywords):
            self.has_serial = True
            
        return self


class ItemUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    item_type: Optional[str] = None
    category_id: Optional[int] = None
    feature_id: Optional[int] = None
    feature_ids: Optional[List[int]] = None
    uom_category_id: Optional[int] = None
    primary_uom_id: Optional[int] = None
    secondary_uom_id: Optional[int] = None
    hsn_code: Optional[str] = None
    sku: Optional[str] = None
    barcode_type: Optional[str] = None
    has_batch: Optional[bool] = None
    has_serial: Optional[bool] = None
    has_expiry: Optional[bool] = None
    shelf_life_days: Optional[int] = None
    safety_stock: Optional[Decimal] = None
    reorder_level: Optional[Decimal] = None
    reorder_qty: Optional[Decimal] = None
    lead_time_days: Optional[int] = None
    min_order_qty: Optional[Decimal] = None
    max_order_qty: Optional[Decimal] = None
    tax_rate: Optional[Decimal] = None
    cgst_rate: Optional[Decimal] = None
    sgst_rate: Optional[Decimal] = None
    igst_rate: Optional[Decimal] = None
    purchase_price: Optional[Decimal] = None
    selling_price: Optional[Decimal] = None
    mrp: Optional[Decimal] = None
    image_url: Optional[str] = None
    is_active: Optional[bool] = None
    brand: Optional[str] = None
    manufacturer: Optional[str] = None
    marketer: Optional[str] = None
    distributor: Optional[str] = None

    dosage_form: Optional[str] = None
    valuation_method: Optional[str] = None
    # Bug fix D-006 — compliance flags editable
    drug_schedule: Optional[str] = None
    is_schedule_h1: Optional[bool] = None
    is_narcotic: Optional[bool] = None
    requires_prescription: Optional[bool] = None
    requires_cold_chain: Optional[bool] = None
    min_storage_temp_c: Optional[Decimal] = None
    max_storage_temp_c: Optional[Decimal] = None
    regulatory_notes: Optional[str] = None

    @field_validator("name")
    @classmethod
    def val_name(cls, v):
        if v is not None and not v.strip():
            raise ValueError("Item name cannot be empty")
        return v.strip()[:255] if v else v

    @field_validator("purchase_price", "selling_price", "mrp", "tax_rate", "cgst_rate", "sgst_rate", "igst_rate",
                     "safety_stock", "reorder_level", "reorder_qty", "min_order_qty", "max_order_qty")
    @classmethod
    def val_non_negative(cls, v):
        if v is not None and v < 0:
            raise ValueError("Value cannot be negative")
        return v

    @field_validator("barcode_type")
    @classmethod
    def val_barcode(cls, v):
        if v is not None:
            v = v.strip().lower()
            if v not in VALID_BARCODE_TYPES:
                raise ValueError(f"Invalid barcode type. Must be one of: {', '.join(VALID_BARCODE_TYPES)}")
        return v

    @model_validator(mode="after")
    def check_asset_serial(self):
        if self.item_type is not None:
            item_type_lower = self.item_type.lower()
            asset_keywords = ['asset', 'equipment', 'laptop', 'computer', 'it', 'fixed']
            if any(kw in item_type_lower for kw in asset_keywords):
                self.has_serial = True
        return self


class ItemResponse(BaseModel):
    id: int
    category_id: Optional[int] = None
    feature_id: Optional[int] = None
    feature_ids: Optional[List[int]] = None
    feature_names: Optional[List[str]] = None
    item_code: str
    name: str
    description: Optional[str] = None
    item_type: str
    uom_category_id: Optional[int] = None
    primary_uom_id: int
    secondary_uom_id: Optional[int] = None
    hsn_code: Optional[str] = None
    sku: Optional[str] = None
    barcode_type: Optional[str] = None
    barcode_value: Optional[str] = None
    has_batch: bool
    has_serial: bool
    has_expiry: bool
    shelf_life_days: int
    safety_stock: Decimal
    reorder_level: Decimal
    reorder_qty: Decimal
    purchase_price: Decimal
    selling_price: Decimal
    mrp: Decimal
    # Bug fix BUG_0085/0086/0088 — expose tax fields so PO/Quotation/PR forms
    # can auto-fill them when an item is picked.
    tax_rate: Decimal = Decimal("0")
    cgst_rate: Decimal = Decimal("0")
    sgst_rate: Decimal = Decimal("0")
    igst_rate: Decimal = Decimal("0")
    brand: Optional[str] = None
    manufacturer: Optional[str] = None
    marketer: Optional[str] = None
    distributor: Optional[str] = None

    dosage_form: Optional[str] = None
    valuation_method: Optional[str] = None
    # Bug fix D-006 — compliance flags exposed (Wave 7 columns)
    drug_schedule: Optional[str] = None
    is_schedule_h1: Optional[bool] = None
    is_narcotic: Optional[bool] = None
    requires_prescription: Optional[bool] = None
    requires_cold_chain: Optional[bool] = None
    min_storage_temp_c: Optional[Decimal] = None
    max_storage_temp_c: Optional[Decimal] = None
    regulatory_notes: Optional[str] = None
    is_active: bool
    status: Optional[str] = None
    created_at: Optional[datetime] = None
    model_config = {"from_attributes": True}

    @model_validator(mode="after")
    def compute_status(self):
        self.status = "active" if self.is_active else "inactive"
        return self


# ===================== VENDOR =====================

class VendorTypeCreate(BaseModel):
    code: str
    name: str
    description: Optional[str] = None
    is_active: Optional[bool] = None

    @field_validator("code")
    @classmethod
    def val_code(cls, v):
        v = _require_non_empty(v, "Vendor type code").lower()
        if not re.match(r"^[a-z0-9_-]+$", v):
            raise ValueError("Vendor type code may contain letters, numbers, hyphen, or underscore")
        return v[:50]

    @field_validator("name")
    @classmethod
    def val_name(cls, v):
        return _require_non_empty(v, "Vendor type name")[:100]

    @field_validator("description")
    @classmethod
    def val_desc(cls, v):
        return _strip_or_none(v, 500)


class VendorTypeResponse(BaseModel):
    id: int
    code: str
    name: str
    description: Optional[str] = None
    is_active: bool
    status: Optional[str] = None
    model_config = {"from_attributes": True}

    @model_validator(mode="after")
    def compute_status(self):
        self.status = "active" if self.is_active else "inactive"
        return self


class VendorCategoryCreate(BaseModel):
    code: str
    name: str
    description: Optional[str] = None
    is_active: Optional[bool] = None

    @field_validator("code")
    @classmethod
    def val_code(cls, v):
        v = _require_non_empty(v, "Vendor category code").lower()
        if not re.match(r"^[a-z0-9_-]+$", v):
            raise ValueError("Vendor category code may contain letters, numbers, hyphen, or underscore")
        return v[:50]

    @field_validator("name")
    @classmethod
    def val_name(cls, v):
        return _require_non_empty(v, "Vendor category name")[:100]

    @field_validator("description")
    @classmethod
    def val_desc(cls, v):
        return _strip_or_none(v, 500)


class VendorCategoryResponse(BaseModel):
    id: int
    code: str
    name: str
    description: Optional[str] = None
    is_active: bool
    status: Optional[str] = None
    model_config = {"from_attributes": True}

    @model_validator(mode="after")
    def compute_status(self):
        self.status = "active" if self.is_active else "inactive"
        return self


class VendorCreate(BaseModel):
    vendor_code: str
    name: str
    contact_person: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    alt_phone: Optional[str] = None
    address_line1: Optional[str] = None
    address_line2: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    pincode: Optional[str] = None
    country: str = "India"
    gst_number: Optional[str] = None
    pan_number: Optional[str] = None
    bank_name: Optional[str] = None
    bank_account: Optional[str] = None
    bank_ifsc: Optional[str] = None
    payment_terms_days: Optional[int] = 30
    credit_limit: Optional[Decimal] = Decimal("0")
    vendor_type: str = "material"
    vendor_type_id: Optional[int] = None
    vendor_type_ids: List[int] = Field(default_factory=list)
    vendor_category_id: Optional[int] = None
    is_transport_vendor: bool = False
    # Bug fix D-002 — DL fields were silently stripped, blocking medicine PO
    drug_license_number: Optional[str] = None
    drug_license_state: Optional[str] = None
    drug_license_expiry: Optional[date] = None
    gst_certificate_url: Optional[str] = None
    license_doc_url: Optional[str] = None

    @field_validator("vendor_code")
    @classmethod
    def val_code(cls, v):
        return _require_non_empty(v, "Vendor code")[:50]

    @field_validator("name")
    @classmethod
    def val_name(cls, v):
        return _require_non_empty(v, "Vendor name")[:255]

    @field_validator("email")
    @classmethod
    def val_email(cls, v):
        if v and v.strip():
            v = v.strip().lower()
            if not EMAIL_PATTERN.match(v):
                raise ValueError("Invalid email format")
            return v[:255]
        return None

    @field_validator("phone", "alt_phone")
    @classmethod
    def val_phone(cls, v):
        if v and v.strip():
            v = v.strip()
            if not PHONE_PATTERN.match(v):
                raise ValueError("Invalid phone number. Use digits, +, -, spaces, or parentheses (6-20 chars)")
            return v[:20]
        return None

    @field_validator("gst_number")
    @classmethod
    def val_gst(cls, v):
        if v and v.strip():
            v = v.strip().upper()
            if len(v) != 15 or not GST_PATTERN.match(v):
                raise ValueError("Invalid GSTIN format. Must be 15-char alphanumeric (e.g., 29ABCDE1234F1Z5)")
            return v
        return None

    # BUG-PRO-104 fix: validate PAN format on create.
    @field_validator("pan_number")
    @classmethod
    def val_pan(cls, v):
        if v and v.strip():
            v = v.strip().upper()
            if not PAN_PATTERN.match(v):
                raise ValueError("Invalid PAN format. Must be 10-char alphanumeric (e.g., ABCDE1234F)")
            return v
        return None

    @field_validator("pincode")
    @classmethod
    def val_pincode(cls, v):
        if v and v.strip():
            v = v.strip()
            if not PINCODE_PATTERN.match(v):
                raise ValueError("Invalid pincode. Must be 5-10 digits")
            return v[:10]
        return None

    @field_validator("vendor_type")
    @classmethod
    def val_type(cls, v):
        return _legacy_vendor_type(v)

    @field_validator("credit_limit")
    @classmethod
    def val_credit(cls, v):
        if v is not None and v < 0:
            raise ValueError("Credit limit cannot be negative")
        return v

    @field_validator("payment_terms_days")
    @classmethod
    def val_terms(cls, v):
        if v is None:
            return v
        if v < 0 or v > 365:
            raise ValueError("Payment terms must be between 0 and 365 days")
        return v


class VendorUpdate(BaseModel):
    name: Optional[str] = None
    contact_person: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    alt_phone: Optional[str] = None
    address_line1: Optional[str] = None
    address_line2: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    pincode: Optional[str] = None
    country: Optional[str] = None
    gst_number: Optional[str] = None
    pan_number: Optional[str] = None
    bank_name: Optional[str] = None
    bank_account: Optional[str] = None
    bank_ifsc: Optional[str] = None
    payment_terms_days: Optional[int] = None
    credit_limit: Optional[Decimal] = None
    vendor_type: Optional[str] = None
    vendor_type_id: Optional[int] = None
    vendor_type_ids: Optional[List[int]] = None
    vendor_category_id: Optional[int] = None
    is_transport_vendor: Optional[bool] = None
    is_active: Optional[bool] = None
    # Bug fix D-002 — DL fields can be edited
    drug_license_number: Optional[str] = None
    drug_license_state: Optional[str] = None
    drug_license_expiry: Optional[date] = None
    gst_certificate_url: Optional[str] = None
    license_doc_url: Optional[str] = None

    @field_validator("name")
    @classmethod
    def val_name(cls, v):
        if v is not None and not v.strip():
            raise ValueError("Vendor name cannot be empty")
        return v.strip()[:255] if v else v

    @field_validator("email")
    @classmethod
    def val_email(cls, v):
        if v and v.strip():
            v = v.strip().lower()
            if not EMAIL_PATTERN.match(v):
                raise ValueError("Invalid email format")
            return v[:255]
        return v

    @field_validator("phone", "alt_phone")
    @classmethod
    def val_phone(cls, v):
        if v and v.strip():
            v = v.strip()
            if not PHONE_PATTERN.match(v):
                raise ValueError("Invalid phone number")
            return v[:20]
        return v

    @field_validator("gst_number")
    @classmethod
    def val_gst(cls, v):
        if v and v.strip():
            v = v.strip().upper()
            if len(v) != 15 or not GST_PATTERN.match(v):
                raise ValueError("Invalid GSTIN format")
            return v
        return v

    # BUG-PRO-104 fix: validate PAN format on update.
    @field_validator("pan_number")
    @classmethod
    def val_pan(cls, v):
        if v and v.strip():
            v = v.strip().upper()
            if not PAN_PATTERN.match(v):
                raise ValueError("Invalid PAN format. Must be 10-char alphanumeric (e.g., ABCDE1234F)")
            return v
        return v

    @field_validator("pincode")
    @classmethod
    def val_pincode(cls, v):
        if v and v.strip():
            v = v.strip()
            if not PINCODE_PATTERN.match(v):
                raise ValueError("Invalid pincode. Must be 5-10 digits")
            return v[:10]
        return v

    @field_validator("vendor_type")
    @classmethod
    def val_type(cls, v):
        return _legacy_vendor_type(v)

    @field_validator("credit_limit")
    @classmethod
    def val_credit(cls, v):
        if v is not None and v < 0:
            raise ValueError("Credit limit cannot be negative")
        return v

    @field_validator("payment_terms_days")
    @classmethod
    def val_terms(cls, v):
        if v is None:
            return v
        if v < 0 or v > 365:
            raise ValueError("Payment terms must be between 0 and 365 days")
        return v


class VendorResponse(BaseModel):
    id: int
    vendor_code: str
    name: str
    contact_person: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    alt_phone: Optional[str] = None
    # Bug fix D-016 — was missing address, pincode, PAN, bank, DL fields
    address_line1: Optional[str] = None
    address_line2: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    pincode: Optional[str] = None
    country: Optional[str] = None
    gst_number: Optional[str] = None
    pan_number: Optional[str] = None
    bank_name: Optional[str] = None
    bank_account: Optional[str] = None
    bank_ifsc: Optional[str] = None
    payment_terms_days: Optional[int] = None
    credit_limit: Optional[Decimal] = None
    vendor_type: Optional[str] = None
    vendor_type_id: Optional[int] = None
    vendor_type_name: Optional[str] = None
    vendor_type_ids: List[int] = Field(default_factory=list)
    vendor_types: List[VendorTypeResponse] = Field(default_factory=list)
    vendor_category_id: Optional[int] = None
    vendor_category_code: Optional[str] = None
    vendor_category_name: Optional[str] = None
    vendor_category: Optional[VendorCategoryResponse] = None
    rating: Optional[Decimal] = None
    is_transport_vendor: bool
    # Bug fix D-002 — DL fields exposed
    drug_license_number: Optional[str] = None
    drug_license_state: Optional[str] = None
    drug_license_expiry: Optional[date] = None
    gst_certificate_url: Optional[str] = None
    license_doc_url: Optional[str] = None
    vendor_compliance_status: Optional[str] = None
    is_active: bool
    has_login: Optional[bool] = None
    status: Optional[str] = None
    created_at: Optional[datetime] = None
    model_config = {"from_attributes": True}

    @model_validator(mode="after")
    def compute_status(self):
        self.status = "active" if self.is_active else "inactive"
        return self


# ===================== CUSTOMER =====================

class CustomerCreate(BaseModel):
    customer_code: str
    name: str
    contact_person: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address_line1: Optional[str] = None
    address_line2: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    pincode: Optional[str] = None
    country: str = "India"
    gst_number: Optional[str] = None
    credit_limit: Decimal = Decimal("0")
    payment_terms_days: int = 30

    @field_validator("customer_code")
    @classmethod
    def val_code(cls, v):
        return _require_non_empty(v, "Customer code")[:50]

    @field_validator("name")
    @classmethod
    def val_name(cls, v):
        return _require_non_empty(v, "Customer name")[:255]


class CustomerUpdate(BaseModel):
    name: Optional[str] = None
    contact_person: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address_line1: Optional[str] = None
    address_line2: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    pincode: Optional[str] = None
    gst_number: Optional[str] = None
    credit_limit: Optional[Decimal] = None
    payment_terms_days: Optional[int] = None
    is_active: Optional[bool] = None


class CustomerResponse(BaseModel):
    id: int
    customer_code: str
    name: str
    contact_person: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    gst_number: Optional[str] = None
    is_active: bool
    status: Optional[str] = None
    created_at: Optional[datetime] = None
    model_config = {"from_attributes": True}

    @model_validator(mode="after")
    def compute_status(self):
        self.status = "active" if self.is_active else "inactive"
        return self


# ===================== WAREHOUSE =====================

class WarehouseCreate(BaseModel):
    organization_id: Optional[int] = 1
    code: str
    name: str
    type: Optional[str] = "main"
    warehouse_type: Optional[str] = None
    address_line1: Optional[str] = None
    address_line2: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    pincode: Optional[str] = None
    contact_person: Optional[str] = None
    phone: Optional[str] = None
    contact_phone: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    parent_id: Optional[int] = None

    @field_validator("code")
    @classmethod
    def val_code(cls, v):
        return _require_non_empty(v, "Warehouse code")[:50]

    @field_validator("name")
    @classmethod
    def val_name(cls, v):
        return _require_non_empty(v, "Warehouse name")[:255]

    @field_validator("pincode")
    @classmethod
    def val_pincode(cls, v):
        if v and v.strip():
            v = v.strip()
            # Indian pincode: 6 digits, first digit 1-9 (but allow 5-10 for intl)
            if not re.match(r"^[0-9]{5,10}$", v):
                raise ValueError("Invalid pincode — must be 5-10 digits")
            return v[:10]
        return None

    @field_validator("phone", "contact_phone")
    @classmethod
    def val_phone(cls, v):
        if v and v.strip():
            v = v.strip()
            if not PHONE_PATTERN.match(v):
                raise ValueError("Invalid phone number — use digits, +, -, spaces, parentheses (6-20 chars)")
            return v[:20]
        return None


class WarehouseUpdate(BaseModel):
    name: Optional[str] = None
    type: Optional[str] = None
    address_line1: Optional[str] = None
    address_line2: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    pincode: Optional[str] = None
    contact_person: Optional[str] = None
    phone: Optional[str] = None
    is_active: Optional[bool] = None
    parent_id: Optional[int] = None


class WarehouseResponse(BaseModel):
    id: int
    organization_id: int
    code: str
    name: str
    type: Optional[str] = None
    warehouse_type: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    contact_person: Optional[str] = None
    is_active: bool
    status: Optional[str] = None
    created_at: Optional[datetime] = None
    parent_id: Optional[int] = None
    parent_name: Optional[str] = None
    model_config = {"from_attributes": True}

    @model_validator(mode="after")
    def compute_fields(self):
        self.status = "active" if self.is_active else "inactive"
        self.warehouse_type = self.type
        return self


# ===================== ORGANIZATION STRUCTURE =====================

class ProjectMasterCreate(BaseModel):
    name: str
    code: str
    description: Optional[str] = None
    status: Optional[str] = "active"

    @field_validator("name")
    @classmethod
    def val_name(cls, v):
        return _require_non_empty(v, "Project name")[:255]

    @field_validator("code")
    @classmethod
    def val_code(cls, v):
        return _require_non_empty(v, "Project code")[:50]


class ProjectMasterResponse(BaseModel):
    id: int
    name: str
    code: str
    description: Optional[str] = None
    status: Optional[str] = None
    model_config = {"from_attributes": True}


class OfficeCreate(BaseModel):
    name: str
    level: Optional[str] = None
    country: Optional[str] = None
    state: Optional[str] = None
    district: Optional[str] = None
    mandal: Optional[str] = None
    cluster: Optional[str] = None
    cluster_type: Optional[str] = None
    specific_location: Optional[str] = None
    address: Optional[str] = None

    @field_validator("name")
    @classmethod
    def val_name(cls, v):
        return _require_non_empty(v, "Office name")[:255]

    @model_validator(mode="after")
    def normalize(self):
        for field, limit in (
            ("level", 50), ("country", 100), ("state", 100), ("district", 100),
            ("mandal", 100), ("cluster", 100), ("cluster_type", 50), ("specific_location", 255),
        ):
            setattr(self, field, _strip_or_none(getattr(self, field), limit))
        self.address = _strip_or_none(self.address, 2000)
        return self


class OfficeResponse(OfficeCreate):
    id: int
    model_config = {"from_attributes": True}


class PositionCreate(BaseModel):
    name: str
    code: str
    role_name: Optional[str] = None
    role_id: Optional[int] = None
    level_name: Optional[str] = None
    level_rank: Optional[int] = None
    department: Optional[str] = None
    section: Optional[str] = None
    project_id: Optional[int] = None
    office_id: Optional[int] = None
    parent_position_id: Optional[int] = None

    @field_validator("name")
    @classmethod
    def val_name(cls, v):
        return _require_non_empty(v, "Position name")[:255]

    @field_validator("code")
    @classmethod
    def val_code(cls, v):
        return _require_non_empty(v, "Position code")[:100]

    @model_validator(mode="after")
    def normalize(self):
        for field, limit in (
            ("role_name", 100), ("level_name", 50), ("department", 100), ("section", 100),
        ):
            setattr(self, field, _strip_or_none(getattr(self, field), limit))
        return self


class PositionResponse(PositionCreate):
    id: int
    role_code: Optional[str] = None
    project_name: Optional[str] = None
    office_name: Optional[str] = None
    parent_position_name: Optional[str] = None
    model_config = {"from_attributes": True}


class EmployeeCreate(BaseModel):
    employee_code: str
    name: str
    photo: Optional[str] = None
    status: Optional[str] = "Active"
    dob: Optional[date] = None
    gender: Optional[str] = None
    pan_number: Optional[str] = None
    aadhaar_number: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    position_id: Optional[int] = None

    @field_validator("employee_code")
    @classmethod
    def val_employee_code(cls, v):
        return _require_non_empty(v, "Employee code")[:50]

    @field_validator("name")
    @classmethod
    def val_name(cls, v):
        return _require_non_empty(v, "Employee name")[:255]

    @field_validator("pan_number")
    @classmethod
    def val_pan(cls, v):
        v = _strip_or_none(v, 10)
        if v and not PAN_PATTERN.match(v.upper()):
            raise ValueError("Invalid PAN number")
        return v.upper() if v else None

    @field_validator("aadhaar_number")
    @classmethod
    def val_aadhaar(cls, v):
        v = _strip_or_none(v, 12)
        if v and not re.match(r"^[0-9]{12}$", v):
            raise ValueError("Invalid Aadhaar number")
        return v

    @field_validator("email")
    @classmethod
    def val_email(cls, v):
        v = _strip_or_none(v, 100)
        if v and not EMAIL_PATTERN.match(v):
            raise ValueError("Invalid email")
        return v

    @field_validator("phone")
    @classmethod
    def val_phone(cls, v):
        v = _strip_or_none(v, 15)
        if v and not PHONE_PATTERN.match(v):
            raise ValueError("Invalid phone number")
        return v

    @model_validator(mode="after")
    def normalize(self):
        self.photo = _strip_or_none(self.photo, 255)
        self.status = _strip_or_none(self.status, 20) or "Active"
        self.gender = _strip_or_none(self.gender, 20)
        return self


class EmployeeResponse(EmployeeCreate):
    id: int
    position_name: Optional[str] = None
    position_code: Optional[str] = None
    model_config = {"from_attributes": True}


# ===================== WAREHOUSE HIERARCHY =====================

class LocationCreate(BaseModel):
    warehouse_id: int
    code: str
    name: str
    description: Optional[str] = None

class LineCreate(BaseModel):
    location_id: int
    code: str
    name: str
    zone_type: str = "storage"

class RackCreate(BaseModel):
    line_id: int
    code: str
    name: str
    levels: int = 1

class BinCreate(BaseModel):
    rack_id: int
    code: str
    name: str
    bin_type: str = "shelf"
    capacity: Decimal = Decimal("0")
    capacity_uom: Optional[str] = None
    is_reserve: bool = False
    is_pick_bin: bool = False


# ===================== PRICE LIST =====================

class PriceListCreate(BaseModel):
    name: str
    type: str
    currency: str = "INR"
    is_default: bool = False
    valid_from: Optional[date] = None
    valid_to: Optional[date] = None

    @field_validator("name")
    @classmethod
    def val_name(cls, v):
        return _require_non_empty(v, "Price list name")[:255]

    @field_validator("type")
    @classmethod
    def val_type(cls, v):
        v = v.strip().lower()
        if v not in VALID_PRICE_LIST_TYPES:
            raise ValueError(f"Invalid price list type. Must be one of: {', '.join(VALID_PRICE_LIST_TYPES)}")
        return v


class PriceListItemCreate(BaseModel):
    price_list_id: int
    item_id: int
    rate: Decimal
    min_qty: Decimal = Decimal("0")
    valid_from: Optional[date] = None
    valid_to: Optional[date] = None

    @field_validator("rate")
    @classmethod
    def val_rate(cls, v):
        if v < 0:
            raise ValueError("Rate cannot be negative")
        return v


# ===================== VENDOR ITEM/CONTRACT/RATING =====================



class VendorItemCreate(BaseModel):
    vendor_id: Optional[int] = None
    item_id: int
    vendor_item_code: Optional[str] = None
    lead_time_days: int = 0
    min_order_qty: Decimal = Decimal("0")
    rate: Decimal = Decimal("0")
    is_preferred: bool = False


class VendorItemBulkMapCreate(BaseModel):
    vendor_ids: List[int]
    item_ids: List[int]
    lead_time_days: int = 0
    min_order_qty: Decimal = Decimal("0")
    rate: Decimal = Decimal("0")
    is_preferred: bool = False

    @field_validator("vendor_ids", "item_ids")
    @classmethod
    def val_non_empty_ids(cls, v):
        ids = []
        seen = set()
        for raw in v or []:
            try:
                item_id = int(raw)
            except (TypeError, ValueError):
                continue
            if item_id > 0 and item_id not in seen:
                seen.add(item_id)
                ids.append(item_id)
        if not ids:
            raise ValueError("Select at least one record")
        return ids

    @field_validator("lead_time_days")
    @classmethod
    def val_lead_time(cls, v):
        if v is not None and (v < 0 or v > 3650):
            raise ValueError("Lead time must be between 0 and 3650 days")
        return v or 0

    @field_validator("min_order_qty", "rate")
    @classmethod
    def val_non_negative_decimal(cls, v):
        if v is not None and v < 0:
            raise ValueError("Value cannot be negative")
        return v or Decimal("0")


class UserItemBulkMapCreate(BaseModel):
    role_ids: List[int]
    category_ids: List[int] = Field(default_factory=list)
    item_ids: List[int] = Field(default_factory=list)
    action: str = "view"
    replace_existing: bool = False

    @field_validator("role_ids", "category_ids", "item_ids")
    @classmethod
    def val_id_list(cls, v):
        ids = []
        seen = set()
        for raw in v or []:
            try:
                item_id = int(raw)
            except (TypeError, ValueError):
                continue
            if item_id > 0 and item_id not in seen:
                seen.add(item_id)
                ids.append(item_id)
        return ids

    @field_validator("action")
    @classmethod
    def val_action(cls, v):
        v = (v or "view").strip().lower()
        allowed = {"view", "indent", "consume", "approve", "create"}
        if v not in allowed:
            raise ValueError(f"Action must be one of {', '.join(sorted(allowed))}")
        return v

    @model_validator(mode="after")
    def val_mapping(self):
        if not self.role_ids:
            raise ValueError("Select at least one role")
        if not self.category_ids and not self.item_ids:
            raise ValueError("Select at least one category or item")
        return self


class VendorContractCreate(BaseModel):
    vendor_id: int
    contract_number: str
    title: Optional[str] = None
    start_date: date
    end_date: date
    terms: Optional[str] = None
    status: str = "draft"

class VendorRatingCreate(BaseModel):
    vendor_id: int
    period_from: Optional[date] = None
    period_to: Optional[date] = None
    delivery_timeliness: Decimal = Decimal("0")
    cost_efficiency: Decimal = Decimal("0")
    service_reliability: Decimal = Decimal("0")
    delivery_accuracy: Decimal = Decimal("0")
    overall_rating: Decimal = Decimal("0")
    remarks: Optional[str] = None
