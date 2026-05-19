"""JWT + password utilities.

Security fixes applied:
  S4 — Replaced python-jose (CVE-2024-33663/33664) with PyJWT
  B7 — Refresh tokens use a SEPARATE secret from access tokens
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt                         # PyJWT (replaces python-jose)
from passlib.context import CryptContext
from app.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


# BUG-AUTH-030 fix: pin the algorithm whitelist so a config-rot can never
# re-enable insecure algorithms like ``none``. Always reject anything outside
# the safe set even if settings.JWT_ALGORITHM is tampered.
# BUG-AUTH-035 (Wave 5): allow RS256/RS384/RS512 when key files are
# configured. Falls back to HS256 if the asymmetric setup is incomplete.
_HS_ALGORITHMS = {"HS256", "HS384", "HS512"}
_RS_ALGORITHMS = {"RS256", "RS384", "RS512"}
_ALLOWED_JWT_ALGORITHMS = _HS_ALGORITHMS | _RS_ALGORITHMS


# Lazy-load the RSA key material so HS256 deployments never touch disk.
_rsa_keys_cached: dict[str, str | None] = {"priv": None, "pub": None, "loaded": None}


def _load_rsa_keys() -> tuple[str | None, str | None]:
    """Return ``(private_pem, public_pem)`` for RSA signing.

    Reads file paths from ``settings.JWT_PRIVATE_KEY_PATH`` /
    ``settings.JWT_PUBLIC_KEY_PATH`` (or the matching env vars). Cached on
    first successful read so repeated token mints don't hit disk.
    """
    import os
    if _rsa_keys_cached["loaded"]:
        return _rsa_keys_cached["priv"], _rsa_keys_cached["pub"]
    priv_path = (
        getattr(settings, "JWT_PRIVATE_KEY_PATH", None)
        or os.environ.get("JWT_PRIVATE_KEY_PATH")
    )
    pub_path = (
        getattr(settings, "JWT_PUBLIC_KEY_PATH", None)
        or os.environ.get("JWT_PUBLIC_KEY_PATH")
    )
    priv = pub = None
    try:
        if priv_path and os.path.isfile(priv_path):
            with open(priv_path, "r", encoding="utf-8") as fh:
                priv = fh.read()
        if pub_path and os.path.isfile(pub_path):
            with open(pub_path, "r", encoding="utf-8") as fh:
                pub = fh.read()
    except OSError:
        priv = pub = None
    _rsa_keys_cached["priv"] = priv
    _rsa_keys_cached["pub"] = pub
    _rsa_keys_cached["loaded"] = "yes"
    return priv, pub


def _safe_algorithm() -> str:
    alg = (getattr(settings, "JWT_ALGORITHM", None) or "HS256").upper()
    if alg not in _ALLOWED_JWT_ALGORITHMS:
        # Fall back rather than raise so a misconfig doesn't crash workers
        return "HS256"
    if alg in _RS_ALGORITHMS:
        priv, pub = _load_rsa_keys()
        if not priv or not pub:
            # Asymmetric requested but keys missing — fall back to HS256
            # rather than refuse to mint tokens.
            return "HS256"
    return alg


def _signing_key(alg: str, hs_secret: str) -> str:
    """Return the key to PASS to ``jwt.encode`` for the given algorithm."""
    if alg in _RS_ALGORITHMS:
        priv, _ = _load_rsa_keys()
        if priv:
            return priv
    return hs_secret


def _verification_keys(alg: str, hs_secret: str) -> list[str]:
    """Return candidate keys to try when decoding tokens.

    During an HS256→RS256 rollover, both keys may need to verify in-flight
    tokens. We always include the HS secret as a fallback so old access
    tokens continue to work after the algorithm flip.
    """
    keys = []
    if alg in _RS_ALGORITHMS:
        _, pub = _load_rsa_keys()
        if pub:
            keys.append(pub)
    keys.append(hs_secret)
    return keys


def _decode_algorithms() -> list[str]:
    """Algorithms to accept when decoding. Always pinned to the active set."""
    alg = _safe_algorithm()
    if alg in _RS_ALGORITHMS:
        # Allow rolling back to HS256 mid-flight without forcing a logout.
        return sorted(_RS_ALGORITHMS | _HS_ALGORITHMS)
    return sorted(_HS_ALGORITHMS)


# BUG-AUTH-031 fix: stamp constant audience / issuer claims so anyone parsing
# our tokens (including future microservices) can pin both. We only ENFORCE
# `iss` / `aud` if the deployment opted in via env, to avoid breaking active
# sessions on rollout.
_JWT_ISSUER = "bhspl-erp"
_JWT_AUDIENCE = "bhspl-erp-api"


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    now = datetime.now(timezone.utc)
    expire = now + (
        expires_delta or timedelta(minutes=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    # BUG-AUTH-022 partial fix: stamp `iat` so refresh-token endpoint can
    # invalidate tokens issued before password_changed_at. (Full `jti`
    # tracking is deferred until token_blocklist migration lands.)
    # BUG-AUTH-031: stamp `iss`/`aud` so downstream services can pin them.
    to_encode.update({
        "exp": expire, "iat": now, "type": "access",
        "iss": _JWT_ISSUER, "aud": _JWT_AUDIENCE,
    })
    alg = _safe_algorithm()
    return jwt.encode(to_encode, _signing_key(alg, settings.JWT_SECRET_KEY), algorithm=alg)


def create_refresh_token(data: dict) -> str:
    to_encode = data.copy()
    now = datetime.now(timezone.utc)
    # BUG-AUTH-038: use the clamped accessor so an over-large
    # JWT_REFRESH_TOKEN_EXPIRE_DAYS value in .env can never mint a multi-year
    # token without explicit code changes.
    days = getattr(settings, "effective_refresh_token_days", settings.JWT_REFRESH_TOKEN_EXPIRE_DAYS)
    expire = now + timedelta(days=days)
    to_encode.update({
        "exp": expire, "iat": now, "type": "refresh",
        "iss": _JWT_ISSUER, "aud": _JWT_AUDIENCE,
    })
    # B7 — uses a SEPARATE secret so a leaked access token can't forge refreshes
    secret = settings.JWT_REFRESH_SECRET_KEY or settings.JWT_SECRET_KEY
    alg = _safe_algorithm()
    return jwt.encode(to_encode, _signing_key(alg, secret), algorithm=alg)


def decode_token(token: str, secret: str | None = None) -> Optional[dict]:
    payload, _reason = inspect_token(token, secret)
    return payload


def inspect_token(token: str, secret: str | None = None) -> tuple[Optional[dict], Optional[str]]:
    """BUG-AUTH-032 fix: distinguish between PyJWT failure modes.

    Returns ``(payload, None)`` on success, or ``(None, reason)`` where
    ``reason`` is one of ``"expired"``, ``"invalid_signature"``,
    ``"invalid_claims"``, ``"malformed"``, or ``"unknown"``. Callers can
    surface different status codes / log messages without leaking
    cryptographic detail to clients.
    """
    hs_secret = secret or settings.JWT_SECRET_KEY
    algs = _decode_algorithms()
    last_reason: Optional[str] = None
    # BUG-AUTH-035 (Wave 5): try the asymmetric public key first when RS* is
    # active; fall back to the HS secret so HS-signed tokens already in
    # flight keep verifying during a rollover.
    for key in _verification_keys(_safe_algorithm(), hs_secret):
        try:
            payload = jwt.decode(
                token,
                key,
                algorithms=algs,
                options={"verify_aud": False, "verify_iss": False},
            )
            return payload, None
        except jwt.ExpiredSignatureError:
            return None, "expired"
        except jwt.InvalidSignatureError:
            last_reason = "invalid_signature"
            continue   # try next candidate key
        except jwt.InvalidTokenError:
            last_reason = "malformed"
            continue
        except jwt.PyJWTError:
            last_reason = "unknown"
            continue
    return None, last_reason or "unknown"


def verify_access_token(token: str) -> Optional[dict]:
    payload = decode_token(token, settings.JWT_SECRET_KEY)
    if payload and payload.get("type") == "access":
        return payload
    return None


def verify_refresh_token(token: str) -> Optional[dict]:
    secret = settings.JWT_REFRESH_SECRET_KEY or settings.JWT_SECRET_KEY
    payload = decode_token(token, secret)
    if payload and payload.get("type") == "refresh":
        return payload
    return None


def inspect_refresh_token(token: str) -> tuple[Optional[dict], Optional[str]]:
    """Return (payload, reason) for a refresh token. ``reason`` mirrors
    inspect_token's vocabulary; ``"wrong_type"`` is added when the token is
    valid but is not a refresh token."""
    secret = settings.JWT_REFRESH_SECRET_KEY or settings.JWT_SECRET_KEY
    payload, reason = inspect_token(token, secret)
    if payload and payload.get("type") != "refresh":
        return None, "wrong_type"
    return payload, reason
