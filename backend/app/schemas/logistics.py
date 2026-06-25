from pydantic import BaseModel, Field, field_validator
from typing import List, Optional, Dict, Any
from datetime import datetime, date
from app.schemas.master import validate_phone_number


# --- MASTER DATA SCHEMAS ---

class LocationSchema(BaseModel):
    id: int
    location_code: str
    location_name: str
    location_type: str
    address_line1: str
    address_line2: Optional[str] = None
    city: str
    state: str
    pincode: str
    latitude: float
    longitude: float
    contact_person: str
    mobile: str
    email: str
    delivery_instructions: Optional[str] = None
    access_hours_from: Optional[str] = None
    access_hours_to: Optional[str] = None
    is_active: bool

    @field_validator("mobile")
    @classmethod
    def val_mobile(cls, v):
        if v and v.strip():
            return validate_phone_number(v)
        return v

    class Config:
        from_attributes = True

class RouteLocationSchema(BaseModel):
    id: int
    route_id: int
    location_id: int
    sequence_number: int
    distance_from_previous_km: float
    estimated_time_minutes: int
    location: Optional[LocationSchema] = None

    class Config:
        from_attributes = True

class RouteSchema(BaseModel):
    id: int
    route_code: str
    route_name: str
    origin_warehouse_id: int
    estimated_distance_km: float
    estimated_duration_hours: float
    terrain_type: str
    recommended_vehicle_type: str
    is_active: bool

    class Config:
        from_attributes = True

class LoadingBaySchema(BaseModel):
    id: int
    warehouse_id: int
    bay_number: str
    bay_name: Optional[str] = None
    max_vehicle_type: Optional[str] = None
    is_covered: bool
    has_dock_leveler: bool
    has_forklift: bool
    is_active: bool
    current_status: str

    class Config:
        from_attributes = True

# --- DISPATCH SCHEMAS ---

class MaterialCreate(BaseModel):
    materialId: int
    qty: float
    batchNo: Optional[str] = None
    pkgType: str
    pkgCount: int
    instructions: Optional[str] = None

class DestinationCreate(BaseModel):
    locationId: int
    seq: int
    contactPerson: str
    contactMobile: str

    @field_validator("contactMobile")
    @classmethod
    def val_contact_mobile(cls, v):
        if v and v.strip():
            return validate_phone_number(v)
        return v

class SdoCreate(BaseModel):
    routeId: Optional[int] = None
    pickupDate: str
    deliveryDate: str
    loadingTime: int
    unloadingTime: int
    helperRequired: bool
    specialReqs: Optional[str] = None
    destinations: List[DestinationCreate]
    materials: List[MaterialCreate]

class MdoCreate(BaseModel):
    warehouseId: int
    priority: str
    specialInstructions: Optional[str] = None
    materials: List[MaterialCreate]
    dispatch_mode: Optional[str] = "direct"
    # SCM Single/Multi-Level Dispatch fields
    material_issue_id: Optional[int] = None
    indent_id: Optional[int] = None
    destination_warehouse_id: Optional[int] = None
    destination_user_id: Optional[int] = None
    delivery_address: Optional[str] = None
    e_challan: Optional[str] = None
    waybill: Optional[str] = None
    dispatch_type: Optional[str] = "THIRD_PARTY"
    courier_name: Optional[str] = None
    awb_no: Optional[str] = None
    vehicle_no: Optional[str] = None
    driver_name: Optional[str] = None
    driver_phone: Optional[str] = None
    received_by_name: Optional[str] = None
    received_by_phone: Optional[str] = None
    handover_remarks: Optional[str] = None

    @field_validator("driver_phone", "received_by_phone")
    @classmethod
    def val_phones(cls, v):
        if v and v.strip():
            return validate_phone_number(v)
        return v

# --- TRANSACTION RESPONSE SCHEMAS ---

