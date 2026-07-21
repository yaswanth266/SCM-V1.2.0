from sqlalchemy import Column, BigInteger, String, Text, DateTime, Enum, ForeignKey, Numeric, JSON
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class MaterialIssue(Base):
    __tablename__ = "material_issues"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    issue_number = Column(String(50), unique=True, nullable=False)
    indent_id = Column(BigInteger, ForeignKey("indents.id"))
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    destination_warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=True)
    issue_date = Column(DateTime, nullable=False)
    department = Column(String(100))
    issued_to = Column(BigInteger, ForeignKey("users.id"))
    status = Column(Enum("draft", "issued", "dispatched", "acknowledged", "completed", "cancelled", "delivered", "received", "partially_acknowledged", name="mi_status_enum"), default="draft")
    remarks = Column(Text)
    issued_by = Column(BigInteger)
    dispatched_at = Column(DateTime, nullable=True)
    vehicle_code = Column(String(50), nullable=True)
    vehicle_number = Column(String(50), nullable=True)
    service_code = Column(String(50), nullable=True)
    template_type = Column(String(50), nullable=True)
    template_id = Column(BigInteger, ForeignKey("project_indent_templates.id"), nullable=True)
    template_name = Column(String(100), nullable=True)
    project_id = Column(BigInteger, ForeignKey("projects.id"), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    # Wave 5 — needed for ordering / "last edited" UX (BUG-ISS-014).
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    indent = relationship("Indent")
    project = relationship("Project")
    warehouse = relationship("Warehouse", foreign_keys=[warehouse_id])
    destination_warehouse = relationship("Warehouse", foreign_keys=[destination_warehouse_id])
    issued_to_user = relationship("User", foreign_keys=[issued_to])
    items = relationship("MaterialIssueItem", back_populates="material_issue", cascade="all, delete-orphan")


class MaterialIssueItem(Base):
    __tablename__ = "material_issue_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    issue_id = Column(BigInteger, ForeignKey("material_issues.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    batch_id = Column(BigInteger, ForeignKey("batches.id"), nullable=True)
    qty = Column(Numeric(15, 3), nullable=False)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    bin_id = Column(BigInteger, ForeignKey("warehouse_bins.id"), nullable=True)
    rate = Column(Numeric(15, 2), default=0)
    amount = Column(Numeric(15, 2), default=0)
    # Wave 7 — Healthcare compliance (per-line so mixed H1/OTC issues are precise)
    prescriber_name = Column(String(255))
    prescriber_license = Column(String(100))
    patient_name = Column(String(255))
    patient_id_text = Column(String(100))
    serial_numbers = Column(JSON, nullable=True)
    # Non-central warehouse traceability — free-text batch/bin reference (no FK, no ledger validation)
    batch_number_text = Column(String(100), nullable=True)
    bin_code_text = Column(String(100), nullable=True)


    material_issue = relationship("MaterialIssue", back_populates="items")
    item = relationship("Item")
    uom = relationship("UOM")
    batch = relationship("Batch")
    bin = relationship("WarehouseBin")


# =============================================================
# Wave 5 — Issue returns (BUG-ISS-063). When a department/ward returns
# unused issued stock, we need a separate document type so stock_ledger
# rows can be written with a return reference and auditors can see the
# round-trip.
# =============================================================
class IssueReturn(Base):
    __tablename__ = "issue_returns"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    return_number = Column(String(50), unique=True, nullable=False)
    issue_id = Column(BigInteger, ForeignKey("material_issues.id"), nullable=False)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    return_date = Column(DateTime, nullable=False)
    reason = Column(Text)
    status = Column(String(30), nullable=False, default="draft")
    created_by = Column(BigInteger, ForeignKey("users.id"))
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    issue = relationship("MaterialIssue")
    warehouse = relationship("Warehouse")
    items = relationship("IssueReturnItem", back_populates="issue_return", cascade="all, delete-orphan")


class IssueReturnItem(Base):
    __tablename__ = "issue_return_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    return_id = Column(BigInteger, ForeignKey("issue_returns.id", ondelete="CASCADE"), nullable=False)
    issue_item_id = Column(BigInteger)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    batch_id = Column(BigInteger)
    qty = Column(Numeric(15, 3), nullable=False)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    rate = Column(Numeric(15, 2), default=0)
    reason = Column(Text)

    issue_return = relationship("IssueReturn", back_populates="items")
    item = relationship("Item")
    uom = relationship("UOM")


class VehicleIssue(Base):
    __tablename__ = "vehicle_issues"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    issue_number = Column(String(50), unique=True, nullable=False)
    indent_id = Column(BigInteger, ForeignKey("indents.id"), nullable=True)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    vehicle_code = Column(String(50), nullable=False)
    vehicle_number = Column(String(50), nullable=False)
    issue_date = Column(DateTime, nullable=False)
    department = Column(String(100))
    issued_to = Column(BigInteger, ForeignKey("users.id"))
    status = Column(String(50), default="draft")
    remarks = Column(Text)
    issued_by = Column(BigInteger, ForeignKey("users.id"))
    project_id = Column(BigInteger, ForeignKey("projects.id"), nullable=True)
    template_type = Column(String(50), nullable=True)
    template_id = Column(BigInteger, ForeignKey("project_indent_templates.id"), nullable=True)
    template_name = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    indent = relationship("Indent")
    project = relationship("Project")
    warehouse = relationship("Warehouse", foreign_keys=[warehouse_id])
    issued_to_user = relationship("User", foreign_keys=[issued_to])
    issued_by_user = relationship("User", foreign_keys=[issued_by])
    items = relationship("VehicleIssueItem", back_populates="vehicle_issue", cascade="all, delete-orphan")


class VehicleIssueItem(Base):
    __tablename__ = "vehicle_issue_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    vehicle_issue_id = Column(BigInteger, ForeignKey("vehicle_issues.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    batch_id = Column(BigInteger, ForeignKey("batches.id"), nullable=True)
    qty = Column(Numeric(15, 3), nullable=False)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    bin_id = Column(BigInteger, ForeignKey("warehouse_bins.id"), nullable=True)
    rate = Column(Numeric(15, 2), default=0)
    amount = Column(Numeric(15, 2), default=0)
    serial_numbers = Column(JSON, nullable=True)
    batch_number_text = Column(String(100), nullable=True)
    bin_code_text = Column(String(100), nullable=True)

    vehicle_issue = relationship("VehicleIssue", back_populates="items")
    item = relationship("Item")
    uom = relationship("UOM")
    batch = relationship("Batch")
    bin = relationship("WarehouseBin")


class MaterialAcknowledgement(Base):
    __tablename__ = "material_acknowledgements"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    acknowledgement_number = Column(String(50), unique=True, nullable=False)
    vehicle_issue_id = Column(BigInteger, ForeignKey("vehicle_issues.id"), nullable=False)
    acknowledged_by = Column(BigInteger, ForeignKey("users.id"), nullable=False)
    employee_code = Column(String(100), nullable=True)
    remarks = Column(Text, nullable=True)
    status = Column(String(50), default="acknowledged")
    acknowledged_at = Column(DateTime, nullable=False)
    photos = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    vehicle_issue = relationship("VehicleIssue")
    acknowledger = relationship("User", foreign_keys=[acknowledged_by])
    items = relationship("MaterialAcknowledgementItem", back_populates="acknowledgement", cascade="all, delete-orphan")


class MaterialAcknowledgementItem(Base):
    __tablename__ = "material_acknowledgement_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    acknowledgement_id = Column(BigInteger, ForeignKey("material_acknowledgements.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    received_qty = Column(Numeric(15, 3), nullable=False)
    remarks = Column(Text, nullable=True)
    serial_numbers = Column(JSON, nullable=True)
    photos = Column(JSON, nullable=True)

    acknowledgement = relationship("MaterialAcknowledgement", back_populates="items")
    item = relationship("Item")

