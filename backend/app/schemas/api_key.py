from pydantic import BaseModel, Field
from typing import List, Optional
from datetime import datetime

class ApiKeyBase(BaseModel):
    name: str = Field(..., max_length=255)
    scopes: Optional[List[str]] = []
    linked_user_ids: Optional[List[int]] = []
    linked_role_ids: Optional[List[int]] = []
    expires_at: Optional[datetime] = None

class ApiKeyCreate(ApiKeyBase):
    pass

class ApiKeyResponse(ApiKeyBase):
    id: int
    name: str
    scopes: Optional[List[str]]
    linked_user_ids: Optional[List[int]]
    expires_at: Optional[datetime]
    is_active: bool
    last_used_at: Optional[datetime]
    created_at: datetime

    class Config:
        from_attributes = True

class ApiKeyReveal(ApiKeyResponse):
    raw_key: str
