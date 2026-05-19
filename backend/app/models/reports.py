"""Wave 10 — Reporting models."""
from sqlalchemy import (
    Column, BigInteger, String, Text, Boolean, DateTime, Enum, ForeignKey, Integer, JSON, Index, UniqueConstraint,
)
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class ReportDefinition(Base):
    __tablename__ = "report_definitions"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    description = Column(Text)
    source_table = Column(String(80), nullable=False)
    report_type = Column(Enum("pivot", "timeseries", "list", name="report_type_enum"), nullable=False, default="pivot")
    dimensions = Column(JSON)
    measures = Column(JSON)
    filters = Column(JSON)
    chart_type = Column(String(40))
    is_shared = Column(Boolean, default=False)
    created_by = Column(BigInteger, ForeignKey("users.id"))
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    schedules = relationship("ReportSchedule", back_populates="report", cascade="all, delete-orphan")
    creator = relationship("User", foreign_keys=[created_by])

    __table_args__ = (
        Index("idx_repdef_creator", "created_by"),
        Index("idx_repdef_shared", "is_shared"),
        UniqueConstraint("created_by", "name", name="uq_repdef_creator_name"),
    )


class ReportSchedule(Base):
    __tablename__ = "report_schedules"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    report_id = Column(BigInteger, ForeignKey("report_definitions.id", ondelete="CASCADE"), nullable=False)
    frequency = Column(Enum("daily", "weekly", "monthly", name="report_freq_enum"), nullable=False)
    hour_of_day = Column(Integer, default=9)
    day_of_week = Column(Integer)
    day_of_month = Column(Integer)
    recipient_emails = Column(Text, nullable=False)
    format = Column(Enum("csv", "pdf", "html", name="report_format_enum"), default="csv")
    is_active = Column(Boolean, default=True)
    last_run_at = Column(DateTime)
    last_run_status = Column(String(40))
    next_run_at = Column(DateTime)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    report = relationship("ReportDefinition", back_populates="schedules")

    __table_args__ = (
        Index("idx_repsched_report", "report_id"),
        Index("idx_repsched_next", "is_active", "next_run_at"),
    )
