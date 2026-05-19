"""Business Rules Engine models (Wave 5 of the configurable workflow stack).

Two tables:
  - BusinessRule: declarative rule (trigger + condition + action)
  - BusinessRuleExecution: per-fire audit log

The actual evaluator lives in `app/services/rules_engine.py`.
"""
from sqlalchemy import (
    Column, BigInteger, String, Text, Boolean, DateTime, Integer, ForeignKey, Index,
)
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class BusinessRule(Base):
    __tablename__ = "business_rules"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    description = Column(Text)
    # Event names are dotted strings, e.g. "stock.balance_changed",
    # "indent.approved", "po.received". Engine fires when matching event
    # is published from the relevant service.
    trigger_event = Column(String(100), nullable=False)
    # JSON predicate. Supports {and|or|eq|lte|gte|in|lte_field|gte_field}.
    condition_json = Column(Text, nullable=False)
    # Action handler name. Must match a key in ACTION_HANDLERS in
    # app/services/rules_engine.py — currently: notify | create_indent |
    # update_status. (BUG-HC-100 fix: previous comment also mentioned
    # `webhook`, which has no handler implemented; removed to avoid admins
    # configuring rules that fail at fire-time with "unknown action_type".)
    action_type = Column(String(50), nullable=False)
    # JSON config consumed by the matching handler.
    action_config = Column(Text, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    organization_id = Column(BigInteger)
    created_by = Column(BigInteger, ForeignKey("users.id"))
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    last_fired_at = Column(DateTime)
    fire_count = Column(Integer, default=0, nullable=False)

    creator = relationship("User")
    executions = relationship(
        "BusinessRuleExecution", back_populates="rule", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("ix_br_event_active", "trigger_event", "is_active"),
    )


class BusinessRuleExecution(Base):
    __tablename__ = "business_rule_executions"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    rule_id = Column(BigInteger, ForeignKey("business_rules.id", ondelete="CASCADE"), nullable=False)
    fired_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    trigger_context = Column(Text)  # JSON snapshot of context that fired the rule
    status = Column(String(20), nullable=False)  # success | skipped | failed
    result = Column(Text)  # JSON output from the action handler
    error = Column(Text)

    rule = relationship("BusinessRule", back_populates="executions")

    __table_args__ = (
        Index("ix_bre_rule_fired", "rule_id", "fired_at"),
    )
