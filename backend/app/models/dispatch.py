from sqlalchemy import Column, BigInteger, String, Text, Boolean, DateTime, Enum, ForeignKey
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
    customer_id = Column(BigInteger, ForeignKey("customers.id"))
    vehicle_number = Column(String(50))
    vehicle_type = Column(String(50))
    driver_name = Column(String(255))
    driver_contact = Column(String(20))
    transport_vendor_id = Column(BigInteger)
    lr_number = Column(String(100))
    docket_number = Column(String(100))
    # Wave 5 — timezone-aware so the round-trip preserves UTC offset
    # (BUG-ISS-092). Endpoint already writes datetime.now(timezone.utc).
    dispatch_date = Column(DateTime(timezone=True))
    loading_confirmed = Column(Boolean, default=False)
    loading_confirmed_at = Column(DateTime)
    status = Column(Enum("draft", "loading", "loaded", "dispatched", "in_transit", "delivered", "cancelled", name="dispatch_status_enum"), default="draft")
    remarks = Column(Text)
    dispatched_by = Column(BigInteger)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    warehouse = relationship("Warehouse")
    customer = relationship("Customer")


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
