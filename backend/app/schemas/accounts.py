from pydantic import BaseModel, field_validator, model_validator
from typing import List, Optional
from datetime import datetime, date
from decimal import Decimal


# ---- Chart of Accounts ----
class AccountCreate(BaseModel):
    parent_id: Optional[int] = None
    project_id: Optional[int] = None
    account_code: str
    account_name: str
    account_type: str
    account_group: Optional[str] = None
    is_group: bool = False
    level: int = 0

class AccountResponse(BaseModel):
    id: int
    parent_id: Optional[int] = None
    project_id: Optional[int] = None
    account_code: str
    account_name: str
    account_type: str
    account_group: Optional[str] = None
    is_group: bool
    level: int
    is_active: bool
    model_config = {"from_attributes": True}

# ---- Invoice ----
class InvoiceItemCreate(BaseModel):
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
    def val_qty(cls, v):
        if v is not None and v <= 0:
            raise ValueError("Quantity must be greater than zero")
        return v

    @field_validator("rate")
    @classmethod
    def val_rate(cls, v):
        if v is not None and v < 0:
            raise ValueError("Rate cannot be negative")
        return v

    @field_validator("discount_pct", "cgst_rate", "sgst_rate", "igst_rate")
    @classmethod
    def val_pct(cls, v):
        if v is not None and (v < 0 or v > 100):
            raise ValueError("Percentage must be 0-100")
        return v

class InvoiceCreate(BaseModel):
    invoice_type: str
    party_type: str
    party_id: int
    po_id: Optional[int] = None
    so_id: Optional[int] = None
    project_id: Optional[int] = None
    invoice_date: date
    due_date: Optional[date] = None
    remarks: Optional[str] = None
    attachment_url: Optional[str] = None
    items: List[InvoiceItemCreate]

    @field_validator("items")
    @classmethod
    def val_items(cls, v):
        if not v or len(v) == 0:
            raise ValueError("At least one item is required")
        return v

    @model_validator(mode="after")
    def val_dates(self):
        if self.due_date and self.invoice_date and self.due_date < self.invoice_date:
            raise ValueError("Due date must be >= invoice date")
        return self

class InvoiceUpdate(BaseModel):
    status: Optional[str] = None
    remarks: Optional[str] = None
    attachment_url: Optional[str] = None

class InvoiceItemResponse(BaseModel):
    id: int
    item_id: int
    qty: Decimal
    uom_id: int
    rate: Decimal
    discount_pct: Decimal
    tax_amount: Decimal
    amount: Decimal
    model_config = {"from_attributes": True}

class InvoiceResponse(BaseModel):
    id: int
    invoice_number: str
    invoice_type: str
    party_type: str
    party_id: int
    party_name: Optional[str] = None
    po_id: Optional[int] = None
    po_number: Optional[str] = None
    so_id: Optional[int] = None
    so_number: Optional[str] = None
    project_id: Optional[int] = None
    project_name: Optional[str] = None
    invoice_date: datetime
    due_date: Optional[datetime] = None
    subtotal: Decimal = Decimal("0")
    # BUG-FIN-050: tax_amount is nullable on the row when no tax lines exist;
    # default to 0 so the response always carries a numeric value rather than
    # coercing to None / failing validation for the FE.
    tax_amount: Decimal = Decimal("0")
    grand_total: Decimal = Decimal("0")
    paid_amount: Decimal = Decimal("0")
    balance_amount: Decimal = Decimal("0")
    status: str
    attachment_url: Optional[str] = None
    created_by: Optional[int] = None
    creator_name: Optional[str] = None
    created_at: Optional[datetime] = None
    items: List[InvoiceItemResponse] = []
    model_config = {"from_attributes": True}

# ---- Payment ----
class PaymentCreate(BaseModel):
    payment_type: str
    party_type: str
    party_id: int
    invoice_id: Optional[int] = None
    po_id: Optional[int] = None
    project_id: Optional[int] = None
    payment_date: date
    amount: Decimal
    payment_mode: str = "bank_transfer"
    reference_number: Optional[str] = None
    bank_account: Optional[str] = None
    is_advance: bool = False
    remarks: Optional[str] = None

    @field_validator("amount")
    @classmethod
    def val_amount(cls, v):
        if v is None or v <= 0:
            raise ValueError("Payment amount must be greater than zero")
        return v

class PaymentResponse(BaseModel):
    id: int
    payment_number: str
    payment_type: str
    party_type: str
    party_id: int
    party_name: Optional[str] = None
    invoice_id: Optional[int] = None
    project_id: Optional[int] = None
    project_name: Optional[str] = None
    payment_date: datetime
    amount: Decimal
    payment_mode: str
    reference_number: Optional[str] = None
    status: str
    created_by: Optional[int] = None
    creator_name: Optional[str] = None
    created_at: Optional[datetime] = None
    model_config = {"from_attributes": True}

# ---- Credit Note ----
class CreditNoteCreate(BaseModel):
    invoice_id: int
    party_type: Optional[str] = None
    party_id: Optional[int] = None
    cn_date: Optional[date] = None
    amount: Decimal
    reason: Optional[str] = None
    remarks: Optional[str] = None

    @field_validator("amount")
    @classmethod
    def val_amount(cls, v):
        if v is None or v <= 0:
            raise ValueError("Credit note amount must be greater than zero")
        return v

class CreditNoteResponse(BaseModel):
    id: int
    cn_number: str
    invoice_id: int
    party_type: str
    party_id: int
    party_name: Optional[str] = None
    project_name: Optional[str] = None
    cn_date: datetime
    amount: Decimal
    reason: Optional[str] = None
    status: str
    created_at: Optional[datetime] = None
    model_config = {"from_attributes": True}

# ---- Journal Entry ----
class JournalEntryLineCreate(BaseModel):
    account_id: int
    debit: Decimal = Decimal("0")
    credit: Decimal = Decimal("0")
    party_type: Optional[str] = None
    party_id: Optional[int] = None
    narration: Optional[str] = None

class JournalEntryCreate(BaseModel):
    entry_date: date
    entry_type: str = "journal"
    project_id: Optional[int] = None
    reference_type: Optional[str] = None
    reference_id: Optional[int] = None
    narration: Optional[str] = None
    lines: List[JournalEntryLineCreate]

class JournalEntryLineResponse(BaseModel):
    id: int
    account_id: int
    account_name: Optional[str] = None
    debit: Decimal
    credit: Decimal
    party_type: Optional[str] = None
    party_id: Optional[int] = None
    narration: Optional[str] = None
    model_config = {"from_attributes": True}

class JournalEntryResponse(BaseModel):
    id: int
    entry_number: str
    entry_date: datetime
    entry_type: str
    project_id: Optional[int] = None
    project_name: Optional[str] = None
    total_debit: Decimal
    total_credit: Decimal
    narration: Optional[str] = None
    status: str
    created_by: Optional[int] = None
    creator_name: Optional[str] = None
    created_at: Optional[datetime] = None
    lines: List[JournalEntryLineResponse] = []
    model_config = {"from_attributes": True}

# ---- Account Ledger ----
class AccountLedgerResponse(BaseModel):
    id: int
    account_id: int
    account_name: Optional[str] = None
    posting_date: datetime
    party_type: Optional[str] = None
    party_id: Optional[int] = None
    party_name: Optional[str] = None
    project_id: Optional[int] = None
    po_id: Optional[int] = None
    reference_type: Optional[str] = None
    reference_id: Optional[int] = None
    debit: Decimal
    credit: Decimal
    balance: Decimal
    narration: Optional[str] = None
    created_at: Optional[datetime] = None
    model_config = {"from_attributes": True}
