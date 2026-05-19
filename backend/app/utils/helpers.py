import math
import os
import uuid
from typing import Any, Dict, List, Optional, Type, TypeVar
from datetime import datetime
from decimal import Decimal
from fastapi import UploadFile
from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from app.config import settings

T = TypeVar("T")


def paginate_params(page: int = 1, page_size: int = 20):
    """Calculate offset and limit for pagination."""
    page = max(1, page)
    page_size = min(max(1, page_size), 100)
    offset = (page - 1) * page_size
    return offset, page_size


def build_paginated_response(items: list, total: int, page: int, page_size: int) -> dict:
    """Build a paginated response dict."""
    total_pages = math.ceil(total / page_size) if page_size > 0 else 0
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
    }


async def save_upload_file(upload_file: UploadFile, sub_dir: str = "general") -> str:
    """Save an uploaded file and return the file path. Validates type and size."""
    import aiofiles

    # Validate file extension
    ext = os.path.splitext(upload_file.filename)[1].lower() if upload_file.filename else ""
    if ext not in settings.allowed_extensions_list:
        raise ValueError(f"File type '{ext}' not allowed. Allowed: {settings.ALLOWED_UPLOAD_EXTENSIONS}")

    # Read and validate size
    content = await upload_file.read()
    if len(content) > settings.MAX_UPLOAD_SIZE:
        raise ValueError(f"File too large. Maximum size: {settings.MAX_UPLOAD_SIZE // 1048576}MB")

    upload_dir = os.path.join(settings.UPLOAD_DIR, sub_dir)
    os.makedirs(upload_dir, exist_ok=True)

    file_name = f"{uuid.uuid4().hex}{ext}"
    file_path = os.path.join(upload_dir, file_name)

    async with aiofiles.open(file_path, "wb") as f:
        await f.write(content)

    return file_path


def apply_search_filter(query, model, search: Optional[str], search_fields: list):
    """Apply search filter across multiple fields."""
    if not search:
        return query
    search_conditions = []
    for field_name in search_fields:
        field = getattr(model, field_name, None)
        if field is not None:
            search_conditions.append(field.ilike(f"%{search}%"))
    if search_conditions:
        query = query.where(or_(*search_conditions))
    return query


def apply_sort(query, model, sort_by: Optional[str], sort_order: str = "asc"):
    """Apply sorting to a query."""
    if not sort_by:
        return query
    field = getattr(model, sort_by, None)
    if field is None:
        return query
    if sort_order.lower() == "desc":
        return query.order_by(field.desc())
    return query.order_by(field.asc())


def calculate_tax_amount(
    amount: Decimal,
    cgst_rate: Decimal = Decimal("0"),
    sgst_rate: Decimal = Decimal("0"),
    igst_rate: Decimal = Decimal("0"),
) -> Dict[str, Decimal]:
    """Calculate tax amounts from rates."""
    cgst = amount * cgst_rate / 100
    sgst = amount * sgst_rate / 100
    igst = amount * igst_rate / 100
    total_tax = cgst + sgst + igst
    return {
        "cgst_amount": cgst,
        "sgst_amount": sgst,
        "igst_amount": igst,
        "tax_amount": total_tax,
    }


def calculate_line_amount(
    qty: Decimal,
    rate: Decimal,
    discount_pct: Decimal = Decimal("0"),
    tax_rate: Decimal = Decimal("0"),
) -> Dict[str, Decimal]:
    """Calculate line item amount with discount and tax."""
    base_amount = qty * rate
    discount = base_amount * discount_pct / 100
    net_amount = base_amount - discount
    tax = net_amount * tax_rate / 100
    return {
        "base_amount": base_amount,
        "discount_amount": discount,
        "net_amount": net_amount,
        "tax_amount": tax,
        "total_amount": net_amount + tax,
    }
