from sqlalchemy import Column, BigInteger, String, Text, DateTime, Enum, ForeignKey, Numeric
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class GoodsReceiptNote(Base):
    __tablename__ = "goods_receipt_notes"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    grn_number = Column(String(50), unique=True, nullable=False)
    po_id = Column(BigInteger, ForeignKey("purchase_orders.id"))
    inward_id = Column(BigInteger, ForeignKey("material_inwards.id"), nullable=True)
    vendor_id = Column(BigInteger, ForeignKey("vendors.id"), nullable=False)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    grn_date = Column(DateTime, nullable=False)
    supplier_invoice = Column(String(100))
    supplier_invoice_date = Column(DateTime)
    vehicle_number = Column(String(50))
    lr_number = Column(String(100))
    po_number = Column(String(50), nullable=True)
    receipt_type = Column(String(50), default="inward_based")
    # Wave 5 — link transfer GRNs back to the originating stock transfer
    # (BUG-INV-108). Nullable because po_based / direct GRNs don't set it.
    transfer_id = Column(BigInteger, ForeignKey("stock_transfers.id"))
    status = Column(Enum("draft", "pending_qi", "qi_in_progress", "qi_done", "putaway_pending", "partially_putaway", "putaway_done", "completed", "cancelled", name="grn_status_enum"), default="draft")
    total_qty = Column(Numeric(15, 3), default=0)
    accepted_qty = Column(Numeric(15, 3), default=0)
    rejected_qty = Column(Numeric(15, 3), default=0)
    remarks = Column(Text)
    received_by = Column(BigInteger)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    purchase_order = relationship("PurchaseOrder")
    inward = relationship("MaterialInward")
    vendor = relationship("Vendor")
    warehouse = relationship("Warehouse")
    items = relationship("GRNItem", back_populates="grn", cascade="all, delete-orphan")


class GRNItem(Base):
    __tablename__ = "grn_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    grn_id = Column(BigInteger, ForeignKey("goods_receipt_notes.id", ondelete="CASCADE"), nullable=False)
    po_item_id = Column(BigInteger)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    ordered_qty = Column(Numeric(15, 3), default=0)
    received_qty = Column(Numeric(15, 3), nullable=False)
    accepted_qty = Column(Numeric(15, 3), default=0)
    rejected_qty = Column(Numeric(15, 3), default=0)
    shortage_qty = Column(Numeric(15, 3), default=0)
    excess_qty = Column(Numeric(15, 3), default=0)
    damaged_qty = Column(Numeric(15, 3), default=0)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    batch_id = Column(BigInteger, ForeignKey("batches.id"))
    batch_number = Column(String(100))
    manufacturing_date = Column(DateTime)
    expiry_date = Column(DateTime)
    rate = Column(Numeric(15, 2), default=0)
    amount = Column(Numeric(15, 2), default=0)
    # Wave 5 — full tax + discount persistence on receipt (BUG-INV-008)
    discount_pct = Column(Numeric(5, 2), default=0)
    cgst_rate = Column(Numeric(5, 2), default=0)
    sgst_rate = Column(Numeric(5, 2), default=0)
    igst_rate = Column(Numeric(5, 2), default=0)
    tax_amount = Column(Numeric(15, 2), default=0)
    # Wave 5 — physical weight for landed-cost by_weight allocation
    # (BUG-PRO-095). Null/0 falls back to by-qty.
    weight = Column(Numeric(15, 3), default=0)
    qi_status = Column(Enum("pending", "accepted", "rejected", "hold", name="grn_qi_status_enum"), default="pending")
    remarks = Column(Text)

    grn = relationship("GoodsReceiptNote", back_populates="items")
    item = relationship("Item")
    uom = relationship("UOM")
    batch = relationship("Batch")
    serials = relationship("GRNItemSerial", back_populates="grn_item", cascade="all, delete-orphan")


