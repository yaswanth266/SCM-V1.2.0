from sqlalchemy import Column, BigInteger, String, Text, DateTime, Enum, ForeignKey, Numeric
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class ConsumptionEntry(Base):
    __tablename__ = "consumption_entries"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    entry_number = Column(String(50), unique=True, nullable=False)
    project_id = Column(BigInteger, ForeignKey("projects.id"))
    warehouse_id = Column(BigInteger)
    consumption_date = Column(DateTime, nullable=False)
    department = Column(String(100))
    cost_center = Column(String(100))
    consumed_by = Column(BigInteger, ForeignKey("users.id"), nullable=False)
    source = Column(Enum("web", "mobile_app", name="consumption_source_enum"), default="web")
    case_id = Column(String(100))
    patient_name = Column(String(255))
    patient_aadhaar = Column(String(20))
    # Wave 7 — Healthcare compliance: prescriber + e-signature audit
    prescriber_name = Column(String(255))
    prescriber_license = Column(String(100))
    e_signature_id = Column(BigInteger)
    status = Column(Enum("draft", "submitted", "approved", "cancelled", name="consumption_status_enum"), default="draft")
    remarks = Column(Text)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    project = relationship("Project")
    consumer = relationship("User", foreign_keys=[consumed_by])
    items = relationship("ConsumptionItem", back_populates="entry", cascade="all, delete-orphan")


class ConsumptionItem(Base):
    __tablename__ = "consumption_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    entry_id = Column(BigInteger, ForeignKey("consumption_entries.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    batch_id = Column(BigInteger)
    qty = Column(Numeric(15, 3), nullable=False)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    rate = Column(Numeric(15, 2), default=0)
    amount = Column(Numeric(15, 2), default=0)
    remarks = Column(Text)

    entry = relationship("ConsumptionEntry", back_populates="items")
    item = relationship("Item")
    uom = relationship("UOM")


# =============================================================
# Wave 5 — Consumption returns (BUG-ISS-063). Mirror of IssueReturn for
# items that were posted as consumed and then rolled back (e.g. cancelled
# procedure / mis-attribution).
# =============================================================
class ConsumptionReturn(Base):
    __tablename__ = "consumption_returns"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    return_number = Column(String(50), unique=True, nullable=False)
    entry_id = Column(BigInteger, ForeignKey("consumption_entries.id"), nullable=False)
    warehouse_id = Column(BigInteger, ForeignKey("warehouses.id"), nullable=False)
    return_date = Column(DateTime, nullable=False)
    reason = Column(Text)
    status = Column(String(30), nullable=False, default="draft")
    created_by = Column(BigInteger, ForeignKey("users.id"))
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    entry = relationship("ConsumptionEntry")
    warehouse = relationship("Warehouse")
    items = relationship("ConsumptionReturnItem", back_populates="consumption_return", cascade="all, delete-orphan")


class ConsumptionReturnItem(Base):
    __tablename__ = "consumption_return_items"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    return_id = Column(BigInteger, ForeignKey("consumption_returns.id", ondelete="CASCADE"), nullable=False)
    consumption_item_id = Column(BigInteger)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    batch_id = Column(BigInteger)
    qty = Column(Numeric(15, 3), nullable=False)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=False)
    rate = Column(Numeric(15, 2), default=0)
    reason = Column(Text)

    consumption_return = relationship("ConsumptionReturn", back_populates="items")
    item = relationship("Item")
    uom = relationship("UOM")
