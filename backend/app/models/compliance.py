"""Wave 7 compliance models — separate file to keep healthcare.py focused."""
from sqlalchemy import (
    Column, BigInteger, String, Text, Boolean, DateTime, Date, Enum,
    ForeignKey, Numeric, Index,
)
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class PrescriptionRecord(Base):
    """Audit row for every dispense of an H1, narcotic, or Schedule X drug."""
    __tablename__ = "prescription_records"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    source_type = Column(Enum("material_issue", "consumption_entry", name="presc_source_enum"), nullable=False)
    source_id = Column(BigInteger, nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    batch_id = Column(BigInteger, ForeignKey("batches.id"))
    qty_dispensed = Column(Numeric(15, 3), nullable=False)
    drug_schedule = Column(String(10))
    prescriber_name = Column(String(255), nullable=False)
    prescriber_license = Column(String(100), nullable=False)
    patient_name = Column(String(255))
    patient_id = Column(String(100))
    prescription_image_url = Column(String(500))
    dispensed_by = Column(BigInteger, ForeignKey("users.id"), nullable=False)
    dispensed_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    retention_until = Column(Date)
    notes = Column(Text)

    item = relationship("Item")
    batch = relationship("Batch")
    dispenser = relationship("User", foreign_keys=[dispensed_by])

    __table_args__ = (
        Index("idx_presc_item", "item_id"),
        Index("idx_presc_source", "source_type", "source_id"),
        Index("idx_presc_date", "dispensed_at"),
    )


class ColdChainLog(Base):
    __tablename__ = "cold_chain_logs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    batch_id = Column(BigInteger, ForeignKey("batches.id"), nullable=False)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"))
    reading_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    temperature_c = Column(Numeric(5, 2), nullable=False)
    humidity_pct = Column(Numeric(5, 2))
    is_breach = Column(Boolean, default=False)
    breach_severity = Column(Enum("minor", "major", "critical", name="cold_breach_enum"))
    recorded_by = Column(BigInteger, ForeignKey("users.id"))
    notes = Column(Text)

    batch = relationship("Batch")
    warehouse = relationship("Warehouse")
    recorder = relationship("User", foreign_keys=[recorded_by])

    __table_args__ = (
        Index("idx_cclog_batch", "batch_id"),
        Index("idx_cclog_breach", "is_breach"),
        Index("idx_cclog_date", "reading_at"),
    )


class ESignature(Base):
    __tablename__ = "e_signatures"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    source_type = Column(String(50), nullable=False)
    source_id = Column(BigInteger, nullable=False)
    signer_user_id = Column(BigInteger, ForeignKey("users.id"), nullable=False)
    signed_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    payload_hash = Column(String(128), nullable=False)
    signature_method = Column(String(50), default="password_reauth")
    client_ip = Column(String(45))
    client_meta = Column(Text)

    signer = relationship("User", foreign_keys=[signer_user_id])

    __table_args__ = (
        Index("idx_esig_source", "source_type", "source_id"),
        Index("idx_esig_signer", "signer_user_id"),
    )


class ComplianceAudit(Base):
    __tablename__ = "compliance_audits"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    event_type = Column(String(80), nullable=False)
    severity = Column(Enum("info", "warning", "error", "critical", name="compliance_severity_enum"), default="info")
    vendor_id = Column(BigInteger)
    item_id = Column(BigInteger)
    batch_id = Column(BigInteger)
    source_type = Column(String(50))
    source_id = Column(BigInteger)
    user_id = Column(BigInteger)
    payload = Column(Text)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    __table_args__ = (
        Index("idx_cmpaudit_event", "event_type"),
        Index("idx_cmpaudit_severity", "severity"),
        Index("idx_cmpaudit_date", "created_at"),
    )