class DispatchMaterialResponse(BaseModel):
    id: int
    mdo_id: Optional[int]
    sdo_id: Optional[int]
    material_id: int
    material_code: Optional[str] = None
    material_name: Optional[str] = None
    quantity: float
    unit_of_measure: str
    total_weight_kg: float
    total_volume_cft: float
    unit_price: float
    total_value: float
    batch_number: Optional[str]
    serial_numbers: Optional[List[str]] = None
    number_of_packages: int
    package_type: Optional[str]
    handling_instructions: Optional[str]
    special_storage_condition: bool = False
    storage_min_temp: Optional[float] = None
    storage_max_temp: Optional[float] = None
    storage_min_moisture: Optional[float] = None
    storage_max_moisture: Optional[float] = None
    storage_breakable: bool = False
    special_transport_condition: bool = False
    transport_min_temp: Optional[float] = None
    transport_max_temp: Optional[float] = None
    transport_min_moisture: Optional[float] = None
    transport_max_moisture: Optional[float] = None
    transport_breakable: bool = False

    class Config:
        from_attributes = True

class SdoDestinationResponse(BaseModel):
    id: int
    sdo_id: int
    location_id: int
    location_name: Optional[str] = None
    location_code: Optional[str] = None
    sequence_number: int
    estimated_arrival_datetime: datetime
    delivery_contact_person: str
    delivery_contact_mobile: str
    actual_arrival_datetime: Optional[datetime] = None
    actual_departure_datetime: Optional[datetime] = None
    pod_received: bool
    pod_received_by: Optional[str] = None
    pod_received_at: Optional[datetime] = None
    pod_document_url: Optional[str] = None
    status: str

    class Config:
        from_attributes = True

class SdoResponse(BaseModel):
    id: int
    sdo_number: str
    mdo_id: int
    route_id: Optional[int]
    route_name: Optional[str]
    vehicle_type_required: str
    estimated_weight_kg: float
    estimated_volume_cft: float
    estimated_distance_km: float
    loading_time_minutes: int
    unloading_time_minutes: int
    requires_loading_helper: bool
    special_requirements: Optional[str]
    status: str
    created_at: datetime
    destinations: List[SdoDestinationResponse] = []
    materials: List[DispatchMaterialResponse] = []
    custodian_position_id: Optional[int] = None
    custodian_position_name: Optional[str] = None
    sequence_number: Optional[int] = 1
    handover_type: Optional[str] = None
    handed_over_by_id: Optional[int] = None
    handed_over_by_name: Optional[str] = None
    handover_time: Optional[datetime] = None
    carrier_details: Optional[Dict[str, Any]] = None
    received_by_id: Optional[int] = None
    received_by_name: Optional[str] = None
    received_at: Optional[datetime] = None
    seal_intact: Optional[bool] = None
    packaging_condition: Optional[str] = None
    discrepancy_reported: Optional[bool] = None
    receiving_remarks: Optional[str] = None
    handover_photos: Optional[List[str]] = None
    handover_signature: Optional[str] = None
    receipt_photos: Optional[List[str]] = None
    receipt_signature: Optional[str] = None

    class Config:
        from_attributes = True


class DispatchHandoverResponse(BaseModel):
    id: int
    dispatch_id: int
    handover_no: Optional[str] = None
    handover_type: str
    handed_over_by_entity_id: int
    received_by_name: str
    received_by_phone: Optional[str] = None
    transporter_id: Optional[int] = None
    vehicle_no: Optional[str] = None
    driver_name: Optional[str] = None
    driver_phone: Optional[str] = None
    courier_name: Optional[str] = None
    awb_no: Optional[str] = None
    handover_otp: Optional[str] = None
    otp_verified: bool
    handover_document: Optional[str] = None
    remarks: Optional[str] = None
    handover_time: datetime
    status: str
    created_at: datetime

    class Config:
        from_attributes = True


