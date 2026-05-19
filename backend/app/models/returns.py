from sqlalchemy import Column, BigInteger, String, Text, Boolean, DateTime, Enum, ForeignKey, Numeric
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class PurchaseReturn(Base):
    __tablename__ = "purchase_returns"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    return_number = Column(String(50), unique=True, nullable=False)
    po_id = Column(BigInteger)
    grn_id = Column(BigInteger)
    vendor_id = Column(BigInteger, ForeignKey("vendors.id"), nullable=False)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    return_date = Column(DateTime, nullable=False)
    reason = Column(Text)
    status = Column(Enum("draft", "pending_approval", "approved", "dispatched", "completed", "cancelled", name="pr_status_enum"), default="draft")
    total_amount = Column(Numeric(15, 2), default=0)
    # Wave 5 — distinguish expired-stock returns from defective returns so
    # vendor accounting can split short-pay vs replacement (BUG-ISS-055).
    is_expired_return = Column(Boolean, default=False, nullable=False)
    created_by = Column(BigInteger)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    vendor = relationship("Vendor")
    warehouse = relationship("Warehouse")
    items = relationship("PurchaseReturnItem", back_populates="purchase_return", cascade="all, delete-orphan")


class PurchaseReturnItem(Base):
    __tablename__ = "purchase_return_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    return_id = Column(BigInteger, ForeignKey("purchase_returns.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    batch_id = Column(BigInteger)
    qty = Column(Numeric(15, 3), nullable=False)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    rate = Column(Numeric(15, 2), default=0)
    amount = Column(Numeric(15, 2), default=0)
    reason = Column(Text)

    purchase_return = relationship("PurchaseReturn", back_populates="items")
    item = relationship("Item")
    uom = relationship("UOM")
