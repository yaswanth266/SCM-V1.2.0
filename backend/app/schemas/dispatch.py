from pydantic import BaseModel, Field
from datetime import date
from typing import Any, Dict, List, Optional
from decimal import Decimal

# Dispatch Item Schemas
class DispatchItemBase(BaseModel):
    material_id: int
    indent_id: Optional[int] = None
    material_issue_id: Optional[int] = None
    requested_quantity: Decimal
    approved_quantity: Decimal
    dispatched_quantity: Decimal
    uom: str
    request_date: date
    serial_numbers: Optional[List[str]] = None

class DispatchItemCreate(DispatchItemBase):
    pass

class DispatchItemResponse(DispatchItemBase):
    id: int
    dispatch_id: str
    material_name: Optional[str] = None
    material_code: Optional[str] = None
    serial_numbers: Optional[List[str]] = None
    acknowledged_qty: Optional[Decimal] = None
    remarks: Optional[str] = None

    class Config:
        from_attributes = True

# Dispatch Header Schemas
class DispatchHeaderBase(BaseModel):
    dispatch_date: Optional[date] = None
    expected_delivery_date: Optional[date] = None
    status: str = "Draft"
    remarks: Optional[str] = None
    destination_type: Optional[str] = "USER"
    dispatch_type: Optional[str] = "THIRD_PARTY"
    warehouse_id: Optional[int] = None
    destination_warehouse_id: Optional[int] = None
    destination_user_id: Optional[int] = None

class DispatchCreate(DispatchHeaderBase):
    items: List[DispatchItemCreate]

class DispatchUpdate(DispatchHeaderBase):
    items: List[DispatchItemCreate]

class DispatchResponse(DispatchHeaderBase):
    id: int
    dispatch_id: str
    items: List[DispatchItemResponse]
    destination_warehouse_name: Optional[str] = None
    destination_user_name: Optional[str] = None
    
    # Acknowledgement details
    delivery_acknowledged: bool = False
    delivery_acknowledged_at: Optional[Any] = None
    delivery_acknowledged_by_name: Optional[str] = None
    delivery_acknowledged_by_designation: Optional[str] = None
    delivery_acknowledged_by_phone: Optional[str] = None
    delivery_acknowledged_by_email: Optional[str] = None
    delivery_acknowledged_by_department: Optional[str] = None
    delivery_acknowledged_by_employee_code: Optional[str] = None
    receiver_signature_url: Optional[str] = None
    receiver_id_proof_type: Optional[str] = None
    receiver_id_proof_number: Optional[str] = None
    actual_delivery_location: Optional[str] = None
    delivery_location_latitude: Optional[Decimal] = None
    delivery_location_longitude: Optional[Decimal] = None
    delivery_photo_urls: Optional[Any] = None
    goods_condition_on_delivery: Optional[str] = None
    delivery_remarks: Optional[str] = None

    class Config:
        from_attributes = True
