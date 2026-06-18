from sqlalchemy import Column, BigInteger, String, Text, Boolean, DateTime, Date, ForeignKey, Integer, JSON
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class UserGroup(Base):
    __tablename__ = "user_groups"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(255), nullable=False)
    description = Column(Text)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class UserGroupMember(Base):
    __tablename__ = "user_group_members"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    group_id = Column(BigInteger, ForeignKey("user_groups.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    added_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class UserGroupPermission(Base):
    __tablename__ = "user_group_permissions"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    group_id = Column(BigInteger, ForeignKey("user_groups.id", ondelete="CASCADE"), nullable=False)
    entity_type = Column(String(50), nullable=False)
    entity_id = Column(BigInteger, nullable=True)
    action = Column(String(50), default="view")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class UserItemPermission(Base):
    __tablename__ = "user_item_permissions"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id = Column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    entity_type = Column(String(50), nullable=False)
    entity_id = Column(BigInteger, nullable=True)
    action = Column(String(50), default="view", nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class Office(Base):
    __tablename__ = "offices"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    name = Column(String(255), unique=True, nullable=False)
    level = Column(String(50))
    country = Column(String(100))
    state = Column(String(100))
    district = Column(String(100))
    mandal = Column(String(100))
    cluster = Column(String(100))
    cluster_type = Column(String(50))
    specific_location = Column(String(255))
    address = Column(Text)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    positions = relationship("Position", back_populates="office")


class Position(Base):
    __tablename__ = "positions"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    code = Column(String(100), unique=True, nullable=False)
    role_name = Column(String(100))
    role_id = Column(BigInteger, ForeignKey("roles.id", ondelete="SET NULL"), nullable=True)
    level_name = Column(String(50))
    level_rank = Column(Integer)
    department = Column(String(100))
    section = Column(String(100))
    # Wave 11C — additional fields from HRMS API
    job_name = Column(String(100))
    job_family_name = Column(String(100))
    job_family_id = Column(BigInteger)
    role_type_id = Column(BigInteger)
    status = Column(String(50), default="active")
    start_date = Column(DateTime)
    project_id = Column(BigInteger, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    office_id = Column(BigInteger, ForeignKey("offices.id", ondelete="SET NULL"), nullable=True)
    parent_position_id = Column(BigInteger, ForeignKey("positions.id", ondelete="SET NULL"), nullable=True)
    employee_id = Column(BigInteger, ForeignKey("employees.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    project = relationship("Project")
    role = relationship("Role")
    office = relationship("Office", back_populates="positions")
    parent_position = relationship("Position", remote_side=[id])
    employees = relationship("Employee", back_populates="position", foreign_keys="[Employee.position_id]")
    employee = relationship("Employee", back_populates="positions", foreign_keys=[employee_id])


class Employee(Base):
    __tablename__ = "employees"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    employee_code = Column(String(50), unique=True, nullable=False)
    name = Column(String(255), nullable=False)
    photo = Column(String(255))
    status = Column(String(20), default="Active")
    dob = Column(Date)
    gender = Column(String(20))
    pan_number = Column(String(10))
    aadhaar_number = Column(String(12))
    email = Column(String(100))
    phone = Column(String(15))
    # Wave 11C — additional fields from HRMS API
    hire_date = Column(Date)
    bank_details = Column(JSON)
    position_id = Column(BigInteger, ForeignKey("positions.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    position = relationship("Position", back_populates="employees", foreign_keys=[position_id])
    positions = relationship("Position", back_populates="employee", foreign_keys="[Position.employee_id]")
