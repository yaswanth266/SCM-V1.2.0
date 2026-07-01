"""Consignment & Package models — healthcare logistics traceability pipeline.

Pipeline:
  Indent → Material Issue → Consignment → Packages → PackageItems
                                    ↓ (on receipt)
                         PackageAcknowledgement → StockLedger (dest. warehouse)
"""
from decimal import Decimal
from datetime import datetime, timezone
from sqlalchemy import (
    Column, BigInteger, String, Text, Boolean, DateTime,
    ForeignKey, Numeric, Integer, JSON, Index, UniqueConstraint,
)
from sqlalchemy.orm import relationship
from app.database import Base


class Consignment(Base):
    """One consignment = one person + one delivery + many packages.

    Created after a Material Issue is approved. Linked to an Indent (source),
    Material Issue (items), optional MDO (logistics order).
    """
    __tablename__ = "consignments"

    id = Column(BigInteger, primary_key=True, autoincrement=True)

    # Document numbers  —  CON-AP-2026-000001
    consignment_number = Column(String(60), unique=True, nullable=False, index=True)
    # QR payload stored as JSON string: {"type":"consignment","consignment":"CON-...", ...}
    consignment_barcode = Column(String(500), nullable=False)

    # Parent package details
    parent_package_code = Column(String(100), nullable=True)
    parent_package_barcode = Column(String(500), nullable=True)

    # Source linkage
    indent_id = Column(BigInteger, ForeignKey("indents.id", ondelete="SET NULL"), nullable=True)
    material_issue_id = Column(BigInteger, ForeignKey("material_issues.id", ondelete="RESTRICT"), nullable=False)
    mdo_id = Column(BigInteger, ForeignKey("logistics_main_dispatch_orders.id", ondelete="SET NULL"), nullable=True)

    # Warehouses
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id", ondelete="RESTRICT"), nullable=False)
    destination_warehouse_id = Column(BigInteger, ForeignKey("warehouses.id", ondelete="SET NULL"), nullable=True)

    # Receiver details
    destination_user_id = Column(BigInteger, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    receiver_employee_code = Column(String(50), nullable=True)   # e.g. LT001
    receiver_name = Column(String(255), nullable=True)
    receiver_position_code = Column(String(100), nullable=True)

    # State code for numbering (AP, TS, MH …)
    state_code = Column(String(10), nullable=True)

    # Denormalized aggregates — recalculated on every pack/add-package
    total_packages = Column(Integer, default=0, nullable=False)
    total_weight_kg = Column(Numeric(15, 3), default=Decimal("0"), nullable=False)
    total_volume_cft = Column(Numeric(15, 3), default=Decimal("0"), nullable=False)
    total_value = Column(Numeric(18, 2), default=Decimal("0"), nullable=False)
    total_items = Column(Integer, default=0, nullable=False)   # distinct material lines

    # Status lifecycle: DRAFT → PACKED → IN_TRANSIT → PARTIALLY_RECEIVED → RECEIVED
    status = Column(String(30), nullable=False, default="DRAFT")

    # Receipt evidence (filled when entire consignment is marked CONSIGNMENT_RECEIVED)
    receipt_signature_url = Column(String(500), nullable=True)
    receipt_photos = Column(JSON, nullable=True)
    receipt_remarks = Column(Text, nullable=True)

    # Timestamps
    packed_at = Column(DateTime(timezone=True), nullable=True)
    dispatched_at = Column(DateTime(timezone=True), nullable=True)
    received_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(BigInteger, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    # Relationships
    indent = relationship("Indent", foreign_keys=[indent_id])
    material_issue = relationship("MaterialIssue", foreign_keys=[material_issue_id], backref="consignments")
    mdo = relationship("LogisticsMainDispatchOrder", foreign_keys=[mdo_id], backref="consignments")
    source_warehouse = relationship("Warehouse", foreign_keys=[warehouse_id])
    destination_warehouse = relationship("Warehouse", foreign_keys=[destination_warehouse_id])
    destination_user = relationship("User", foreign_keys=[destination_user_id])
    creator = relationship("User", foreign_keys=[created_by])
    packages = relationship("ConsignmentPackage", back_populates="consignment", cascade="all, delete-orphan", order_by="ConsignmentPackage.sequence_number")

    __table_args__ = (
        Index("ix_consignment_mi", "material_issue_id"),
        Index("ix_consignment_mdo", "mdo_id"),
        Index("ix_consignment_status", "status"),
        Index("ix_consignment_indent", "indent_id"),
    )


class ConsignmentPackage(Base):
    """Individual physical package (box / carton / crate) within a consignment.

    Each package gets a unique number, QR barcode, and holds multiple PackageItems.
    A PackageContainer is auto-created 1:1 alongside each Package.
    """
    __tablename__ = "consignment_packages"

    id = Column(BigInteger, primary_key=True, autoincrement=True)

    # PKG-AP-2026-000456-01
    package_number = Column(String(80), unique=True, nullable=False, index=True)
    # QR payload: {"type":"package","package":"PKG-...","consignment":"CON-..."}
    package_barcode = Column(String(500), nullable=False)

    consignment_id = Column(BigInteger, ForeignKey("consignments.id", ondelete="CASCADE"), nullable=False)
    sequence_number = Column(Integer, default=1, nullable=False)

    # Parent package details
    parent_package_code = Column(String(100), nullable=True)
    parent_package_barcode = Column(String(500), nullable=True)

    # Physical attributes
    package_type = Column(String(50), nullable=False, default="BOX")   # BOX CRATE PALLET BAG LOOSE
    package_description = Column(String(255), nullable=True)
    length_cm = Column(Numeric(10, 2), nullable=True)
    width_cm = Column(Numeric(10, 2), nullable=True)
    height_cm = Column(Numeric(10, 2), nullable=True)
    gross_weight_kg = Column(Numeric(15, 3), default=Decimal("0"), nullable=False)
    net_weight_kg = Column(Numeric(15, 3), default=Decimal("0"), nullable=False)
    volume_cft = Column(Numeric(15, 3), default=Decimal("0"), nullable=False)

    # Sealing
    seal_number = Column(String(100), nullable=True)
    seal_intact = Column(Boolean, default=True, nullable=False)

    # Denorm count of distinct material lines
    material_count = Column(Integer, default=0, nullable=False)

    # Status: DRAFT → PACKED → IN_TRANSIT → RECEIVED | PARTIALLY_RECEIVED
    status = Column(String(30), nullable=False, default="DRAFT")

    # Timestamps
    packed_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(BigInteger, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    # Receipt acknowledgement fields (filled when receiver scans & acknowledges)
    received_at = Column(DateTime(timezone=True), nullable=True)
    received_by_id = Column(BigInteger, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    packaging_condition_on_receipt = Column(String(50), nullable=True)   # INTACT DAMAGED OPENED
    seal_intact_on_receipt = Column(Boolean, nullable=True)
    receipt_remarks = Column(Text, nullable=True)
    receipt_photos = Column(JSON, nullable=True)
    receipt_signature_url = Column(String(500), nullable=True)

    # Relationships
    consignment = relationship("Consignment", back_populates="packages")
    items = relationship("ConsignmentPackageItem", back_populates="package", cascade="all, delete-orphan")
    container = relationship("ConsignmentPackageContainer", back_populates="package", uselist=False, cascade="all, delete-orphan")
    acknowledgements = relationship("ConsignmentPackageAcknowledgement", back_populates="package", cascade="all, delete-orphan")
    creator = relationship("User", foreign_keys=[created_by])
    receiver = relationship("User", foreign_keys=[received_by_id])

    __table_args__ = (
        Index("ix_con_pkg_consignment", "consignment_id"),
        Index("ix_con_pkg_status", "status"),
    )


class ConsignmentPackageItem(Base):
    """Links a package to a specific Material Issue Item with packed quantities.

    Tracks: material + batch + expiry + source bin + packed qty + received qty.
    After acknowledgement, destination_bin_id is filled (storage location at MMU).
    """
    __tablename__ = "consignment_package_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)

    package_id = Column(BigInteger, ForeignKey("consignment_packages.id", ondelete="CASCADE"), nullable=False)
    material_issue_item_id = Column(BigInteger, ForeignKey("material_issue_items.id", ondelete="RESTRICT"), nullable=False)
    material_id = Column(BigInteger, ForeignKey("items.id", ondelete="RESTRICT"), nullable=False)
    batch_id = Column(BigInteger, ForeignKey("batches.id", ondelete="SET NULL"), nullable=True)
    uom_id = Column(BigInteger, ForeignKey("uom.id", ondelete="SET NULL"), nullable=True)
    uom_code = Column(String(20), nullable=True, default="NOS")

    # Source & destination bin
    source_bin_id = Column(BigInteger, ForeignKey("warehouse_bins.id", ondelete="SET NULL"), nullable=True)
    destination_bin_id = Column(BigInteger, ForeignKey("warehouse_bins.id", ondelete="SET NULL"), nullable=True)

    # Quantities
    quantity_packed = Column(Numeric(15, 3), nullable=False)
    quantity_received = Column(Numeric(15, 3), nullable=True)
    quantity_accepted = Column(Numeric(15, 3), nullable=True)
    quantity_rejected = Column(Numeric(15, 3), nullable=True, default=Decimal("0"))
    quantity_damaged = Column(Numeric(15, 3), nullable=True, default=Decimal("0"))

    # Condition & rejection details (filled on acknowledgement)
    item_condition = Column(String(50), nullable=True)      # GOOD DAMAGED WET CRUSHED
    rejection_reason = Column(String(255), nullable=True)
    damage_description = Column(Text, nullable=True)

    # Serial number tracking
    serial_numbers = Column(JSON, nullable=True)             # packed serials
    serial_numbers_received = Column(JSON, nullable=True)    # serials confirmed on receipt

    # Valuation
    unit_price = Column(Numeric(18, 2), default=Decimal("0"), nullable=False)
    total_value = Column(Numeric(18, 2), default=Decimal("0"), nullable=False)

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    # Relationships
    package = relationship("ConsignmentPackage", back_populates="items")
    material_issue_item = relationship("MaterialIssueItem", backref="consignment_package_items")
    material = relationship("Item")
    batch = relationship("Batch")
    uom = relationship("UOM")
    source_bin = relationship("WarehouseBin", foreign_keys=[source_bin_id])
    destination_bin = relationship("WarehouseBin", foreign_keys=[destination_bin_id])

    __table_args__ = (
        Index("ix_con_pkg_item_pkg", "package_id"),
        Index("ix_con_pkg_item_mi", "material_issue_item_id"),
        # Same MI item can appear in multiple packages (split qty) — constraint is per-package
        UniqueConstraint("package_id", "material_issue_item_id", name="uq_pkg_mi_item"),
    )


class ConsignmentPackageContainer(Base):
    """Auto-created container record for every package (1-to-1).

    Represents the physical container/bin used to hold and track the package
    in transit. Container number is derived from package number.
    """
    __tablename__ = "consignment_package_containers"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    package_id = Column(BigInteger, ForeignKey("consignment_packages.id", ondelete="CASCADE"), nullable=False, unique=True)
    container_number = Column(String(80), unique=True, nullable=False)
    container_type = Column(String(50), default="PACKAGE", nullable=False)   # PACKAGE PALLET CONTAINER
    # QR payload for the container
    container_barcode = Column(String(500), nullable=True)
    tare_weight_kg = Column(Numeric(15, 3), default=Decimal("0"), nullable=False)
    max_load_weight_kg = Column(Numeric(15, 3), nullable=True)
    status = Column(String(30), default="ACTIVE", nullable=False)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    package = relationship("ConsignmentPackage", back_populates="container")
    warehouse = relationship("Warehouse")


class ConsignmentPackageAcknowledgement(Base):
    """Per-package acknowledgement record — created when the receiver scans & confirms a package.

    On creation:
    - PackageItem quantities (received, accepted, rejected, damaged) are updated
    - stock_ledger entries are posted to destination warehouse (batch-level)
    - ConsignmentPackage.status is updated to RECEIVED or PARTIALLY_RECEIVED
    """
    __tablename__ = "consignment_package_acknowledgements"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    package_id = Column(BigInteger, ForeignKey("consignment_packages.id", ondelete="CASCADE"), nullable=False)
    consignment_id = Column(BigInteger, ForeignKey("consignments.id", ondelete="CASCADE"), nullable=False)

    # Who acknowledged
    acknowledged_by_user_id = Column(BigInteger, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    acknowledged_by_name = Column(String(255), nullable=True)
    acknowledged_by_designation = Column(String(100), nullable=True)
    acknowledged_by_phone = Column(String(20), nullable=True)
    acknowledged_by_employee_code = Column(String(50), nullable=True)

    # Evidence
    receiver_signature_url = Column(String(500), nullable=True)
    photos = Column(JSON, nullable=True)
    remarks = Column(Text, nullable=True)

    # Physical condition
    packaging_condition = Column(String(50), nullable=True)    # INTACT DAMAGED OPENED TAMPERED
    seal_intact = Column(Boolean, nullable=True)
    seal_number_verified = Column(Boolean, default=False, nullable=False)
    temperature_recorded = Column(Numeric(8, 2), nullable=True)
    humidity_recorded = Column(Numeric(8, 2), nullable=True)

    # Geolocation
    latitude = Column(Numeric(12, 8), nullable=True)
    longitude = Column(Numeric(12, 8), nullable=True)
    geo_fence_verified = Column(Boolean, default=False, nullable=False)

    # Device / audit trail
    device_id = Column(String(255), nullable=True)
    ip_address = Column(String(45), nullable=True)

    # PENDING | ACCEPTED | PARTIALLY_ACCEPTED | REJECTED
    acknowledgement_status = Column(String(30), default="PENDING", nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    # Relationships
    package = relationship("ConsignmentPackage", back_populates="acknowledgements")
    consignment = relationship("Consignment")
    acknowledger = relationship("User", foreign_keys=[acknowledged_by_user_id])

    __table_args__ = (
        Index("ix_con_pkg_ack_pkg", "package_id"),
        Index("ix_con_pkg_ack_con", "consignment_id"),
    )


class ConsignmentParentPackage(Base):
    """Parent package that groups multiple child packages in a consignment.

    E.g. a pallet containing several boxes, or a container with crates.
    A child package can only belong to ONE parent package within a consignment.
    """
    __tablename__ = "consignment_parent_packages"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    consignment_id = Column(BigInteger, ForeignKey("consignments.id", ondelete="CASCADE"), nullable=False)

    # Identity
    parent_package_number = Column(String(80), unique=True, nullable=False, index=True)
    parent_package_barcode = Column(String(500), nullable=False)
    parent_package_type = Column(String(50), nullable=False, default="PALLET")  # PALLET CONTAINER BUNDLE CRATE

    # Physical — parent's own tare + aggregate children
    tare_weight_kg = Column(Numeric(15, 3), default=Decimal("0"), nullable=False)
    gross_weight_kg = Column(Numeric(15, 3), default=Decimal("0"), nullable=False)
    total_child_weight_kg = Column(Numeric(15, 3), default=Decimal("0"), nullable=False)
    total_volume_cft = Column(Numeric(15, 3), default=Decimal("0"), nullable=False)

    # Dimensions (of the parent itself)
    length_cm = Column(Numeric(10, 2), nullable=True)
    width_cm = Column(Numeric(10, 2), nullable=True)
    height_cm = Column(Numeric(10, 2), nullable=True)

    # Sealing
    seal_number = Column(String(100), nullable=True)

    # Denormalised counts
    child_package_count = Column(Integer, default=0, nullable=False)
    total_items = Column(Integer, default=0, nullable=False)
    total_value = Column(Numeric(18, 2), default=Decimal("0"), nullable=False)

    # Status — follows consignment lifecycle
    status = Column(String(30), nullable=False, default="DRAFT")

    # Timestamps
    created_by = Column(BigInteger, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    # Relationships
    consignment = relationship("Consignment", backref="parent_packages")
    children = relationship(
        "ConsignmentParentPackageChild",
        back_populates="parent_package",
        cascade="all, delete-orphan",
        order_by="ConsignmentParentPackageChild.sequence_number",
    )
    creator = relationship("User", foreign_keys=[created_by])

    __table_args__ = (
        Index("ix_parent_pkg_con", "consignment_id"),
    )


class ConsignmentParentPackageChild(Base):
    """Junction: links a parent package to its child packages.

    Application-level constraint ensures a child package belongs to at most
    ONE parent within the same consignment.
    """
    __tablename__ = "consignment_parent_package_children"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    parent_package_id = Column(BigInteger, ForeignKey("consignment_parent_packages.id", ondelete="CASCADE"), nullable=False)
    child_package_id = Column(BigInteger, ForeignKey("consignment_packages.id", ondelete="CASCADE"), nullable=False)
    sequence_number = Column(Integer, default=1, nullable=False)

    # Relationships
    parent_package = relationship("ConsignmentParentPackage", back_populates="children")
    child_package = relationship("ConsignmentPackage")

    __table_args__ = (
        UniqueConstraint("parent_package_id", "child_package_id", name="uq_parent_child_pkg"),
        Index("ix_ppc_child", "child_package_id"),
    )

