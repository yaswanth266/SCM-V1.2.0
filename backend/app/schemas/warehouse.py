from pydantic import BaseModel, field_validator, model_validator
from typing import List, Optional, Union
from datetime import datetime, date
from decimal import Decimal


# ---- GRN ----
class GRNItemCreate(BaseModel):
    po_item_id: Optional[int] = None
    item_id: int
    ordered_qty: Decimal = Decimal("0")
    received_qty: Decimal
    # BUG-INV-149: uom_id is optional from the API; if the FE omits it (or sends
    # the deprecated `uom` string), the create_grn endpoint resolves it from
    # Item.primary_uom_id. Was hard-required which 422'd silently when items
    # had no primary UOM bound or when the FE row hadn't picked one yet.
    uom_id: Optional[int] = None
    batch_number: Optional[str] = None
    manufacturing_date: Optional[date] = None
    expiry_date: Optional[date] = None
    rate: Decimal = Decimal("0")
    # Wave 5 — tax + discount persistence on receipt (BUG-INV-008)
    discount_pct: Decimal = Decimal("0")
    cgst_rate: Decimal = Decimal("0")
    sgst_rate: Decimal = Decimal("0")
    igst_rate: Decimal = Decimal("0")
    tax_amount: Decimal = Decimal("0")
    weight: Decimal = Decimal("0")  # BUG-PRO-095
    accepted_qty: Decimal = Decimal("0")
    rejected_qty: Decimal = Decimal("0")
    remarks: Optional[str] = None
    serial_numbers: Optional[List[str]] = None

    @field_validator("received_qty", "ordered_qty")
    @classmethod
    def val_qty(cls, v):
        if v is not None and v < 0:
            raise ValueError("Quantity cannot be negative")
        return v

    @field_validator("rate")
    @classmethod
    def val_rate(cls, v):
        if v is not None and v < 0:
            raise ValueError("Rate cannot be negative")
        return v

    @field_validator("expiry_date")
    @classmethod
    def val_expiry(cls, v):
        if v is not None and v < date.today():
            raise ValueError("Expiry date cannot be in the past — critical for pharma compliance")
        return v

    @field_validator("manufacturing_date")
    @classmethod
    def val_mfg(cls, v):
        if v is not None and v > date.today():
            from datetime import timedelta
            # same 1-day IST slack as GRN date
            if v > (date.today() + timedelta(days=1)):
                raise ValueError("Manufacturing date cannot be more than 1 day in the future")
            return v
        return v

    @model_validator(mode="after")
    def val_mfg_before_expiry(self):
        if self.manufacturing_date and self.expiry_date and self.manufacturing_date > self.expiry_date:
            raise ValueError("Manufacturing date must be before expiry date")
        return self

class GRNCreate(BaseModel):
    po_id: Optional[int] = None
    inward_id: Optional[int] = None
    po_number: Optional[str] = None
    vendor_id: int
    warehouse_id: int
    grn_date: date
    supplier_invoice: Optional[str] = None
    supplier_invoice_date: Optional[date] = None
    vehicle_number: Optional[str] = None
    lr_number: Optional[str] = None
    receipt_type: str = "inward_based"
    remarks: Optional[str] = None
    items: List[GRNItemCreate]
    # BUG-INV-013/125: allow the frontend to flag a GRN as "save as draft" so
    # the backend doesn't unconditionally bump the status to pending_qi.
    # Default False keeps backwards compatibility with existing callers.
    is_draft: bool = False
    accepted_qty: Decimal = Decimal("0")
    rejected_qty: Decimal = Decimal("0")

    @field_validator("items")
    @classmethod
    def val_items_not_empty(cls, v):
        if not v or len(v) == 0:
            raise ValueError("At least one item is required")
        return v

    @field_validator("grn_date")
    @classmethod
    def val_grn_date(cls, v):
        # Allow today + 1 day of slack so IST clients don't get rejected
        # when the server is still on UTC yesterday.
        from datetime import timedelta
        if v is not None and v > (date.today() + timedelta(days=1)):
            raise ValueError("GRN date cannot be more than 1 day in the future")
        return v

