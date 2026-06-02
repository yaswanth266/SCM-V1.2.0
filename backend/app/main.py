import os
import logging
import sys
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import IntegrityError, OperationalError
from app.config import settings
from app.database import engine
from app.api.v1.router import api_router
from app.middleware.audit import AuditMiddleware
from app.middleware.csrf import CSRFMiddleware
from app.workers.email_worker import email_worker
from app.workers.scheduler import notification_scheduler
from app.workers.ntp_check import check_clock_drift
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from app.services.stock_service import InsufficientStockError
from app.utils.exceptions import (
    http_exception_handler,
    integrity_error_handler,
    operational_error_handler,
    general_exception_handler,
    insufficient_stock_handler,
    validation_exception_handler,
)
from app.utils.schema_sync import (
    ensure_feature_schema_on_connection,
    ensure_vendor_type_schema,
    ensure_organization_structure_schema,
    ensure_supplier_portal_schema,
    ensure_rfq_schema,
    ensure_material_issue_schema,
    ensure_logistics_so_schema,
    ensure_universal_dispatch_ack_schema,
)
from fastapi.exceptions import RequestValidationError

logger = logging.getLogger(__name__)

# Startup security checks — S2 fix: NO DEBUG bypass, always fatal
_INSECURE_SECRETS = {"CHANGE_ME_BEFORE_PRODUCTION", "change-this-to-a-very-long-random-string-in-production", ""}
if settings.JWT_SECRET_KEY in _INSECURE_SECRETS:
    logger.critical("FATAL: JWT_SECRET_KEY is insecure. Set a strong random key in .env. Refusing to start.")
    sys.exit(1)
if not settings.JWT_REFRESH_SECRET_KEY:
    logger.critical("FATAL: JWT_REFRESH_SECRET_KEY is not set in .env. Refusing to start.")
    sys.exit(1)
if settings.JWT_REFRESH_SECRET_KEY == settings.JWT_SECRET_KEY:
    # BUG-AUTH-033 fix: previously only WARNED. If refresh and access secrets
    # are identical, a leaked access token can forge refresh tokens (defeats
    # the purpose of separate secrets). Refuse to start.
    logger.critical("FATAL: JWT_REFRESH_SECRET_KEY must differ from JWT_SECRET_KEY. Refusing to start.")
    sys.exit(1)

