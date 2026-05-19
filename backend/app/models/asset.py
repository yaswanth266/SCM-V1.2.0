from sqlalchemy import Column, BigInteger, String, Text, Boolean, DateTime, Enum, ForeignKey, Numeric, Integer
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class AssetCategory(Base):
    __tablename__ = "asset_categories"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    type = Column(Enum("it", "medical", "fixed", "other", name="asset_cat_type_enum"), nullable=False)
    depreciation_method = Column(Enum("straight_line", "written_down", name="depreciation_method_enum"), default="straight_line")
    useful_life_years = Column(Integer, default=5)
    depreciation_rate = Column(Numeric(5, 2), default=0)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    assets = relationship("Asset", back_populates="category")


class Asset(Base):
    __tablename__ = "assets"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    asset_code = Column(String(50), unique=True, nullable=False)
    name = Column(String(255), nullable=False)
    category_id = Column(BigInteger, ForeignKey("asset_categories.id"), nullable=False)
    serial_number = Column(String(100))
    barcode = Column(String(255))
    purchase_date = Column(DateTime)
    purchase_price = Column(Numeric(15, 2), default=0)
    current_value = Column(Numeric(15, 2), default=0)
    vendor_id = Column(BigInteger, ForeignKey("vendors.id"))
    po_id = Column(BigInteger)
    warranty_expiry = Column(DateTime)
    current_warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"))
    current_location = Column(String(255))
    assigned_to = Column(BigInteger, ForeignKey("users.id"))
    status = Column(Enum("available", "in_use", "maintenance", "disposed", "lost", name="asset_status_enum"), default="available")
    condition_status = Column(Enum("new", "good", "fair", "poor", "damaged", name="asset_condition_enum"), default="new")
    remarks = Column(Text)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    category = relationship("AssetCategory", back_populates="assets")
    vendor = relationship("Vendor")
    warehouse = relationship("Warehouse")
    assigned_user = relationship("User")
    movements = relationship("AssetMovement", back_populates="asset")


class AssetMovement(Base):
    __tablename__ = "asset_movements"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    asset_id = Column(BigInteger, ForeignKey("assets.id"), nullable=False)
    movement_type = Column(Enum("transfer", "assign", "return", "maintenance", "dispose", name="asset_movement_type_enum"), nullable=False)
    from_location = Column(String(255))
    to_location = Column(String(255))
    from_warehouse_id = Column(BigInteger)
    to_warehouse_id = Column(BigInteger)
    from_user_id = Column(BigInteger)
    to_user_id = Column(BigInteger)
    movement_date = Column(DateTime, nullable=False)
    reason = Column(Text)
    created_by = Column(BigInteger)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    asset = relationship("Asset", back_populates="movements")
