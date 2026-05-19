from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.models.user import User
from app.models.system import Notification
from app.services.notification_service import mark_as_read, mark_all_as_read, get_unread_count
from app.utils.dependencies import get_current_user
from app.utils.helpers import paginate_params, build_paginated_response

router = APIRouter()


@router.get("")
async def list_notifications(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    is_read: bool = Query(None),
    notification_type: str = Query(None),
    module: str = Query(None, description="Filter by source module (BUG-FIN-144)"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List notifications for the current user."""
    offset, limit = paginate_params(page, page_size)
    query = select(Notification).where(Notification.user_id == current_user.id)
    count_query = select(func.count(Notification.id)).where(Notification.user_id == current_user.id)

    if is_read is not None:
        query = query.where(Notification.is_read == is_read)
        count_query = count_query.where(Notification.is_read == is_read)
    if notification_type:
        query = query.where(Notification.type == notification_type)
        count_query = count_query.where(Notification.type == notification_type)
    # BUG-FIN-144: honour the `module` query parameter the FE sidebar sends.
    if module:
        query = query.where(Notification.module == module)
        count_query = count_query.where(Notification.module == module)

    total = (await db.execute(count_query)).scalar()
    result = await db.execute(query.offset(offset).limit(limit).order_by(Notification.id.desc()))
    notifications = result.scalars().all()

    items = [{
        "id": n.id, "title": n.title, "message": n.message,
        "type": n.type, "module": n.module,
        "reference_type": n.reference_type, "reference_id": n.reference_id,
        "is_read": n.is_read, "read_at": n.read_at,
        "created_at": n.created_at,
    } for n in notifications]

    return build_paginated_response(items, total, page, page_size)


@router.get("/unread-count")
async def get_notification_unread_count(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get count of unread notifications."""
    count = await get_unread_count(db, current_user.id)
    return {"unread_count": count}


@router.post("/{notification_id}/read")
async def mark_notification_read(
    notification_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Mark a notification as read."""
    success = await mark_as_read(db, notification_id, current_user.id)
    if not success:
        return {"success": False, "message": "Notification not found"}
    return {"success": True, "message": "Marked as read"}


@router.post("/read-all")
async def mark_all_notifications_read(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Mark all notifications as read."""
    count = await mark_all_as_read(db, current_user.id)
    return {"success": True, "message": f"{count} notifications marked as read"}