if settings.DEBUG:
    logger.warning("WARNING: Running in DEBUG mode. Do NOT use in production.")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Wave 5: start background workers + clock-drift check on boot, and
    shut them down cleanly on exit.

    The startup steps never raise (each catches its own errors) so a flaky
    NTP server or absent SMTP config can't keep FastAPI from coming up.
    """
    # 1. NTP drift warning (BUG-AUTH-021)
    try:
        check_clock_drift()
    except Exception as exc:  # belt-and-braces; the function shouldn't raise
        logger.info("ntp_check failed at startup: %s", exc)

    # 1a. Schema bootstrap for newly introduced masters (feature + items.feature_id).
    try:
        async with engine.begin() as conn:
            await ensure_feature_schema_on_connection(conn)
    except Exception as exc:
        logger.warning("feature schema bootstrap failed at startup: %s", exc)

    # Vendor type master is used immediately by the Vendors page. Bootstrap it
    # at startup so request handlers do not race through legacy schema updates.
    try:
        from app.database import AsyncSessionLocal
        async with AsyncSessionLocal() as session:
            await ensure_vendor_type_schema(session)
            await ensure_organization_structure_schema(session)
            await ensure_supplier_portal_schema(session)
            await ensure_rfq_schema(session)
            await ensure_material_issue_schema(session)
            await ensure_logistics_so_schema(session)
            await ensure_universal_dispatch_ack_schema(session)
            await session.commit()
    except Exception as exc:
        logger.warning("vendor type schema bootstrap failed at startup: %s", exc)

    # Logistics Master Data Seeding
    try:
        from app.database import AsyncSessionLocal
        from app.api.v1.logistics import bootstrap_logistics_data
        async with AsyncSessionLocal() as session:
            await bootstrap_logistics_data(session)
            await session.commit()
    except Exception as exc:
        logger.warning("logistics master data seeding failed at startup: %s", exc)

    # Retroactive PO Address Seeding
    try:
        from app.database import AsyncSessionLocal
        from app.models.procurement import PurchaseOrder
        from app.models.warehouse import Warehouse
        from sqlalchemy import select, or_
        from sqlalchemy.orm import selectinload
        
        async with AsyncSessionLocal() as session:
            # Find POs with missing billing or shipping addresses
            po_query = select(PurchaseOrder).where(
                or_(PurchaseOrder.billing_address == None, PurchaseOrder.shipping_address == None)
            )
            po_result = await session.execute(po_query)
            pos_to_update = po_result.scalars().all()
            
            if pos_to_update:
                warehouse_cache = {}
                for po in pos_to_update:
                    if not po.warehouse_id:
                        continue
                        
                    if po.warehouse_id not in warehouse_cache:
                        w_res = await session.execute(
                            select(Warehouse).options(selectinload(Warehouse.organization)).where(Warehouse.id == po.warehouse_id)
                        )
                        warehouse_cache[po.warehouse_id] = w_res.scalar_one_or_none()
                        
                    warehouse_row = warehouse_cache[po.warehouse_id]
                    if not warehouse_row:
                        continue
                        
                    # Generate Billing Address
                    if not po.billing_address and warehouse_row.organization:
                        org = warehouse_row.organization
                        org_parts = [
                            org.name,
                            org.address,
                            f"GSTIN: {org.gst_number}" if org.gst_number else None,
                            f"PAN: {org.pan_number}" if org.pan_number else None,
                            f"Phone: {org.phone}" if org.phone else None,
                            f"Email: {org.email}" if org.email else None
                        ]
                        po.billing_address = "\n".join([p for p in org_parts if p])
                        
                    # Generate Shipping Address
                    if not po.shipping_address:
                        ship_parts = [
                            warehouse_row.name,
                            warehouse_row.address_line1,
                            warehouse_row.address_line2,
                            warehouse_row.city,
                            warehouse_row.state,
                            warehouse_row.pincode,
                            f"Contact: {warehouse_row.contact_person}" if warehouse_row.contact_person else None,
                            f"Phone: {warehouse_row.phone}" if warehouse_row.phone else None
                        ]
                        po.shipping_address = "\n".join([str(p) for p in ship_parts if p])
                        
                await session.commit()
                logger.info(f"Retroactive PO Address Seeding complete. Updated {len(pos_to_update)} POs.")
    except Exception as exc:
        logger.warning("Retroactive PO Address Seeding failed at startup: %s", exc)

    # 2. APScheduler — daily / 4-hourly notification jobs
    try:
        notification_scheduler.start()
    except Exception as exc:
        logger.warning("notification_scheduler failed to start: %s", exc)

    # 3. Email queue drain
    try:
        await email_worker.start()
    except Exception as exc:
        logger.warning("email_worker failed to start: %s", exc)

    try:
        yield
    finally:
        # Reverse-order graceful shutdown.
        try:
            await email_worker.stop()
        except Exception as exc:
            logger.warning("email_worker shutdown error: %s", exc)
        try:
            notification_scheduler.shutdown()
        except Exception as exc:
            logger.warning("notification_scheduler shutdown error: %s", exc)


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="BHSPL Supply Chain Management ERP - Complete Backend API",
    docs_url="/docs" if settings.DEBUG else None,
    redoc_url="/redoc" if settings.DEBUG else None,
    # BUG-AUTH-146 fix: when DEBUG is off we hid /docs and /redoc but FastAPI
    # still served the underlying /openapi.json at the standard path,
    # leaking every route + schema to anonymous scanners. Disable the schema
    # endpoint entirely outside DEBUG; ops teams that need it can grab the
    # spec from a DEBUG environment.
    openapi_url="/openapi.json" if settings.DEBUG else None,
    lifespan=lifespan,
)

# CORS
# BUG-AUTH-143 fix: when CORS_ORIGINS contains a wildcard, refuse to enable
# allow_credentials. Browsers refuse the combination anyway, but explicitly
# downgrading to credentials=False guards against silent token exfiltration
# if a future deployment accidentally ships `["*"]` to production.
_cors_origins = settings.cors_origins_list
_cors_allow_credentials = True
if any(origin == "*" or origin.strip() == "*" for origin in _cors_origins):
    logger.warning(
        "CORS_ORIGINS contains a wildcard; disabling allow_credentials "
        "to prevent cross-origin cookie/auth-header leakage."
    )
    _cors_allow_credentials = False

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=_cors_allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Sanitize middleware (strips HTML/JS from all incoming JSON string fields)
from app.middleware.sanitize import SanitizeMiddleware
app.add_middleware(SanitizeMiddleware)

# Audit middleware
app.add_middleware(AuditMiddleware)

# BUG-AUTH-144 (Wave 5): CSRF middleware. Runs in shadow mode (logs only)
# until CSRF_ENFORCE=1 is set in the environment so the rollout never breaks
# clients that haven't started echoing X-CSRF-Token yet. Bearer-token
# requests are exempt because JWT auth is structurally CSRF-immune.
app.add_middleware(CSRFMiddleware)

# Rate limiting
from app.api.v1.auth import limiter
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Exception handlers
app.add_exception_handler(HTTPException, http_exception_handler)
app.add_exception_handler(RequestValidationError, validation_exception_handler)
app.add_exception_handler(IntegrityError, integrity_error_handler)
app.add_exception_handler(OperationalError, operational_error_handler)
app.add_exception_handler(InsufficientStockError, insufficient_stock_handler)
if not settings.DEBUG:
    app.add_exception_handler(Exception, general_exception_handler)

# Include API routes
app.include_router(api_router)

# S6 fix: uploads dir created but NOT publicly mounted.
# Files are served via an authenticated endpoint in the API router.
upload_dir = os.path.abspath(settings.UPLOAD_DIR)
os.makedirs(upload_dir, exist_ok=True)


@app.get("/health")
async def health_check():
    return {"status": "healthy", "app": settings.APP_NAME, "version": settings.APP_VERSION}


@app.get("/")
async def root():
    return {
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "docs": "/docs",
        "health": "/health",
    }
