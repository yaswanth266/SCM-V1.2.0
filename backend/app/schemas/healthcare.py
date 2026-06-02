from pydantic import BaseModel
from typing import Dict, List, Literal, Optional
from datetime import date, datetime
from decimal import Decimal


# ---- Batch Recall ----
class BatchRecallCreate(BaseModel):
    item_id: int
    batch_id: Optional[int] = None
    reason: str
    severity: str
    notes: Optional[str] = None


class BatchRecallResponse(BaseModel):
    id: int
    recall_number: str
    item_id: int
    batch_id: Optional[int] = None
    reason: str
    severity: str
    status: str
    notes: Optional[str] = None
    recovered_qty: Optional[Decimal] = None
    completed_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    traces: List[dict] = []
    model_config = {"from_attributes": True}


class BatchRecallUpdate(BaseModel):
    status: Optional[str] = None
    notes: Optional[str] = None
    recovered_qty: Optional[Decimal] = None
    completed_at: Optional[datetime] = None


# ---- Rate Contract ----
class RateContractItemCreate(BaseModel):
    item_id: int
    base_rate: Decimal
    min_qty: Decimal = Decimal("0")
    max_qty: Decimal = Decimal("0")
    discount_pct: Decimal = Decimal("0")
    effective_rate: Decimal
    uom_id: Optional[int] = None


class RateContractItemResponse(BaseModel):
    id: int
    rate_contract_id: int
    item_id: int
    base_rate: Decimal
    min_qty: Decimal
    max_qty: Decimal
    discount_pct: Decimal
    effective_rate: Decimal
    uom_id: Optional[int] = None
    model_config = {"from_attributes": True}


class RateContractCreate(BaseModel):
    vendor_id: int
    start_date: date
    end_date: date
    min_order_value: Decimal = Decimal("0")
    payment_terms_days: int = 30
    remarks: Optional[str] = None
    items: List[RateContractItemCreate] = []


class RateContractResponse(BaseModel):
    id: int
    contract_number: str
    vendor_id: int
    start_date: date
    end_date: date
    min_order_value: Decimal
    payment_terms_days: int
    status: str
    remarks: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    items: List[RateContractItemResponse] = []
    model_config = {"from_attributes": True}


class RateContractUpdate(BaseModel):
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    min_order_value: Optional[Decimal] = None
    payment_terms_days: Optional[int] = None
    status: Optional[str] = None
    remarks: Optional[str] = None
    items: Optional[List[RateContractItemCreate]] = None


# ---- Vendor Scorecard ----
class VendorScorecardResponse(BaseModel):
    id: int
    vendor_id: int
    vendor_name: Optional[str] = None
    period_from: Optional[date] = None
    period_to: Optional[date] = None
    total_orders: int = 0
    on_time_deliveries: int = 0
    rejected_qty: Decimal = Decimal("0")
    total_qty: Decimal = Decimal("0")
    avg_lead_time_days: Decimal = Decimal("0")
    quality_score: Decimal = Decimal("0")
    delivery_score: Decimal = Decimal("0")
    cost_score: Decimal = Decimal("0")
    overall_score: Decimal = Decimal("0")
    grade: Optional[str] = None
    created_at: Optional[datetime] = None
    model_config = {"from_attributes": True}


# ---- Item Kit ----
class KitComponentCreate(BaseModel):
    item_id: int
    qty: Decimal
    uom_id: Optional[int] = None
    is_optional: bool = False
    remarks: Optional[str] = None


class KitComponentResponse(BaseModel):
    id: int
    kit_id: int
    item_id: int
    qty: Decimal
    uom_id: Optional[int] = None
    is_optional: bool
    remarks: Optional[str] = None
    model_config = {"from_attributes": True}


class ItemKitCreate(BaseModel):
    kit_code: str
    name: str
    description: Optional[str] = None
    kit_type: str = "custom"
    department: Optional[str] = None
    components: List[KitComponentCreate] = []


class ItemKitResponse(BaseModel):
    id: int
    kit_code: str
    name: str
    description: Optional[str] = None
    kit_type: str
    department: Optional[str] = None
    is_active: bool
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    components: List[KitComponentResponse] = []
    model_config = {"from_attributes": True}


class ItemKitUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    kit_type: Optional[str] = None
    department: Optional[str] = None
    is_active: Optional[bool] = None


# ---- Department Budget ----
class DepartmentBudgetCreate(BaseModel):
    department: str
    project_id: Optional[int] = None
    fiscal_year: str
    budget_amount: Decimal


class DepartmentBudgetResponse(BaseModel):
    id: int
    department: str
    project_id: Optional[int] = None
    fiscal_year: str
    budget_amount: Decimal
    consumed_amount: Decimal = Decimal("0")
    blocked_amount: Decimal = Decimal("0")
    available_amount: Decimal = Decimal("0")
    utilization_pct: Decimal = Decimal("0")
    status: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    model_config = {"from_attributes": True}


class DepartmentBudgetUpdate(BaseModel):
    budget_amount: Optional[Decimal] = None
    status: Optional[str] = None


