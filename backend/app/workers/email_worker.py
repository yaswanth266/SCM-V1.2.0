"""Email worker — drains the ``email_logs`` queue.

Wave 5 infra fix. Closes BUG-NOT-001..005, BUG-APR-017, BUG-FIN-140,
BUG-FIN-145, BUG-FIN-146.

The wider system enqueues an ``EmailLog`` row whenever a ``Notification`` is
created with ``send_email=True`` (see
``app.services.notification_service.queue_email_notification``).  Until this
worker existed those rows piled up forever — operators saw "queued" status
in the UI but no mail ever left the box.

Behaviour
---------
* Polls every ``poll_interval`` seconds (default 60s) for rows where
  ``status='queued'`` AND ``sent_at IS NULL``.
* Skips rows that have already failed ``max_attempts`` times — without
  introducing new DB columns we encode the attempt count in
  ``error_message`` (``[attempt N/5] ...``).
* SMTP credentials come from the ``system_settings`` table (keys
  ``smtp_host``, ``smtp_port``, ``smtp_username``, ``smtp_password``,
  ``smtp_ssl``, ``from_email``, ``from_name``) with fallback to the
  application settings (``settings.SMTP_HOST`` etc.) so a fresh deployment
  works without any DB rows.
* Honours TLS (port 587 / ``smtp_ssl=tls``) and SSL (port 465 /
  ``smtp_ssl=ssl``); plain connections are allowed when explicitly
  configured.
* On success: ``status='sent'``, ``sent_at=now()``.
* On failure: ``status='failed'`` once attempts exhausted, otherwise the row
  stays ``queued`` with the latest error appended so the next tick can pick
  it up.
* Graceful shutdown: ``stop()`` cancels the polling task; the in-flight tick
  finishes and rolls back if it cannot complete.

The worker never raises: SMTP errors, missing config, dead connection — all
are logged and the queue is preserved for the next tick.
"""

from __future__ import annotations

import asyncio
import logging
import re
import smtplib
import ssl
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Optional

from sqlalchemy import select, and_, or_

from app.config import settings
from app.database import AsyncSessionLocal
from app.models.system import EmailLog, SystemSetting

logger = logging.getLogger(__name__)


_DEFAULT_POLL_INTERVAL = 60          # seconds
_DEFAULT_BATCH_SIZE = 25             # rows per tick
_MAX_ATTEMPTS = 5                    # mirrors brief
_ATTEMPT_TAG_RE = re.compile(r"^\[attempt (\d+)/(\d+)\]\s*", re.IGNORECASE)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _read_attempts(error_message: Optional[str]) -> int:
    """Recover the attempt count from the ``error_message`` prefix tag.

    Schema doesn't have an ``attempts`` column, so we encode it in the
    error string — `[attempt N/M] reason ...`.
    """
    if not error_message:
        return 0
    m = _ATTEMPT_TAG_RE.match(error_message)
    if not m:
        return 0
    try:
        return int(m.group(1))
    except ValueError:
        return 0


def _strip_tag(error_message: Optional[str]) -> str:
    if not error_message:
        return ""
    return _ATTEMPT_TAG_RE.sub("", error_message).strip()


async def _load_smtp_config() -> dict:
    """Resolve SMTP settings from the DB with .env fallbacks."""
    cfg = {
        "host": settings.SMTP_HOST or "",
        "port": int(settings.SMTP_PORT or 587),
        "username": settings.SMTP_USER or "",
        "password": settings.SMTP_PASSWORD or "",
        "from_email": settings.SMTP_FROM_EMAIL or "",
        "from_name": settings.APP_NAME,
        "use_tls": True,
        "use_ssl": False,
    }
    try:
        async with AsyncSessionLocal() as session:
            rows = (await session.execute(select(SystemSetting))).scalars().all()
            kv = {r.setting_key: (r.setting_value or "") for r in rows}
    except Exception as exc:  # DB unreachable
        logger.warning("email_worker: cannot read system_settings: %s", exc)
        kv = {}

    def _v(*keys: str, default: str = "") -> str:
        for k in keys:
            if k in kv and kv[k] not in (None, ""):
                return kv[k]
        return default

    cfg["host"] = _v("smtp_host", "smtp.host", default=cfg["host"])
    try:
        cfg["port"] = int(_v("smtp_port", "smtp.port", default=str(cfg["port"])) or cfg["port"])
    except (TypeError, ValueError):
        pass
    cfg["username"] = _v("smtp_username", "smtp.username", default=cfg["username"])
    # password may be plaintext OR (eventually) encrypted; this worker accepts
    # whatever the DB has — encryption-at-rest is a future hardening.
    cfg["password"] = _v("smtp_password", "smtp.password_encrypted", "smtp.password",
                         default=cfg["password"])
    cfg["from_email"] = _v("from_email", "smtp.from_address", default=cfg["from_email"])
    cfg["from_name"] = _v("from_name", default=cfg["from_name"])
    ssl_mode = (_v("smtp_ssl", "smtp.use_tls") or "").strip().lower()
    if ssl_mode in {"ssl", "smtps", "true", "1"} and cfg["port"] == 465:
        cfg["use_ssl"] = True
        cfg["use_tls"] = False
    elif ssl_mode in {"none", "plain", "false", "0"}:
        cfg["use_tls"] = False
        cfg["use_ssl"] = False
    else:
        # default: STARTTLS on 587
        cfg["use_tls"] = True
        cfg["use_ssl"] = False
    return cfg


