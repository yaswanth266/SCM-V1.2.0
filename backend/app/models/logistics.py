from sqlalchemy import Column, BigInteger, String, Text, DateTime, Enum, ForeignKey, Numeric, Integer
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class TransportRequirement(Base):
    __tablename__ = "transport_requirements"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    requirement_number = Column(String(50), unique=True, nullable=False)
    requirement_type = Column(Enum("material_dispatch", "inter_warehouse", "vendor_delivery", "customer_shipment", name="tr_type_enum"), nullable=False)
    dispatch_warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"))
    destination_warehouse_id = Column(BigInteger)
    dispatch_address = Column(Text)
    destination_address = Column(Text)
    material_description = Column(Text)
    total_qty = Column(Numeric(15, 3))
    total_weight = Column(Numeric(10, 3))
    total_volume = Column(Numeric(10, 3))
    vehicle_type_required = Column(String(50))
    expected_dispatch_date = Column(DateTime)
    expected_delivery_date = Column(DateTime)
    priority = Column(Enum("low", "medium", "high", "urgent", name="tr_priority_enum"), default="medium")
    status = Column(Enum("draft", "open", "quotation_received", "vendor_selected", "in_transit", "delivered", "closed", "cancelled", name="tr_status_enum"), default="draft")
    reference_type = Column(String(50))
    reference_id = Column(BigInteger)
    remarks = Column(Text)
    created_by = Column(BigInteger)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    dispatch_warehouse = relationship("Warehouse")
    quotations = relationship("TransportQuotation", back_populates="requirement")


class TransportQuotation(Base):
    __tablename__ = "transport_quotations"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    requirement_id = Column(BigInteger, ForeignKey("transport_requirements.id"), nullable=False)
    vendor_id = Column(BigInteger, ForeignKey("vendors.id"), nullable=False)
    quoted_amount = Column(Numeric(15, 2), nullable=False)
    vehicle_available = Column(Integer, default=1)
    vehicle_type = Column(String(50))
    estimated_delivery_days = Column(Integer)
    remarks = Column(Text)
    status = Column(Enum("submitted", "accepted", "rejected", name="tq_status_enum"), default="submitted")
    submitted_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    requirement = relationship("TransportRequirement", back_populates="quotations")
    vendor = relationship("Vendor")


class TransportOrder(Base):
    __tablename__ = "transport_orders"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    order_number = Column(String(50), unique=True, nullable=False)
    requirement_id = Column(BigInteger, ForeignKey("transport_requirements.id"), nullable=False)
    quotation_id = Column(BigInteger, ForeignKey("transport_quotations.id"))
    vendor_id = Column(BigInteger, ForeignKey("vendors.id"), nullable=False)
    vehicle_type = Column(String(50))
    vehicle_number = Column(String(50))
    driver_name = Column(String(255))
    driver_contact = Column(String(20))
    docket_number = Column(String(100))
    courier_reference = Column(String(100))
    lr_number = Column(String(100))
    dispatch_date = Column(DateTime)
    expected_delivery_date = Column(DateTime)
    actual_delivery_date = Column(DateTime)
    transport_cost = Column(Numeric(15, 2), default=0)
    status = Column(Enum("draft", "confirmed", "vehicle_assigned", "dispatched", "in_transit", "delivered", "closed", "cancelled", name="to_status_enum"), default="draft")
    remarks = Column(Text)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    requirement = relationship("TransportRequirement")
    quotation = relationship("TransportQuotation")
    vendor = relationship("Vendor")
    documents = relationship("TransportDocument", back_populates="transport_order")
    tracking = relationship("ShipmentTracking", back_populates="transport_order")


class TransportDocument(Base):
    __tablename__ = "transport_documents"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    transport_order_id = Column(BigInteger, ForeignKey("transport_orders.id"), nullable=False)
    document_type = Column(Enum("lr", "docket", "invoice", "pod", "other", name="td_type_enum"), nullable=False)
    document_number = Column(String(100))
    file_url = Column(String(500))
    uploaded_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    transport_order = relationship("TransportOrder", back_populates="documents")


class MaterialDispatchAdvice(Base):
    __tablename__ = "material_dispatch_advice"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    mda_number = Column(String(50), unique=True, nullable=False)
    transport_order_id = Column(BigInteger, ForeignKey("transport_orders.id"), nullable=False)
    dispatch_warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    destination = Column(Text)
    dispatch_date = Column(DateTime)
    vehicle_number = Column(String(50))
    docket_number = Column(String(100))
    lr_number = Column(String(100))
    total_packages = Column(Integer, default=0)
    total_weight = Column(Numeric(10, 3))
    remarks = Column(Text)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    transport_order = relationship("TransportOrder")
    dispatch_warehouse = relationship("Warehouse")
    items = relationship("MDAItem", back_populates="mda", cascade="all, delete-orphan")


class MDAItem(Base):
    __tablename__ = "mda_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    mda_id = Column(BigInteger, ForeignKey("material_dispatch_advice.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    batch_id = Column(BigInteger)
    qty = Column(Numeric(15, 3), nullable=False)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)

    mda = relationship("MaterialDispatchAdvice", back_populates="items")
    item = relationship("Item")
    uom = relationship("UOM")


class ShipmentTracking(Base):
    __tablename__ = "shipment_tracking"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    transport_order_id = Column(BigInteger, ForeignKey("transport_orders.id"), nullable=False)
    status = Column(Enum("vehicle_assigned", "loading", "dispatched", "in_transit", "reached_destination", "unloading", "delivered", name="st_status_enum"), nullable=False)
    status_timestamp = Column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    location_description = Column(String(255))
    barcode_scanned = Column(String(255))
    updated_by = Column(BigInteger)
    remarks = Column(Text)

    transport_order = relationship("TransportOrder", back_populates="tracking")


class ReceiptConfirmation(Base):
    __tablename__ = "receipt_confirmations"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    transport_order_id = Column(BigInteger, ForeignKey("transport_orders.id"), nullable=False)
    received_by = Column(BigInteger, ForeignKey("users.id"), nullable=False)
    received_at = Column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    received_qty = Column(Numeric(15, 3))
    delivery_remarks = Column(Text)
    condition_remarks = Column(Text)
    barcode_scanned = Column(String(255))
    scan_timestamp = Column(DateTime)

    transport_order = relationship("TransportOrder")
    receiver = relationship("User")