class MdoResponse(BaseModel):
    id: int
    mdo_number: str
    customer_reference: Optional[str]
    order_reference: Optional[str]
    warehouse_id: int
    warehouse_name: Optional[str] = None
    order_date: date
    required_delivery_date: Optional[date]
    total_material_items: int
    total_weight_kg: float
    total_volume_cft: float
    total_value: float
    special_instructions: Optional[str]
    priority: str
    status: str
    created_by: int
    creator_name: Optional[str] = None
    approved_by: Optional[int]
    approved_at: Optional[datetime]
    created_at: datetime
    updated_at: datetime
    sdos: List[SdoResponse] = []
    materials: List[DispatchMaterialResponse] = []
    # SCM Single/Multi-Level Dispatch fields
    material_issue_id: Optional[int] = None
    material_issue_number: Optional[str] = None
    indent_id: Optional[int] = None
    indent_number: Optional[str] = None
    destination_warehouse_id: Optional[int] = None
    destination_user_id: Optional[int] = None
    destination_user_name: Optional[str] = None
    delivery_address: Optional[str] = None
    e_challan: Optional[str] = None
    waybill: Optional[str] = None
    dispatch_type: Optional[str] = None
    dispatch_mode: Optional[str] = "direct"
    handover: Optional[DispatchHandoverResponse] = None
    # Proof of Delivery / Acknowledgement fields
    delivery_acknowledged: Optional[bool] = False
    delivery_acknowledged_at: Optional[datetime] = None
    delivery_acknowledged_by_name: Optional[str] = None
    delivery_acknowledged_by_phone: Optional[str] = None
    receiver_signature_url: Optional[str] = None
    delivery_photo_urls: Optional[Dict[str, Any]] = None
    goods_condition_on_delivery: Optional[str] = None
    delivery_remarks: Optional[str] = None

    class Config:
        from_attributes = True


class DispatchHandoverCreate(BaseModel):
    dispatch_id: int
    handover_type: str
    received_by_name: str
    received_by_phone: Optional[str] = None
    transporter_id: Optional[int] = None
    vehicle_no: Optional[str] = None
    driver_name: Optional[str] = None
    driver_phone: Optional[str] = None
    courier_name: Optional[str] = None
    awb_no: Optional[str] = None
    remarks: Optional[str] = None
    handover_document: Optional[str] = None

    @field_validator("received_by_phone", "driver_phone")
    @classmethod
    def val_phones(cls, v):
        if v and v.strip():
            return validate_phone_number(v)
        return v


class DispatchHandoverVerifyOtp(BaseModel):
    otp: str

# --- RFQ SCHEMAS ---

class RfqCreateSchema(BaseModel):
    title: str
    description: Optional[str] = None
    deadline: str
    expected_delivery_date: Optional[str] = None  # ISO string; communicated to carriers as target
    mdoId: int
    sdoIds: List[int]
    invitedVendorIds: List[int]
    paymentTerms: Optional[str] = None
    advancePercentage: float = 0.0
    insuranceRequired: bool = False
    criteriaPrice: float = 40.0
    criteriaRating: float = 30.0
    criteriaTimeline: float = 30.0
    vehicle_type_required: Optional[str] = None


    @field_validator("deadline")
    @classmethod
    def validate_deadline(cls, v):
        if v:
            try:
                dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
            except ValueError:
                raise ValueError("deadline must be a valid ISO format string")
            now = datetime.now(dt.tzinfo) if dt.tzinfo else datetime.now()
            if dt < now:
                raise ValueError("Deadline cannot be in the past")
        return v

    @field_validator("expected_delivery_date")
    @classmethod
    def validate_expected_delivery_date(cls, v):
        if v:
            try:
                dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
            except ValueError:
                raise ValueError("expected_delivery_date must be a valid ISO format string")
            if dt.date() < date.today():
                raise ValueError("Expected delivery date cannot be in the past")
        return v

class RfqVendorResponse(BaseModel):
    id: int
    rfq_id: int
    vendor_id: int
    vendor_name: Optional[str] = None
    vendor_code: Optional[str] = None
    invited_at: datetime
    response_status: str
    declined_at: Optional[datetime] = None
    decline_reason: Optional[str] = None

    class Config:
        from_attributes = True

class RfqResponseVehicleResponse(BaseModel):
    id: int
    response_id: int
    vehicle_number: str
    vehicle_registration_no: Optional[str] = None
    vehicle_type: str
    vehicle_capacity_kg: Optional[float] = None
    vehicle_capacity_cft: Optional[float] = None
    driver_name: Optional[str] = None
    driver_mobile: Optional[str] = None
    driver_license_no: Optional[str] = None
    vehicle_base_price: float
    vehicle_loading_charges: float
    vehicle_unloading_charges: float
    detention_charges_per_hour: float
    other_charges: float
    total_vehicle_price: float
    insurance_required: bool
    insurance_cost: float
    gps_enabled: bool

    class Config:
        from_attributes = True

