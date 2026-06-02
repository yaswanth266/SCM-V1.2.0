from sqlalchemy import Column, BigInteger, String, Text, Boolean, DateTime, Date, Enum, ForeignKey, Numeric, Integer, JSON, Index
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base

class LogisticsLocation(Base):
    __tablename__ = "logistics_locations"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    location_code = Column(String(50), unique=True, nullable=False)
    location_name = Column(String(255), nullable=False)
    location_type = Column(Enum("CUSTOMER", "WAREHOUSE", "BRANCH", "OTHER", name="logistics_location_type_enum"), nullable=False, default="CUSTOMER")
    address_line1 = Column(String(255), nullable=False)
    address_line2 = Column(String(255))
    city = Column(String(100), nullable=False)
    state = Column(String(100), nullable=False)
    pincode = Column(String(10), nullable=False)
    latitude = Column(Numeric(10, 6), nullable=False, default=0.0)
    longitude = Column(Numeric(10, 6), nullable=False, default=0.0)
    contact_person = Column(String(255), nullable=False)
    mobile = Column(String(20), nullable=False)
    email = Column(String(255), nullable=False)
    delivery_instructions = Column(Text)
    access_hours_from = Column(String(20))
    access_hours_to = Column(String(20))
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

class LogisticsRoute(Base):
    __tablename__ = "logistics_routes"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    route_code = Column(String(50), unique=True, nullable=False)
    route_name = Column(String(255), nullable=False)
    origin_warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    estimated_distance_km = Column(Numeric(10, 2), nullable=False, default=0.0)
    estimated_duration_hours = Column(Numeric(10, 2), nullable=False, default=0.0)
    terrain_type = Column(Enum("HIGHWAY", "CITY", "MIXED", "HILLY", name="terrain_type_enum"), nullable=False, default="HIGHWAY")
    recommended_vehicle_type = Column(String(50), nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    origin_warehouse = relationship("Warehouse")

class LogisticsRouteLocation(Base):
    __tablename__ = "logistics_route_locations"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    route_id = Column(BigInteger, ForeignKey("logistics_routes.id", ondelete="CASCADE"), nullable=False)
    location_id = Column(BigInteger, ForeignKey("logistics_locations.id", ondelete="CASCADE"), nullable=False)
    sequence_number = Column(Integer, nullable=False)
    distance_from_previous_km = Column(Numeric(10, 2), nullable=False, default=0.0)
    estimated_time_minutes = Column(Integer, nullable=False, default=0)

    route = relationship("LogisticsRoute")
    location = relationship("LogisticsLocation")

class LogisticsLoadingBay(Base):
    __tablename__ = "logistics_loading_bays"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    bay_number = Column(String(50), nullable=False)
    bay_name = Column(String(255))
    max_vehicle_type = Column(String(50))
    is_covered = Column(Boolean, default=True, nullable=False)
    has_dock_leveler = Column(Boolean, default=False, nullable=False)
    has_forklift = Column(Boolean, default=False, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    current_status = Column(Enum("AVAILABLE", "OCCUPIED", "MAINTENANCE", name="bay_status_enum"), default="AVAILABLE", nullable=False)

    warehouse = relationship("Warehouse")

class LogisticsMainDispatchOrder(Base):
    __tablename__ = "logistics_main_dispatch_orders"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    mdo_number = Column(String(50), unique=True, nullable=False)
    customer_reference = Column(String(255))
    order_reference = Column(String(255))
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    order_date = Column(Date, nullable=False)
    required_delivery_date = Column(Date)
    total_material_items = Column(Integer, default=0, nullable=False)
    total_weight_kg = Column(Numeric(15, 3), default=0.0, nullable=False)
    total_volume_cft = Column(Numeric(15, 3), default=0.0, nullable=False)
    total_value = Column(Numeric(15, 2), default=0.0, nullable=False)
    special_instructions = Column(Text)
    priority = Column(Enum("LOW", "MEDIUM", "HIGH", "URGENT", name="logistics_priority_enum"), default="MEDIUM", nullable=False)
    status = Column(Enum("DRAFT", "APPROVED", "RFQ_IN_PROGRESS", "CONFIRMED", "DISPATCHED", "IN_TRANSIT", "COMPLETED", "ACKNOWLEDGED", "CANCELLED", name="mdo_status_enum"), default="DRAFT", nullable=False)
    created_by = Column(BigInteger, ForeignKey("users.id"), nullable=False)
    approved_by = Column(BigInteger, ForeignKey("users.id"))
    approved_at = Column(DateTime)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), nullable=False)

    # Single Dispatch SCM fields
    material_issue_id = Column(BigInteger, ForeignKey("material_issues.id", ondelete="SET NULL"), nullable=True)
    indent_id = Column(BigInteger, ForeignKey("indents.id", ondelete="SET NULL"), nullable=True)
    destination_warehouse_id = Column(BigInteger, ForeignKey("warehouses.id", ondelete="SET NULL"), nullable=True)
    delivery_address = Column(String(500))
    e_challan = Column(String(500))
    waybill = Column(String(500))
    dispatch_type = Column(String(50), default="THIRD_PARTY")

    warehouse = relationship("Warehouse", foreign_keys=[warehouse_id])
    destination_warehouse = relationship("Warehouse", foreign_keys=[destination_warehouse_id])
    creator = relationship("User", foreign_keys=[created_by])
    approver = relationship("User", foreign_keys=[approved_by])
    material_issue = relationship("MaterialIssue")
    indent = relationship("Indent")
    sdos = relationship("LogisticsSubDispatchOrder", back_populates="mdo", cascade="all, delete-orphan")
    handover = relationship("DispatchHandover", back_populates="dispatch", uselist=False, cascade="all, delete-orphan")

