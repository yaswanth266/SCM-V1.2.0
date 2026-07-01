from sqlalchemy import Column, BigInteger, String, Boolean, DateTime
from datetime import datetime, timezone
from app.database import Base


class Vehicle(Base):
    __tablename__ = "vehicles"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    vehicle_code = Column(String(50), nullable=False, unique=True)
    vehicle_number = Column(String(50), nullable=False, unique=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), nullable=False)
