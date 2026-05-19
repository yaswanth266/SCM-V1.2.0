"""
HTML sanitization utility for preventing stored XSS.

Strips dangerous HTML tags, attributes, and JS event handlers from string inputs.
Uses only Python stdlib (re module) — no extra dependencies.
"""

import re
from typing import Any

# Pattern to match HTML tags (including self-closing and with attributes)
_TAG_RE = re.compile(r"<[^>]+>", re.IGNORECASE | re.DOTALL)

# Pattern to match common JS event handler attributes (even without proper tags)
_EVENT_HANDLER_RE = re.compile(
    r"\bon\w+\s*=", re.IGNORECASE
)

# Pattern to match javascript: / vbscript: / data: URI schemes in attribute values
_SCRIPT_URI_RE = re.compile(
    r"(javascript|vbscript|data)\s*:", re.IGNORECASE
)


def strip_html(value: str) -> str:
    """Remove HTML tags and dangerous patterns from a string value."""
    if not value:
        return value
    # Strip all HTML tags
    cleaned = _TAG_RE.sub("", value)
    # Strip event handler patterns like onerror=, onclick=
    cleaned = _EVENT_HANDLER_RE.sub("", cleaned)
    # Strip javascript:/vbscript:/data: URI schemes
    cleaned = _SCRIPT_URI_RE.sub("", cleaned)
    return cleaned.strip()


# Field names that must NEVER be HTML-sanitized — sanitization mangles passwords
# and causes silent account lockouts (BUG-AUTH-149).
_SENSITIVE_KEYS = {
    "password",
    "current_password",
    "new_password",
    "old_password",
    "confirm_password",
    "smtp_password",
}


def sanitize_value(value: Any, _key: str = None) -> Any:
    """
    Recursively sanitize a value:
    - strings: strip HTML (unless the parent key is in _SENSITIVE_KEYS)
    - dicts: sanitize all string values (keys are left alone)
    - lists: sanitize each element
    - other types: pass through unchanged

    BUG-AUTH-149: password / credential fields are passed through verbatim so
    that a user with a `<` or `>` in their password is not silently locked out.
    """
    if isinstance(value, str):
        if _key in _SENSITIVE_KEYS:
            return value
        return strip_html(value)
    if isinstance(value, dict):
        return {k: sanitize_value(v, _key=k) for k, v in value.items()}
    if isinstance(value, list):
        # Lists inherit the parent key's sensitivity (e.g. list of passwords).
        return [sanitize_value(item, _key=_key) for item in value]
    return value
