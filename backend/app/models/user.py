from sqlalchemy import Column, BigInteger, String, Text, Boolean, DateTime, Enum, ForeignKey, Integer, Index, JSON
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.database import Base


class Organization(Base):
    __tablename__ = "organizations"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    code = Column(String(50), unique=True, nullable=False)
    address = Column(Text)
    phone = Column(String(20))
    email = Column(String(255))
    gst_number = Column(String(20))
    pan_number = Column(String(20))
    logo_url = Column(String(500))
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    projects = relationship("Project", back_populates="organization")
    users = relationship("User", back_populates="organization")
    warehouses = relationship("Warehouse", back_populates="organization")


class Project(Base):
    __tablename__ = "projects"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    organization_id = Column(BigInteger, ForeignKey("organizations.id"), nullable=False)
    name = Column(String(255), nullable=False)
    code = Column(String(50), unique=True, nullable=False)
    description = Column(Text)
    start_date = Column(DateTime)
    end_date = Column(DateTime)
    status = Column(Enum("active", "inactive", "completed", name="project_status"), default="active")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    organization = relationship("Organization", back_populates="projects")


class Role(Base):
    __tablename__ = "roles"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False)
    code = Column(String(50), unique=True, nullable=False)
    description = Column(Text)
    role_type = Column(Enum("core", "field", name="role_type_enum"), nullable=False, default="core")
    is_active = Column(Boolean, default=True)
    # Wave 5 — org scope so per-org roles don't bleed across tenants.
    organization_id = Column(BigInteger, ForeignKey("organizations.id"), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    permissions = relationship("RolePermission", back_populates="role")


class Permission(Base):
    __tablename__ = "permissions"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    module = Column(String(100), nullable=False)
    action = Column(String(50), nullable=False)
    resource = Column(String(100), nullable=False)
    description = Column(Text)

    roles = relationship("RolePermission", back_populates="permission")


class RolePermission(Base):
    __tablename__ = "role_permissions"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    role_id = Column(BigInteger, ForeignKey("roles.id", ondelete="CASCADE"), nullable=False)
    permission_id = Column(BigInteger, ForeignKey("permissions.id", ondelete="CASCADE"), nullable=False)

    role = relationship("Role", back_populates="permissions")
    permission = relationship("Permission", back_populates="roles")


class User(Base):
    __tablename__ = "users"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    organization_id = Column(BigInteger, ForeignKey("organizations.id"), nullable=False)
    employee_code = Column(String(50), unique=True)
    username = Column(String(100), unique=True, nullable=False)
    email = Column(String(255), unique=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    first_name = Column(String(100), nullable=False)
    last_name = Column(String(100))
    phone = Column(String(20))
    avatar_url = Column(String(500))
    user_type = Column(Enum("core", "field", "admin", "manager", "staff", "viewer", "warehouse_user", "field_staff", name="user_type_enum"), nullable=False, default="core")
    department = Column(String(100))
    designation = Column(String(100))
    is_active = Column(Boolean, default=True)
    last_login = Column(DateTime)
    password_changed_at = Column(DateTime)
    # Wave 5 — account lockout (BUG-AUTH-001) + token revocation cutover
    # (BUG-AUTH-019/029). `tokens_revoked_after` is checked in get_current_user.
    failed_login_attempts = Column(Integer, default=0, nullable=False)
    locked_until = Column(DateTime)
    tokens_revoked_after = Column(DateTime)
    # Workflow rebuild (2026-04-30) — currently-active role for users with
    # multiple role assignments; nullable so legacy single-role users are
    # unaffected.
    active_role_id = Column(BigInteger, ForeignKey("roles.id"), nullable=True)
    employee_id = Column(BigInteger, ForeignKey("employees.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    organization = relationship("Organization", back_populates="users")
    roles = relationship("UserRole", back_populates="user")
    projects = relationship("UserProject", back_populates="user")
    warehouses = relationship("UserWarehouse", back_populates="user")
    active_role = relationship("Role", foreign_keys=[active_role_id], lazy="selectin")
    employee = relationship("Employee", foreign_keys=[employee_id], lazy="selectin")


class UserRole(Base):
    __tablename__ = "user_roles"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id = Column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role_id = Column(BigInteger, ForeignKey("roles.id", ondelete="CASCADE"), nullable=False)

    user = relationship("User", back_populates="roles")
    role = relationship("Role")


class UserProject(Base):
    __tablename__ = "user_projects"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id = Column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    project_id = Column(BigInteger, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)

    user = relationship("User", back_populates="projects")
    project = relationship("Project")


class UserWarehouse(Base):
    __tablename__ = "user_warehouses"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id = Column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    warehouse_id = Column(BigInteger, nullable=False)

    user = relationship("User", back_populates="warehouses")


# =============================================================
# Wave 5 — token blocklist + password history.
# =============================================================
class TokenBlocklist(Base):
    """Revoked JWT access / refresh tokens.

    Two indexing strategies coexist: a token-hash unique index (so we can
    revoke a token even if it has no jti) and an optional jti index for
    forward-compatibility with ``jti``-stamped tokens (BUG-AUTH-022 follow-up).
    """
    __tablename__ = "token_blocklist"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    jti = Column(String(64), nullable=True)
    token_hash = Column(String(128), nullable=False)
    user_id = Column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"))
    token_type = Column(String(20), nullable=False, default="access")
    revoked_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    expires_at = Column(DateTime)
    reason = Column(String(100))

    user = relationship("User")

    __table_args__ = (
        Index("idx_tb_token_hash", "token_hash", unique=True),
        Index("idx_tb_user", "user_id"),
        Index("idx_tb_jti", "jti"),
    )


class PasswordHistory(Base):
    """Past password hashes for a user, to enforce no-reuse policy on
    change_password (BUG-AUTH-046)."""
    __tablename__ = "password_history"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id = Column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    password_hash = Column(String(255), nullable=False)
    changed_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    user = relationship("User")

    __table_args__ = (
        Index("idx_ph_user", "user_id", "changed_at"),
    )

class ApiKey(Base):
    __tablename__ = "api_keys"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id = Column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    key_hash = Column(String(128), unique=True, nullable=False)
    scopes = Column(Text, nullable=True)  # JSON string array of scopes
    linked_user_ids = Column(JSON, nullable=True)  # JSON array of user IDs
    expires_at = Column(DateTime, nullable=True)
    is_active = Column(Boolean, default=True)
    last_used_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    user = relationship("User")

    __table_args__ = (
        Index("idx_api_key_user", "user_id"),
        Index("idx_api_key_hash", "key_hash"),
    )