def _send_one_blocking(cfg: dict, to_email: str, cc_email: Optional[str],
                       subject: str, body: str) -> None:
    """Synchronous SMTP send — runs inside ``asyncio.to_thread``."""
    if not cfg["host"]:
        raise RuntimeError("smtp_host not configured")
    if not cfg["from_email"]:
        raise RuntimeError("from_email not configured")

    msg = MIMEMultipart("alternative")
    from_display = (
        f"{cfg['from_name']} <{cfg['from_email']}>" if cfg["from_name"] else cfg["from_email"]
    )
    msg["From"] = from_display
    msg["To"] = to_email
    if cc_email:
        msg["Cc"] = cc_email
    msg["Subject"] = subject
    # Plain text body (callers are responsible for any HTML).  We attach a
    # text/plain part so most MUAs render it without surprise.
    msg.attach(MIMEText(body or "", "plain", "utf-8"))

    recipients = [to_email]
    if cc_email:
        recipients.extend([c.strip() for c in cc_email.split(",") if c.strip()])

    timeout = 30
    if cfg["use_ssl"]:
        ctx = ssl.create_default_context()
        with smtplib.SMTP_SSL(cfg["host"], cfg["port"], context=ctx, timeout=timeout) as server:
            if cfg["username"]:
                server.login(cfg["username"], cfg["password"])
            server.sendmail(cfg["from_email"], recipients, msg.as_string())
    else:
        with smtplib.SMTP(cfg["host"], cfg["port"], timeout=timeout) as server:
            server.ehlo()
            if cfg["use_tls"]:
                server.starttls(context=ssl.create_default_context())
                server.ehlo()
            if cfg["username"]:
                server.login(cfg["username"], cfg["password"])
            server.sendmail(cfg["from_email"], recipients, msg.as_string())


class EmailWorker:
    """Polling worker that drains ``email_logs``."""

    def __init__(
        self,
        poll_interval: int = _DEFAULT_POLL_INTERVAL,
        batch_size: int = _DEFAULT_BATCH_SIZE,
        max_attempts: int = _MAX_ATTEMPTS,
    ) -> None:
        self.poll_interval = poll_interval
        self.batch_size = batch_size
        self.max_attempts = max_attempts
        self._task: Optional[asyncio.Task] = None
        self._stop_event: Optional[asyncio.Event] = None

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(self._run(), name="email-worker")
        logger.info("email_worker: started (interval=%ss, batch=%s, max_attempts=%s)",
                    self.poll_interval, self.batch_size, self.max_attempts)

    async def stop(self) -> None:
        if self._stop_event is not None:
            self._stop_event.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=10)
            except asyncio.TimeoutError:
                self._task.cancel()
                try:
                    await self._task
                except (asyncio.CancelledError, Exception):
                    pass
            self._task = None
        logger.info("email_worker: stopped")

    async def _run(self) -> None:
        assert self._stop_event is not None
        # Fire immediately on start, then on the cadence
        while not self._stop_event.is_set():
            try:
                await self.tick()
            except Exception as exc:
                logger.exception("email_worker: tick failed: %s", exc)
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=self.poll_interval)
                # If wait succeeded, stop_event is set → exit
                break
            except asyncio.TimeoutError:
                continue

    async def tick(self) -> int:
        """Process up to ``batch_size`` rows. Returns rows attempted."""
        cfg = await _load_smtp_config()
        if not cfg["host"] or not cfg["from_email"]:
            # Don't burn cycles attempting to send when SMTP is unconfigured;
            # rows stay queued for when ops fills in system_settings.
            return 0

        async with AsyncSessionLocal() as session:
            try:
                # Pick up rows that are queued AND haven't blown through attempts
                stmt = (
                    select(EmailLog)
                    .where(
                        and_(
                            EmailLog.sent_at.is_(None),
                            or_(EmailLog.status == "queued", EmailLog.status.is_(None)),
                        )
                    )
                    .order_by(EmailLog.id)
                    .limit(self.batch_size)
                )
                rows = (await session.execute(stmt)).scalars().all()
            except Exception as exc:
                logger.warning("email_worker: queue read failed: %s", exc)
                return 0

            if not rows:
                return 0

            attempted = 0
            for row in rows:
                attempts = _read_attempts(row.error_message)
                if attempts >= self.max_attempts:
                    # Mark as failed so it stops re-appearing in the queue
                    row.status = "failed"
                    continue

                attempts += 1
                attempted += 1
                try:
                    await asyncio.to_thread(
                        _send_one_blocking, cfg,
                        row.to_email, row.cc_email,
                        row.subject or "", row.body or "",
                    )
                    row.status = "sent"
                    row.sent_at = _now()
                    # Wipe attempt tag on success
                    if row.error_message:
                        row.error_message = None
                except Exception as exc:
                    reason = str(exc) or exc.__class__.__name__
                    row.error_message = f"[attempt {attempts}/{self.max_attempts}] {reason[:900]}"
                    if attempts >= self.max_attempts:
                        row.status = "failed"
                    else:
                        row.status = "queued"
                    logger.warning("email_worker: send failed (id=%s, attempt=%s/%s): %s",
                                   row.id, attempts, self.max_attempts, reason[:200])

            try:
                await session.commit()
            except Exception as exc:
                await session.rollback()
                logger.exception("email_worker: commit failed: %s", exc)
                return 0
            return attempted


# Module-level singleton — wired from app.main lifespan.
email_worker = EmailWorker()