class GRNUpdate(BaseModel):
    """BUG-INV-014: validated update payload for GRN PUT (was raw dict).
    Whitelisted scalar fields only — items mutation is intentionally NOT
    permitted on a created GRN; cancel + recreate to change item lines.
    """
    supplier_invoice: Optional[str] = None
    supplier_invoice_date: Optional[date] = None
    vehicle_number: Optional[str] = None
    lr_number: Optional[str] = None
    remarks: Optional[str] = None


class GRNItemResponse(BaseModel):
    id: int
    item_id: int
    item_name: Optional[str] = None
    item_code: Optional[str] = None
    uom_name: Optional[str] = None
    ordered_qty: Decimal
    received_qty: Decimal
    accepted_qty: Decimal
    rejected_qty: Decimal
    shortage_qty: Decimal
    excess_qty: Decimal
    uom_id: int
    batch_number: Optional[str] = None
    expiry_date: Optional[datetime] = None
    rate: Decimal
    amount: Decimal
    qi_status: str
    item_type: Optional[str] = None
    serial_numbers: List[str] = []
    model_config = {"from_attributes": True}

class GRNResponse(BaseModel):
    id: int
    grn_number: str
    po_id: Optional[int] = None
    po_number: Optional[str] = None
    inward_id: Optional[int] = None
    inward_number: Optional[str] = None
    vendor_id: int
    vendor_name: Optional[str] = None
    warehouse_id: int
    warehouse_name: Optional[str] = None
    grn_date: datetime
    receipt_type: str
    status: str
    total_qty: Decimal
    accepted_qty: Decimal
    rejected_qty: Decimal
    supplier_invoice: Optional[str] = None
    supplier_invoice_date: Optional[datetime] = None
    remarks: Optional[str] = None
    received_by: Optional[int] = None
    received_by_name: Optional[str] = None
    created_at: Optional[datetime] = None
    items: List[GRNItemResponse] = []
    model_config = {"from_attributes": True}

# ---- Quality Inspection ----
class QIItemCreate(BaseModel):
    grn_item_id: int
    item_id: int
    inspected_qty: Decimal
    accepted_qty: Decimal = Decimal("0")
    rejected_qty: Decimal = Decimal("0")
    hold_qty: Decimal = Decimal("0")
    result: str = "accepted"
    rejection_reason: Optional[str] = None
    remarks: Optional[str] = None

class QICreate(BaseModel):
    grn_id: int
    inspection_type: str = "incoming"
    inspection_date: datetime
    overall_result: str = "pass"
    status: Optional[str] = "completed"
    remarks: Optional[str] = None
    items: List[QIItemCreate]

class QIItemResponse(BaseModel):
    id: int
    grn_item_id: int
    item_id: int
    item_name: Optional[str] = None
    item_code: Optional[str] = None
    inspected_qty: Decimal
    accepted_qty: Decimal
    rejected_qty: Decimal
    hold_qty: Decimal
    result: str
    batch_number: Optional[str] = None
    rejection_reason: Optional[str] = None
    remarks: Optional[str] = None
    model_config = {"from_attributes": True}


class QIResponse(BaseModel):
    id: int
    qi_number: str
    grn_id: int
    grn_number: Optional[str] = None
    inspection_type: str
    inspection_date: datetime
    overall_result: str
    inspected_by: Optional[int] = None
    inspected_by_name: Optional[str] = None
    remarks: Optional[str] = None
    created_at: Optional[datetime] = None
    items: List[QIItemResponse] = []
    model_config = {"from_attributes": True}

# ---- Putaway ----
class PutawayItemCreate(BaseModel):
    grn_item_id: Optional[int] = None
    item_id: int
    qty: Decimal
    uom_id: Optional[int] = None
    batch_id: Optional[int] = None
    suggested_bin_id: Optional[Union[int, str]] = None

class PutawayCreate(BaseModel):
    grn_id: Optional[int] = None
    warehouse_id: int
    putaway_type: str = "system_directed"
    assigned_to: Optional[int] = None
    items: List[PutawayItemCreate]

class PutawayItemUpdate(BaseModel):
    actual_bin_id: Union[int, str]
    status: str = "done"
    serial_numbers: Optional[List[str]] = None

