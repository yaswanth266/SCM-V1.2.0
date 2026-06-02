from sqlalchemy import Column, BigInteger, String, Text, Boolean, DateTime, Enum, ForeignKey, Numeric, Integer, UniqueConstraint
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class Warehouse(Base):
    __tablename__ = "warehouses"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    organization_id = Column(BigInteger, ForeignKey("organizations.id"), nullable=False)
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(255), nullable=False)
    type = Column(Enum("main", "regional", "transit", "virtual", name="warehouse_type_enum"), default="main")
    address_line1 = Column(String(255))
    address_line2 = Column(String(255))
    city = Column(String(100))
    state = Column(String(100))
    pincode = Column(String(10))
    contact_person = Column(String(255))
    phone = Column(String(20))
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))
    parent_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=True)

    organization = relationship("Organization", back_populates="warehouses")
    locations = relationship("WarehouseLocation", back_populates="warehouse")
    parent = relationship("Warehouse", remote_side=[id], backref="children")

    @property
    def parent_name(self):
        return self.parent.name if self.parent else None


class WarehouseLocation(Base):
    __tablename__ = "warehouse_locations"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    code = Column(String(50), nullable=False)
    name = Column(String(255), nullable=False)
    description = Column(Text)
    is_active = Column(Boolean, default=True)
    layout_x = Column(Numeric(10, 2))
    layout_y = Column(Numeric(10, 2))
    layout_w = Column(Numeric(10, 2))
    layout_h = Column(Numeric(10, 2))

    warehouse = relationship("Warehouse", back_populates="locations")
    lines = relationship("WarehouseLine", back_populates="location")


class WarehouseLine(Base):
    __tablename__ = "warehouse_lines"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    location_id = Column(BigInteger, ForeignKey("warehouse_locations.id"), nullable=False)
    code = Column(String(50), nullable=False)
    name = Column(String(255), nullable=False)
    zone_type = Column(Enum("receiving", "storage", "picking", "packing", "dispatch", "quarantine", "returns", name="zone_type_enum"), default="storage")
    is_active = Column(Boolean, default=True)
    layout_x = Column(Numeric(10, 2))
    layout_y = Column(Numeric(10, 2))
    layout_w = Column(Numeric(10, 2))
    layout_h = Column(Numeric(10, 2))

    location = relationship("WarehouseLocation", back_populates="lines")
    racks = relationship("WarehouseRack", back_populates="line")


class WarehouseRack(Base):
    __tablename__ = "warehouse_racks"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    line_id = Column(BigInteger, ForeignKey("warehouse_lines.id"), nullable=False)
    code = Column(String(50), nullable=False)
    name = Column(String(255), nullable=False)
    levels = Column(Integer, default=1)
    rack_type = Column(String(10))  # 'A' (5-level medium duty) / 'B' (3-level)
    is_active = Column(Boolean, default=True)
    layout_x = Column(Numeric(10, 2))
    layout_y = Column(Numeric(10, 2))
    layout_w = Column(Numeric(10, 2))
    layout_h = Column(Numeric(10, 2))

    line = relationship("WarehouseLine", back_populates="racks")
    bins = relationship("WarehouseBin", back_populates="rack")


class WarehouseBin(Base):
    __tablename__ = "warehouse_bins"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    rack_id = Column(BigInteger, ForeignKey("warehouse_racks.id"), nullable=False)
    code = Column(String(50), nullable=False)
    name = Column(String(255), nullable=False)
    bin_type = Column(Enum("pallet", "shelf", "floor", "bulk", "pick", name="bin_type_enum"), default="shelf")
    capacity = Column(Numeric(15, 3), default=0)
    capacity_uom = Column(String(10))
    is_reserve = Column(Boolean, default=False)
    is_pick_bin = Column(Boolean, default=False)
    barcode = Column(String(255))
    is_active = Column(Boolean, default=True)
    layout_x = Column(Numeric(10, 2))
    layout_y = Column(Numeric(10, 2))
    layout_w = Column(Numeric(10, 2))
    layout_h = Column(Numeric(10, 2))

    rack = relationship("WarehouseRack", back_populates="bins")


class Batch(Base):
    __tablename__ = "batches"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    batch_number = Column(String(100), nullable=False)
    lot_number = Column(String(100))
    manufacturing_date = Column(DateTime)
    expiry_date = Column(DateTime)
    supplier_batch = Column(String(100))
    status = Column(Enum("active", "expired", "recalled", "consumed", name="batch_status_enum"), default="active")
    notes = Column(Text)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    item = relationship("Item")

    # Wave 5 — UNIQUE(item_id, batch_number) so duplicate batches per item
    # can be caught at the DB level (BUG-INV-082). Race-safe inserts in the
    # warehouse / GRN paths must catch IntegrityError and resolve to the
    # existing row.
    __table_args__ = (
        UniqueConstraint("item_id", "batch_number", name="uq_batches_item_batch"),
    )


class SerialNumber(Base):
    __tablename__ = "serial_numbers"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    serial_number = Column(String(100), nullable=False)
    batch_id = Column(BigInteger, ForeignKey("batches.id"))
    status = Column(Enum("available", "issued", "consumed", "returned", "scrapped", name="serial_status_enum"), default="available")
    warehouse_id = Column(BigInteger)
    bin_id = Column(BigInteger)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    item = relationship("Item")
    batch = relationship("Batch")


class MaterialInward(Base):
    __tablename__ = "material_inwards"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    inward_number = Column(String(50), unique=True, nullable=False)
    po_id = Column(BigInteger, ForeignKey("purchase_orders.id"), nullable=True)
    po_number = Column(String(50), nullable=True)  # For manual entry when PO is not in system
    vendor_id = Column(BigInteger, ForeignKey("vendors.id"), nullable=True)
    vendor_name_manual = Column(String(255), nullable=True) # Manual vendor name fallback
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    received_date = Column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    vehicle_number = Column(String(50))
    driver_name = Column(String(255))
    remarks = Column(Text)
    status = Column(Enum("draft", "received", "grn_created", "cancelled", name="inward_status_enum"), default="draft")
    
    created_by = Column(BigInteger)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    purchase_order = relationship("PurchaseOrder")
    vendor = relationship("Vendor")
    warehouse = relationship("Warehouse")
    items = relationship("MaterialInwardItem", back_populates="inward", cascade="all, delete-orphan")


class MaterialInwardItem(Base):
    __tablename__ = "material_inward_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    inward_id = Column(BigInteger, ForeignKey("material_inwards.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=True)  # Optional if item is not in system
    item_name_manual = Column(String(255), nullable=True)
    ordered_qty = Column(Numeric(15, 3), default=0)
    received_qty = Column(Numeric(15, 3), nullable=False)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=True)
    uom_manual = Column(String(50), nullable=True)
    remarks = Column(Text)

    inward = relationship("MaterialInward", back_populates="items")
    item = relationship("Item")
    uom = relationship("UOM")