class SdoAssignmentResponse(BaseModel):
    id: int
    response_id: int
    vehicle_response_id: int
    sdo_id: int
    sdo_number: Optional[str] = None
    sdo_quoted_price: float
    estimated_pickup_datetime: datetime
    estimated_delivery_datetime: datetime

    class Config:
        from_attributes = True

class RfqResponseQuoteResponse(BaseModel):
    id: int
    rfq_id: int
    vendor_id: int
    vendor_name: Optional[str] = None
    response_number: str
    response_date: datetime
    pricing_type: str
    total_quoted_price: float
    advance_payment_percentage: float
    vendor_remarks: Optional[str] = None
    status: str
    evaluation_score: Optional[float] = None
    is_selected: bool
    vehicles: List[RfqResponseVehicleResponse] = []
    assignments: List[SdoAssignmentResponse] = []

    class Config:
        from_attributes = True

class RfqResponse(BaseModel):
    id: int
    rfq_number: str
    rfq_type: str
    mdo_id: Optional[int]
    mdo_number: Optional[str] = None
    title: str
    description: Optional[str] = None
    issue_date: datetime
    response_deadline: datetime
    expected_delivery_date: Optional[datetime] = None
    total_estimated_weight_kg: float
    total_estimated_volume_cft: float
    vehicle_type_required: str
    payment_terms: Optional[str] = None
    advance_payment_percentage: float
    insurance_required: bool
    status: str
    evaluation_criteria: Optional[Dict[str, float]] = None
    created_at: datetime
    invited_vendors: List[RfqVendorResponse] = []
    responses: List[RfqResponseQuoteResponse] = []
    materials: List[DispatchMaterialResponse] = []

    class Config:
        from_attributes = True

# --- BIDDING SCHEMAS ---

class SdoAssignmentCreate(BaseModel):
    sdoId: int
    quotedPrice: float
    pickupTime: str
    deliveryTime: str

class VehicleQuoteCreate(BaseModel):
    vehicleType: str
    registrationNo: str
    driverName: str
    driverMobile: str
    driverLicense: str
    capacityKg: float
    capacityCft: float
    basePrice: float
    loadingCharges: float
    unloadingCharges: float
    detentionCharges: float
    otherCharges: float
    gpsEnabled: bool
    sdoAssignments: List[SdoAssignmentCreate]

    @field_validator("driverMobile")
    @classmethod
    def val_driver_mobile(cls, v):
        if v and v.strip():
            return validate_phone_number(v)
        return v

class QuoteSubmit(BaseModel):
    rfqId: int
    vendorId: int
    pricingType: str
    totalQuotedPrice: float
    paymentTerms: str
    advancePercentage: float
    remarks: Optional[str] = None
    vehicles: List[VehicleQuoteCreate]

class DeclineRfqInvitation(BaseModel):
    rfqId: int
    vendorId: int
    reason: str

class AwardRfqQuote(BaseModel):
    rfqId: int
    responseId: int
    remarks: Optional[str] = None

# --- SERVICE ORDER SCHEMAS ---

class ServiceOrderSdoMappingResponse(BaseModel):
    id: int
    so_id: int
    so_vehicle_id: int
    sdo_id: int
    sdo_number: Optional[str] = None
    delivery_sequence: Optional[int] = None
    status: str
    delivered_at: Optional[datetime] = None
    delivered_to: Optional[str] = None
    delivery_remarks: Optional[str] = None

    class Config:
        from_attributes = True

