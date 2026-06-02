from sqlalchemy import Column, BigInteger, String, Text, Boolean, DateTime, Date, Enum, ForeignKey, Numeric, Integer, JSON
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class DispatchOrder(Base):
    __tablename__ = "dispatch_orders"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    dispatch_number = Column(String(50), unique=True, nullable=False)
    do_id = Column(BigInteger)
    pack_id = Column(BigInteger)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    
    customer_id = Column(BigInteger, ForeignKey("customers.id"), nullable=True)
    destination_user_id = Column(BigInteger, ForeignKey("users.id"), nullable=True)
    destination_warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=True)
    destination_type = Column(Enum("WAREHOUSE", "USER", "BRANCH", "DEALER", name="destination_type_enum"), nullable=False, default="USER")
    dispatch_type = Column(Enum("THIRD_PARTY", "COURIER", "OWN_VEHICLE", "IN_PERSON", name="dispatch_type_enum"), nullable=False, default="THIRD_PARTY")

    # Delivery Acknowledgement Details
    delivery_acknowledged = Column(Boolean, default=False, nullable=False)
    delivery_acknowledged_at = Column(DateTime(timezone=True), nullable=True)
    delivery_acknowledged_by_id = Column(BigInteger, ForeignKey("users.id"), nullable=True)
    delivery_acknowledged_by_name = Column(String(100), nullable=True)
    delivery_acknowledged_by_designation = Column(String(100), nullable=True)
    delivery_acknowledged_by_phone = Column(String(20), nullable=True)
    delivery_acknowledged_by_email = Column(String(100), nullable=True)

    # Proof of Delivery
    receiver_signature_url = Column(String(500), nullable=True)
    receiver_id_proof_type = Column(Enum("AADHAR", "PAN", "DRIVING_LICENSE", "EMPLOYEE_ID", "NONE", name="id_proof_enum"), default="NONE")
    receiver_id_proof_number = Column(String(50), nullable=True)
    delivery_photo_urls = Column(JSON, nullable=True)
    goods_condition_on_delivery = Column(Enum("GOOD", "DAMAGED", "PARTIAL", "DISCREPANCY", name="goods_cond_enum"), default="GOOD")
    delivery_remarks = Column(Text, nullable=True)

    # Material Issue Link for stock adjustments
    material_issue_id = Column(BigInteger, ForeignKey("material_issues.id"), nullable=True)

    # Geo-fencing
    delivery_location_latitude = Column(Numeric(10, 8), nullable=True)
    delivery_location_longitude = Column(Numeric(11, 8), nullable=True)
    delivery_location_verified = Column(Boolean, default=False, nullable=False)

    # Operational Parameters
    vehicle_number = Column(String(50))
    vehicle_type = Column(String(50))
    driver_name = Column(String(255))
    driver_contact = Column(String(20))
    transport_vendor_id = Column(BigInteger)
    lr_number = Column(String(100))
    docket_number = Column(String(100))
    dispatch_date = Column(DateTime(timezone=True))
    expected_delivery_date = Column(DateTime(timezone=True), nullable=True)
    loading_confirmed = Column(Boolean, default=False)
    loading_confirmed_at = Column(DateTime)
    
    # Enhanced status lifecycle
    status = Column(Enum(
        "draft", "loading", "loaded", "dispatched", "in_transit",
        "out_for_delivery", "delivered", "acknowledged",
        "partially_acknowledged", "rejected", "returned", "cancelled",
        name="dispatch_status_enum"
    ), default="draft")
    
    remarks = Column(Text)
    dispatched_by = Column(BigInteger)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    warehouse = relationship("Warehouse", foreign_keys=[warehouse_id])
    destination_warehouse = relationship("Warehouse", foreign_keys=[destination_warehouse_id])
    destination_user = relationship("User", foreign_keys=[destination_user_id])
    ack_user = relationship("User", foreign_keys=[delivery_acknowledged_by_id])
    customer = relationship("Customer", foreign_keys=[customer_id])
    items = relationship("DispatchOrderItem", back_populates="dispatch_order", cascade="all, delete-orphan")


class GatePass(Base):
    __tablename__ = "gate_passes"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    gate_pass_number = Column(String(50), unique=True, nullable=False)
    gate_type = Column(Enum("inward", "outward", name="gate_type_enum"), nullable=False)
    dispatch_id = Column(BigInteger, ForeignKey("dispatch_orders.id"))
    grn_id = Column(BigInteger)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    vehicle_number = Column(String(50))
    person_name = Column(String(255))
    person_contact = Column(String(20))
    material_description = Column(Text)
    barcode = Column(String(255))
    gate_in_time = Column(DateTime)
    gate_out_time = Column(DateTime)
    status = Column(Enum("pending", "approved", "gate_in", "gate_out", "completed", "cancelled", name="gate_pass_status_enum"), default="pending")
    approved_by = Column(BigInteger)
    security_guard = Column(String(255))
    remarks = Column(Text)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    dispatch_order = relationship("DispatchOrder")
    warehouse = relationship("Warehouse")


