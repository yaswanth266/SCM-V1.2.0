from pydantic import BaseModel, EmailStr, field_validator
from typing import List, Optional
from datetime import datetime
import re


class LoginRequest(BaseModel):
    username: str
    password: str

    @field_validator("username")
    @classmethod
    def validate_username_length(cls, v):
        # BUG-AUTH-012 fix: reject whitespace-only / empty usernames before
        # the constant-time bcrypt path runs — otherwise the audit log fills
        # with spam from clients sending `username=" "`.
        if not v or not v.strip():
            raise ValueError("Username is required")
        if len(v) > 100:
            raise ValueError("Username too long")
        return v

    @field_validator("password")
    @classmethod
    def validate_password_length(cls, v):
        if not v:
            raise ValueError("Password is required")
        if len(v) > 128:
            raise ValueError("Password too long")
        return v


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    user: "UserResponse"


class RefreshTokenRequest(BaseModel):
    refresh_token: str


class UserCreate(BaseModel):
    organization_id: Optional[int] = None
    employee_id: Optional[int] = None
    username: str
    email: EmailStr
    password: str
    first_name: str
    last_name: Optional[str] = None

    @field_validator("username")
    @classmethod
    def validate_username_nonempty(cls, v):
        if not v or not v.strip():
            raise ValueError("Username is required")
        v = v.strip()
        if len(v) < 3:
            raise ValueError("Username must be at least 3 characters")
        if len(v) > 100:
            raise ValueError("Username must be at most 100 characters")
        import re as _re
        if not _re.match(r"^[a-zA-Z0-9_]+$", v):
            raise ValueError("Username can only contain letters, numbers, and underscores")
        return v

    @field_validator("first_name")
    @classmethod
    def validate_first_name(cls, v):
        if not v or not v.strip():
            raise ValueError("First name is required")
        return v.strip()[:100]
    employee_code: Optional[str] = None
    phone: Optional[str] = None
    user_type: str = "core"
    department: Optional[str] = None
    designation: Optional[str] = None
    role_ids: Optional[List[int]] = []
    warehouse_ids: Optional[List[int]] = []
    project_ids: Optional[List[int]] = []

    @field_validator("password")
    @classmethod
    def validate_password_strength(cls, v):
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        if not re.search(r"[A-Z]", v):
            raise ValueError("Password must contain at least one uppercase letter")
        if not re.search(r"[a-z]", v):
            raise ValueError("Password must contain at least one lowercase letter")
        if not re.search(r"\d", v):
            raise ValueError("Password must contain at least one digit")
        if not re.search(r"[!@#$%^&*(),.?\":{}|<>]", v):
            raise ValueError("Password must contain at least one special character")
        return v


class UserUpdate(BaseModel):
    employee_id: Optional[int] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    department: Optional[str] = None
    designation: Optional[str] = None
    is_active: Optional[bool] = None
    user_type: Optional[str] = None
    employee_code: Optional[str] = None
    role_ids: Optional[List[int]] = None
    warehouse_ids: Optional[List[int]] = None
    project_ids: Optional[List[int]] = None


class ResetPassword(BaseModel):
    new_password: str

    # BUG-AUTH-042 / BUG-AUTH-073 fix: align admin reset-password complexity
    # with self-register so admins can't set weak 6-char passwords on behalf
    # of users.
    @field_validator("new_password")
    @classmethod
    def validate_password_strength(cls, v):
        if not v or len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        if len(v) > 128:
            raise ValueError("Password too long")
        if not re.search(r"[A-Z]", v):
            raise ValueError("Password must contain at least one uppercase letter")
        if not re.search(r"[a-z]", v):
            raise ValueError("Password must contain at least one lowercase letter")
        if not re.search(r"\d", v):
            raise ValueError("Password must contain at least one digit")
        if not re.search(r"[!@#$%^&*(),.?\":{}|<>]", v):
            raise ValueError("Password must contain at least one special character")
        return v


class RoleInfo(BaseModel):
    id: int
    code: str
    name: str


class UserResponse(BaseModel):
    id: int
    organization_id: int
    employee_id: Optional[int] = None
    employee_code: Optional[str] = None
    username: str
    email: str
    first_name: str
    last_name: Optional[str] = None
    full_name: Optional[str] = None
    phone: Optional[str] = None
    user_type: str
    # Top-level role string for clients that consume a single role (mobile app
    # reads `user.role` directly). Populated from active_role_id if set, else
    # the first assigned role's code, else falls back to user_type.
    role: Optional[str] = None
    # Primary warehouse for clients that scope queries to a single warehouse
    # (mobile field staff must only see their own warehouse). Populated from
    # the user's first user_warehouses row.
    warehouse_id: Optional[int] = None
    warehouse_name: Optional[str] = None
    department: Optional[str] = None
    designation: Optional[str] = None
    is_active: bool
    status: str = "active"
    last_login: Optional[datetime] = None
    created_at: Optional[datetime] = None
    roles: List[RoleInfo] = []
    permissions: List[str] = []

    model_config = {"from_attributes": True}


class ChangePassword(BaseModel):
    current_password: str
    new_password: str

    # BUG-AUTH-044 fix: previously this schema had NO validators so
    # /auth/change-password accepted a 1-character password. Mirror the
    # complexity rules already enforced on UserCreate.
    @field_validator("new_password")
    @classmethod
    def validate_new_password_strength(cls, v):
        if not v or len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        if len(v) > 128:
            raise ValueError("Password too long")
        if not re.search(r"[A-Z]", v):
            raise ValueError("Password must contain at least one uppercase letter")
        if not re.search(r"[a-z]", v):
            raise ValueError("Password must contain at least one lowercase letter")
        if not re.search(r"\d", v):
            raise ValueError("Password must contain at least one digit")
        if not re.search(r"[!@#$%^&*(),.?\":{}|<>]", v):
            raise ValueError("Password must contain at least one special character")
        return v


class AssignRoles(BaseModel):
    role_ids: List[int]


class AssignWarehouses(BaseModel):
    warehouse_ids: List[int]


class AssignProjects(BaseModel):
    project_ids: List[int]


TokenResponse.model_rebuild()
