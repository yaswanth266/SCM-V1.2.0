from sqlalchemy import Column, BigInteger, String, Text, Boolean, DateTime, Enum, ForeignKey, Numeric, Integer, Index
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class ApprovalWorkflow(Base):
    __tablename__ = "approval_workflows"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    module = Column(String(100), nullable=False)
    document_type = Column(String(100), nullable=False)
    project_id = Column(BigInteger, ForeignKey("projects.id"))
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    project = relationship("Project")
    levels = relationship("ApprovalLevel", back_populates="workflow", cascade="all, delete-orphan")


class ApprovalLevel(Base):
    __tablename__ = "approval_levels"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    workflow_id = Column(BigInteger, ForeignKey("approval_workflows.id", ondelete="CASCADE"), nullable=False)
    level = Column(Integer, nullable=False)
    approver_role_id = Column(BigInteger, ForeignKey("roles.id"))
    approver_user_id = Column(BigInteger, ForeignKey("users.id"))
    min_amount = Column(Numeric(15, 2), default=0)
    max_amount = Column(Numeric(15, 2), default=999999999)
    auto_approve_after_days = Column(Integer, default=0)
    send_email = Column(Boolean, default=True)
    send_notification = Column(Boolean, default=True)
    # SLA escalation (Wave 2). 0 = no SLA. When set, the breach scanner
    # adds the escalation_user_id as an additional eligible approver.
    escalation_user_id = Column(BigInteger, ForeignKey("users.id"))
    escalation_after_hours = Column(Integer, default=0, nullable=False)
    # Conditional routing (Wave 3). NULL = no constraint on that dimension.
    # All conditions are AND-ed; level is "applicable" only if every non-null
    # constraint matches the submission context.
    department = Column(String(100))
    category = Column(String(100))
    request_type = Column(String(50))
    condition_json = Column(Text)  # extensible JSON rules (eq/in/range)
    # Parallel approvers (Wave 4). When True, ALL eligible approvers at this
    # level must approve before the workflow advances. Default False keeps
    # the legacy "first approver wins" behavior.
    requires_all = Column(Boolean, default=False, nullable=False)

    workflow = relationship("ApprovalWorkflow", back_populates="levels")
    approver_role = relationship("Role")
    approver_user = relationship("User", foreign_keys=[approver_user_id])
    escalation_user = relationship("User", foreign_keys=[escalation_user_id])


class ApprovalRequest(Base):
    __tablename__ = "approval_requests"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    workflow_id = Column(BigInteger, ForeignKey("approval_workflows.id"), nullable=False)
    document_type = Column(String(100), nullable=False)
    document_id = Column(BigInteger, nullable=False)
    document_number = Column(String(100))
    current_level = Column(Integer, default=1)
    total_levels = Column(Integer, default=1)
    status = Column(Enum("pending", "approved", "rejected", "on_hold", "cancelled", name="ar_status_enum"), default="pending")
    requested_by = Column(BigInteger, ForeignKey("users.id"), nullable=False)
    requested_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    completed_at = Column(DateTime)
    # SLA escalation runtime fields (Wave 2). When the breach scanner picks
    # up a request past its level's escalation_after_hours, it stamps these
    # so the UI can show an "Escalated" badge and can_user_approve() lets
    # the escalation target act on it.
    escalated_to_user_id = Column(BigInteger, ForeignKey("users.id"))
    escalated_at = Column(DateTime)
    escalation_count = Column(Integer, default=0, nullable=False)
    # Wave 5 — persisted submission context for re-evaluation of conditional
    # routing (BUG-APR-008/009). Without these, _next_applicable_level can't
    # re-test conditions (it would have to re-fetch the source document).
    amount = Column(Numeric(15, 2))
    department = Column(String(100))
    category = Column(String(100))
    request_type = Column(String(50))
    extra_json = Column(Text)  # arbitrary JSON-encoded context for rules

    workflow = relationship("ApprovalWorkflow")
    requester = relationship("User", foreign_keys=[requested_by])
    escalated_to = relationship("User", foreign_keys=[escalated_to_user_id])
    history = relationship("ApprovalHistory", back_populates="request", cascade="all, delete-orphan")

    __table_args__ = (
        Index("idx_ar_doc", "document_type", "document_id"),
    )


class ApprovalHistory(Base):
    __tablename__ = "approval_history"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    request_id = Column(BigInteger, ForeignKey("approval_requests.id", ondelete="CASCADE"), nullable=False)
    level = Column(Integer, nullable=False)
    action = Column(Enum("approved", "rejected", "on_hold", "escalated", "returned", name="ah_action_enum"), nullable=False)
    action_by = Column(BigInteger, ForeignKey("users.id"), nullable=False)
    action_date = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    comments = Column(Text)

    request = relationship("ApprovalRequest", back_populates="history")
    actor = relationship("User")


class ApprovalDelegation(Base):
    """A user delegating their incoming approvals to a colleague for a date
    window. `scope_module` (optional) restricts the delegation to a single
    module — null = applies to every module the delegator is in approval
    chains for. Multiple overlapping delegations are allowed; the resolver
    picks the most recently-created active one whose scope matches.
    """
    __tablename__ = "approval_delegations"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    delegator_id = Column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    delegatee_id = Column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    valid_from = Column(DateTime, nullable=False)
    valid_to = Column(DateTime, nullable=False)
    scope_module = Column(String(100))  # null = all modules
    # Wave 5 — per-document-type narrowing (BUG-APR-031). Null = applies to
    # every document_type within scope_module.
    scope_document_type = Column(String(100))
    reason = Column(Text)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    revoked_at = Column(DateTime)

    delegator = relationship("User", foreign_keys=[delegator_id])
    delegatee = relationship("User", foreign_keys=[delegatee_id])