class LogisticsSubDispatchOrder(Base):
    __tablename__ = "logistics_sub_dispatch_orders"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    sdo_number = Column(String(50), unique=True, nullable=False)
    mdo_id = Column(BigInteger, ForeignKey("logistics_main_dispatch_orders.id", ondelete="CASCADE"), nullable=False)
    route_id = Column(BigInteger, ForeignKey("logistics_routes.id"))
    route_name = Column(String(255))
    vehicle_type_required = Column(String(50), nullable=False)
    estimated_weight_kg = Column(Numeric(15, 3), default=0.0, nullable=False)
    estimated_volume_cft = Column(Numeric(15, 3), default=0.0, nullable=False)
    estimated_distance_km = Column(Numeric(10, 2), default=0.0, nullable=False)
    required_pickup_datetime = Column(DateTime, nullable=False)
    required_delivery_datetime = Column(DateTime, nullable=False)
    loading_time_minutes = Column(Integer, default=0, nullable=False)
    unloading_time_minutes = Column(Integer, default=0, nullable=False)
    requires_loading_helper = Column(Boolean, default=False, nullable=False)
    special_requirements = Column(Text)
    status = Column(Enum("PENDING", "RFQ_SENT", "QUOTED", "SO_CREATED", "IN_TRANSIT", "DELIVERED", "CANCELLED", name="sdo_status_enum"), default="PENDING", nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    mdo = relationship("LogisticsMainDispatchOrder", back_populates="sdos")
    route = relationship("LogisticsRoute")
    destinations = relationship("LogisticsSdoDestination", back_populates="sdo", cascade="all, delete-orphan")
    materials = relationship("LogisticsDispatchMaterial", back_populates="sdo", cascade="all, delete-orphan")

class LogisticsSdoDestination(Base):
    __tablename__ = "logistics_sdo_destinations"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    sdo_id = Column(BigInteger, ForeignKey("logistics_sub_dispatch_orders.id", ondelete="CASCADE"), nullable=False)
    location_id = Column(BigInteger, ForeignKey("logistics_locations.id"), nullable=False)
    sequence_number = Column(Integer, nullable=False)
    estimated_arrival_datetime = Column(DateTime, nullable=False)
    delivery_contact_person = Column(String(255), nullable=False)
    delivery_contact_mobile = Column(String(20), nullable=False)
    actual_arrival_datetime = Column(DateTime)
    actual_departure_datetime = Column(DateTime)
    pod_received = Column(Boolean, default=False, nullable=False)
    pod_received_by = Column(String(255))
    pod_received_at = Column(DateTime)
    pod_document_url = Column(String(500))
    status = Column(Enum("PENDING", "IN_TRANSIT", "REACHED", "DELIVERED", "FAILED", name="dest_status_enum"), default="PENDING", nullable=False)

    sdo = relationship("LogisticsSubDispatchOrder", back_populates="destinations")
    location = relationship("LogisticsLocation")

class LogisticsDispatchMaterial(Base):
    __tablename__ = "logistics_dispatch_materials"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    mdo_id = Column(BigInteger, ForeignKey("logistics_main_dispatch_orders.id", ondelete="CASCADE"))
    sdo_id = Column(BigInteger, ForeignKey("logistics_sub_dispatch_orders.id", ondelete="CASCADE"))
    material_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    quantity = Column(Numeric(15, 3), nullable=False)
    unit_of_measure = Column(String(50), nullable=False)
    total_weight_kg = Column(Numeric(15, 3), nullable=False)
    total_volume_cft = Column(Numeric(15, 3), nullable=False)
    unit_price = Column(Numeric(15, 2), nullable=False)
    total_value = Column(Numeric(15, 2), nullable=False)
    batch_number = Column(String(100))
    serial_numbers = Column(JSON)
    number_of_packages = Column(Integer, default=1, nullable=False)
    package_type = Column(String(100))
    handling_instructions = Column(Text)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    material = relationship("Item")
    sdo = relationship("LogisticsSubDispatchOrder", back_populates="materials")

class LogisticsRfqMaster(Base):
    __tablename__ = "logistics_rfq_masters"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    rfq_number = Column(String(50), unique=True, nullable=False)
    rfq_type = Column(Enum("MDO", "SDO", "MIXED", name="rfq_type_enum"), default="SDO", nullable=False)
    mdo_id = Column(BigInteger, ForeignKey("logistics_main_dispatch_orders.id"))
    parent_rfq_id = Column(BigInteger, ForeignKey("logistics_rfq_masters.id"))
    title = Column(String(255), nullable=False)
    description = Column(Text)
    issue_date = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    response_deadline = Column(DateTime, nullable=False)
    expected_delivery_date = Column(DateTime, nullable=True)  # target delivery communicated to carriers
    total_estimated_weight_kg = Column(Numeric(15, 3), default=0.0, nullable=False)
    total_estimated_volume_cft = Column(Numeric(15, 3), default=0.0, nullable=False)
    vehicle_type_required = Column(String(50), nullable=False)
    special_requirements = Column(Text)
    payment_terms = Column(String(255))
    advance_payment_percentage = Column(Numeric(5, 2), default=0.0, nullable=False)
    insurance_required = Column(Boolean, default=False, nullable=False)
    evaluation_criteria = Column(JSON)  # Dict with price_weight, rating_weight, timeline_weight
    status = Column(Enum("DRAFT", "PUBLISHED", "IN_PROGRESS", "CLOSED", "CANCELLED", name="rfq_status_enum"), default="DRAFT", nullable=False)
    closed_at = Column(DateTime)
    closed_by = Column(BigInteger, ForeignKey("users.id"))
    closure_remarks = Column(Text)
    created_by = Column(BigInteger, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    creator = relationship("User", foreign_keys=[created_by])
    mappings = relationship("LogisticsRfqDispatchMapping", back_populates="rfq", cascade="all, delete-orphan")
    invited_vendors = relationship("LogisticsRfqVendor", back_populates="rfq", cascade="all, delete-orphan")
    responses = relationship("LogisticsRfqResponse", back_populates="rfq", cascade="all, delete-orphan")

class LogisticsRfqDispatchMapping(Base):
    __tablename__ = "logistics_rfq_dispatch_mappings"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    rfq_id = Column(BigInteger, ForeignKey("logistics_rfq_masters.id", ondelete="CASCADE"), nullable=False)
    sdo_id = Column(BigInteger, ForeignKey("logistics_sub_dispatch_orders.id", ondelete="CASCADE"), nullable=False)
    is_primary = Column(Boolean, default=False, nullable=False)
    sequence_number = Column(Integer)
    estimated_weight_kg = Column(Numeric(15, 3), nullable=False)
    estimated_volume_cft = Column(Numeric(15, 3), nullable=False)
    required_pickup_datetime = Column(DateTime, nullable=False)
    required_delivery_datetime = Column(DateTime, nullable=False)
    status = Column(Enum("PENDING", "QUOTED", "SELECTED", "REJECTED", name="mapping_status_enum"), default="PENDING", nullable=False)

    rfq = relationship("LogisticsRfqMaster", back_populates="mappings")
    sdo = relationship("LogisticsSubDispatchOrder")

class LogisticsRfqVendor(Base):
    __tablename__ = "logistics_rfq_vendors"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    rfq_id = Column(BigInteger, ForeignKey("logistics_rfq_masters.id", ondelete="CASCADE"), nullable=False)
    vendor_id = Column(BigInteger, ForeignKey("vendors.id"), nullable=False)
    invited_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    invited_by = Column(BigInteger, ForeignKey("users.id"))
    invitation_method = Column(Enum("EMAIL", "SMS", "PORTAL", "MANUAL", name="invite_method_enum"), default="PORTAL", nullable=False)
    invitation_sent = Column(Boolean, default=True, nullable=False)
    viewed_at = Column(DateTime)
    response_status = Column(Enum("PENDING", "VIEWED", "QUOTED", "DECLINED", "NO_RESPONSE", name="rfq_vendor_response_status_enum"), default="PENDING", nullable=False)
    declined_at = Column(DateTime)
    decline_reason = Column(Text)
    reminder_count = Column(Integer, default=0, nullable=False)

    rfq = relationship("LogisticsRfqMaster", back_populates="invited_vendors")
    vendor = relationship("Vendor")

class LogisticsRfqResponse(Base):
    __tablename__ = "logistics_rfq_responses"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    rfq_id = Column(BigInteger, ForeignKey("logistics_rfq_masters.id", ondelete="CASCADE"), nullable=False)
    vendor_id = Column(BigInteger, ForeignKey("vendors.id"), nullable=False)
    response_number = Column(String(50), unique=True, nullable=False)
    response_date = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    pricing_type = Column(Enum("CONSOLIDATED", "VEHICLE_WISE", "SDO_WISE", name="pricing_type_enum"), default="CONSOLIDATED", nullable=False)
    total_quoted_price = Column(Numeric(15, 2), nullable=False)
    currency = Column(String(10), default="INR", nullable=False)
    price_validity_days = Column(Integer, default=30, nullable=False)
    consolidated_vehicle_type = Column(String(50))
    consolidated_vehicle_no = Column(String(50))
    number_of_vehicles = Column(Integer, default=1, nullable=False)
    fleet_details = Column(JSON)
    payment_terms = Column(String(255))
    advance_payment_percentage = Column(Numeric(5, 2), default=0.0, nullable=False)
    insurance_included = Column(Boolean, default=False, nullable=False)
    insurance_cost = Column(Numeric(15, 2), default=0.0, nullable=False)
    loading_charges = Column(Numeric(15, 2), default=0.0, nullable=False)
    unloading_charges = Column(Numeric(15, 2), default=0.0, nullable=False)
    detention_charges_per_hour = Column(Numeric(15, 2), default=0.0, nullable=False)
    other_charges = Column(Numeric(15, 2), default=0.0, nullable=False)
    other_charges_description = Column(String(255))
    vendor_remarks = Column(Text)
    status = Column(Enum("SUBMITTED", "UNDER_REVIEW", "SHORTLISTED", "SELECTED", "REJECTED", name="quote_status_enum"), default="SUBMITTED", nullable=False)
    evaluation_score = Column(Numeric(5, 2))
    evaluation_notes = Column(Text)
    evaluated_by = Column(BigInteger, ForeignKey("users.id"))
    evaluated_at = Column(DateTime)
    is_selected = Column(Boolean, default=False, nullable=False)
    selected_by = Column(BigInteger, ForeignKey("users.id"))
    selected_at = Column(DateTime)
    selection_remarks = Column(Text)
    rejection_reason = Column(Text)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    rfq = relationship("LogisticsRfqMaster", back_populates="responses")
    vendor = relationship("Vendor")
    vehicles = relationship("LogisticsRfqResponseVehicle", back_populates="response", cascade="all, delete-orphan")
    assignments = relationship("LogisticsRfqResponseSdoAssignment", back_populates="response", cascade="all, delete-orphan")

class LogisticsRfqResponseVehicle(Base):
    __tablename__ = "logistics_rfq_response_vehicles"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    response_id = Column(BigInteger, ForeignKey("logistics_rfq_responses.id", ondelete="CASCADE"), nullable=False)
    vehicle_number = Column(String(50), nullable=False)  # V1, V2, etc.
    vehicle_registration_no = Column(String(50))
    vehicle_type = Column(String(50), nullable=False)
    vehicle_capacity_kg = Column(Numeric(15, 3))
    vehicle_capacity_cft = Column(Numeric(15, 3))
    vehicle_make_model = Column(String(255))
    vehicle_year = Column(Integer)
    driver_name = Column(String(255))
    driver_mobile = Column(String(20))
    driver_license_no = Column(String(100))
    driver_license_expiry = Column(Date)
    availability_from = Column(DateTime, nullable=False)
    availability_to = Column(DateTime)
    vehicle_base_price = Column(Numeric(15, 2), default=0.0, nullable=False)
    vehicle_loading_charges = Column(Numeric(15, 2), default=0.0, nullable=False)
    vehicle_unloading_charges = Column(Numeric(15, 2), default=0.0, nullable=False)
    detention_charges_per_hour = Column(Numeric(15, 2), default=0.0, nullable=False)
    other_charges = Column(Numeric(15, 2), default=0.0, nullable=False)
    total_vehicle_price = Column(Numeric(15, 2), default=0.0, nullable=False)
    insurance_required = Column(Boolean, default=False, nullable=False)
    insurance_cost = Column(Numeric(15, 2), default=0.0, nullable=False)
    gps_enabled = Column(Boolean, default=False, nullable=False)

    response = relationship("LogisticsRfqResponse", back_populates="vehicles")

class LogisticsRfqResponseSdoAssignment(Base):
    __tablename__ = "logistics_rfq_response_sdo_assignments"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    response_id = Column(BigInteger, ForeignKey("logistics_rfq_responses.id", ondelete="CASCADE"), nullable=False)
    vehicle_response_id = Column(BigInteger, ForeignKey("logistics_rfq_response_vehicles.id", ondelete="CASCADE"), nullable=False)
    sdo_id = Column(BigInteger, ForeignKey("logistics_sub_dispatch_orders.id", ondelete="CASCADE"), nullable=False)
    sequence_number = Column(Integer)
    sdo_quoted_price = Column(Numeric(15, 2), default=0.0, nullable=False)
    estimated_pickup_datetime = Column(DateTime, nullable=False)
    estimated_delivery_datetime = Column(DateTime, nullable=False)
    proposed_route = Column(String(255))
    estimated_distance_km = Column(Numeric(10, 2))
    estimated_duration_hours = Column(Numeric(10, 2))

    response = relationship("LogisticsRfqResponse", back_populates="assignments")
    vehicle = relationship("LogisticsRfqResponseVehicle")
    sdo = relationship("LogisticsSubDispatchOrder")

class LogisticsServiceOrder(Base):
    __tablename__ = "logistics_service_orders"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    so_number = Column(String(50), unique=True, nullable=False)
    rfq_id = Column(BigInteger, ForeignKey("logistics_rfq_masters.id"), nullable=False)
    response_id = Column(BigInteger, ForeignKey("logistics_rfq_responses.id"), nullable=False)
    vendor_id = Column(BigInteger, ForeignKey("vendors.id"), nullable=False)
    mdo_id = Column(BigInteger, ForeignKey("logistics_main_dispatch_orders.id"))
    parent_so_id = Column(BigInteger, ForeignKey("logistics_service_orders.id"))
    so_type = Column(Enum("MASTER", "INDIVIDUAL", name="so_type_enum"), default="INDIVIDUAL", nullable=False)
    total_order_value = Column(Numeric(15, 2), nullable=False)
    payment_terms = Column(String(255))
    advance_payment_percentage = Column(Numeric(5, 2), default=0.0, nullable=False)
    advance_payment_amount = Column(Numeric(15, 2))
    advance_paid = Column(Boolean, default=False, nullable=False)
    advance_paid_date = Column(DateTime)
    final_payment_status = Column(Enum("PENDING", "PARTIAL", "COMPLETED", name="final_payment_status_enum"), default="PENDING", nullable=False)
    po_number = Column(String(100))
    contract_document_url = Column(String(500))
    status = Column(Enum("CREATED", "ACKNOWLEDGED", "IN_PROGRESS", "COMPLETED", "CANCELLED", name="so_status_enum"), default="CREATED", nullable=False)
    acknowledged_by_vendor = Column(Boolean, default=False, nullable=False)
    acknowledged_at = Column(DateTime)
    arrival_date = Column(String(50))
    expected_delivery_date = Column(DateTime, nullable=True)  # inherited from RFQ
    vendor_remarks = Column(Text)
    completed_at = Column(DateTime)
    completion_remarks = Column(Text)
    cancelled_at = Column(DateTime)
    cancelled_by = Column(BigInteger, ForeignKey("users.id"))
    cancellation_reason = Column(Text)
    created_by = Column(BigInteger, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    rfq = relationship("LogisticsRfqMaster")
    response = relationship("LogisticsRfqResponse")
    vendor = relationship("Vendor")
    mdo = relationship("LogisticsMainDispatchOrder")
    creator = relationship("User", foreign_keys=[created_by])
    vehicles = relationship("LogisticsServiceOrderVehicle", back_populates="so", cascade="all, delete-orphan")
    mappings = relationship("LogisticsServiceOrderSdoMapping", back_populates="so", cascade="all, delete-orphan")

class LogisticsServiceOrderVehicle(Base):
    __tablename__ = "logistics_service_order_vehicles"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    so_id = Column(BigInteger, ForeignKey("logistics_service_orders.id", ondelete="CASCADE"), nullable=False)
    vehicle_response_id = Column(BigInteger, ForeignKey("logistics_rfq_response_vehicles.id"))
    vehicle_type = Column(String(50))
    vehicle_registration_no = Column(String(50))
    driver_name = Column(String(255))
    driver_mobile = Column(String(20))
    driver_license_no = Column(String(100))
    vehicle_order_value = Column(Numeric(15, 2))
    scheduled_pickup_datetime = Column(DateTime)
    scheduled_delivery_datetime = Column(DateTime)
    gate_entry_time = Column(DateTime)
    gate_entry_by = Column(BigInteger, ForeignKey("users.id"))
    gate_pass_number = Column(String(50))
    loading_bay_number = Column(String(50))
    loading_supervisor = Column(BigInteger, ForeignKey("users.id"))
    loading_start_time = Column(DateTime)
    loading_end_time = Column(DateTime)
    actual_arrival_datetime = Column(DateTime)
    actual_departure_datetime = Column(DateTime)
    actual_delivery_datetime = Column(DateTime)
    lr_number = Column(String(100))
    lr_date = Column(Date)
    eway_bill_number = Column(String(100))
    eway_bill_expiry = Column(DateTime)
    pod_received = Column(Boolean, default=False, nullable=False)
    pod_received_at = Column(DateTime)
    pod_received_by = Column(String(255))
    pod_document_url = Column(String(500))
    gps_tracking_url = Column(String(500))
    current_location_lat = Column(Numeric(10, 6))
    current_location_lng = Column(Numeric(10, 6))
    last_location_update = Column(DateTime)
    vehicle_status = Column(Enum("SCHEDULED", "ARRIVED", "LOADING", "DISPATCHED", "IN_TRANSIT", "DELIVERED", "CANCELLED", name="so_vehicle_status_enum"), default="SCHEDULED", nullable=False)
    has_issues = Column(Boolean, default=False, nullable=False)
    issue_description = Column(Text)
    delay_reason = Column(Text)
    delay_minutes = Column(Integer, default=0, nullable=False)
    vendor_rating = Column(Numeric(3, 2))
    driver_rating = Column(Numeric(3, 2))
    feedback = Column(Text)

    so = relationship("LogisticsServiceOrder", back_populates="vehicles")
    vehicle_response = relationship("LogisticsRfqResponseVehicle")
    gate_entry_user = relationship("User", foreign_keys=[gate_entry_by])
    supervisor_user = relationship("User", foreign_keys=[loading_supervisor])

class LogisticsServiceOrderSdoMapping(Base):
    __tablename__ = "logistics_service_order_sdo_mappings"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    so_id = Column(BigInteger, ForeignKey("logistics_service_orders.id", ondelete="CASCADE"), nullable=False)
    so_vehicle_id = Column(BigInteger, ForeignKey("logistics_service_order_vehicles.id", ondelete="CASCADE"), nullable=False)
    sdo_id = Column(BigInteger, ForeignKey("logistics_sub_dispatch_orders.id", ondelete="CASCADE"), nullable=False)
    delivery_sequence = Column(Integer)
    status = Column(Enum("PENDING", "LOADED", "IN_TRANSIT", "DELIVERED", "FAILED", name="so_mapping_status_enum"), default="PENDING", nullable=False)
    delivered_at = Column(DateTime)
    delivered_to = Column(String(255))
    delivery_remarks = Column(Text)

    so = relationship("LogisticsServiceOrder", back_populates="mappings")
    so_vehicle = relationship("LogisticsServiceOrderVehicle")
    sdo = relationship("LogisticsSubDispatchOrder")


class DispatchHandover(Base):
    __tablename__ = "dispatch_handovers"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    dispatch_id = Column(BigInteger, ForeignKey("logistics_main_dispatch_orders.id", ondelete="CASCADE"), nullable=False)
    handover_no = Column(String(50), unique=True)
    handover_type = Column(Enum("THIRD_PARTY", "own vehicle", "COURIER", "IN_PERSON", name="handover_type_enum"), nullable=False)
    handed_over_by_entity_id = Column(BigInteger, nullable=False)
    received_by_name = Column(String(150), nullable=False)
    received_by_phone = Column(String(30))
    transporter_id = Column(BigInteger, ForeignKey("vendors.id", ondelete="SET NULL"), nullable=True)
    vehicle_no = Column(String(50))
    driver_name = Column(String(150))
    driver_phone = Column(String(30))
    courier_name = Column(String(100))
    awb_no = Column(String(100))
    handover_otp = Column(String(20))
    otp_verified = Column(Boolean, default=False)
    handover_document = Column(String(500))
    remarks = Column(Text)
    handover_time = Column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    status = Column(Enum("PENDING", "HANDED_OVER", "REJECTED", name="handover_status_enum"), default="PENDING")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    dispatch = relationship("LogisticsMainDispatchOrder", back_populates="handover")
    transporter = relationship("Vendor")
