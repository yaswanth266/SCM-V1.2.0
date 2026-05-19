import logging

from fastapi import Request, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError, OperationalError
from app.services.stock_service import InsufficientStockError

logger = logging.getLogger(__name__)


async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """Log full Pydantic validation details so 422s are debuggable from logs.

    uvicorn only emits "422 Unprocessable Entity" by default which is useless
    when a frontend silently malforms a payload. This emits one structured
    line per missing/invalid field along with the path so we can pinpoint
    field issues from `journalctl -u bhspl-backend`.
    """
    try:
        errors = exc.errors()
    except Exception:
        errors = []
    
    # BUG-FIX: Ensure errors are JSON serializable. 
    # Some Pydantic errors might contain raw Exception objects in 'ctx'.
    serializable_errors = []
    for err in errors:
        if isinstance(err, dict):
            new_err = {}
            for k, v in err.items():
                if k == "ctx" and isinstance(v, dict):
                    new_err[k] = {ck: str(cv) if isinstance(cv, Exception) else cv for ck, cv in v.items()}
                else:
                    new_err[k] = v
            serializable_errors.append(new_err)
        else:
            serializable_errors.append(str(err))

    logger.warning(
        "422 validation %s %s -> %d errors: %s",
        request.method,
        request.url.path,
        len(errors),
        serializable_errors,
    )
    return JSONResponse(
        status_code=422,
        content={
            "success": False,
            "message": "Validation failed",
            "errors": serializable_errors,
        },
    )


async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "success": False,
            "message": exc.detail,
            "data": None,
        },
    )


async def integrity_error_handler(request: Request, exc: IntegrityError):
    detail = str(exc.orig) if exc.orig else str(exc)
    if "Duplicate entry" in detail:
        msg = "A record with this value already exists"
    elif "foreign key constraint" in detail.lower():
        msg = "Referenced record does not exist or cannot be deleted due to dependencies"
    else:
        msg = "Database integrity error"
    return JSONResponse(
        status_code=409,
        content={
            "success": False,
            "message": msg,
            "data": None,
        },
    )


async def operational_error_handler(request: Request, exc: OperationalError):
    # Log the ACTUAL SQL error — generic 503 messages hid a day's worth of bugs.
    # Unknown column, missing table, real connection loss all look the same to
    # the client; operators need the real reason in journalctl.
    logger.exception(
        "OperationalError on %s %s: %s",
        request.method, request.url.path,
        getattr(exc, "orig", exc),
    )
    return JSONResponse(
        status_code=503,
        content={
            "success": False,
            "message": "Database connection error. Please try again later.",
            "data": None,
        },
    )


async def insufficient_stock_handler(request: Request, exc: InsufficientStockError):
    return JSONResponse(
        status_code=400,
        content={
            "success": False,
            "message": str(exc),
            "data": {
                "item_id": exc.item_id,
                "warehouse_id": exc.warehouse_id,
                "available": str(exc.available),
                "requested": str(exc.requested),
            },
        },
    )


async def general_exception_handler(request: Request, exc: Exception):
    """Log the full exception and return a generic 500.

    BUG-AUTH-148 fix: previously the raw ``str(exc)`` (which can contain
    SQL fragments, internal table / column names and even sample row
    values) was returned to the caller for any short message. We now only
    surface a small set of known-safe friendly messages mapped from common
    DB error patterns, and otherwise return a generic "unexpected error"
    text. The full traceback is still written to the server log via
    ``logger.exception`` so operators can debug without leaking detail.
    """
    logger.exception(
        "Unhandled exception on %s %s",
        request.method, request.url.path,
    )
    raw = str(exc)
    if "Data too long" in raw:
        msg = "Input value is too long for the field"
    elif "Incorrect" in raw and "value" in raw:
        msg = "Invalid value provided for one of the fields"
    elif "cannot be null" in raw.lower():
        msg = "A required field is missing"
    else:
        # Never echo raw exception text — it routinely contains SQL or
        # filesystem details the client should not see.
        msg = "An unexpected error occurred"
    return JSONResponse(
        status_code=500,
        content={
            "success": False,
            "message": msg,
            "data": None,
        },
    )


class AppException(HTTPException):
    """Custom application exception."""
    def __init__(self, status_code: int = 400, detail: str = "Bad Request"):
        super().__init__(status_code=status_code, detail=detail)


class NotFoundException(AppException):
    def __init__(self, entity: str = "Record"):
        super().__init__(status_code=404, detail=f"{entity} not found")


class DuplicateException(AppException):
    def __init__(self, entity: str = "Record"):
        super().__init__(status_code=409, detail=f"{entity} already exists")


class ForbiddenException(AppException):
    def __init__(self, detail: str = "Access denied"):
        super().__init__(status_code=403, detail=detail)


class ValidationException(AppException):
    def __init__(self, detail: str = "Validation error"):
        super().__init__(status_code=422, detail=detail)