class DispatchOrderItem(Base):
    __tablename__ = "dispatch_order_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    dispatch_order_id = Column(BigInteger, ForeignKey("dispatch_orders.id", ondelete="CASCADE"), nullable=False)
    material_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    indent_id = Column(BigInteger, ForeignKey("indents.id"), nullable=True)
    material_issue_id = Column(BigInteger, ForeignKey("material_issues.id"), nullable=True)
    requested_quantity = Column(Numeric(15, 3), nullable=False)
    approved_quantity = Column(Numeric(15, 3), nullable=False)
    dispatched_quantity = Column(Numeric(15, 3), nullable=False)
    uom = Column(String(50), nullable=False)
    request_date = Column(Date, nullable=False)
    serial_numbers = Column(JSON, nullable=True)

    dispatch_order = relationship("DispatchOrder", back_populates="items")
    material = relationship("Item")
    indent = relationship("Indent")
    material_issue = relationship("MaterialIssue")


class DispatchDeliveryAcknowledgement(Base):
    __tablename__ = "dispatch_delivery_acknowledgements"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    dispatch_id = Column(BigInteger, ForeignKey("dispatch_orders.id", ondelete="CASCADE"), nullable=False)
    acknowledgement_number = Column(String(50), unique=True, nullable=False)
    acknowledgement_type = Column(Enum("FULL_DELIVERY", "PARTIAL_DELIVERY", "DAMAGED_DELIVERY", "REJECTED", "CONDITIONAL", name="ack_type_enum"), nullable=False)
    acknowledged_at = Column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))

    # Receiver Information
    acknowledged_by_user_id = Column(BigInteger, ForeignKey("users.id"), nullable=True)
    acknowledged_by_name = Column(String(100), nullable=False)
    acknowledged_by_designation = Column(String(100))
    acknowledged_by_department = Column(String(100))
    acknowledged_by_phone = Column(String(20), nullable=False)
    acknowledged_by_email = Column(String(100))
    acknowledged_by_employee_code = Column(String(50))

    # Destination Info
    destination_warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"))
    destination_user_id = Column(BigInteger, ForeignKey("users.id"))
    destination_address_id = Column(BigInteger)
    actual_delivery_location = Column(Text)

    # Verification Method
    verification_method = Column(Enum("OTP_SMS", "OTP_EMAIL", "DIGITAL_SIGNATURE", "BIOMETRIC", "MANUAL", name="verif_method_enum"), default="DIGITAL_SIGNATURE")

    # Digital Evidence
    receiver_signature_url = Column(String(500))
    receiver_signature_captured_via = Column(Enum("MOBILE_APP", "TABLET", "WEB_PORTAL", "SIGNATURE_PAD", name="sig_capture_enum"))
    receiver_id_proof_type = Column(Enum("AADHAR", "PAN", "EMPLOYEE_ID", "DRIVING_LICENSE", "PASSPORT", "NONE", name="receiver_id_type_enum"))
    receiver_id_proof_number = Column(String(50))
    receiver_id_proof_document_url = Column(String(500))
    delivery_photos = Column(JSON)

    # Geolocation Verification
    delivery_latitude = Column(Numeric(10, 8))
    delivery_longitude = Column(Numeric(11, 8))
    geo_fence_verified = Column(Boolean, default=False)
    device_id = Column(String(100))
    ip_address = Column(String(50))

    # Goods Inspection Details
    total_items_expected = Column(Integer)
    total_items_received = Column(Integer)
    total_items_damaged = Column(Integer)
    total_items_rejected = Column(Integer)
    goods_condition = Column(Enum("GOOD", "DAMAGED", "PARTIAL", "DISCREPANCY", "REJECTED", name="goods_cond_ins_enum"))
    quality_check_performed = Column(Boolean, default=False)
    quality_checked_by = Column(String(100))
    quality_check_remarks = Column(Text)

    # Packaging
    packaging_condition = Column(Enum("INTACT", "DAMAGED", "OPENED", "TAMPERED", name="pkg_cond_enum"))
    seal_intact = Column(Boolean, default=True)
    seal_number_verified = Column(String(100))
    temperature_recorded = Column(Numeric(5, 2))
    humidity_recorded = Column(Numeric(5, 2))

    # SLA & delays
    expected_delivery_datetime = Column(DateTime(timezone=True))
    actual_delivery_datetime = Column(DateTime(timezone=True))
    delay_minutes = Column(Integer)
    delay_reason = Column(Text)
    sla_met = Column(Boolean)

    # Discrepancy Management
    discrepancy_reported = Column(Boolean, default=False)
    discrepancy_type = Column(Enum("QUANTITY_MISMATCH", "QUALITY_ISSUE", "WRONG_ITEM", "DAMAGE", "MISSING_DOCUMENTS", name="discrep_type_enum"))
    discrepancy_description = Column(Text)
    discrepancy_resolution_status = Column(Enum("PENDING", "UNDER_REVIEW", "RESOLVED", "ESCALATED", name="resolution_status_enum"))

    # Audits
    invoice_value = Column(Numeric(15, 2))
    accepted_value = Column(Numeric(15, 2))
    rejected_value = Column(Numeric(15, 2))
    damage_claim_amount = Column(Numeric(15, 2))

    # Document References
    invoice_number = Column(String(50))
    packing_list_number = Column(String(50))
    eway_bill_number = Column(String(50))
    lr_number = Column(String(100))

    # Workflow Statuses
    acknowledgement_status = Column(Enum("PENDING", "ACKNOWLEDGED", "DISPUTED", "APPROVED", "REJECTED", "CANCELLED", name="ack_status_enum"), default="PENDING")
    approved_by_user_id = Column(BigInteger, ForeignKey("users.id"))
    approved_at = Column(DateTime(timezone=True))
    rejection_reason = Column(Text)
    erp_sync_status = Column(Enum("PENDING", "SYNCED", "FAILED", name="sync_status_enum"), default="PENDING")
    erp_sync_at = Column(DateTime(timezone=True))
    erp_reference_number = Column(String(100))
    accounting_entry_posted = Column(Boolean, default=False)
    inventory_updated = Column(Boolean, default=False)

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))
    created_by_user_id = Column(BigInteger, ForeignKey("users.id"))
    updated_by_user_id = Column(BigInteger, ForeignKey("users.id"))

    dispatch = relationship("DispatchOrder", foreign_keys=[dispatch_id])
    receiver = relationship("User", foreign_keys=[acknowledged_by_user_id])
    approver = relationship("User", foreign_keys=[approved_by_user_id])
    items = relationship("DispatchAcknowledgementItem", back_populates="acknowledgement", cascade="all, delete-orphan")


