"""Background workers for the BHSPL SCM ERP backend.

Modules
-------
email_worker
    Drains the ``email_logs`` queue every 60 seconds and dispatches via SMTP.

scheduler
    APScheduler-based cron jobs (expiring batches, expiring licenses,
    low-stock alerts, recall-ack reminders).

ntp_check
    Startup-time clock-drift warning against ``time.google.com``.

All workers expose ``start()`` / ``stop()`` coroutines so they can be wired
into the FastAPI ``lifespan`` cleanly.
"""

from app.workers.email_worker import EmailWorker
from app.workers.scheduler import NotificationScheduler
from app.workers.ntp_check import check_clock_drift

__all__ = ["EmailWorker", "NotificationScheduler", "check_clock_drift"]
