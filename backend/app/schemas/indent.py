from pydantic import BaseModel, field_validator
from typing import List, Optional
from datetime import datetime, date
from decimal import Decimal


class IndentItemCreate(BaseModel):
    item_id: int
    requested_qty: Decimal
    uom_id: Optional[int] = None
    uom: Optional[str] = None
    remarks: Optional[str] = None

    @field_validator("requested_qty")
    @classmethod
    def val_qty(cls, v):
        if v is not None and v <= 0:
            raise ValueError("Requested quantity must be greater than zero")
        return v

class IndentCreate(BaseModel):
    project_id: Optional[int] = None
    # Optional at the schema layer — backend auto-fills from the user's
    # assignments when missing (single-assignment users skip the picker).
    # Handler raises 422 if still unresolved after auto-fill.
    warehouse_id: Optional[int] = None
    indent_date: Optional[date] = None
    required_date: Optional[date] = None
    department: Optional[str] = None
    # BUG-IND-028 — `department_id` is a foreign key to the departments
    # table; previously typed as Optional[str] which silently accepted
    # garbage like "Cardiology" (the department NAME) and stored it where
    # an int FK was expected. The handler also assigns
    # `department = payload.department or payload.department_id or None`
    # so that string fallback path (intentional legacy behavior) still
    # works, but the typed shape now matches the schema.
    department_id: Optional[int] = None
    indent_type: str = "regular"
    status: Optional[str] = None
    remarks: Optional[str] = None
    items: List[IndentItemCreate]

    @field_validator("items")
    @classmethod
    def val_items(cls, v):
        if not v or len(v) == 0:
            raise ValueError("At least one item is required")
        return v

    @field_validator("indent_date")
    @classmethod
    def val_indent_date(cls, v):
        # BUG-IND-025 — `indent_date` previously had no upper bound. Users
        # could submit indents dated years in the future to game reporting,
        # SLA windows, or rolling submission caps. Cap at today.
        if v is not None:
            from datetime import date as _date
            if v > _date.today():
                raise ValueError("indent_date cannot be in the future")
        return v

    @field_validator("required_date")
    @classmethod
    def val_required(cls, v, info):
        # BUG-IND-024 — refuse a required_date in the past on CREATE. The
        # original carve-out ("users may edit existing indents with old
        # required dates") was load-bearing on update, but IndentCreate is
        # only ever used for new indents — and a past required_date on a
        # brand-new indent is always a UI bug.
        if v is not None:
            from datetime import date as _date
            if v < _date.today():
                raise ValueError("required_date cannot be in the past")
            # BUG-IND-026 — required_date must not precede indent_date.
            # Asking for the goods before the indent itself is dated is a
            # UI bug.
            indent_date = info.data.get("indent_date") if info and getattr(info, "data", None) else None
            if indent_date and v < indent_date:
                raise ValueError("required_date cannot be earlier than indent_date")
        return v

class IndentUpdate(BaseModel):
    # BUG-IND-010 — `status` removed from the update contract. Status
    # transitions go through dedicated endpoints (/submit, /approve,
    # /reject, /acknowledge) and the approval engine. Letting clients
    # set status here meant a regular PUT could push an indent from
    # draft -> approved without going through any workflow.
    warehouse_id: Optional[int] = None
    required_date: Optional[date] = None
    indent_type: Optional[str] = None
    remarks: Optional[str] = None
    # When provided, replaces all existing items on the indent. Only allowed
    # while the indent is still in draft status (handler enforces).
    items: Optional[List[IndentItemCreate]] = None

class IndentItemResponse(BaseModel):
    id: int
    item_id: int
    requested_qty: Decimal
    approved_qty: Decimal
    issued_qty: Decimal
    uom_id: int
    remarks: Optional[str] = None
    # Enrichment fields populated by indent.get_indent — declared so they
    # survive model_dump() rather than relying on dict-key patching.
    item_name: Optional[str] = None
    item_code: Optional[str] = None
    uom_name: Optional[str] = None
    has_batch: Optional[bool] = None
    rate: Optional[Decimal] = None
    purchase_price: Optional[Decimal] = None
    model_config = {"from_attributes": True}

class IndentResponse(BaseModel):
    id: int
    indent_number: str
    project_id: Optional[int] = None
    warehouse_id: int
    indent_date: datetime
    required_date: Optional[datetime] = None
    department: Optional[str] = None
    indent_type: str
    status: str
    raised_by: int
    approved_by: Optional[int] = None
    approved_date: Optional[datetime] = None
    remarks: Optional[str] = None
    created_at: Optional[datetime] = None
    items: List[IndentItemResponse] = []
    model_config = {"from_attributes": True}


# --- Acknowledgement Schemas ---

class AckItemCreate(BaseModel):
    indent_item_id: Optional[int] = None
    item_id: int
    received_qty: Decimal
    remarks: Optional[str] = None

class ScannedBarcode(BaseModel):
    value: str
    timestamp: Optional[str] = None
    mode: Optional[str] = None

class IndentAcknowledgementCreate(BaseModel):
    indent_id: int
    remarks: Optional[str] = None
    scan_timestamp: Optional[str] = None
    items: List[AckItemCreate] = []
    scanned_barcodes: List[ScannedBarcode] = []
    # Legacy fields (backward compat with simple ack)
    received_qty: Optional[Decimal] = None
    scan_barcode: Optional[str] = None

class AckItemResponse(BaseModel):
    id: int
    item_id: int
    indent_item_id: Optional[int] = None
    received_qty: Decimal
    remarks: Optional[str] = None
    item_code: Optional[str] = None
    item_name: Optional[str] = None
    uom: Optional[str] = None
    approved_qty: Optional[Decimal] = None
    model_config = {"from_attributes": True}

class IndentAcknowledgementResponse(BaseModel):
    id: int
    indent_id: int
    indent_number: Optional[str] = None
    warehouse_name: Optional[str] = None
    acknowledged_by: int
    acknowledged_by_name: Optional[str] = None
    acknowledged_at: datetime
    received_items_count: Optional[int] = None
    total_received_qty: Optional[Decimal] = None
    status: Optional[str] = "received"
    remarks: Optional[str] = None
    scan_barcode: Optional[str] = None
    scan_timestamp: Optional[datetime] = None
    scanned_barcodes: Optional[list] = None
    items: List[AckItemResponse] = []
    model_config = {"from_attributes": True}