class PutawayItemResponse(BaseModel):
    id: int
    grn_item_id: int
    item_id: int
    item_name: Optional[str] = None
    item_code: Optional[str] = None
    qty: Decimal
    uom_id: int
    uom_name: Optional[str] = None
    batch_id: Optional[int] = None
    batch_number: Optional[str] = None
    suggested_bin_id: Optional[int] = None
    actual_bin_id: Optional[int] = None
    status: str
    has_serial: bool = False
    serial_numbers: List[str] = []
    model_config = {"from_attributes": True}


class PutawayResponse(BaseModel):
    id: int
    putaway_number: str
    grn_id: int
    grn_number: Optional[str] = None
    warehouse_id: int
    warehouse_name: Optional[str] = None
    putaway_type: str
    status: str
    assigned_to: Optional[int] = None
    assigned_to_name: Optional[str] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    total_items: int = 0
    completed_items: int = 0
    created_at: Optional[datetime] = None
    items: List[PutawayItemResponse] = []
    model_config = {"from_attributes": True}

# ---- Material Issue ----
class MaterialIssueItemCreate(BaseModel):
    item_id: int
    batch_id: Optional[int] = None
    qty: Decimal
    uom_id: int
    bin_id: Optional[int] = None
    rate: Decimal = Decimal("0")
    # Wave 7 — required when item is H1/narcotic/Rx; backend gate enforces
    prescriber_name: Optional[str] = None
    prescriber_license: Optional[str] = None
    patient_name: Optional[str] = None
    patient_id_text: Optional[str] = None
    serial_numbers: Optional[List[str]] = None

    @field_validator("qty")
    @classmethod
    def val_qty(cls, v):
        if v is not None and v <= 0:
            raise ValueError("Issue quantity must be greater than zero")
        return v

    @field_validator("rate")
    @classmethod
    def val_rate(cls, v):
        if v is not None and v < 0:
            raise ValueError("Rate cannot be negative")
        return v

class MaterialIssueCreate(BaseModel):
    mr_id: Optional[int] = None
    indent_id: Optional[int] = None
    warehouse_id: int
    destination_warehouse_id: Optional[int] = None
    issue_date: date
    department: Optional[str] = None
    issued_to: Optional[int] = None
    cost_center: Optional[str] = None
    remarks: Optional[str] = None
    items: List[MaterialIssueItemCreate]

    @field_validator("items")
    @classmethod
    def val_items_not_empty(cls, v):
        if not v or len(v) == 0:
            raise ValueError("At least one item is required")
        return v

    @field_validator("issue_date")
    @classmethod
    def val_issue_date(cls, v):
        from datetime import timedelta
        if v is not None and v > (date.today() + timedelta(days=1)):
            raise ValueError("Issue date cannot be more than 1 day in the future")
        # BUG-ISS-007 — lower bound 90 days back. Stops fraudulent retro-issue
        # back to 2020 / arbitrary historical dates.
        if v is not None and v < (date.today() - timedelta(days=90)):
            raise ValueError("Issue date cannot be more than 90 days in the past")
        return v

class MaterialIssueUpdate(BaseModel):
    mr_id: Optional[int] = None
    indent_id: Optional[int] = None
    warehouse_id: Optional[int] = None
    destination_warehouse_id: Optional[int] = None
    issue_date: Optional[date] = None
    department: Optional[str] = None
    issued_to: Optional[int] = None
    cost_center: Optional[str] = None
    remarks: Optional[str] = None
    items: Optional[List[MaterialIssueItemCreate]] = None

    @field_validator("issue_date")
    @classmethod
    def val_issue_date(cls, v):
        # BUG-ISS-007 — apply same +1d / -90d bounds on update path.
        from datetime import timedelta
        if v is not None and v > (date.today() + timedelta(days=1)):
            raise ValueError("Issue date cannot be more than 1 day in the future")
        if v is not None and v < (date.today() - timedelta(days=90)):
            raise ValueError("Issue date cannot be more than 90 days in the past")
        return v

class MaterialIssueItemResponse(BaseModel):
    # BUG-ISS-047 — DO NOT add patient_name / patient_id_text / prescriber_*
    # to this schema. PII must NOT leak via the generic MI list/detail
    # endpoint. A separate clinical-view endpoint is the right home for
    # those fields, gated by a healthcare role.
    id: int
    item_id: int
    item_name: Optional[str] = None
    item_code: Optional[str] = None
    uom_name: Optional[str] = None
    batch_id: Optional[int] = None
    batch_number: Optional[str] = None
    qty: Decimal
    uom_id: int
    bin_id: Optional[int] = None
    rate: Decimal
    amount: Decimal
    serial_numbers: Optional[List[str]] = None
    has_serial: bool = False
    model_config = {"from_attributes": True}

