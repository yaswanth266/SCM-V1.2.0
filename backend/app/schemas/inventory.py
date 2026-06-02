from pydantic import BaseModel, field_validator, model_validator
from typing import List, Optional, Union
from datetime import datetime, date
from decimal import Decimal


# ---- Stock Balance ----
class StockBalanceResponse(BaseModel):
    id: int
    item_id: int
    warehouse_id: int
    bin_id: Optional[int] = None
    batch_id: Optional[int] = None
    available_qty: Decimal
    reserved_qty: Decimal
    transit_qty: Decimal
    total_qty: Decimal
    valuation_rate: Decimal
    stock_value: Decimal
    last_updated: Optional[datetime] = None
    
    # Extra fields for UI
    item_code: Optional[str] = None
    item_name: Optional[str] = None
    warehouse_name: Optional[str] = None
    batch_name: Optional[str] = None
    batch_number: Optional[str] = None
    bin_name: Optional[str] = None
    bin_code: Optional[str] = None
    rack: Optional[str] = None
    location: Optional[str] = None
    expiry_date: Optional[date] = None
    manufacturing_date: Optional[date] = None
    is_low_stock: Optional[bool] = None
    is_below_reorder: Optional[bool] = None
    is_expiring_soon: Optional[bool] = None

    model_config = {"from_attributes": True}

# ---- Stock Ledger ----
class StockLedgerResponse(BaseModel):
    id: int
    item_id: int
    warehouse_id: int
    bin_id: Optional[int] = None
    batch_id: Optional[int] = None
    transaction_type: str
    reference_type: Optional[str] = None
    reference_id: Optional[int] = None
    qty_in: Decimal
    qty_out: Decimal
    balance_qty: Decimal
    rate: Decimal
    value_in: Decimal
    value_out: Decimal
    balance_value: Decimal
    posting_date: datetime
    created_at: Optional[datetime] = None

    # Extra fields for UI
    item_code: Optional[str] = None
    item_name: Optional[str] = None
    warehouse_name: Optional[str] = None
    reference: Optional[str] = None
    created_by: Optional[Union[int, str]] = None

    model_config = {"from_attributes": True}

# ---- Stock Transfer ----
class TransferItemCreate(BaseModel):
    item_id: int
    batch_id: Optional[int] = None
    qty: Decimal
    uom_id: Optional[int] = 1
    source_bin_id: Optional[int] = None
    destination_bin_id: Optional[int] = None

    @field_validator("qty")
    @classmethod
    def val_qty(cls, v):
        if v is not None and v <= 0:
            raise ValueError("Transfer quantity must be greater than zero")
        return v

class TransferCreate(BaseModel):
    source_warehouse_id: int
    destination_warehouse_id: int
    transfer_date: date
    expected_date: Optional[date] = None
    transfer_type: str = "warehouse_to_warehouse"
    remarks: Optional[str] = None
    status: Optional[str] = None
    items: List[TransferItemCreate]

    @field_validator("items")
    @classmethod
    def val_items(cls, v):
        if not v or len(v) == 0:
            raise ValueError("At least one item is required")
        return v

    @model_validator(mode="after")
    def val_different_warehouses(self):
        if self.source_warehouse_id == self.destination_warehouse_id:
            raise ValueError("Source and destination warehouses must be different")
        return self

class TransferUpdate(BaseModel):
    status: Optional[str] = None
    remarks: Optional[str] = None

class TransferItemResponse(BaseModel):
    id: int
    item_id: int
    batch_id: Optional[int] = None
    qty: Decimal
    received_qty: Decimal
    uom_id: int
    source_bin_id: Optional[int] = None
    destination_bin_id: Optional[int] = None
    status: str
    model_config = {"from_attributes": True}

class TransferResponse(BaseModel):
    id: int
    transfer_number: str
    source_warehouse_id: int
    destination_warehouse_id: int
    transfer_date: datetime
    expected_date: Optional[datetime] = None
    transfer_type: str
    status: str
    remarks: Optional[str] = None
    requested_by: Optional[int] = None
    created_at: Optional[datetime] = None
    items: List[TransferItemResponse] = []
    model_config = {"from_attributes": True}

# ---- Stock Audit ----
class AuditItemCreate(BaseModel):
    item_id: int
    bin_id: Optional[int] = None
    batch_id: Optional[int] = None
    system_qty: Decimal = Decimal("0")
    physical_qty: Decimal = Decimal("0")
    uom_id: int
    remarks: Optional[str] = None

    @field_validator("system_qty", "physical_qty")
    @classmethod
    def val_qty(cls, v):
        if v is not None and v < 0:
            raise ValueError("Quantity cannot be negative")
        return v

class AuditCreate(BaseModel):
    warehouse_id: int
    audit_date: date
    audit_type: str = "full"
    items: List[AuditItemCreate]

    @field_validator("audit_date")
    @classmethod
    def val_audit_date(cls, v):
        if v is not None and v > date.today():
            raise ValueError("Audit date cannot be in the future")
        return v

class AuditItemResponse(BaseModel):
    id: int
    item_id: int
    bin_id: Optional[int] = None
    batch_id: Optional[int] = None
    system_qty: Decimal
    physical_qty: Decimal
    variance_qty: Decimal
    uom_id: int
    adjustment_type: str
    adjusted: bool
    remarks: Optional[str] = None
    model_config = {"from_attributes": True}

class AuditResponse(BaseModel):
    id: int
    audit_number: str
    warehouse_id: int
    audit_date: datetime
    audit_type: str
    status: str
    total_items: int
    variance_items: int
    conducted_by: Optional[int] = None
    created_at: Optional[datetime] = None
    items: List[AuditItemResponse] = []
    model_config = {"from_attributes": True}

# ---- Replenishment Rule ----
class ReplenishmentRuleCreate(BaseModel):
    item_id: int
    pick_bin_id: int
    reserve_bin_id: int
    min_qty: Decimal
    max_qty: Decimal
    replenish_qty: Decimal

class ReplenishmentRuleResponse(BaseModel):
    id: int
    item_id: int
    pick_bin_id: int
    reserve_bin_id: int
    min_qty: Decimal
    max_qty: Decimal
    replenish_qty: Decimal
    is_active: bool
    model_config = {"from_attributes": True}
