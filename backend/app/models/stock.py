from sqlalchemy import Column, BigInteger, String, DateTime, Enum, ForeignKey, Numeric, Time, Index, UniqueConstraint
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class StockLedger(Base):
    __tablename__ = "stock_ledger"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    bin_id = Column(BigInteger, ForeignKey("warehouse_bins.id"))
    batch_id = Column(BigInteger, ForeignKey("batches.id"))
    transaction_type = Column(String(50), nullable=False)
    reference_type = Column(String(50))
    reference_id = Column(BigInteger)
    qty_in = Column(Numeric(15, 3), default=0)
    qty_out = Column(Numeric(15, 3), default=0)
    balance_qty = Column(Numeric(15, 3), default=0)
    uom_id = Column(BigInteger)
    rate = Column(Numeric(15, 2), default=0)
    value_in = Column(Numeric(15, 2), default=0)
    value_out = Column(Numeric(15, 2), default=0)
    balance_value = Column(Numeric(15, 2), default=0)
    posting_date = Column(DateTime, nullable=False)
    posting_time = Column(Time)
    created_by = Column(BigInteger)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    item = relationship("Item")
    warehouse = relationship("Warehouse")
    batch = relationship("Batch")

    __table_args__ = (
        Index("idx_sl_item", "item_id"),
        Index("idx_sl_wh", "warehouse_id"),
        Index("idx_sl_date", "posting_date"),
        Index("idx_sl_ref", "reference_type", "reference_id"),
    )


class StockBalance(Base):
    __tablename__ = "stock_balance"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    bin_id = Column(BigInteger, ForeignKey("warehouse_bins.id"))
    batch_id = Column(BigInteger, ForeignKey("batches.id"))
    available_qty = Column(Numeric(15, 3), default=0)
    reserved_qty = Column(Numeric(15, 3), default=0)
    transit_qty = Column(Numeric(15, 3), default=0)
    total_qty = Column(Numeric(15, 3), default=0)
    valuation_rate = Column(Numeric(15, 2), default=0)
    stock_value = Column(Numeric(15, 2), default=0)
    last_updated = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    item = relationship("Item")
    warehouse = relationship("Warehouse")
    batch = relationship("Batch")
    bin = relationship("WarehouseBin")

    __table_args__ = (
        Index("idx_sb_item", "item_id"),
        Index("idx_sb_wh", "warehouse_id"),
        Index("idx_sb_composite", "item_id", "warehouse_id", "bin_id", "batch_id"),
        UniqueConstraint("item_id", "warehouse_id", "bin_id", "batch_id", name="uq_stock_balance_key"),
    )
