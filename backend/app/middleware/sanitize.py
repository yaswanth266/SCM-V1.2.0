"""
Request body sanitization middleware.

Intercepts incoming JSON request bodies and strips dangerous HTML/JS
from all string fields before the request reaches route handlers.
"""

import json
import logging
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from app.utils.sanitize import sanitize_value

logger = logging.getLogger(__name__)

# Only sanitize requests that carry a JSON body
_METHODS_WITH_BODY = {"POST", "PUT", "PATCH"}

# BUG-AUTH-149: never run HTML sanitization on these routes — they carry
# credentials and stripping `<`/`>` can silently lock users out.
_BYPASS_PATH_SUFFIXES = (
    "/auth/login",
    "/auth/register",
    "/auth/change-password",       # main employee
    "/carrier-auth/change-password",  # carrier portal
    "/vendor-auth/change-password",   # vendor/supplier portal
    "/auth/refresh-token",
    "/reset-password",  # matches /users/{id}/reset-password
)


def _path_bypassed(path: str) -> bool:
    return any(path.endswith(suffix) for suffix in _BYPASS_PATH_SUFFIXES)


class SanitizeMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        if (
            request.method in _METHODS_WITH_BODY
            and "application/json" in (request.headers.get("content-type") or "")
            and not _path_bypassed(request.url.path)
        ):
            try:
                # Reject oversized bodies (10 MB cap)
                content_length = request.headers.get("content-length")
                if content_length and int(content_length) > 10 * 1024 * 1024:
                    from starlette.responses import JSONResponse
                    return JSONResponse(
                        {"detail": "Request body too large (max 10 MB)"},
                        status_code=413,
                    )
                raw_body = await request.body()
                if len(raw_body) > 10 * 1024 * 1024:
                    from starlette.responses import JSONResponse
                    return JSONResponse(
                        {"detail": "Request body too large (max 10 MB)"},
                        status_code=413,
                    )
                if raw_body:
                    data = json.loads(raw_body)
                    sanitized = sanitize_value(data)
                    sanitized_body = json.dumps(sanitized).encode("utf-8")

                    # Replace the request's receive so downstream reads the sanitized body
                    async def receive():
                        return {"type": "http.request", "body": sanitized_body}

                    request._receive = receive
            except (json.JSONDecodeError, UnicodeDecodeError):
                # Not valid JSON — let the framework handle the error naturally
                pass
            except Exception:
                logger.exception("Error in SanitizeMiddleware")

        return await call_next(request)
