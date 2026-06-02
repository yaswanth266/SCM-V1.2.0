from sqlalchemy import Column, BigInteger, String, Text, DateTime, Enum, ForeignKey, Numeric, Integer, Boolean
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class MaterialRequest(Base):
    __tablename__ = "material_requests"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    mr_number = Column(String(50), unique=True, nullable=False)
    indent_id = Column(BigInteger)
    project_id = Column(BigInteger, ForeignKey("projects.id"))
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"))
    request_type = Column(Enum("purchase", "transfer", "consumption", "maintenance", "replenishment", name="mr_request_type_enum"), nullable=False)
    department = Column(String(100))
    requested_by = Column(BigInteger, ForeignKey("users.id"), nullable=False)
    request_date = Column(DateTime, nullable=False)
    required_date = Column(DateTime)
    priority = Column(Enum("low", "medium", "high", "urgent", name="mr_priority_enum"), default="medium")
    status = Column(Enum("draft", "pending_approval", "approved", "partially_ordered", "ordered", "rejected", "cancelled", name="mr_status_enum"), default="draft")
    remarks = Column(Text)
    approved_by = Column(BigInteger)
    approved_date = Column(DateTime)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    project = relationship("Project")
    warehouse = relationship("Warehouse")
    requester = relationship("User", foreign_keys=[requested_by])
    items = relationship("MaterialRequestItem", back_populates="material_request", cascade="all, delete-orphan")


class MaterialRequestItem(Base):
    __tablename__ = "material_request_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    mr_id = Column(BigInteger, ForeignKey("material_requests.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    qty = Column(Numeric(15, 3), nullable=False)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    ordered_qty = Column(Numeric(15, 3), default=0)
    received_qty = Column(Numeric(15, 3), default=0)
    target_warehouse_id = Column(BigInteger)
    remarks = Column(Text)

    material_request = relationship("MaterialRequest", back_populates="items")
    item = relationship("Item")
    uom = relationship("UOM")


class MrIndentLink(Base):
    """Junction between a consolidated MR and the source indents it absorbed.
    One row per indent line that contributed qty to an MR line."""
    __tablename__ = "mr_indent_links"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    mr_id = Column(BigInteger, ForeignKey("material_requests.id", ondelete="CASCADE"), nullable=False)
    indent_id = Column(BigInteger, ForeignKey("indents.id"), nullable=False)
    indent_item_id = Column(BigInteger, ForeignKey("indent_items.id"))
    mr_item_id = Column(BigInteger, ForeignKey("material_request_items.id"))
    qty = Column(Numeric(15, 3), nullable=False, default=0)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class RFQ(Base):
    __tablename__ = "rfqs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    rfq_number = Column(String(50), unique=True, nullable=False)
    mr_id = Column(BigInteger, ForeignKey("material_requests.id"), nullable=True)
    title = Column(String(200), nullable=True)
    rfq_date = Column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    valid_until = Column(DateTime, nullable=True)
    payment_terms = Column(Text, nullable=True)
    with_vehicle = Column(Boolean, default=False, nullable=False)
    status = Column(Enum("draft", "sent", "under_evaluation", "closed", "cancelled", name="rfq_status_enum"), default="draft", nullable=False)
    remarks = Column(Text, nullable=True)
    created_by = Column(BigInteger, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), nullable=False)

    material_request = relationship("MaterialRequest")
    items = relationship("RFQItem", back_populates="rfq", cascade="all, delete-orphan")
    vendors = relationship("RFQVendor", back_populates="rfq", cascade="all, delete-orphan")
    quotations = relationship("Quotation", back_populates="rfq", cascade="all, delete-orphan")


class RFQItem(Base):
    __tablename__ = "rfq_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    rfq_id = Column(BigInteger, ForeignKey("rfqs.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    qty = Column(Numeric(15, 3), nullable=False)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    remarks = Column(Text, nullable=True)

    rfq = relationship("RFQ", back_populates="items")
    item = relationship("Item")
    uom = relationship("UOM")


