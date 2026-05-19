"""APScheduler-driven background jobs.

Wave 5 infra fix.

Schedules
---------
* ``expiring_batches_alert``      — daily 06:00 (BUG-INV/HC expiry alerts)
* ``expiring_licenses_alert``     — daily 06:00 (vendor DL renewal nudge)
* ``low_stock_alert``             — every 4 hours (BUG-FIN-134, BUG-INV-122)
* ``recall_ack_reminder``         — daily 09:00 (BUG-NOT-004, BUG-HC recalls)
* ``batch_expire_job``            — daily 00:30 (flips Batch.status=expired,
                                      BUG-INV-085)

Each job is a thin wrapper around an async function that opens its own DB
session and emits notifications via ``app.services.notification_service``.

The scheduler is shut down cleanly from ``app.main`` ``lifespan`` to avoid
asyncio-loop-closed warnings.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select, and_, func, distinct
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal

logger = logging.getLogger(__name__)


# ────────────────────── job bodies ──────────────────────

async def _notify_managers(
    session: AsyncSession,
    title: str,
    message: str,
    *,
    notification_type: str = "warning",
    module: str = "alerts",
    reference_type: Optional[str] = None,
    reference_id: Optional[int] = None,
    send_email: bool = True,
) -> int:
    """Fan out a notification to super_admin / admin / warehouse_manager users.

    Returns the number of recipients notified.
    """
    from app.models.user import User, UserRole, Role
    from app.services.notification_service import create_notification

    target_roles = {"super_admin", "admin", "warehouse_manager", "purchase_manager"}
    rows = await session.execute(
        select(User.id)
        .join(UserRole, UserRole.user_id == User.id)
        .join(Role, Role.id == UserRole.role_id)
        .where(Role.code.in_(target_roles))
        .where(User.is_active == True)  # noqa: E712
        .where(Role.is_active == True)  # noqa: E712
        .distinct()
    )
    user_ids = [r[0] for r in rows.all()]
    for uid in user_ids:
        await create_notification(
            session, uid, title, message,
            notification_type=notification_type,
            module=module,
            reference_type=reference_type,
            reference_id=reference_id,
            send_email=send_email,
        )
    return len(user_ids)


async def _job_expiring_batches() -> None:
    """Daily 06:00. Notify managers of batches expiring within 30 days."""
    from app.models.warehouse import Batch
    from app.models.master import Item
    from app.models.stock import StockBalance

    today = date.today()
    horizon = today + timedelta(days=30)
    async with AsyncSessionLocal() as session:
        try:
            stmt = (
                select(
                    Batch.id, Batch.batch_number, Batch.expiry_date,
                    Item.code, Item.name,
                    func.coalesce(func.sum(StockBalance.available_qty), 0).label("qty"),
                )
                .select_from(Batch)
                .join(Item, Item.id == Batch.item_id)
                .outerjoin(StockBalance, StockBalance.batch_id == Batch.id)
                .where(
                    Batch.expiry_date.isnot(None),
                    Batch.expiry_date <= horizon,
                    Batch.expiry_date >= today,
                    Batch.status == "active",
                )
                .group_by(Batch.id, Batch.batch_number, Batch.expiry_date, Item.code, Item.name)
                .having(func.coalesce(func.sum(StockBalance.available_qty), 0) > 0)
            )
            rows = (await session.execute(stmt)).all()
            if not rows:
                logger.info("scheduler: expiring_batches — no rows in 30-day window")
                return
            count = len(rows)
            sample = ", ".join(
                f"{r.code} {r.batch_number} (exp {r.expiry_date})" for r in rows[:5]
            )
            recipients = await _notify_managers(
                session,
                title=f"{count} batch(es) expiring within 30 days",
                message=(
                    f"There are {count} active batches with stock that expire on or before "
                    f"{horizon.isoformat()}. First {min(5, count)}: {sample}."
                ),
                notification_type="warning",
                module="alerts",
                reference_type="batch_expiry",
            )
            await session.commit()
            logger.info("scheduler: expiring_batches — %s rows, notified %s recipients",
                        count, recipients)
        except Exception as exc:
            await session.rollback()
            logger.exception("scheduler: expiring_batches failed: %s", exc)


async def _job_expiring_licenses() -> None:
    """Daily 06:00. Notify when a vendor drug-license expires within 30 days."""
    from app.models.master import Vendor

    today = date.today()
    horizon = today + timedelta(days=30)
    async with AsyncSessionLocal() as session:
        try:
            rows = (await session.execute(
                select(Vendor.id, Vendor.name, Vendor.drug_license_expiry)
                .where(Vendor.drug_license_expiry.isnot(None))
                .where(Vendor.drug_license_expiry <= horizon)
                .where(Vendor.is_active == True)  # noqa: E712
            )).all()
            if not rows:
                logger.info("scheduler: expiring_licenses — none in window")
                return
            expiring = [r for r in rows if r.drug_license_expiry >= today]
            expired = [r for r in rows if r.drug_license_expiry < today]
            parts = []
            if expired:
                parts.append(f"{len(expired)} EXPIRED: " +
                             ", ".join(f"{v.name} ({v.drug_license_expiry})" for v in expired[:5]))
            if expiring:
                parts.append(f"{len(expiring)} expiring soon: " +
                             ", ".join(f"{v.name} ({v.drug_license_expiry})" for v in expiring[:5]))
            recipients = await _notify_managers(
                session,
                title=f"Vendor DL renewal: {len(rows)} vendor(s) need attention",
                message=" | ".join(parts),
                notification_type="warning" if not expired else "error",
                module="compliance",
                reference_type="vendor_license",
            )
            await session.commit()
            logger.info("scheduler: expiring_licenses — %s vendors, notified %s",
                        len(rows), recipients)
        except Exception as exc:
            await session.rollback()
            logger.exception("scheduler: expiring_licenses failed: %s", exc)


async def _job_low_stock() -> None:
    """Every 4h. Notify when items fall below reorder_level."""
    from app.models.master import Item
    from app.models.stock import StockBalance

    async with AsyncSessionLocal() as session:
        try:
            stmt = (
                select(
                    Item.id, Item.code, Item.name, Item.reorder_level,
                    func.coalesce(func.sum(StockBalance.available_qty), 0).label("qty"),
                )
                .select_from(Item)
                .outerjoin(StockBalance, StockBalance.item_id == Item.id)
                .where(Item.is_active == True)  # noqa: E712
                .where(Item.reorder_level.isnot(None))
                .where(Item.reorder_level > 0)
                .group_by(Item.id, Item.code, Item.name, Item.reorder_level)
                .having(func.coalesce(func.sum(StockBalance.available_qty), 0) < Item.reorder_level)
            )
            rows = (await session.execute(stmt)).all()
            if not rows:
                logger.info("scheduler: low_stock — none below reorder")
                return
            count = len(rows)
            sample = ", ".join(f"{r.code} ({float(r.qty):.0f}/{float(r.reorder_level):.0f})"
                               for r in rows[:5])
            # 4-hourly notifications would be too chatty; cap email to once a day.
            now = datetime.now(timezone.utc)
            send_email = now.hour < 4   # only the first run of the day emails
            recipients = await _notify_managers(
                session,
                title=f"Low stock: {count} item(s) below reorder level",
                message=f"Below reorder: {sample}{' …' if count > 5 else ''}",
                notification_type="warning",
                module="alerts",
                reference_type="low_stock",
                send_email=send_email,
            )
            await session.commit()
            logger.info("scheduler: low_stock — %s items, notified %s (email=%s)",
                        count, recipients, send_email)
        except Exception as exc:
            await session.rollback()
            logger.exception("scheduler: low_stock failed: %s", exc)


async def _job_recall_ack_reminder() -> None:
    """Daily 09:00. Remind managers of in-progress recalls without traces."""
    from app.models.healthcare import BatchRecall, BatchRecallTrace

    async with AsyncSessionLocal() as session:
        try:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
            # In-progress recalls that haven't completed AND were initiated > 24h ago
            stmt = (
                select(BatchRecall.id, BatchRecall.recall_number,
                       BatchRecall.severity, BatchRecall.initiated_at)
                .where(BatchRecall.status.in_(["initiated", "in_progress"]))
                .where(BatchRecall.initiated_at <= cutoff)
            )
            recalls = (await session.execute(stmt)).all()
            if not recalls:
                logger.info("scheduler: recall_ack — no stale recalls")
                return
            sample = ", ".join(f"{r.recall_number} ({r.severity})" for r in recalls[:5])
            recipients = await _notify_managers(
                session,
                title=f"Open batch recalls: {len(recalls)} need acknowledgement",
                message=(
                    f"The following recalls have been open >24h: {sample}"
                    f"{' …' if len(recalls) > 5 else ''}. "
                    "Confirm acknowledgement and update trace status."
                ),
                notification_type="error",
                module="compliance",
                reference_type="batch_recall",
            )
            await session.commit()
            logger.info("scheduler: recall_ack — %s recalls, notified %s",
                        len(recalls), recipients)
        except Exception as exc:
            await session.rollback()
            logger.exception("scheduler: recall_ack failed: %s", exc)


async def _job_batch_expire() -> None:
    """Daily 00:30. Flip status='expired' on batches past expiry_date.

    Mirrors ``POST /warehouse/batches/expire-job`` so deployments don't have
    to call it manually.
    """
    from app.models.warehouse import Batch
    today = date.today()
    async with AsyncSessionLocal() as session:
        try:
            rows = (await session.execute(
                select(Batch).where(
                    Batch.status == "active",
                    Batch.expiry_date.isnot(None),
                    Batch.expiry_date < datetime.combine(today, datetime.min.time()),
                )
            )).scalars().all()
            flipped = 0
            for b in rows:
                b.status = "expired"
                flipped += 1
            await session.commit()
            logger.info("scheduler: batch_expire — flipped %s batches", flipped)
        except Exception as exc:
            await session.rollback()
            logger.exception("scheduler: batch_expire failed: %s", exc)


# ────────────────────── scheduler shell ──────────────────────


class NotificationScheduler:
    """Owns the APScheduler instance and lifecycle.

    APScheduler is an optional dependency — if it isn't installed we log a
    warning and become a no-op so the rest of the app keeps booting.
    """

    def __init__(self) -> None:
        self._scheduler = None  # type: ignore[assignment]

    def start(self) -> None:
        try:
            from apscheduler.schedulers.asyncio import AsyncIOScheduler
            from apscheduler.triggers.cron import CronTrigger
            from apscheduler.triggers.interval import IntervalTrigger
        except ImportError:
            logger.warning(
                "scheduler: apscheduler not installed — background jobs are "
                "disabled. `pip install apscheduler` to enable."
            )
            return

        sched = AsyncIOScheduler(timezone="UTC")
        # Daily 06:00 UTC
        sched.add_job(_job_expiring_batches, CronTrigger(hour=6, minute=0),
                      id="expiring_batches", replace_existing=True,
                      misfire_grace_time=3600, coalesce=True)
        sched.add_job(_job_expiring_licenses, CronTrigger(hour=6, minute=0),
                      id="expiring_licenses", replace_existing=True,
                      misfire_grace_time=3600, coalesce=True)
        # Every 4h
        sched.add_job(_job_low_stock, IntervalTrigger(hours=4),
                      id="low_stock", replace_existing=True,
                      misfire_grace_time=1800, coalesce=True)
        # Daily 09:00 UTC
        sched.add_job(_job_recall_ack_reminder, CronTrigger(hour=9, minute=0),
                      id="recall_ack_reminder", replace_existing=True,
                      misfire_grace_time=3600, coalesce=True)
        # Daily 00:30 UTC — flip expired batches
        sched.add_job(_job_batch_expire, CronTrigger(hour=0, minute=30),
                      id="batch_expire", replace_existing=True,
                      misfire_grace_time=3600, coalesce=True)
        sched.start()
        self._scheduler = sched
        logger.info("scheduler: started with %d jobs", len(sched.get_jobs()))

    def shutdown(self) -> None:
        if self._scheduler is None:
            return
        try:
            self._scheduler.shutdown(wait=False)
            logger.info("scheduler: shut down")
        except Exception as exc:  # pragma: no cover
            logger.warning("scheduler: shutdown error: %s", exc)
        finally:
            self._scheduler = None


notification_scheduler = NotificationScheduler()