# ---- Landed Cost ----
class LandedCostAllocationResponse(BaseModel):
    id: int
    landed_cost_id: int
    grn_item_id: int
    allocated_amount: Decimal
    model_config = {"from_attributes": True}


class LandedCostCreate(BaseModel):
    grn_id: int
    cost_type: str
    description: Optional[str] = None
    amount: Decimal
    allocation_method: str = "by_value"


class LandedCostResponse(BaseModel):
    id: int
    grn_id: int
    cost_type: str
    description: Optional[str] = None
    amount: Decimal
    allocation_method: str
    created_at: Optional[datetime] = None
    allocations: List[LandedCostAllocationResponse] = []
    model_config = {"from_attributes": True}


# ---- Carrier Tracking ----
class CarrierTrackingCreate(BaseModel):
    carrier_name: str
    tracking_number: str
    carrier_url: Optional[str] = None
    transport_order_id: Optional[int] = None
    dispatch_id: Optional[int] = None
    estimated_delivery: Optional[datetime] = None


class CarrierTrackingResponse(BaseModel):
    id: int
    carrier_name: str
    tracking_number: str
    carrier_url: Optional[str] = None
    transport_order_id: Optional[int] = None
    dispatch_id: Optional[int] = None
    current_status: Optional[str] = None
    last_location: Optional[str] = None
    estimated_delivery: Optional[datetime] = None
    actual_delivery: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    model_config = {"from_attributes": True}


class CarrierTrackingUpdate(BaseModel):
    current_status: Optional[str] = None
    last_location: Optional[str] = None
    actual_delivery: Optional[datetime] = None


# ============================================================
# Analytics / Report Response Schemas
# ============================================================

# ---- Expiry Bucket ----
class ExpiryBucketItem(BaseModel):
    item_id: int
    item_code: str
    item_name: str
    batch_number: str
    expiry_date: date
    qty: Decimal
    warehouse_name: Optional[str] = None
    days_until_expiry: int
    bucket: Literal["expired", "0-30", "31-60", "61-90", "90+"]


class ExpiryDashboardResponse(BaseModel):
    summary: Dict[str, int]
    items: List[ExpiryBucketItem]


# ---- ABC / VED / FSN Analysis ----
class ABCItem(BaseModel):
    item_id: int
    item_code: str
    item_name: str
    annual_consumption_value: Decimal
    cumulative_pct: Decimal
    abc_class: str
    ved_class: str
    fsn_class: str


# ---- Patient Cost ----
class PatientCostItem(BaseModel):
    patient_name: str
    patient_aadhaar_masked: Optional[str] = None
    department: Optional[str] = None
    total_items: int
    total_value: Decimal


# ---- Vendor Comparison ----
class VendorComparisonItem(BaseModel):
    vendor_id: int
    vendor_name: str
    unit_rate: Decimal
    qty_available: Optional[Decimal] = None
    delivery_days: Optional[int] = None
    total_amount: Decimal
    contract_number: Optional[str] = None


# ---- Available To Promise (ATP) ----
class ATPItem(BaseModel):
    item_id: int
    item_code: str
    item_name: str
    warehouse_id: Optional[int] = None
    warehouse_name: Optional[str] = None
    total_stock: Decimal
    transit_qty: Decimal
    available_qty: Decimal


# ---- Stock Aging ----
class AgingBucket(BaseModel):
    item_id: int
    item_code: str
    item_name: str
    warehouse: Optional[str] = None
    bucket_0_30: Decimal
    bucket_31_60: Decimal
    bucket_61_90: Decimal
    bucket_90_plus: Decimal
    total_value: Decimal


# ---- Procurement Cycle Time ----
class CycleTimeItem(BaseModel):
    vendor_id: int
    vendor_name: str
    avg_indent_to_po_days: Decimal
    avg_po_to_grn_days: Decimal
    avg_total_days: Decimal
    order_count: int


# ---- Inter-Warehouse Transfer Suggestion ----
class TransferSuggestion(BaseModel):
    item_id: int
    item_code: str
    item_name: str
    from_warehouse_id: int
    from_warehouse: str
    to_warehouse_id: int
    to_warehouse: str
    suggested_qty: Decimal
    from_stock: Decimal
    to_stock: Decimal
    reason: str


# ---- FEFO Picking ----
class FEFOPickingSuggestion(BaseModel):
    batch_id: Optional[int] = None
    batch_number: Optional[str] = None
    item_id: int
    item_code: str
    item_name: str
    expiry_date: Optional[date] = None
    qty_available: Decimal
    warehouse_id: int
    warehouse_name: Optional[str] = None
    is_expired: bool


# ---- Kit Consume Request ----
class KitConsumeRequest(BaseModel):
    warehouse_id: int
    department: Optional[str] = None
    patient_name: Optional[str] = None
    qty: int = 1
    # BUG-HC-034: prescriber identifiers required if any kit component is H1/narcotic/Rx
    prescriber_name: Optional[str] = None
    prescriber_license: Optional[str] = None
