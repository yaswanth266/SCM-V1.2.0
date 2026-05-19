from pydantic import BaseModel
from typing import Any, Generic, List, Optional, TypeVar
from datetime import datetime

T = TypeVar("T")


class APIResponse(BaseModel):
    success: bool = True
    message: str = "Success"
    data: Any = None


class PaginatedResponse(BaseModel, Generic[T]):
    items: List[T]
    total: int
    page: int
    page_size: int
    total_pages: int


class FilterParams(BaseModel):
    page: int = 1
    page_size: int = 20
    search: Optional[str] = None
    sort_by: Optional[str] = None
    sort_order: Optional[str] = "asc"
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None
    status: Optional[str] = None
    warehouse_id: Optional[int] = None
    project_id: Optional[int] = None


class IDResponse(BaseModel):
    id: int
    message: str = "Created successfully"
