from pydantic import BaseModel, field_validator, model_validator
from typing import List, Optional
from datetime import datetime, date
from decimal import Decimal


# ---- Material Request ----
class MRItemCreate(BaseModel):
    item_id: int
    qty: Decimal
    uom_id: Optional[int] = None
    target_warehouse_id: Optional[int] = None
    remarks: Optional[str] = None

    @field_validator("qty")
    @classmethod
    def validate_qty(cls, v):
        if v is not None:
            if v <= 0:
                raise ValueError("Quantity must be greater than zero")
            if v >= 10_000_000:
                raise ValueError("Quantity must be less than 10,000,000")
        return v

class MRCreate(BaseModel):
    project_id: Optional[int] = None
    warehouse_id: Optional[int] = None
    indent_id: Optional[int] = None
    request_type: str = "purchase"
    department: Optional[str] = None
    department_id: Optional[str] = None
    request_date: Optional[date] = None
    required_date: Optional[date] = None
    priority: str = "medium"
    remarks: Optional[str] = None
    status: Optional[str] = None
    items: List[MRItemCreate]

    @field_validator("required_date")
    @classmethod
    def validate_required_date(cls, v):
        if v is not None and v < date.today():
            raise ValueError("Required date cannot be in the past")
        return v

    @field_validator("items")
    @classmethod
    def validate_items_not_empty(cls, v):
        if not v or len(v) == 0:
            raise ValueError("At least one item is required")
        return v

class MRUpdate(BaseModel):
    required_date: Optional[date] = None
    priority: Optional[str] = None
    remarks: Optional[str] = None
    status: Optional[str] = None

class MRItemResponse(BaseModel):
    id: int
    item_id: int
    qty: Decimal
    uom_id: int
    ordered_qty: Decimal
    received_qty: Decimal
    target_warehouse_id: Optional[int] = None
    remarks: Optional[str] = None
    model_config = {"from_attributes": True}

class MRResponse(BaseModel):
    id: int
    mr_number: str
    indent_id: Optional[int] = None
    project_id: Optional[int] = None
    warehouse_id: Optional[int] = None
    request_type: str
    department: Optional[str] = None
    requested_by: int
    request_date: datetime
    required_date: Optional[datetime] = None
    priority: str
    status: str
    remarks: Optional[str] = None
    approved_by: Optional[int] = None
    approved_date: Optional[datetime] = None
    created_at: Optional[datetime] = None
    items: List[MRItemResponse] = []
    model_config = {"from_attributes": True}

# ---- Quotation ----
class QuotationItemCreate(BaseModel):
    item_id: int
    qty: Decimal
    uom_id: int
    rate: Decimal
    discount_pct: Decimal = Decimal("0")
    tax_rate: Decimal = Decimal("0")
    cgst_rate: Decimal = Decimal("0")
    sgst_rate: Decimal = Decimal("0")
    igst_rate: Decimal = Decimal("0")
    expected_delivery: Optional[date] = None
    remarks: Optional[str] = None

    @field_validator("qty")
    @classmethod
    def validate_qty(cls, v):
        if v is not None and v <= 0:
            raise ValueError("Quantity must be greater than zero")
        return v

    @field_validator("rate")
    @classmethod
    def validate_rate(cls, v):
        if v is not None and v < 0:
            raise ValueError("Rate cannot be negative")
        return v

    @field_validator("discount_pct", "tax_rate", "cgst_rate", "sgst_rate", "igst_rate")
    @classmethod
    def validate_pct(cls, v):
        if v is not None and (v < 0 or v > 100):
            raise ValueError("Percentage must be between 0 and 100")
        return v

class QuotationCreate(BaseModel):
    rfq_id: Optional[int] = None
    rfq_number: Optional[str] = None
    mr_id: Optional[int] = None
    vendor_id: int
    quotation_date: date
    valid_until: Optional[date] = None
    currency: str = "INR"
    delivery_days: Optional[int] = None
    payment_terms: Optional[str] = None
    with_vehicle: Optional[bool] = False
    vehicle_cost: Optional[Decimal] = Decimal("0")
    remarks: Optional[str] = None
    items: List[QuotationItemCreate]

    @field_validator("items")
    @classmethod
    def validate_items_not_empty(cls, v):
        if not v or len(v) == 0:
            raise ValueError("At least one item is required")
        return v

    @model_validator(mode="after")
    def validate_valid_until(self):
        if self.valid_until and self.quotation_date and self.valid_until < self.quotation_date:
            raise ValueError("Valid until date must be >= quotation date")
        # BUG-PRO-046 fix: refuse already-expired quotations on create.
        if self.valid_until and self.valid_until < date.today():
            raise ValueError("Valid until date cannot be in the past")
        return self