class GRNItemSerial(Base):
    __tablename__ = "grn_item_serials"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    grn_item_id = Column(BigInteger, ForeignKey("grn_items.id", ondelete="CASCADE"), nullable=False)
    serial_number = Column(String(100), nullable=False)

    grn_item = relationship("GRNItem", back_populates="serials")


class QualityInspection(Base):
    __tablename__ = "quality_inspections"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    qi_number = Column(String(50), unique=True, nullable=False)
    grn_id = Column(BigInteger, ForeignKey("goods_receipt_notes.id"), nullable=False)
    inspection_type = Column(String(50), nullable=False, default="incoming")
    inspection_date = Column(DateTime, nullable=False)
    overall_result = Column(Enum("pass", "fail", "partial", name="qi_result_enum"), default="pass")
    inspected_by = Column(BigInteger)
    remarks = Column(Text)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    grn = relationship("GoodsReceiptNote")
    items = relationship("QualityInspectionItem", back_populates="inspection", cascade="all, delete-orphan")


class QualityInspectionItem(Base):
    __tablename__ = "quality_inspection_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    qi_id = Column(BigInteger, ForeignKey("quality_inspections.id", ondelete="CASCADE"), nullable=False)
    grn_item_id = Column(BigInteger, ForeignKey("grn_items.id"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    inspected_qty = Column(Numeric(15, 3), nullable=False)
    accepted_qty = Column(Numeric(15, 3), default=0)
    rejected_qty = Column(Numeric(15, 3), default=0)
    hold_qty = Column(Numeric(15, 3), default=0)
    result = Column(Enum("accepted", "rejected", "hold", name="qi_item_result_enum"), default="accepted")
    rejection_reason = Column(Text)
    remarks = Column(Text)

    inspection = relationship("QualityInspection", back_populates="items")
    grn_item = relationship("GRNItem")
    item = relationship("Item")

    @property
    def batch_number(self):
        return self.grn_item.batch_number if self.grn_item else None


class PutawayOrder(Base):
    __tablename__ = "putaway_orders"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    putaway_number = Column(String(50), unique=True, nullable=False)
    grn_id = Column(BigInteger, ForeignKey("goods_receipt_notes.id"), nullable=False)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    putaway_type = Column(Enum("system_directed", "manual", name="putaway_type_enum"), default="system_directed")
    status = Column(Enum("draft", "in_progress", "completed", "cancelled", name="putaway_status_enum"), default="draft")
    assigned_to = Column(BigInteger)
    started_at = Column(DateTime)
    completed_at = Column(DateTime)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    grn = relationship("GoodsReceiptNote")
    warehouse = relationship("Warehouse")
    items = relationship("PutawayItem", back_populates="putaway_order", cascade="all, delete-orphan")


class PutawayItem(Base):
    __tablename__ = "putaway_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    putaway_id = Column(BigInteger, ForeignKey("putaway_orders.id", ondelete="CASCADE"), nullable=False)
    grn_item_id = Column(BigInteger, ForeignKey("grn_items.id"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    qty = Column(Numeric(15, 3), nullable=False)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    batch_id = Column(BigInteger, ForeignKey("batches.id"),nullable=False)
    suggested_bin_id = Column(BigInteger, ForeignKey("warehouse_bins.id"))
    actual_bin_id = Column(BigInteger, ForeignKey("warehouse_bins.id"))
    status = Column(Enum("pending", "in_progress", "done", "skipped", name="putaway_item_status_enum"), default="pending")
    scanned_at = Column(DateTime)
    scanned_by = Column(BigInteger)

    putaway_order = relationship("PutawayOrder", back_populates="items")
    item = relationship("Item")
    batch = relationship("Batch")
    suggested_bin = relationship("WarehouseBin", foreign_keys=[suggested_bin_id])
    actual_bin = relationship("WarehouseBin", foreign_keys=[actual_bin_id])

    @property
    def batch_number(self):
        return self.batch.batch_number if self.batch else None