class MaterialIssueResponse(BaseModel):
    id: int
    issue_number: str
    mr_id: Optional[int] = None
    indent_id: Optional[int] = None
    warehouse_id: int
    warehouse_name: Optional[str] = None
    destination_warehouse_id: Optional[int] = None
    destination_warehouse_name: Optional[str] = None
    issue_date: datetime
    department: Optional[str] = None
    issued_to: Optional[int] = None
    issued_to_name: Optional[str] = None
    cost_center: Optional[str] = None
    status: str
    remarks: Optional[str] = None
    issued_by: Optional[int] = None
    created_at: Optional[datetime] = None
    items: List[MaterialIssueItemResponse] = []
    model_config = {"from_attributes": True}

# ---- Picking ----
class PickingItemCreate(BaseModel):
    item_id: int
    batch_id: Optional[int] = None
    from_bin_id: int
    qty_to_pick: Decimal
    uom_id: int

class PickingCreate(BaseModel):
    wave_id: Optional[int] = None
    do_id: Optional[int] = None
    warehouse_id: int
    pick_strategy: str = "fifo"
    assigned_to: Optional[int] = None
    items: List[PickingItemCreate]

class PickingItemUpdate(BaseModel):
    qty_picked: Decimal
    status: str = "picked"

class PickingResponse(BaseModel):
    id: int
    pick_number: str
    wave_id: Optional[int] = None
    do_id: Optional[int] = None
    warehouse_id: int
    pick_strategy: str
    status: str
    assigned_to: Optional[int] = None
    created_at: Optional[datetime] = None
    model_config = {"from_attributes": True}

# ---- Packing ----
class PackingItemCreate(BaseModel):
    item_id: int
    batch_id: Optional[int] = None
    qty: Decimal
    uom_id: int
    package_number: Optional[str] = None
    package_type: str = "box"
    gross_weight: Optional[Decimal] = None
    net_weight: Optional[Decimal] = None

class PackingCreate(BaseModel):
    pick_id: Optional[int] = None
    warehouse_id: int
    items: List[PackingItemCreate]

class PackingResponse(BaseModel):
    id: int
    pack_number: str
    pick_id: Optional[int] = None
    warehouse_id: int
    status: str
    total_packages: int
    created_at: Optional[datetime] = None
    model_config = {"from_attributes": True}

# ---- Dispatch ----
class DispatchCreate(BaseModel):
    do_id: Optional[int] = None
    pack_id: Optional[int] = None
    warehouse_id: int
    customer_id: Optional[int] = None
    destination_user_id: Optional[int] = None
    destination_warehouse_id: Optional[int] = None
    destination_type: Optional[str] = "USER"
    dispatch_type: Optional[str] = "THIRD_PARTY"
    material_issue_id: Optional[int] = None
    vehicle_number: Optional[str] = None
    vehicle_type: Optional[str] = None
    driver_name: Optional[str] = None
    driver_contact: Optional[str] = None
    transport_vendor_id: Optional[int] = None
    lr_number: Optional[str] = None
    docket_number: Optional[str] = None
    dispatch_date: Optional[datetime] = None
    expected_delivery_date: Optional[datetime] = None
    remarks: Optional[str] = None

class DispatchResponse(BaseModel):
    id: int
    dispatch_number: str
    warehouse_id: int
    status: str
    vehicle_number: Optional[str] = None
    dispatch_date: Optional[datetime] = None
    expected_delivery_date: Optional[datetime] = None
    created_at: Optional[datetime] = None
    destination_user_id: Optional[int] = None
    destination_warehouse_id: Optional[int] = None
    destination_type: Optional[str] = None
    dispatch_type: Optional[str] = None
    delivery_acknowledged: bool = False
    delivery_acknowledged_at: Optional[datetime] = None
    delivery_acknowledged_by_id: Optional[int] = None
    delivery_acknowledged_by_name: Optional[str] = None
    delivery_acknowledged_by_designation: Optional[str] = None
    delivery_acknowledged_by_phone: Optional[str] = None
    delivery_acknowledged_by_email: Optional[str] = None
    receiver_signature_url: Optional[str] = None
    receiver_id_proof_type: Optional[str] = None
    receiver_id_proof_number: Optional[str] = None
    delivery_photo_urls: Optional[List[str]] = None
    goods_condition_on_delivery: Optional[str] = None
    delivery_remarks: Optional[str] = None
    material_issue_id: Optional[int] = None
    delivery_location_latitude: Optional[Decimal] = None
    delivery_location_longitude: Optional[Decimal] = None
    delivery_location_verified: bool = False
    model_config = {"from_attributes": True}