class QuotationItemUpdate(BaseModel):
    """Item payload for QuotationUpdate (line-level GST split)."""
    item_id: int
    qty: Decimal
    uom_id: int
    rate: Decimal
    discount_pct: Decimal = Decimal("0")
    cgst_rate: Decimal = Decimal("0")
    sgst_rate: Decimal = Decimal("0")
    igst_rate: Decimal = Decimal("0")
    tax_rate: Decimal = Decimal("0")
    amount: Decimal = Decimal("0")
    expected_delivery: Optional[date] = None
    remarks: Optional[str] = None

class QuotationUpdate(BaseModel):
    valid_until: Optional[date] = None
    status: Optional[str] = None
    remarks: Optional[str] = None
    # Allow financial header fields (sent by frontend on edit)
    total_amount: Optional[Decimal] = None
    subtotal: Optional[Decimal] = None
    cgst_amount: Optional[Decimal] = None
    sgst_amount: Optional[Decimal] = None
    igst_amount: Optional[Decimal] = None
    tax_amount: Optional[Decimal] = None
    grand_total: Optional[Decimal] = None
    delivery_days: Optional[int] = None
    payment_terms: Optional[str] = None
    currency: Optional[str] = None
    # Items — when provided, replace existing items entirely
    items: Optional[List[QuotationItemUpdate]] = None

class QuotationItemResponse(BaseModel):
    id: int
    item_id: int
    qty: Decimal
    uom_id: int
    rate: Decimal
    discount_pct: Decimal
    tax_rate: Decimal
    cgst_rate: Decimal
    sgst_rate: Decimal
    igst_rate: Decimal
    amount: Decimal
    expected_delivery: Optional[datetime] = None
    remarks: Optional[str] = None
    model_config = {"from_attributes": True}

class QuotationResponse(BaseModel):
    id: int
    rfq_id: Optional[int] = None
    rfq_number: Optional[str] = None
    quotation_number: str
    mr_id: Optional[int] = None
    vendor_id: int
    quotation_date: datetime
    valid_until: Optional[datetime] = None
    subtotal: Decimal = Decimal("0")
    total_amount: Decimal
    cgst_amount: Decimal = Decimal("0")
    sgst_amount: Decimal = Decimal("0")
    igst_amount: Decimal = Decimal("0")
    tax_amount: Decimal
    vehicle_cost: Decimal = Decimal("0")
    grand_total: Decimal
    currency: str
    delivery_days: Optional[int] = None
    with_vehicle: Optional[bool] = False
    status: str
    remarks: Optional[str] = None
    created_at: Optional[datetime] = None
    items: List[QuotationItemResponse] = []
    model_config = {"from_attributes": True}


class RFQItemCreate(QuotationItemCreate):
    rate: Decimal = Decimal("0")


class RFQCreate(BaseModel):
    mr_id: Optional[int] = None
    title: Optional[str] = None
    vendor_ids: List[int]
    rfq_date: date
    valid_until: Optional[date] = None
    currency: str = "INR"
    delivery_days: Optional[int] = None
    payment_terms: Optional[str] = None
    with_vehicle: Optional[bool] = False
    remarks: Optional[str] = None
    items: List[RFQItemCreate]

    @field_validator("vendor_ids")
    @classmethod
    def validate_vendors_not_empty(cls, v):
        if not v:
            raise ValueError("At least one supplier is required")
        return v

    @field_validator("items")
    @classmethod
    def validate_rfq_items_not_empty(cls, v):
        if not v:
            raise ValueError("At least one RFQ item is required")
        return v

    @model_validator(mode="after")
    def validate_valid_until(self):
        if self.valid_until and self.rfq_date and self.valid_until < self.rfq_date:
            raise ValueError("RFQ valid until date must be >= RFQ date")
        return self


class SplitAwardItem(BaseModel):
    item_id: int
    vendor_id: int
    qty: Decimal
    rate: Decimal
    quotation_id: int

class SplitPORequest(BaseModel):
    rfq_number: str
    mr_id: Optional[int] = None
    awards: List[SplitAwardItem]

# ---- Purchase Order ----
class POItemCreate(BaseModel):
    item_id: int
    qty: Decimal
    uom_id: int
    rate: Decimal
    discount_pct: Decimal = Decimal("0")
    cgst_rate: Decimal = Decimal("0")
    sgst_rate: Decimal = Decimal("0")
    igst_rate: Decimal = Decimal("0")

    @field_validator("qty")
    @classmethod
    def validate_qty(cls, v):
        if v is not None:
            if v <= 0:
                raise ValueError("Quantity must be greater than zero")
            if v >= 10_000_000:
                raise ValueError("Quantity must be less than 10,000,000")
        return v

    @field_validator("rate")
    @classmethod
    def validate_rate(cls, v):
        if v is not None and v < 0:
            raise ValueError("Rate cannot be negative")
        return v

    @field_validator("discount_pct", "cgst_rate", "sgst_rate", "igst_rate")
    @classmethod
    def validate_pct(cls, v):
        if v is not None and (v < 0 or v > 100):
            raise ValueError("Percentage must be between 0 and 100")
        return v

