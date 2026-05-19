from sqlalchemy import Column, BigInteger, String, Text, DateTime, Enum, ForeignKey, Numeric, Integer
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class SalesOrder(Base):
    __tablename__ = "sales_orders"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    so_number = Column(String(50), unique=True, nullable=False)
    customer_id = Column(BigInteger, ForeignKey("customers.id"), nullable=False)
    project_id = Column(BigInteger)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    order_date = Column(DateTime, nullable=False)
    delivery_date = Column(DateTime)
    subtotal = Column(Numeric(15, 2), default=0)
    tax_amount = Column(Numeric(15, 2), default=0)
    grand_total = Column(Numeric(15, 2), default=0)
    status = Column(Enum("draft", "confirmed", "picking", "packing", "dispatched", "delivered", "closed", "cancelled", name="so_status_enum"), default="draft")
    source = Column(Enum("manual", "api", "excel_upload", name="so_source_enum"), default="manual")
    remarks = Column(Text)
    created_by = Column(BigInteger)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    customer = relationship("Customer")
    warehouse = relationship("Warehouse")
    items = relationship("SalesOrderItem", back_populates="sales_order", cascade="all, delete-orphan")


class SalesOrderItem(Base):
    __tablename__ = "sales_order_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    so_id = Column(BigInteger, ForeignKey("sales_orders.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    qty = Column(Numeric(15, 3), nullable=False)
    picked_qty = Column(Numeric(15, 3), default=0)
    packed_qty = Column(Numeric(15, 3), default=0)
    dispatched_qty = Column(Numeric(15, 3), default=0)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    rate = Column(Numeric(15, 2), default=0)
    discount_pct = Column(Numeric(5, 2), default=0)
    tax_amount = Column(Numeric(15, 2), default=0)
    amount = Column(Numeric(15, 2), default=0)

    sales_order = relationship("SalesOrder", back_populates="items")
    item = relationship("Item")
    uom = relationship("UOM")


class DeliveryOrder(Base):
    __tablename__ = "delivery_orders"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    do_number = Column(String(50), unique=True, nullable=False)
    so_id = Column(BigInteger, ForeignKey("sales_orders.id"), nullable=False)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    delivery_date = Column(DateTime)
    status = Column(Enum("draft", "picking", "picked", "packing", "packed", "dispatched", "delivered", "cancelled", name="do_status_enum"), default="draft")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    sales_order = relationship("SalesOrder")
    warehouse = relationship("Warehouse")


class WavePlan(Base):
    __tablename__ = "wave_plans"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    wave_number = Column(String(50), unique=True, nullable=False)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    wave_date = Column(DateTime, nullable=False)
    priority = Column(Enum("low", "medium", "high", "urgent", name="wave_priority_enum"), default="medium")
    criteria = Column(Enum("order_priority", "route", "shipment_date", "customer", name="wave_criteria_enum"), default="order_priority")
    status = Column(Enum("draft", "released", "in_progress", "completed", "cancelled", name="wave_status_enum"), default="draft")
    created_by = Column(BigInteger)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    warehouse = relationship("Warehouse")
    orders = relationship("WavePlanOrder", back_populates="wave_plan", cascade="all, delete-orphan")


class WavePlanOrder(Base):
    __tablename__ = "wave_plan_orders"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    wave_id = Column(BigInteger, ForeignKey("wave_plans.id", ondelete="CASCADE"), nullable=False)
    do_id = Column(BigInteger, ForeignKey("delivery_orders.id"), nullable=False)
    sequence = Column(Integer, default=0)

    wave_plan = relationship("WavePlan", back_populates="orders")
    delivery_order = relationship("DeliveryOrder")


class PickingOrder(Base):
    __tablename__ = "picking_orders"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    pick_number = Column(String(50), unique=True, nullable=False)
    wave_id = Column(BigInteger, ForeignKey("wave_plans.id"))
    do_id = Column(BigInteger, ForeignKey("delivery_orders.id"))
    material_issue_id = Column(BigInteger, ForeignKey("material_issues.id"), nullable=True)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    pick_strategy = Column(Enum("fifo", "lifo", "fefo", "batch", name="pick_strategy_enum"), default="fifo")
    status = Column(Enum("draft", "assigned", "in_progress", "completed", "cancelled", name="pick_status_enum"), default="draft")
    assigned_to = Column(BigInteger)
    started_at = Column(DateTime)
    completed_at = Column(DateTime)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    wave_plan = relationship("WavePlan")
    delivery_order = relationship("DeliveryOrder")
    warehouse = relationship("Warehouse")
    items = relationship("PickingItem", back_populates="picking_order", cascade="all, delete-orphan")
    material_issue = relationship("MaterialIssue", foreign_keys=[material_issue_id])


class PickingItem(Base):
    __tablename__ = "picking_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    pick_id = Column(BigInteger, ForeignKey("picking_orders.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    batch_id = Column(BigInteger)
    from_bin_id = Column(BigInteger, ForeignKey("warehouse_bins.id"), nullable=False)
    qty_to_pick = Column(Numeric(15, 3), nullable=False)
    qty_picked = Column(Numeric(15, 3), default=0)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    status = Column(Enum("pending", "picked", "short", "skipped", name="pick_item_status_enum"), default="pending")
    scanned_at = Column(DateTime)
    scanned_by = Column(BigInteger)

    picking_order = relationship("PickingOrder", back_populates="items")
    item = relationship("Item")
    from_bin = relationship("WarehouseBin")
    uom = relationship("UOM")


class PackingOrder(Base):
    __tablename__ = "packing_orders"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    pack_number = Column(String(50), unique=True, nullable=False)
    pick_id = Column(BigInteger, ForeignKey("picking_orders.id"))
    material_issue_id = Column(BigInteger, ForeignKey("material_issues.id"), nullable=True)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    status = Column(Enum("draft", "in_progress", "completed", "cancelled", name="pack_status_enum"), default="draft")
    total_packages = Column(Integer, default=0)
    packed_by = Column(BigInteger)
    started_at = Column(DateTime)
    completed_at = Column(DateTime)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    picking_order = relationship("PickingOrder")
    warehouse = relationship("Warehouse")
    items = relationship("PackingItem", back_populates="packing_order", cascade="all, delete-orphan")
    material_issue = relationship("MaterialIssue", foreign_keys=[material_issue_id])


class PackingItem(Base):
    __tablename__ = "packing_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    pack_id = Column(BigInteger, ForeignKey("packing_orders.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    batch_id = Column(BigInteger)
    qty = Column(Numeric(15, 3), nullable=False)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    package_number = Column(String(50))
    package_type = Column(Enum("box", "pallet", "carton", "bag", "other", name="package_type_enum"), default="box")
    gross_weight = Column(Numeric(10, 3))
    net_weight = Column(Numeric(10, 3))
    barcode = Column(String(255))

    packing_order = relationship("PackingOrder", back_populates="items")
    item = relationship("Item")