class RFQVendor(Base):
    __tablename__ = "rfq_vendors"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    rfq_id = Column(BigInteger, ForeignKey("rfqs.id", ondelete="CASCADE"), nullable=False)
    vendor_id = Column(BigInteger, ForeignKey("vendors.id", ondelete="CASCADE"), nullable=False)
    status = Column(Enum("invited", "submitted", "declined", name="rfq_vendor_status_enum"), default="invited", nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    rfq = relationship("RFQ", back_populates="vendors")
    vendor = relationship("Vendor")


class Quotation(Base):
    __tablename__ = "quotations"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    rfq_id = Column(BigInteger, ForeignKey("rfqs.id", ondelete="CASCADE"), nullable=True)
    rfq_number = Column(String(50), index=True)
    quotation_number = Column(String(50), unique=True, nullable=False)
    mr_id = Column(BigInteger, ForeignKey("material_requests.id"))
    vendor_id = Column(BigInteger, ForeignKey("vendors.id"), nullable=False)
    quotation_date = Column(DateTime, nullable=False)
    valid_until = Column(DateTime)
    subtotal = Column(Numeric(15, 2), default=0)
    total_amount = Column(Numeric(15, 2), default=0)
    cgst_amount = Column(Numeric(15, 2), default=0)
    sgst_amount = Column(Numeric(15, 2), default=0)
    igst_amount = Column(Numeric(15, 2), default=0)
    tax_amount = Column(Numeric(15, 2), default=0)
    vehicle_cost = Column(Numeric(15, 2), default=0)
    grand_total = Column(Numeric(15, 2), default=0)
    currency = Column(String(3), default="INR")
    delivery_days = Column(Integer)
    payment_terms = Column(Text)
    with_vehicle = Column(Boolean, default=False)
    status = Column(Enum("draft", "submitted", "accepted", "rejected", "expired", name="quotation_status_enum"), default="draft")
    remarks = Column(Text)
    submitted_by = Column(BigInteger)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    rfq = relationship("RFQ", back_populates="quotations")
    material_request = relationship("MaterialRequest")
    vendor = relationship("Vendor")
    items = relationship("QuotationItem", back_populates="quotation", cascade="all, delete-orphan")


class QuotationItem(Base):
    __tablename__ = "quotation_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    quotation_id = Column(BigInteger, ForeignKey("quotations.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    qty = Column(Numeric(15, 3), nullable=False)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    rate = Column(Numeric(15, 2), nullable=False)
    discount_pct = Column(Numeric(5, 2), default=0)
    tax_rate = Column(Numeric(5, 2), default=0)
    cgst_rate = Column(Numeric(5, 2), default=0)
    sgst_rate = Column(Numeric(5, 2), default=0)
    igst_rate = Column(Numeric(5, 2), default=0)
    amount = Column(Numeric(15, 2), default=0)
    expected_delivery = Column(DateTime)
    remarks = Column(Text)

    quotation = relationship("Quotation", back_populates="items")
    item = relationship("Item")
    uom = relationship("UOM")


class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    po_number = Column(String(50), unique=True, nullable=False)
    vendor_id = Column(BigInteger, ForeignKey("vendors.id"), nullable=False)
    mr_id = Column(BigInteger, ForeignKey("material_requests.id"))
    quotation_id = Column(BigInteger, ForeignKey("quotations.id"))
    project_id = Column(BigInteger, ForeignKey("projects.id"))
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"))
    po_date = Column(DateTime, nullable=False)
    expected_delivery_date = Column(DateTime)
    billing_address = Column(Text)
    shipping_address = Column(Text)
    subtotal = Column(Numeric(15, 2), default=0)
    discount_amount = Column(Numeric(15, 2), default=0)
    cgst_amount = Column(Numeric(15, 2), default=0)
    sgst_amount = Column(Numeric(15, 2), default=0)
    igst_amount = Column(Numeric(15, 2), default=0)
    tax_amount = Column(Numeric(15, 2), default=0)
    grand_total = Column(Numeric(15, 2), default=0)
    payment_terms_days = Column(Integer, default=30)
    # Wave 5 — text payment terms + transactional currency (BUG-PRO-007/139).
    payment_terms = Column(Text)
    currency = Column(String(3), default="INR", nullable=False)
    status = Column(Enum("draft", "pending_approval", "approved", "partially_received", "received", "closed", "cancelled", name="po_status_enum"), default="draft")
    remarks = Column(Text)
    attachment_url = Column(String(500))
    approved_by = Column(BigInteger)
    approved_date = Column(DateTime)
    created_by = Column(BigInteger)
    supplier_acknowledgement = Column(String(50), default="pending")
    # Wave 5 — cancellation audit (BUG-PRO-038)
    cancelled_by = Column(BigInteger)
    cancelled_at = Column(DateTime)
    cancel_reason = Column(Text)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    vendor = relationship("Vendor")
    material_request = relationship("MaterialRequest")
    quotation = relationship("Quotation")
    project = relationship("Project")
    warehouse = relationship("Warehouse")
    items = relationship("PurchaseOrderItem", back_populates="purchase_order", cascade="all, delete-orphan")


class PurchaseOrderItem(Base):
    __tablename__ = "purchase_order_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    po_id = Column(BigInteger, ForeignKey("purchase_orders.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    qty = Column(Numeric(15, 3), nullable=False)
    received_qty = Column(Numeric(15, 3), default=0)
    returned_qty = Column(Numeric(15, 3), default=0)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    rate = Column(Numeric(15, 2), nullable=False)
    discount_pct = Column(Numeric(5, 2), default=0)
    cgst_rate = Column(Numeric(5, 2), default=0)
    sgst_rate = Column(Numeric(5, 2), default=0)
    igst_rate = Column(Numeric(5, 2), default=0)
    tax_amount = Column(Numeric(15, 2), default=0)
    amount = Column(Numeric(15, 2), default=0)

    purchase_order = relationship("PurchaseOrder", back_populates="items")
    item = relationship("Item")
    uom = relationship("UOM")
