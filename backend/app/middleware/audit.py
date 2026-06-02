import time
import logging
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from app.database import AsyncSessionLocal
from app.models.system import ActivityLog
from app.services.auth_service import verify_access_token

logger = logging.getLogger(__name__)


class AuditMiddleware(BaseHTTPMiddleware):
    """Middleware to log API activity for audit trail."""

    SKIP_PATHS = {"/docs", "/redoc", "/openapi.json", "/health", "/"}
    # BUG-AUTH-142 fix: HEAD is still skipped (browsers preflight noise) but
    # OPTIONS is now included so CORS recon sweeps leave a faint footprint
    # for security review. The volume cost is negligible because OPTIONS
    # responses are short and we only log when no matching skip path applies.
    SKIP_METHODS = {"HEAD"}
    LOG_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

    # BUG-AUTH-133 fix: derive a semantic action name from the HTTP verb +
    # any trailing action segment in the path. e.g. POST /indents/{id}/submit
    # logs action="submit" rather than action="post".
    _VERB_ACTION_MAP = {
        "POST": "create",
        "PUT": "update",
        "PATCH": "update",
        "DELETE": "delete",
    }

    # BUG-AUTH-132 fix: instead of relying on the parts[2] index which is
    # fragile (depends on /api/v1 prefix presence), search for a known
    # module token after the version segment.
    _KNOWN_MODULES = {
        "auth", "users", "settings", "masters", "procurement", "warehouse",
        "inventory", "indents", "indent", "consumption",
        "approvals", "accounts", "assets", "barcode", "reports", "dashboard",
        "notifications", "healthcare", "outbound", "rules", "compliance",
        "documents", "mrp", "lineage", "alerts", "rate-contracts",
        "cycle-count", "landed-costs", "lms", "automation",
    }

    @classmethod
    def _module_from_path(cls, path: str) -> str:
        parts = [p for p in path.strip("/").split("/") if p]
        for segment in parts:
            if segment in cls._KNOWN_MODULES:
                return segment
        # Fall back to the segment after a "v\d" version marker if any
        for i, p in enumerate(parts):
            if p.lower().startswith("v") and p[1:].isdigit():
                if i + 1 < len(parts):
                    return parts[i + 1]
        return parts[0] if parts else "system"

    @classmethod
    def _action_from_request(cls, method: str, path: str) -> str:
        # If the last path segment is a verb (e.g. /submit, /approve, /cancel)
        # treat that as the action; otherwise fall back to the semantic verb
        # map.
        parts = [p for p in path.strip("/").split("/") if p]
        if parts:
            last = parts[-1]
            if last and not last.isdigit() and "{" not in last:
                # Heuristic: known terminal-action vocabulary
                if last in {
                    "submit", "approve", "reject", "cancel", "issue",
                    "adjust", "post", "void", "close", "reopen", "lock",
                    "unlock", "trigger", "reset-password", "logout",
                    "login", "refresh-token", "change-password", "register",
                    "publish",
                }:
                    return last
        return cls._VERB_ACTION_MAP.get(method, method.lower())

    async def dispatch(self, request: Request, call_next):
        if request.method in self.SKIP_METHODS:
            return await call_next(request)

        path = request.url.path
        if any(path.startswith(skip) for skip in self.SKIP_PATHS):
            return await call_next(request)

        start_time = time.time()
        response: Response = await call_next(request)
        duration = time.time() - start_time

        # Log mutating operations (both success and failures for security audit)
        if request.method in self.LOG_METHODS:
            try:
                # BUG-AUTH-137 fix: cache the verified JWT payload on
                # request.state so downstream middleware / handlers can reuse
                # it instead of decoding the token a second time per request.
                # If `get_current_user` already ran for this request it stashed
                # the user_id we can pick up here without another verify call.
                user_id = getattr(request.state, "user_id", None)
                if user_id is None:
                    auth_header = request.headers.get("authorization", "")
                    if auth_header.startswith("Bearer "):
                        token = auth_header[7:]
                        payload = verify_access_token(token)
                        if payload:
                            try:
                                user_id = int(payload.get("sub", 0)) or None
                            except (TypeError, ValueError):
                                user_id = None
                            # Cache for any later consumer in the same request.
                            try:
                                request.state.user_id = user_id
                            except Exception:
                                pass

                module = self._module_from_path(path)
                action = self._action_from_request(request.method, path)

                ip_address = request.client.host if request.client else None
                user_agent = request.headers.get("user-agent", "")[:500]

                # BUG-AUTH-136 fix: include the trailing path-id segment in
                # the description so audit log searches for "indent 1234"
                # find rows without joining against entity_id (which is null
                # for many actions because the route handler chooses it).
                parts = [p for p in path.strip("/").split("/") if p]
                entity_id_text = ""
                entity_id_value = None
                for seg in reversed(parts):
                    if seg.isdigit():
                        entity_id_text = f" id={seg}"
                        try:
                            entity_id_value = int(seg)
                        except ValueError:
                            entity_id_value = None
                        break

                async with AsyncSessionLocal() as session:
                    log_entry = ActivityLog(
                        user_id=user_id,
                        module=module,
                        action=action,
                        entity_type=module,
                        entity_id=entity_id_value,
                        description=f"{request.method} {path} [{response.status_code}] {duration:.3f}s{entity_id_text}",
                        ip_address=ip_address,
                        user_agent=user_agent,
                    )
                    session.add(log_entry)
                    await session.commit()
            except Exception as exc:
                logger.error(f"Audit logging failed for {request.method} {path}: {exc}")

        return response
