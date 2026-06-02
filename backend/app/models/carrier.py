from sqlalchemy import Column, BigInteger, String, Boolean, DateTime, Integer, ForeignKey, Index
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class CarrierUser(Base):
    """Login account for an external transport carrier (vendor portal user).

    Kept deliberately separate from the `users` table so:
      - carriers cannot accidentally inherit employee roles / permissions
      - employee auth flows (rate limits, role guards, MFA, sidebar) stay
        unaware of carrier accounts and vice versa
      - a carrier deactivation cascades cleanly (vendor.is_active toggles)
    """
    __tablename__ = "carrier_users"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    vendor_id = Column(BigInteger, ForeignKey("vendors.id", ondelete="CASCADE"), nullable=False)
    username = Column(String(100), unique=True, nullable=False)
    email = Column(String(255), nullable=False)
    password_hash = Column(String(255), nullable=False)
    full_name = Column(String(200), nullable=True)
    phone = Column(String(20), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    must_change_password = Column(Boolean, default=True, nullable=False)
    failed_login_attempts = Column(Integer, default=0, nullable=False)
    locked_until = Column(DateTime, nullable=True)
    last_login = Column(DateTime, nullable=True)
    password_changed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc), nullable=False)
    created_by = Column(BigInteger, ForeignKey("users.id"), nullable=True)

    vendor = relationship("Vendor", lazy="joined")

    __table_args__ = (
        Index("idx_carrier_users_vendor", "vendor_id"),
        Index("idx_carrier_users_username", "username", unique=True),
    )
