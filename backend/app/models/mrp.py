"""Wave 9 — MRP models."""
from sqlalchemy import (
    Column, BigInteger, String, Text, Boolean, DateTime, Enum, ForeignKey, Integer, Numeric, Index,
)
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class MRPRun(Base):
    __tablename__ = "mrp_runs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_number = Column(String(50), nullable=False, unique=True)
    run_date = Column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    horizon_days = Column(Integer, default=30, nullable=False)
    history_days = Column(Integer, default=90, nullable=False)
    method = Column(Enum("moving_average", "weighted_average", "seasonal", name="mrp_method_enum"), default="moving_average", nullable=False)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"))
    item_category_id = Column(BigInteger, ForeignKey("item_categories.id"))
    status = Column(Enum("draft", "computed", "po_generated", "closed", name="mrp_status_enum"), default="draft")
    total_items = Column(Integer, default=0)
    items_needing_reorder = Column(Integer, default=0)
    total_suggested_value = Column(Numeric(15, 2), default=0)
    notes = Column(Text)
    created_by = Column(BigInteger, ForeignKey("users.id"))
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    items = relationship("MRPRunItem", back_populates="run", cascade="all, delete-orphan")
    creator = relationship("User", foreign_keys=[created_by])
    warehouse = relationship("Warehouse", foreign_keys=[warehouse_id])

    __table_args__ = (
        Index("idx_mrp_run_date", "run_date"),
    )


class MRPRunItem(Base):
    __tablename__ = "mrp_run_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, ForeignKey("mrp_runs.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    current_stock = Column(Numeric(15, 3), default=0)
    on_order_qty = Column(Numeric(15, 3), default=0)
    reserved_qty = Column(Numeric(15, 3), default=0)
    forecast_qty = Column(Numeric(15, 3), default=0)
    safety_stock = Column(Numeric(15, 3), default=0)
    reorder_level = Column(Numeric(15, 3), default=0)
    net_required = Column(Numeric(15, 3), default=0)
    suggested_qty = Column(Numeric(15, 3), default=0)
    suggested_vendor_id = Column(BigInteger, ForeignKey("vendors.id"))
    suggested_rate = Column(Numeric(15, 2), default=0)
    lead_time_days = Column(Integer, default=0)
    confidence_pct = Column(Numeric(5, 2), default=0)
    selected = Column(Boolean, default=True)
    generated_po_id = Column(BigInteger)
    notes = Column(Text)

    run = relationship("MRPRun", back_populates="items")
    item = relationship("Item", foreign_keys=[item_id])
    suggested_vendor = relationship("Vendor", foreign_keys=[suggested_vendor_id])

    __table_args__ = (
        Index("idx_mri_run", "run_id"),
        Index("idx_mri_item", "item_id"),
        Index("idx_mri_vendor", "suggested_vendor_id"),
    )