# ---- Universal Acknowledgement Schemas ----
class DispatchAcknowledgementItemCreate(BaseModel):
    dispatch_item_id: Optional[int] = None
    material_id: int
    batch_number: Optional[str] = None
    serial_numbers: Optional[List[str]] = None
    quantity_dispatched: Decimal
    quantity_received: Decimal
    quantity_accepted: Decimal
    quantity_rejected: Decimal = Decimal("0")
    quantity_damaged: Decimal = Decimal("0")
    unit_of_measure: str = "Pcs"
    item_condition: str = "GOOD"
    rejection_reason: Optional[str] = None
    damage_description: Optional[str] = None
    item_photo_urls: Optional[List[str]] = None
    unit_price: Optional[Decimal] = None
    total_value: Optional[Decimal] = None
    manufacturing_date: Optional[date] = None
    expiry_date: Optional[date] = None
    temperature_maintained: Optional[bool] = None
    storage_condition_met: Optional[bool] = None
    remarks: Optional[str] = None

    @field_validator("item_condition")
    @classmethod
    def _validate_item_condition(cls, v: str) -> str:
        """Map unrecognised condition values to valid DB ENUM members.
        DB ENUM: GOOD | DAMAGED | EXPIRED | DEFECTIVE | WRONG_ITEM
        'PARTIAL' (formerly sent by frontend) → 'DAMAGED' is the closest match.
        """
        _VALID = {"GOOD", "DAMAGED", "EXPIRED", "DEFECTIVE", "WRONG_ITEM"}
        if v and v.upper() in _VALID:
            return v.upper()
        # Any unrecognised value (e.g. 'PARTIAL') → 'DAMAGED'
        return "DAMAGED"

    @field_validator("unit_of_measure")
    @classmethod
    def _validate_uom(cls, v: str) -> str:
        """Ensure unit_of_measure is never blank (DB column is NOT NULL)."""
        return (v or "").strip() or "Pcs"

class DispatchAcknowledgementCreate(BaseModel):
    acknowledgement_type: str  # FULL_DELIVERY, PARTIAL_DELIVERY, DAMAGED_DELIVERY, REJECTED, CONDITIONAL
    acknowledged_by_name: str
    acknowledged_by_designation: Optional[str] = None
    acknowledged_by_department: Optional[str] = None
    acknowledged_by_phone: str
    acknowledged_by_email: Optional[str] = None
    acknowledged_by_employee_code: Optional[str] = None
    
    # Destination Info
    destination_warehouse_id: Optional[int] = None
    destination_user_id: Optional[int] = None
    actual_delivery_location: Optional[str] = None
    
    # Evidence & Security
    verification_method: str = "DIGITAL_SIGNATURE"
    receiver_signature_url: Optional[str] = None
    receiver_signature_captured_via: Optional[str] = "MOBILE_APP"
    receiver_id_proof_type: Optional[str] = "NONE"
    receiver_id_proof_number: Optional[str] = None
    receiver_id_proof_document_url: Optional[str] = None
    delivery_photos: Optional[dict] = None  # JSON of photos
    
    # Geo
    delivery_latitude: Optional[Decimal] = None
    delivery_longitude: Optional[Decimal] = None
    geo_fence_verified: bool = False
    device_id: Optional[str] = None
    ip_address: Optional[str] = None
    
    # Condition & Inspection
    total_items_expected: int
    total_items_received: int
    total_items_damaged: int = 0
    total_items_rejected: int = 0
    goods_condition: str = "GOOD"
    quality_check_performed: bool = False
    quality_checked_by: Optional[str] = None
    quality_check_remarks: Optional[str] = None
    
    # Package parameters
    packaging_condition: Optional[str] = "INTACT"
    seal_intact: bool = True
    seal_number_verified: Optional[str] = None
    temperature_recorded: Optional[Decimal] = None
    humidity_recorded: Optional[Decimal] = None
    
    # Discrepancy management
    discrepancy_reported: bool = False
    discrepancy_type: Optional[str] = None
    discrepancy_description: Optional[str] = None
    
    # line items
    items: List[DispatchAcknowledgementItemCreate]


