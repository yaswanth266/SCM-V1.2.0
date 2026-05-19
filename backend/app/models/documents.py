"""Wave 8 document management models.

DocumentGroup is the logical "document" — its current_version_id points to
the active FileAttachment row. The FileAttachment chain (document_group_id +
version_number) holds every version uploaded.
"""
from sqlalchemy import (
    Column, BigInteger, String, Text, Boolean, DateTime, Enum, ForeignKey, Integer, JSON, Index, UniqueConstraint,
)
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class DocumentGroup(Base):
    __tablename__ = "document_groups"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    description = Column(Text)
    category = Column(String(80))
    source_type = Column(String(80))
    source_id = Column(BigInteger)
    current_version_id = Column(BigInteger)
    current_version_number = Column(Integer, default=0, nullable=False)
    is_archived = Column(Boolean, default=False)
    created_by = Column(BigInteger, ForeignKey("users.id"))
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    creator = relationship("User", foreign_keys=[created_by])

    __table_args__ = (
        Index("idx_docgroup_source", "source_type", "source_id"),
        Index("idx_docgroup_category", "category"),
    )


class DocumentTemplate(Base):
    __tablename__ = "document_templates"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    description = Column(Text)
    template_type = Column(Enum("email", "pdf", "text", "html", name="doc_template_type_enum"), nullable=False)
    module = Column(String(50))
    subject_template = Column(String(500))
    body_template = Column(Text, nullable=False)
    placeholders = Column(JSON)
    is_active = Column(Boolean, default=True)
    created_by = Column(BigInteger, ForeignKey("users.id"))
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    creator = relationship("User", foreign_keys=[created_by])

    __table_args__ = (
        Index("idx_doctpl_module", "module", "is_active"),
        UniqueConstraint("name", name="uq_doctpl_name"),
    )


class StateTransitionRule(Base):
    """Rule: when {module/source_type} transitions from from_state → to_state,
    optionally require e-signature and/or an attachment of `attachment_category`.

    `from_state` may be NULL to mean 'any state'. Used by the gate in
    document_service.assert_transition_compliance().
    """
    __tablename__ = "state_transition_rules"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    module = Column(String(50), nullable=False)
    source_type = Column(String(50), nullable=False)
    from_state = Column(String(50))
    to_state = Column(String(50), nullable=False)
    requires_e_sign = Column(Boolean, default=False)
    requires_attachment = Column(Boolean, default=False)
    attachment_category = Column(String(80))
    description = Column(Text)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        Index("idx_str_module_to", "module", "source_type", "to_state"),
    )