class POCreate(BaseModel):
    vendor_id: int
    mr_id: Optional[int] = None
    quotation_id: Optional[int] = None
    project_id: Optional[int] = None
    warehouse_id: Optional[int] = None
    po_date: date
    expected_delivery_date: Optional[date] = None
    billing_address: Optional[str] = None
    shipping_address: Optional[str] = None
    # BUG-PRO-007 fix: accept (and ignore at FK) the FE's ``payment_terms`` /
    # ``currency`` text values rather than 422-rejecting the whole payload —
    # the underlying PurchaseOrder model has neither column today (DEFERRED:
    # column add requires migration) but accepting the keys here keeps the
    # PurchaseOrders.jsx form from looking broken to users.
    payment_terms: Optional[str] = None
    currency: Optional[str] = None
    payment_terms_days: int = 30
    remarks: Optional[str] = None
    attachment_url: Optional[str] = None
    items: List[POItemCreate]

    # BUG-PRO-020 fix: cap payment_terms_days. Negative values nonsensical;
    # >365 also signals a bad payload (e.g. accidental year value).
    @field_validator("payment_terms_days")
    @classmethod
    def validate_payment_terms_days(cls, v):
        if v is None:
            return 30
        if v < 0 or v > 365:
            raise ValueError("payment_terms_days must be between 0 and 365")
        return v

    @field_validator("expected_delivery_date")
    @classmethod
    def validate_expected_delivery_date(cls, v):
        if v is not None and v < date.today():
            raise ValueError("Expected delivery date cannot be in the past")
        return v

    @field_validator("items")
    @classmethod
    def validate_items_not_empty(cls, v):
        if not v or len(v) == 0:
            raise ValueError("At least one item is required")
        return v

    @model_validator(mode="after")
    def validate_delivery_after_po(self):
        if self.expected_delivery_date and self.po_date and self.expected_delivery_date < self.po_date:
            raise ValueError("Expected delivery date must be >= PO date")
        return self

class POUpdate(BaseModel):
    expected_delivery_date: Optional[date] = None
    status: Optional[str] = None
    remarks: Optional[str] = None
    attachment_url: Optional[str] = None

class POItemResponse(BaseModel):
    id: int
    item_id: int
    item_name: Optional[str] = None
    item_code: Optional[str] = None
    qty: Decimal
    received_qty: Decimal
    returned_qty: Decimal
    uom_id: int
    uom_name: Optional[str] = None
    rate: Decimal
    discount_pct: Decimal
    cgst_rate: Decimal
    sgst_rate: Decimal
    igst_rate: Decimal
    tax_amount: Decimal
    amount: Decimal
    item_type: Optional[str] = None
    model_config = {"from_attributes": True}

class POResponse(BaseModel):
    id: int
    po_number: str
    vendor_id: int
    vendor_name: Optional[str] = None
    mr_id: Optional[int] = None
    quotation_id: Optional[int] = None
    project_id: Optional[int] = None
    warehouse_id: Optional[int] = None
    po_date: datetime
    expected_delivery_date: Optional[datetime] = None
    billing_address: Optional[str] = None
    shipping_address: Optional[str] = None
    subtotal: Decimal
    discount_amount: Decimal
    cgst_amount: Decimal = Decimal("0")
    sgst_amount: Decimal = Decimal("0")
    igst_amount: Decimal = Decimal("0")
    tax_amount: Decimal
    grand_total: Decimal
    payment_terms_days: int
    payment_terms: Optional[str] = None
    status: str
    remarks: Optional[str] = None
    supplier_acknowledgement: Optional[str] = "pending"
    attachment_url: Optional[str] = None
    approved_by: Optional[int] = None
    approved_date: Optional[datetime] = None
    created_by: Optional[int] = None
    created_at: Optional[datetime] = None
    items: List[POItemResponse] = []
    model_config = {"from_attributes": True}

class POListResponse(BaseModel):
    id: int
    po_number: str
    vendor_id: int
    vendor_name: Optional[str] = None
    po_date: datetime
    expected_delivery_date: Optional[datetime] = None
    subtotal: Optional[Decimal] = None
    grand_total: Decimal
    status: str
    supplier_acknowledgement: Optional[str] = "pending"
    created_at: Optional[datetime] = None
    items: List[POItemResponse] = []
    model_config = {"from_attributes": True}
