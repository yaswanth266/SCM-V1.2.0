from sqlalchemy import Column, BigInteger, String, Text, Boolean, DateTime, Enum, ForeignKey, Numeric, Integer, Index
from datetime import datetime, timezone
from app.database import Base


class BarcodeRegistry(Base):
    __tablename__ = "barcode_registry"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    entity_type = Column(Enum("item", "batch", "serial", "bin", "pallet", "package", "gate_pass", "asset", name="bc_entity_type_enum"), nullable=False)
    entity_id = Column(BigInteger, nullable=False)
    barcode_type = Column(Enum("qrcode", "code128", "ean13", "ean8", "code39", name="bc_type_enum"), nullable=False)
    barcode_value = Column(String(255), unique=True, nullable=False)
    barcode_data = Column(Text)
    label_printed = Column(Boolean, default=False)
    print_count = Column(Integer, default=0)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        Index("idx_bc_entity", "entity_type", "entity_id"),
        Index("idx_bc_value", "barcode_value"),
    )


class ScanLog(Base):
    __tablename__ = "scan_logs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    barcode_value = Column(String(255), nullable=False)
    scan_type = Column(Enum("inward", "outward", "putaway", "pick", "pack", "dispatch", "gate_in", "gate_out", "transfer", "audit", "consumption", "acknowledgement", name="scan_type_enum"), nullable=False)
    warehouse_id = Column(BigInteger)
    bin_id = Column(BigInteger)
    reference_type = Column(String(50))
    reference_id = Column(BigInteger)
    scanned_by = Column(BigInteger, ForeignKey("users.id"), nullable=False)
    scan_timestamp = Column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    device_info = Column(String(255))
    latitude = Column(Numeric(10, 8))
    longitude = Column(Numeric(11, 8))
    notes = Column(Text)

    __table_args__ = (
        Index("idx_scan_barcode", "barcode_value"),
        Index("idx_scan_time", "scan_timestamp"),
        Index("idx_scan_user", "scanned_by"),
    )