class DispatchAcknowledgementItem(Base):
    __tablename__ = "dispatch_acknowledgement_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    acknowledgement_id = Column(BigInteger, ForeignKey("dispatch_delivery_acknowledgements.id", ondelete="CASCADE"), nullable=False)
    dispatch_item_id = Column(BigInteger)
    material_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    batch_number = Column(String(50))
    serial_numbers = Column(JSON)

    quantity_dispatched = Column(Numeric(15, 3), nullable=False)
    quantity_received = Column(Numeric(15, 3), nullable=False)
    quantity_accepted = Column(Numeric(15, 3), nullable=False)
    quantity_rejected = Column(Numeric(15, 3), default=0.0)
    quantity_damaged = Column(Numeric(15, 3), default=0.0)
    unit_of_measure = Column(String(20), nullable=False)
    item_condition = Column(Enum("GOOD", "DAMAGED", "EXPIRED", "DEFECTIVE", "WRONG_ITEM", name="item_cond_enum"), default="GOOD")
    rejection_reason = Column(Text)
    damage_description = Column(Text)
    item_photo_urls = Column(JSON)
    unit_price = Column(Numeric(15, 2))
    total_value = Column(Numeric(15, 2))

    manufacturing_date = Column(Date)
    expiry_date = Column(Date)
    is_expired = Column(Boolean, default=False)
    temperature_maintained = Column(Boolean)
    storage_condition_met = Column(Boolean)
    remarks = Column(Text)

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    acknowledgement = relationship("DispatchDeliveryAcknowledgement", back_populates="items")
    material = relationship("Item")


class DispatchAcknowledgementDocument(Base):
    __tablename__ = "dispatch_acknowledgement_documents"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    acknowledgement_id = Column(BigInteger, ForeignKey("dispatch_delivery_acknowledgements.id", ondelete="CASCADE"), nullable=False)
    document_type = Column(Enum("POD", "DELIVERY_CHALLAN", "INVOICE_COPY", "QUALITY_REPORT", "DAMAGE_REPORT", "RECEIVER_ID", "SIGNATURE", "PHOTOS", "OTHER", name="ack_doc_type_enum"), nullable=False)
    document_name = Column(String(200), nullable=False)
    document_url = Column(String(500), nullable=False)
    file_size_kb = Column(Integer)
    mime_type = Column(String(100))
    uploaded_by_user_id = Column(BigInteger, ForeignKey("users.id"))
    uploaded_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    is_mandatory = Column(Boolean, default=False)
    verification_status = Column(Enum("PENDING", "VERIFIED", "REJECTED", name="doc_verif_status_enum"), default="PENDING")
    verified_by_user_id = Column(BigInteger, ForeignKey("users.id"))
    verified_at = Column(DateTime(timezone=True))
    remarks = Column(Text)
