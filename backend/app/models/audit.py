from sqlalchemy import Column, BigInteger, String, Text, Boolean, DateTime, Enum, ForeignKey, Numeric, Integer
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class StockAudit(Base):
    __tablename__ = "stock_audits"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    audit_number = Column(String(50), unique=True, nullable=False)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    audit_date = Column(DateTime, nullable=False)
    audit_type = Column(Enum("full", "partial", "cycle_count", name="audit_type_enum"), default="full")
    status = Column(Enum("draft", "in_progress", "completed", "cancelled", name="audit_status_enum"), default="draft")
    total_items = Column(Integer, default=0)
    variance_items = Column(Integer, default=0)
    conducted_by = Column(BigInteger)
    approved_by = Column(BigInteger)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    warehouse = relationship("Warehouse")
    items = relationship("StockAuditItem", back_populates="audit", cascade="all, delete-orphan")


class StockAuditItem(Base):
    __tablename__ = "stock_audit_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    audit_id = Column(BigInteger, ForeignKey("stock_audits.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    bin_id = Column(BigInteger)
    batch_id = Column(BigInteger)
    system_qty = Column(Numeric(15, 3), default=0)
    physical_qty = Column(Numeric(15, 3), default=0)
    variance_qty = Column(Numeric(15, 3), default=0)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    adjustment_type = Column(Enum("none", "increase", "decrease", name="adjustment_type_enum"), default="none")
    adjusted = Column(Boolean, default=False)
    remarks = Column(Text)

    audit = relationship("StockAudit", back_populates="items")
    item = relationship("Item")
    uom = relationship("UOM")


class BinReplenishmentRule(Base):
    __tablename__ = "bin_replenishment_rules"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    pick_bin_id = Column(BigInteger, ForeignKey("warehouse_bins.id"), nullable=False)
    reserve_bin_id = Column(BigInteger, ForeignKey("warehouse_bins.id"), nullable=False)
    min_qty = Column(Numeric(15, 3), nullable=False)
    max_qty = Column(Numeric(15, 3), nullable=False)
    replenish_qty = Column(Numeric(15, 3), nullable=False)
    is_active = Column(Boolean, default=True)

    item = relationship("Item")
    pick_bin = relationship("WarehouseBin", foreign_keys=[pick_bin_id])
    reserve_bin = relationship("WarehouseBin", foreign_keys=[reserve_bin_id])
