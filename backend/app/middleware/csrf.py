"""CSRF middleware — double-submit cookie pattern.

Wave 5 infra fix. Closes BUG-AUTH-144.

How it works
------------
On login (see ``app.api.v1.auth.login``) the backend mints a random token
and sets it on a non-HTTPOnly cookie called ``csrf_token`` so JavaScript can
read it. For mutating requests (POST/PUT/PATCH/DELETE) the frontend echoes
that token in an ``X-CSRF-Token`` header. This middleware checks that the
header value matches the cookie value.

Bearer tokens are exempt: a JWT in ``Authorization: Bearer ...`` cannot be
attached automatically by a third-party site, so CSRF is structurally
unreachable for that auth mode. Only cookie-based session auth needs CSRF
protection. Until the app actually issues session cookies, this middleware
runs in **shadow mode** — it logs would-be violations but does not block —
so the rollout to production is safe.

Toggle it with the ``CSRF_ENFORCE`` environment variable: set to ``"1"`` /
``"true"`` to start blocking, otherwise it stays in log-only mode.
"""

from __future__ import annotations

import logging
import os
import secrets

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

logger = logging.getLogger(__name__)


CSRF_COOKIE_NAME = "csrf_token"
CSRF_HEADER_NAME = "X-CSRF-Token"
CSRF_TOKEN_LENGTH = 32  # bytes → 64-char hex

_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
_SKIP_PATHS = {
    "/", "/health", "/docs", "/redoc", "/openapi.json",
    # Login MUST be reachable without an existing cookie.
    "/api/v1/auth/login",
    "/api/v1/auth/refresh-token",
    "/api/v1/auth/register",
}


def generate_csrf_token() -> str:
    """Mint a fresh CSRF token (URL-safe, hex-only)."""
    return secrets.token_hex(CSRF_TOKEN_LENGTH)


def attach_csrf_cookie(response: Response, token: str | None = None) -> str:
    """Set the CSRF cookie on a response and return the token actually set.

    Use this from /auth/login (and any other endpoint that establishes a
    session) so the browser has a token to echo back on subsequent
    mutating requests.
    """
    token = token or generate_csrf_token()
    response.set_cookie(
        key=CSRF_COOKIE_NAME,
        value=token,
        httponly=False,        # JS must be able to read it
        secure=False,          # set True behind HTTPS in nginx
        samesite="strict",
        path="/",
        max_age=60 * 60 * 24,  # 24h — refreshed on each login
    )
    return token


class CSRFMiddleware(BaseHTTPMiddleware):
    """Enforce double-submit cookie on cookie-authenticated mutating requests."""

    def __init__(self, app, *, enforce: bool | None = None) -> None:
        super().__init__(app)
        if enforce is None:
            enforce = os.environ.get("CSRF_ENFORCE", "").strip().lower() in {"1", "true", "yes", "on"}
        self.enforce = bool(enforce)
        if not self.enforce:
            logger.info("CSRFMiddleware: shadow mode (logs only). Set CSRF_ENFORCE=1 to block.")
        else:
            logger.info("CSRFMiddleware: enforcing.")

    async def dispatch(self, request: Request, call_next):
        method = request.method.upper()
        path = request.url.path

        # Fast paths — never check
        if method in _SAFE_METHODS:
            return await call_next(request)
        if path in _SKIP_PATHS or any(path.startswith(skip) for skip in _SKIP_PATHS):
            return await call_next(request)

        # Bearer-token auth: JWT in Authorization header. Browsers can't be
        # tricked into attaching a custom Authorization header on a CSRF
        # forgery, so this auth flavour is structurally CSRF-immune.
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            return await call_next(request)

        # Cookie-based session: enforce double-submit.
        cookie_token = request.cookies.get(CSRF_COOKIE_NAME, "")
        header_token = request.headers.get(CSRF_HEADER_NAME, "")

        ok = bool(cookie_token) and bool(header_token) and secrets.compare_digest(
            cookie_token, header_token,
        )

        if not ok:
            client = request.client.host if request.client else "?"
            ua = request.headers.get("user-agent", "")[:120]
            logger.warning(
                "CSRF: %s %s rejected (client=%s ua=%r cookie=%s header=%s)",
                method, path, client, ua,
                "present" if cookie_token else "missing",
                "present" if header_token else "missing",
            )
            if self.enforce:
                return JSONResponse(
                    status_code=403,
                    content={"detail": "CSRF token missing or invalid"},
                )

        return await call_next(request)