class ServiceOrderVehicleResponse(BaseModel):
    id: int
    so_id: int
    vehicle_type: Optional[str] = None
    vehicle_registration_no: Optional[str] = None
    driver_name: Optional[str] = None
    driver_mobile: Optional[str] = None
    driver_license_no: Optional[str] = None
    vehicle_order_value: Optional[float] = None
    scheduled_pickup_datetime: Optional[datetime] = None
    scheduled_delivery_datetime: Optional[datetime] = None
    gate_entry_time: Optional[datetime] = None
    gate_pass_number: Optional[str] = None
    loading_bay_number: Optional[str] = None
    loading_start_time: Optional[datetime] = None
    loading_end_time: Optional[datetime] = None
    actual_arrival_datetime: Optional[datetime] = None
    actual_departure_datetime: Optional[datetime] = None
    actual_delivery_datetime: Optional[datetime] = None
    lr_number: Optional[str] = None
    lr_date: Optional[date] = None
    eway_bill_number: Optional[str] = None
    eway_bill_expiry: Optional[datetime] = None
    pod_received: bool
    pod_received_at: Optional[datetime] = None
    pod_received_by: Optional[str] = None
    pod_document_url: Optional[str] = None
    gps_tracking_url: Optional[str] = None
    vehicle_status: str
    has_issues: bool
    issue_description: Optional[str] = None
    delay_reason: Optional[str] = None
    delay_minutes: int

    class Config:
        from_attributes = True

class ServiceOrderResponse(BaseModel):
    id: int
    so_number: str
    rfq_id: int
    rfq_number: Optional[str] = None
    response_id: int
    vendor_id: int
    vendor_name: Optional[str] = None
    mdo_id: Optional[int]
    warehouse_id: Optional[int] = None
    warehouse_name: Optional[str] = None
    so_type: str
    total_order_value: float
    payment_terms: Optional[str] = None
    advance_payment_percentage: float
    advance_payment_amount: Optional[float] = None
    advance_paid: bool
    status: str
    acknowledged_by_vendor: bool
    acknowledged_at: Optional[datetime] = None
    vendor_remarks: Optional[str] = None
    arrival_date: Optional[str] = None
    expected_delivery_date: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    po_number: Optional[str] = None
    created_at: datetime
    vehicles: List[ServiceOrderVehicleResponse] = []
    mappings: List[ServiceOrderSdoMappingResponse] = []

    class Config:
        from_attributes = True

class SoAcknowledge(BaseModel):
    action: Optional[str] = "accept"
    remarks: Optional[str] = None
    arrival_date: Optional[str] = None

    @field_validator("arrival_date")
    @classmethod
    def validate_arrival_date(cls, v):
        if v is not None and v.strip():
            try:
                parsed_date = date.fromisoformat(v)
            except ValueError:
                raise ValueError("arrival_date must be in YYYY-MM-DD format")
            if parsed_date < date.today():
                raise ValueError("Expected arrival date cannot be in the past")
        return v

class VehicleStatusUpdate(BaseModel):
    nextStatus: str
    gatePassNumber: Optional[str] = None
    gateOutPassNumber: Optional[str] = None
    loadingBayNumber: Optional[str] = None
    lrNumber: Optional[str] = None
    ewayBillNumber: Optional[str] = None
    podReceivedBy: Optional[str] = None
    podDocumentUrl: Optional[str] = None
    feedbackText: Optional[str] = None
    ratingValue: Optional[float] = None
    delayMinutes: Optional[int] = None
    delayReasonText: Optional[str] = None
    lastLocationName: Optional[str] = None

class VehicleIssueLog(BaseModel):
    issueDescription: str


class SdoHandoverSchema(BaseModel):
    handover_type: str  # OWN_VEHICLE, COURIER, THIRD_PARTY, IN_PERSON
    vehicle_no: Optional[str] = None
    driver_name: Optional[str] = None
    driver_phone: Optional[str] = None
    courier_name: Optional[str] = None
    awb_no: Optional[str] = None
    remarks: Optional[str] = None
    otp: Optional[str] = None
    handover_photos: Optional[List[str]] = None  # Material photo URLs
    handover_signature: Optional[str] = None  # Signature image URL

    @field_validator("driver_phone")
    @classmethod
    def val_driver_phone(cls, v):
        if v and v.strip():
            return validate_phone_number(v)
        return v


class SdoReceiveSchema(BaseModel):
    seal_intact: bool
    packaging_condition: str  # INTACT, DAMAGED, TAMPERED
    discrepancy_reported: bool
    receiving_remarks: Optional[str] = None
    receipt_photos: Optional[List[str]] = None  # Condition photo URLs
    receipt_signature: Optional[str] = None  # Receiver signature URL
