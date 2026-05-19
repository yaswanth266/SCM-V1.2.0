from sqlalchemy import Column, BigInteger, String, Text, Boolean, DateTime, Enum, ForeignKey, Integer, Index, JSON, Numeric
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class Notification(Base):
    __tablename__ = "notifications"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id = Column(BigInteger, ForeignKey("users.id"), nullable=False)
    title = Column(String(255), nullable=False)
    message = Column(Text)
    type = Column(Enum("info", "warning", "error", "success", "approval", name="notification_type_enum"), default="info")
    module = Column(String(100))
    reference_type = Column(String(100))
    reference_id = Column(BigInteger)
    is_read = Column(Boolean, default=False)
    read_at = Column(DateTime)
    send_email = Column(Boolean, default=False)
    email_sent = Column(Boolean, default=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    user = relationship("User")

    __table_args__ = (
        Index("idx_notif_user", "user_id", "is_read"),
    )


class ActivityLog(Base):
    __tablename__ = "activity_logs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id = Column(BigInteger, ForeignKey("users.id"))
    organization_id = Column(BigInteger, ForeignKey("organizations.id"))
    module = Column(String(100), nullable=False)
    action = Column(String(50), nullable=False)
    entity_type = Column(String(100))
    entity_id = Column(BigInteger)
    description = Column(Text)
    old_values = Column(JSON)
    new_values = Column(JSON)
    ip_address = Column(String(45))
    user_agent = Column(String(500))
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    user = relationship("User")

    __table_args__ = (
        Index("idx_al_user", "user_id"),
        Index("idx_al_entity", "entity_type", "entity_id"),
        Index("idx_al_created", "created_at"),
    )


class EmailLog(Base):
    __tablename__ = "email_logs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    to_email = Column(String(255), nullable=False)
    cc_email = Column(String(500))
    subject = Column(String(500), nullable=False)
    body = Column(Text)
    module = Column(String(100))
    reference_type = Column(String(100))
    reference_id = Column(BigInteger)
    status = Column(Enum("queued", "sent", "failed", name="email_status_enum"), default="queued")
    sent_at = Column(DateTime)
    error_message = Column(Text)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class FileAttachment(Base):
    __tablename__ = "file_attachments"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    entity_type = Column(String(100), nullable=False)
    entity_id = Column(BigInteger, nullable=False)
    file_name = Column(String(255), nullable=False)
    file_path = Column(String(500), nullable=False)
    file_type = Column(String(50))
    file_size = Column(BigInteger, default=0)
    uploaded_by = Column(BigInteger, ForeignKey("users.id"))
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    # Wave 8 — versioning fields. document_group_id groups versions of the
    # "same" document; is_current_version=True marks the active version.
    document_group_id = Column(BigInteger)
    version_number = Column(Integer, default=1, nullable=False)
    sha256 = Column(String(64))
    change_note = Column(Text)
    is_current_version = Column(Boolean, default=True, nullable=False)
    category = Column(String(80))

    uploader = relationship("User")

    __table_args__ = (
        Index("idx_fa_entity", "entity_type", "entity_id"),
        Index("idx_fa_group", "document_group_id"),
        Index("idx_fa_sha256", "sha256"),
    )


class SystemSetting(Base):
    __tablename__ = "system_settings"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    setting_key = Column(String(100), unique=True, nullable=False)
    setting_value = Column(Text)
    setting_type = Column(Enum("string", "number", "boolean", "json", name="setting_type_enum"), default="string")
    # Wave 5 — org scope so each tenant has its own settings.
    organization_id = Column(BigInteger, ForeignKey("organizations.id"))
    module = Column(String(100))
    description = Column(Text)
    updated_by = Column(BigInteger)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class NumberSeries(Base):
    __tablename__ = "number_series"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    prefix = Column(String(20), nullable=False)
    module = Column(String(100), nullable=False)
    document_type = Column(String(100), nullable=False)
    current_number = Column(BigInteger, default=0)
    pad_length = Column(Integer, default=5)
    fiscal_year = Column(String(10))
    # Wave 11 — fiscal-year aware numbering (BHSPL/26-27/PO/00001)
    org_prefix = Column(String(20), default="BHSPL")
    format_template = Column(String(255))  # Optional override; default = "{org}/{fy}/{type}/{seq}"
    # Wave 5 — org scope + opaque code for FE selectors (BUG-PRO-133).
    organization_id = Column(BigInteger, ForeignKey("organizations.id"))
    code = Column(String(80))

    __table_args__ = (
        # UNIQUE(module, document_type, fiscal_year): there must be exactly
        # one active counter per (module, doc_type, fiscal_year) tuple.
        Index("uq_ns_module_doc_fy", "module", "document_type", "fiscal_year", unique=True),
    )
