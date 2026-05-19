from sqlalchemy import Column, BigInteger, String, Text, DateTime, Enum, ForeignKey, Numeric
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class StockTransfer(Base):
    __tablename__ = "stock_transfers"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    transfer_number = Column(String(50), unique=True, nullable=False)
    source_warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    destination_warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    transfer_date = Column(DateTime, nullable=False)
    expected_date = Column(DateTime)
    transfer_type = Column(Enum("warehouse_to_warehouse", "location_to_location", "bin_to_bin", name="transfer_type_enum"), default="warehouse_to_warehouse")
    status = Column(Enum("draft", "pending_approval", "approved", "in_transit", "received", "completed", "cancelled", name="transfer_status_enum"), default="draft")
    remarks = Column(Text)
    requested_by = Column(BigInteger)
    approved_by = Column(BigInteger)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    source_warehouse = relationship("Warehouse", foreign_keys=[source_warehouse_id])
    destination_warehouse = relationship("Warehouse", foreign_keys=[destination_warehouse_id])
    items = relationship("StockTransferItem", back_populates="transfer", cascade="all, delete-orphan")


class StockTransferItem(Base):
    __tablename__ = "stock_transfer_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    transfer_id = Column(BigInteger, ForeignKey("stock_transfers.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    batch_id = Column(BigInteger)
    qty = Column(Numeric(15, 3), nullable=False)
    received_qty = Column(Numeric(15, 3), default=0)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    source_bin_id = Column(BigInteger)
    destination_bin_id = Column(BigInteger)
    status = Column(Enum("pending", "dispatched", "received", name="transfer_item_status_enum"), default="pending")

    transfer = relationship("StockTransfer", back_populates="items")
    item = relationship("Item")
    uom = relationship("UOM")
