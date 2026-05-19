from sqlalchemy import (
    Column, BigInteger, String, Text, Boolean, DateTime, Date,
    Enum, ForeignKey, Numeric, Integer, Index, UniqueConstraint
)
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class BatchRecall(Base):
    __tablename__ = "batch_recalls"
    __table_args__ = (
        Index("ix_recall_item", "item_id"),
        Index("ix_recall_batch", "batch_id"),
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    recall_number = Column(String(50), unique=True, nullable=False)
    batch_id = Column(BigInteger, ForeignKey("batches.id"), nullable=True)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    reason = Column(Text, nullable=False)
    severity = Column(Enum("critical", "major", "minor", name="recall_severity"), nullable=False)
    status = Column(
        Enum("initiated", "in_progress", "completed", "cancelled", name="recall_status"),
        nullable=False, default="initiated"
    )
    initiated_by = Column(BigInteger, nullable=False)
    initiated_at = Column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    affected_qty = Column(Numeric(15, 3), nullable=False)
    recovered_qty = Column(Numeric(15, 3), default=0)
    notes = Column(Text)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    traces = relationship("BatchRecallTrace", back_populates="recall", cascade="all, delete-orphan")


class BatchRecallTrace(Base):
    __tablename__ = "batch_recall_traces"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    recall_id = Column(BigInteger, ForeignKey("batch_recalls.id"), nullable=False)
    consumption_entry_id = Column(BigInteger, nullable=True)
    patient_name = Column(String(255), nullable=True)
    patient_aadhaar = Column(String(20), nullable=True)
    department = Column(String(100), nullable=False)
    warehouse_id = Column(BigInteger, nullable=True)
    qty_consumed = Column(Numeric(15, 3), nullable=False)
    consumption_date = Column(DateTime, nullable=True)
    trace_status = Column(
        Enum("identified", "notified", "recovered", "written_off", name="trace_status"),
        nullable=False, default="identified"
    )
    action_taken = Column(Text, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    recall = relationship("BatchRecall", back_populates="traces")


class RateContract(Base):
    __tablename__ = "rate_contracts"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    contract_number = Column(String(50), unique=True, nullable=False)
    vendor_id = Column(BigInteger, ForeignKey("vendors.id"), nullable=False)
    start_date = Column(Date, nullable=False)
    end_date = Column(Date, nullable=False)
    status = Column(
        Enum("draft", "active", "expired", "cancelled", name="rate_contract_status"),
        nullable=False, default="draft"
    )
    min_order_value = Column(Numeric(15, 2), default=0)
    payment_terms_days = Column(Integer, default=30)
    remarks = Column(Text, nullable=True)
    created_by = Column(BigInteger, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    items = relationship("RateContractItem", back_populates="contract", cascade="all, delete-orphan")


class RateContractItem(Base):
    __tablename__ = "rate_contract_items"
    __table_args__ = (Index("ix_rci_item", "item_id"),)

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    contract_id = Column(BigInteger, ForeignKey("rate_contracts.id"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    base_rate = Column(Numeric(15, 2), nullable=False)
    min_qty = Column(Numeric(15, 3), default=0)
    max_qty = Column(Numeric(15, 3), default=0)
    discount_pct = Column(Numeric(5, 2), default=0)
    effective_rate = Column(Numeric(15, 2), nullable=False)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=True)

    contract = relationship("RateContract", back_populates="items")


class VendorScorecard(Base):
    __tablename__ = "vendor_scorecards"
    __table_args__ = (
        UniqueConstraint("vendor_id", "period_start", "period_end", name="uq_vendor_period"),
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    vendor_id = Column(BigInteger, ForeignKey("vendors.id"), nullable=False)
    period_start = Column(Date, nullable=False)
    period_end = Column(Date, nullable=False)
    total_orders = Column(Integer, default=0)
    on_time_deliveries = Column(Integer, default=0)
    late_deliveries = Column(Integer, default=0)
    total_qty_ordered = Column(Numeric(15, 3), default=0)
    total_qty_rejected = Column(Numeric(15, 3), default=0)
    avg_lead_time_days = Column(Numeric(5, 1), default=0)
    quality_score = Column(Numeric(5, 2), default=0)
    delivery_score = Column(Numeric(5, 2), default=0)
    price_score = Column(Numeric(5, 2), default=0)
    overall_score = Column(Numeric(5, 2), default=0)
    grade = Column(Enum("A", "B", "C", "D", "F", name="vendor_grade"), nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class ItemKit(Base):
    __tablename__ = "item_kits"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    kit_code = Column(String(50), unique=True, nullable=False)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    kit_type = Column(
        Enum("surgical", "procedure", "department", "custom", name="kit_type"),
        nullable=False
    )
    department = Column(String(100), nullable=True)
    is_active = Column(Boolean, default=True)
    created_by = Column(BigInteger, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    components = relationship("ItemKitComponent", back_populates="kit", cascade="all, delete-orphan")


class ItemKitComponent(Base):
    __tablename__ = "item_kit_components"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    kit_id = Column(BigInteger, ForeignKey("item_kits.id"), nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    qty = Column(Numeric(15, 3), nullable=False)
    uom_id = Column(BigInteger, ForeignKey("uom.id"), nullable=True)
    is_optional = Column(Boolean, default=False)
    remarks = Column(String(255), nullable=True)

    kit = relationship("ItemKit", back_populates="components")


class DepartmentBudget(Base):
    __tablename__ = "department_budgets"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    department = Column(String(100), nullable=False)
    project_id = Column(BigInteger, ForeignKey("projects.id"), nullable=True)
    fiscal_year = Column(String(10), nullable=False)
    budget_amount = Column(Numeric(15, 2), nullable=False)
    consumed_amount = Column(Numeric(15, 2), default=0)
    remaining_amount = Column(Numeric(15, 2), default=0)
    status = Column(
        Enum("active", "exhausted", "frozen", name="budget_status"),
        nullable=False, default="active"
    )
    created_by = Column(BigInteger, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class LandedCost(Base):
    __tablename__ = "landed_costs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    grn_id = Column(BigInteger, ForeignKey("goods_receipt_notes.id"), nullable=False)
    cost_type = Column(
        Enum("freight", "insurance", "customs", "handling", "other", name="landed_cost_type"),
        nullable=False
    )
    description = Column(String(255), nullable=True)
    amount = Column(Numeric(15, 2), nullable=False)
    allocation_method = Column(
        Enum("by_value", "by_qty", "by_weight", "equal", name="landed_cost_allocation_method"),
        nullable=False
    )
    created_by = Column(BigInteger, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    allocations = relationship(
        "LandedCostAllocation", back_populates="landed_cost", cascade="all, delete-orphan"
    )


class LandedCostAllocation(Base):
    __tablename__ = "landed_cost_allocations"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    landed_cost_id = Column(BigInteger, ForeignKey("landed_costs.id"), nullable=False)
    grn_item_id = Column(BigInteger, nullable=False)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    allocated_amount = Column(Numeric(15, 2), nullable=False)
    original_rate = Column(Numeric(15, 2), nullable=False)
    adjusted_rate = Column(Numeric(15, 2), nullable=False)

    landed_cost = relationship("LandedCost", back_populates="allocations")


class DemandForecast(Base):
    __tablename__ = "demand_forecasts"
    __table_args__ = (Index("ix_forecast_item", "item_id"),)

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    item_id = Column(BigInteger, ForeignKey("items.id"), nullable=False)
    warehouse_id = Column(BigInteger, nullable=True)
    forecast_date = Column(Date, nullable=False)
    forecast_qty = Column(Numeric(15, 3), nullable=False)
    actual_qty = Column(Numeric(15, 3), nullable=True)
    method = Column(
        Enum("moving_average", "weighted_average", "seasonal", name="forecast_method"),
        nullable=False
    )
    confidence_pct = Column(Numeric(5, 2), default=0)
    period = Column(
        Enum("daily", "weekly", "monthly", name="forecast_period"),
        nullable=False
    )
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class CarrierTracking(Base):
    __tablename__ = "carrier_tracking"
    __table_args__ = (Index("ix_carrier_tracking_num", "tracking_number"),)

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    transport_order_id = Column(BigInteger, nullable=True)
    dispatch_id = Column(BigInteger, nullable=True)
    carrier_name = Column(String(255), nullable=False)
    tracking_number = Column(String(255), nullable=False)
    carrier_url = Column(String(500), nullable=True)
    current_status = Column(
        Enum(
            "booked", "picked_up", "in_transit", "out_for_delivery",
            "delivered", "exception",
            name="carrier_tracking_status"
        ),
        nullable=False, default="booked"
    )
    estimated_delivery = Column(DateTime, nullable=True)
    actual_delivery = Column(DateTime, nullable=True)
    last_location = Column(String(255), nullable=True)
    last_updated = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))
