from pydantic import BaseModel, field_validator
from typing import List, Optional
from datetime import datetime, date
from decimal import Decimal


class TransportRequirementCreate(BaseModel):
    requirement_type: str
    dispatch_warehouse_id: Optional[int] = None
    destination_warehouse_id: Optional[int] = None
    dispatch_address: Optional[str] = None
    destination_address: Optional[str] = None
    destination: Optional[str] = None  # frontend alias for destination_address
    material_description: Optional[str] = None
    total_qty: Optional[Decimal] = None
    total_weight: Optional[Decimal] = None
    total_volume: Optional[Decimal] = None
    vehicle_type_required: Optional[str] = None
    expected_dispatch_date: Optional[date] = None
    expected_delivery_date: Optional[date] = None
    priority: str = "medium"
    status: Optional[str] = None  # frontend may pass status (draft / open)
    reference_type: Optional[str] = None
    reference_id: Optional[int] = None
    remarks: Optional[str] = None

class TransportRequirementResponse(BaseModel):
    id: int
    requirement_number: str
    requirement_type: str
    dispatch_warehouse_id: Optional[int] = None
    destination_warehouse_id: Optional[int] = None
    # Bug fix BUG_0008/0024 — these fields were missing from the response,
    # causing all locations + materials to display as blank in the UI.
    dispatch_address: Optional[str] = None
    destination_address: Optional[str] = None
    material_description: Optional[str] = None
    total_qty: Optional[Decimal] = None
    total_weight: Optional[Decimal] = None
    total_volume: Optional[Decimal] = None
    vehicle_type_required: Optional[str] = None
    reference_type: Optional[str] = None
    reference_id: Optional[int] = None
    remarks: Optional[str] = None
    priority: str
    status: str
    expected_dispatch_date: Optional[datetime] = None
    expected_delivery_date: Optional[datetime] = None
    created_at: Optional[datetime] = None
    created_by: Optional[int] = None
    model_config = {"from_attributes": True}

class TransportQuotationCreate(BaseModel):
    requirement_id: Optional[int] = None
    transport_requirement_id: Optional[int] = None  # frontend alias
    vendor_id: int
    quoted_amount: Decimal
    vehicle_available: bool = True
    vehicle_availability: Optional[bool] = None  # frontend alias
    vehicle_type: Optional[str] = None
    estimated_delivery_days: Optional[int] = None
    vendor_rating: Optional[float] = None
    previous_performance: Optional[float] = None
    remarks: Optional[str] = None

class TransportQuotationResponse(BaseModel):
    id: int
    requirement_id: int
    vendor_id: int
    quoted_amount: Decimal
    vehicle_type: Optional[str] = None
    estimated_delivery_days: Optional[int] = None
    status: str
    # Bug fix BUG_0007/0071 — fields were missing from the response, hiding
    # the comparison data the user expects to see.
    vehicle_available: Optional[bool] = None
    vendor_rating: Optional[float] = None
    previous_performance: Optional[float] = None
    remarks: Optional[str] = None
    submitted_at: Optional[datetime] = None
    model_config = {"from_attributes": True}

class TransportOrderCreate(BaseModel):
    requirement_id: int
    quotation_id: Optional[int] = None
    vendor_id: int
    vehicle_type: Optional[str] = None
    vehicle_number: Optional[str] = None
    driver_name: Optional[str] = None
    driver_contact: Optional[str] = None
    docket_number: Optional[str] = None
    courier_reference: Optional[str] = None
    lr_number: Optional[str] = None
    expected_delivery_date: Optional[date] = None
    transport_cost: Decimal = Decimal("0")
    remarks: Optional[str] = None

class TransportOrderResponse(BaseModel):
    id: int
    order_number: str
    requirement_id: int
    vendor_id: int
    vehicle_number: Optional[str] = None
    driver_name: Optional[str] = None
    status: str
    transport_cost: Decimal
    dispatch_date: Optional[datetime] = None
    expected_delivery_date: Optional[datetime] = None
    actual_delivery_date: Optional[datetime] = None
    created_at: Optional[datetime] = None
    model_config = {"from_attributes": True}

class ShipmentTrackingCreate(BaseModel):
    transport_order_id: int
    status: str
    status_timestamp: Optional[datetime] = None
    location_description: Optional[str] = None
    barcode_scanned: Optional[str] = None
    remarks: Optional[str] = None

    # BUG-ISS-102 — status_timestamp must not be in the future. A future scan
    # produces a non-sensical tracking timeline. Allow +5 min slack for clock
    # skew between mobile scanner and server.
    @field_validator("status_timestamp")
    @classmethod
    def _val_status_ts(cls, v):
        if v is None:
            return v
        from datetime import datetime as _dt, timezone as _tz, timedelta
        now = _dt.now(_tz.utc)
        # Pydantic gives tz-aware datetime when input has tz; coerce naive to UTC.
        cmp_v = v if v.tzinfo is not None else v.replace(tzinfo=_tz.utc)
        if cmp_v > now + timedelta(minutes=5):
            raise ValueError("status_timestamp cannot be in the future")
        return v

class ShipmentTrackingResponse(BaseModel):
    id: int
    transport_order_id: int
    status: str
    status_timestamp: datetime
    location_description: Optional[str] = None
    barcode_scanned: Optional[str] = None
    updated_by: Optional[int] = None
    remarks: Optional[str] = None
    model_config = {"from_attributes": True}

class ReceiptConfirmationCreate(BaseModel):
    transport_order_id: int
    received_qty: Optional[Decimal] = None
    delivery_remarks: Optional[str] = None
    condition_remarks: Optional[str] = None
    barcode_scanned: Optional[str] = None

class ReceiptConfirmationResponse(BaseModel):
    id: int
    transport_order_id: int
    received_by: int
    received_at: datetime
    received_qty: Optional[Decimal] = None
    delivery_remarks: Optional[str] = None
    condition_remarks: Optional[str] = None
    barcode_scanned: Optional[str] = None
    model_config = {"from_attributes": True}

class MDAItemCreate(BaseModel):
    item_id: int
    batch_id: Optional[int] = None
    qty: Decimal
    uom_id: int

class MDACreate(BaseModel):
    transport_order_id: int
    dispatch_warehouse_id: int
    destination: Optional[str] = None
    dispatch_date: Optional[datetime] = None
    vehicle_number: Optional[str] = None
    docket_number: Optional[str] = None
    lr_number: Optional[str] = None
    total_packages: int = 0
    total_weight: Optional[Decimal] = None
    remarks: Optional[str] = None
    items: List[MDAItemCreate]

class MDAResponse(BaseModel):
    id: int
    mda_number: str
    transport_order_id: int
    dispatch_warehouse_id: int
    destination: Optional[str] = None
    dispatch_date: Optional[datetime] = None
    vehicle_number: Optional[str] = None
    total_packages: int
    created_at: Optional[datetime] = None
    model_config = {"from_attributes": True}