# ---- Gate Pass ----
class GatePassCreate(BaseModel):
    gate_type: str
    dispatch_id: Optional[int] = None
    grn_id: Optional[int] = None
    so_id: Optional[int] = None
    warehouse_id: int
    vehicle_number: Optional[str] = None
    person_name: Optional[str] = None
    person_contact: Optional[str] = None
    # CR_04 — destination is mandatory on gate-pass creation. We reuse the
    # material_description column for now (no migration needed) but enforce
    # presence at the schema level. UI labels this field "Destination".
    material_description: str  # destination + material info, required
    # BUG-ISS-083 — capture the security guard who approved entry/exit so the
    # gate-pass record is auditable. Optional at create; can also be set at
    # complete. Backed by GatePass.security_guard column.
    security_guard: Optional[str] = None
    remarks: Optional[str] = None

    @field_validator("material_description")
    @classmethod
    def _val_destination(cls, v):
        if not v or not str(v).strip():
            raise ValueError("Destination is required")
        return str(v).strip()

class GatePassResponse(BaseModel):
    id: int
    gate_pass_number: str
    gate_type: str
    warehouse_id: int
    vehicle_number: Optional[str] = None
    status: str
    gate_in_time: Optional[datetime] = None
    gate_out_time: Optional[datetime] = None
    created_at: Optional[datetime] = None
    so_id: Optional[int] = None
    so_number: Optional[str] = None
    model_config = {"from_attributes": True}

# ---- Sales Order ----
class SOItemCreate(BaseModel):
    item_id: int
    qty: Decimal
    uom_id: int
    rate: Decimal = Decimal("0")
    discount_pct: Decimal = Decimal("0")

class SOCreate(BaseModel):
    customer_id: int
    project_id: Optional[int] = None
    warehouse_id: int
    order_date: date
    delivery_date: Optional[date] = None
    source: str = "manual"
    remarks: Optional[str] = None
    items: List[SOItemCreate]

class SOResponse(BaseModel):
    id: int
    so_number: str
    customer_id: int
    warehouse_id: int
    order_date: datetime
    delivery_date: Optional[datetime] = None
    subtotal: Decimal
    tax_amount: Decimal
    grand_total: Decimal
    status: str
    created_at: Optional[datetime] = None
    model_config = {"from_attributes": True}

# ---- Delivery Order ----
class DOCreate(BaseModel):
    so_id: int
    warehouse_id: int
    delivery_date: Optional[date] = None

class DOResponse(BaseModel):
    id: int
    do_number: str
    so_id: int
    warehouse_id: int
    delivery_date: Optional[datetime] = None
    status: str
    created_at: Optional[datetime] = None
    model_config = {"from_attributes": True}

# ---- Wave Plan ----
class WavePlanCreate(BaseModel):
    warehouse_id: int
    wave_date: date
    priority: str = "medium"
    criteria: str = "order_priority"
    do_ids: List[int] = []

class WavePlanResponse(BaseModel):
    id: int
    wave_number: str
    warehouse_id: int
    wave_date: datetime
    priority: str
    criteria: str
    status: str
    created_at: Optional[datetime] = None
    model_config = {"from_attributes": True}

# ---- Purchase Return ----
class PurchaseReturnItemCreate(BaseModel):
    item_id: int
    batch_id: Optional[int] = None
    qty: Decimal
    uom_id: int
    rate: Decimal = Decimal("0")
    reason: Optional[str] = None

