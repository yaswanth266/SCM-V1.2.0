from typing import Optional, List
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime, timezone
from app.models.system import Notification, EmailLog


async def create_notification(
    db: AsyncSession,
    user_id: int,
    title: str,
    message: str,
    notification_type: str = "info",
    module: Optional[str] = None,
    reference_type: Optional[str] = None,
    reference_id: Optional[int] = None,
    send_email: bool = False,
) -> Notification:
    """Create a notification for a user."""
    notification = Notification(
        user_id=user_id,
        title=title,
        message=message,
        type=notification_type,
        module=module,
        reference_type=reference_type,
        reference_id=reference_id,
        send_email=send_email,
    )
    db.add(notification)
    await db.flush()

    if send_email:
        await queue_email_notification(db, user_id, title, message, module, reference_type, reference_id)

    return notification


async def create_bulk_notifications(
    db: AsyncSession,
    user_ids: List[int],
    title: str,
    message: str,
    notification_type: str = "info",
    module: Optional[str] = None,
    reference_type: Optional[str] = None,
    reference_id: Optional[int] = None,
) -> List[Notification]:
    """Create notifications for multiple users."""
    notifications = []
    for uid in user_ids:
        n = Notification(
            user_id=uid,
            title=title,
            message=message,
            type=notification_type,
            module=module,
            reference_type=reference_type,
            reference_id=reference_id,
        )
        db.add(n)
        notifications.append(n)
    await db.flush()
    return notifications


async def mark_as_read(db: AsyncSession, notification_id: int, user_id: int) -> bool:
    """Mark a notification as read."""
    result = await db.execute(
        update(Notification)
        .where(Notification.id == notification_id, Notification.user_id == user_id)
        .values(is_read=True, read_at=datetime.now(timezone.utc))
    )
    return result.rowcount > 0


async def mark_all_as_read(db: AsyncSession, user_id: int) -> int:
    """Mark all notifications as read for a user."""
    result = await db.execute(
        update(Notification)
        .where(Notification.user_id == user_id, Notification.is_read == False)
        .values(is_read=True, read_at=datetime.now(timezone.utc))
    )
    return result.rowcount


async def get_unread_count(db: AsyncSession, user_id: int) -> int:
    """Get count of unread notifications for a user."""
    from sqlalchemy import func
    result = await db.execute(
        select(func.count(Notification.id))
        .where(Notification.user_id == user_id, Notification.is_read == False)
    )
    return result.scalar() or 0


async def queue_email_notification(
    db: AsyncSession,
    user_id: int,
    subject: str,
    body: str,
    module: Optional[str] = None,
    reference_type: Optional[str] = None,
    reference_id: Optional[int] = None,
) -> None:
    """Queue an email for sending.

    BUG-FIN-140: previously this silently no-op'd when the user had no email
    address — operators never learnt the alert was lost. Now we log a
    warning so admins can fill in the missing email.
    BUG-FIN-141: include the recipient's name and a configured from-address
    in the body so downstream sender (and any audit trail) has the context
    it needs. EmailLog has no `recipient_name`/`from_email` columns yet, so
    we prefix the body with the salutation and a "From" header.
    """
    from app.models.user import User
    import logging as _logging
    import os as _os
    log = _logging.getLogger(__name__)

    res = await db.execute(
        select(User.email, User.first_name, User.last_name).where(User.id == user_id)
    )
    row = res.first()
    if not row:
        log.warning("queue_email_notification: user %s not found; email skipped", user_id)
        return
    email = row.email
    if not email:
        log.warning(
            "queue_email_notification: user %s has no email; subject=%r module=%s",
            user_id, subject, module,
        )
        return
    full_name = " ".join(filter(None, [row.first_name, row.last_name])).strip() or "there"

    from_email = _os.environ.get("EMAIL_FROM_ADDRESS") or _os.environ.get("SMTP_FROM") or "no-reply@bavyahealthservices.com"
    enriched_body = (
        f"From: {from_email}\n"
        f"To: {full_name} <{email}>\n\n"
        f"Hello {full_name},\n\n"
        f"{body}"
    )

    email_log = EmailLog(
        to_email=email,
        subject=subject,
        body=enriched_body,
        module=module,
        reference_type=reference_type,
        reference_id=reference_id,
        status="queued",
    )
    db.add(email_log)
    await db.flush()
