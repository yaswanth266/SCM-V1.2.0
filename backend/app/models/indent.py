from sqlalchemy import Column, BigInteger, String, Text, DateTime, Enum, ForeignKey, Numeric
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class Indent(Base):
    __tablename__ = "indents"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    indent_number = Column(String(50), unique=True, nullable=False)
    project_id = Column(BigInteger, ForeignKey("projects.id"))
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    indent_date = Column(DateTime, nullable=False)
    required_date = Column(DateTime)
    department = Column(String(100))
    indent_type = Column(Enum("regular", "urgent", "auto_reorder", name="indent_type_enum"), default="regular")
    status = Column(Enum("draft", "pending_approval", "approved", "partially_fulfilled", "fulfilled", "rejected", "cancelled", name="indent_status_enum"), default="draft")
    raised_by = Column(BigInteger, ForeignKey("users.id"), nullable=False)
    approved_by = Column(BigInteger)
    approved_date = Column(DateTime)
    remarks = Column(Text)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    project = relationship("Project")
    warehouse = relationship("Warehouse")
    raiser = relationship("User", foreign_keys=[raised_by])
    items = relationship("IndentItem", back_populates="indent", cascade="all, delete-orphan")
    acknowledgements = relationship("IndentAcknowledgement", back_populates="indent")


class IndentItem(Base):
    __tablename__ = "indent_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    indent_id = Column(BigInteger, ForeignKey("indents.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    requested_qty = Column(Numeric(15, 3), nullable=False)
    approved_qty = Column(Numeric(15, 3), default=0)
    issued_qty = Column(Numeric(15, 3), default=0)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    remarks = Column(Text)

    # Workflow rebuild (2026-04-30) — line-level fulfillment routing/status,
    # split-line parent linkage, and wh-mgr reservation timestamp.
    fulfillment_route = Column(
        Enum('pending_decision', 'issue', 'procure', 'partial_split',
             name='fulfillment_route'),
        nullable=False, server_default='pending_decision')
    fulfillment_status = Column(
        Enum('pending', 'reserved', 'in_mr_bucket', 'in_mr_draft', 'in_po',
             'awaiting_inward', 'inward_received', 'picking', 'picked', 'packed',
             'qc_passed', 'at_gate', 'in_transit', 'delivered', 'acknowledged',
             name='line_fulfillment_status'),
        nullable=False, server_default='pending')
    parent_item_id = Column(BigInteger, ForeignKey('indent_items.id'), nullable=True)
    reserved_at = Column(DateTime, nullable=True)

    indent = relationship("Indent", back_populates="items")
    item = relationship("Item")
    uom = relationship("UOM")


class IndentAcknowledgement(Base):
    __tablename__ = "indent_acknowledgements"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    indent_id = Column(BigInteger, ForeignKey("indents.id"), nullable=False)
    acknowledged_by = Column(BigInteger, ForeignKey("users.id"), nullable=False)
    acknowledged_at = Column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    received_qty = Column(Numeric(15, 3), default=0)
    status = Column(String(50), default="received")  # received, partial, completed
    remarks = Column(Text)
    scan_barcode = Column(String(255))
    scan_timestamp = Column(DateTime)
    scanned_barcodes_json = Column(Text)  # JSON array of scanned barcodes

    indent = relationship("Indent", back_populates="acknowledgements")
    acknowledger = relationship("User")
    items = relationship("IndentAcknowledgementItem", back_populates="acknowledgement", cascade="all, delete-orphan")


# Wave 11 — Indent now has back-link to MR via material_requests.source_indent_id


class IndentAcknowledgementItem(Base):
    __tablename__ = "indent_acknowledgement_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    acknowledgement_id = Column(BigInteger, ForeignKey("indent_acknowledgements.id", ondelete="CASCADE"), nullable=False)
    indent_item_id = Column(BigInteger, ForeignKey("indent_items.id"))
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    received_qty = Column(Numeric(15, 3), default=0)
    remarks = Column(Text)

    acknowledgement = relationship("IndentAcknowledgement", back_populates="items")
    item = relationship("Item")
    indent_item = relationship("IndentItem")