class PurchaseReturnCreate(BaseModel):
    po_id: Optional[int] = None
    grn_id: Optional[int] = None
    vendor_id: int
    warehouse_id: int
    return_date: date
    reason: Optional[str] = None
    items: List[PurchaseReturnItemCreate]

    # BUG-ISS-054 — reason MUST be supplied and at least 5 characters so the
    # vendor accounting team has a valid justification on every return.
    @field_validator("reason")
    @classmethod
    def _val_reason(cls, v):
        if v is None or not str(v).strip():
            raise ValueError("Reason is required for purchase return")
        s = str(v).strip()
        if len(s) < 5:
            raise ValueError("Reason must be at least 5 characters")
        return s

    @field_validator("return_date")
    @classmethod
    def _val_return_date(cls, v):
        # BUG-ISS-058 (partial) — return_date cannot be in the future. The
        # full check (return_date >= grn.received_date) is enforced in the
        # create_purchase_return handler since GRN lookup needs the DB.
        from datetime import timedelta
        if v is not None and v > (date.today() + timedelta(days=1)):
            raise ValueError("Return date cannot be in the future")
        return v

class PurchaseReturnUpdate(BaseModel):
    po_id: Optional[int] = None
    grn_id: Optional[int] = None
    vendor_id: Optional[int] = None
    warehouse_id: Optional[int] = None
    return_date: Optional[date] = None
    reason: Optional[str] = None
    items: Optional[List[PurchaseReturnItemCreate]] = None

class PurchaseReturnItemResponse(BaseModel):
    id: int
    return_id: int
    item_id: int
    item_name: Optional[str] = None
    item_code: Optional[str] = None
    uom_name: Optional[str] = None
    batch_id: Optional[int] = None
    qty: Decimal
    uom_id: int
    rate: Decimal
    amount: Decimal
    reason: Optional[str] = None
    model_config = {"from_attributes": True}

class PurchaseReturnResponse(BaseModel):
    id: int
    return_number: str
    po_id: Optional[int] = None
    grn_id: Optional[int] = None
    vendor_id: int
    warehouse_id: int
    return_date: datetime
    reason: Optional[str] = None
    status: str
    total_amount: Decimal
    created_by: Optional[int] = None
    created_at: Optional[datetime] = None
    items: List[PurchaseReturnItemResponse] = []
    model_config = {"from_attributes": True}


# ---- Material Inward ----

class MaterialInwardItemCreate(BaseModel):
    item_id: Optional[int] = None
    item_name_manual: Optional[str] = None
    ordered_qty: Decimal = Decimal("0")
    received_qty: Decimal
    uom_id: Optional[int] = None
    uom_manual: Optional[str] = None
    remarks: Optional[str] = None

    @field_validator("received_qty")
    @classmethod
    def val_qty(cls, v):
        if v <= 0:
            raise ValueError("Received quantity must be greater than zero")
        return v


class MaterialInwardCreate(BaseModel):
    po_id: Optional[int] = None
    po_number: Optional[str] = None
    vendor_id: Optional[int] = None
    vendor_name_manual: Optional[str] = None
    warehouse_id: int
    received_date: datetime
    vehicle_number: Optional[str] = None
    driver_name: Optional[str] = None
    remarks: Optional[str] = None
    items: List[MaterialInwardItemCreate]

    @field_validator("items")
    @classmethod
    def val_items_not_empty(cls, v):
        if not v or len(v) == 0:
            raise ValueError("At least one item is required")
        return v


class MaterialInwardItemResponse(BaseModel):
    id: int
    inward_id: int
    item_id: Optional[int] = None
    item_name_manual: Optional[str] = None
    ordered_qty: Decimal
    received_qty: Decimal
    uom_id: Optional[int] = None
    uom_manual: Optional[str] = None
    remarks: Optional[str] = None
    
    # Display helpers
    item_code: Optional[str] = None
    item_name: Optional[str] = None
    uom_name: Optional[str] = None
    item_type: Optional[str] = None

    model_config = {"from_attributes": True}


class MaterialInwardResponse(BaseModel):
    id: int
    inward_number: str
    po_id: Optional[int] = None
    po_number: Optional[str] = None
    vendor_id: Optional[int] = None
    vendor_name_manual: Optional[str] = None
    warehouse_id: int
    received_date: datetime
    vehicle_number: Optional[str] = None
    driver_name: Optional[str] = None
    remarks: Optional[str] = None
    status: str
    created_by: Optional[int] = None
    created_at: datetime
    updated_at: datetime

    # Display names
    warehouse_name: Optional[str] = None
    vendor_name: Optional[str] = None
    items: List[MaterialInwardItemResponse]

    model_config = {"from_attributes": True}

