"""Startup-time NTP clock-drift check.

Wave 5 infra fix. Closes BUG-AUTH-021 (refresh-token clock drift).

We compare the local clock against a public NTP server (default
``time.google.com``) using a single SNTP packet over UDP. Result:

* drift  > 60s  → ``logger.error`` with the magnitude.
* drift > 5s   → ``logger.warning`` so ops sees small skew accumulate.
* network unreachable / timeout → ``logger.info`` (don't block boot).

Uses only stdlib (``socket`` / ``struct``) so no extra dependency.
"""

from __future__ import annotations

import logging
import socket
import struct
import time

logger = logging.getLogger(__name__)


_NTP_SERVER = "time.google.com"
_NTP_PORT = 123
_NTP_PACKET = b"\x1b" + 47 * b"\0"   # LI=0, VN=3, Mode=3 (client)
_NTP_DELTA = 2208988800              # seconds between 1900-01-01 and 1970-01-01
_TIMEOUT_SECS = 3.0
_WARN_THRESHOLD_SECS = 5.0
_ERROR_THRESHOLD_SECS = 60.0


def _query_ntp(server: str = _NTP_SERVER, port: int = _NTP_PORT) -> float:
    """Return server-time minus local-time, in seconds.

    Positive ⇒ local clock is BEHIND. Negative ⇒ local clock is AHEAD.
    Raises ``socket.timeout`` / ``OSError`` on network issues.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.settimeout(_TIMEOUT_SECS)
        sock.sendto(_NTP_PACKET, (server, port))
        send_ts = time.time()
        data, _ = sock.recvfrom(48)
        recv_ts = time.time()
    finally:
        sock.close()

    if len(data) < 48:
        raise OSError("short NTP response")

    # Bytes 40..47 = transmit timestamp (seconds + fraction)
    secs, frac = struct.unpack("!II", data[40:48])
    server_time = (secs - _NTP_DELTA) + (frac / 2**32)
    local_mid = (send_ts + recv_ts) / 2.0
    return server_time - local_mid


def check_clock_drift(server: str = _NTP_SERVER) -> float | None:
    """Sync check. Returns drift (seconds) or ``None`` if NTP failed.

    Always logs; never raises.
    """
    try:
        drift = _query_ntp(server)
    except (socket.timeout, OSError) as exc:
        logger.info("ntp_check: %s unreachable (%s) — skipping drift check", server, exc)
        return None
    except Exception as exc:  # extreme edge — never block boot
        logger.info("ntp_check: unexpected error %r — skipping drift check", exc)
        return None

    abs_drift = abs(drift)
    if abs_drift > _ERROR_THRESHOLD_SECS:
        logger.error(
            "ntp_check: SYSTEM CLOCK DRIFT %+0.2fs vs %s — JWT exp/iat checks will misbehave. "
            "Sync the host clock (timedatectl set-ntp true / chronyd / w32tm).",
            drift, server,
        )
    elif abs_drift > _WARN_THRESHOLD_SECS:
        logger.warning(
            "ntp_check: clock drift %+0.2fs vs %s (warning threshold %.1fs)",
            drift, server, _WARN_THRESHOLD_SECS,
        )
    else:
        logger.info("ntp_check: clock drift %+0.2fs vs %s (within tolerance)", drift, server)
    return drift
