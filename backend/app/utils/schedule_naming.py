"""URL validation for scout targets."""
from __future__ import annotations

from urllib.parse import urlparse


def validate_url(url: str) -> bool:
    """Validate URL for SSRF protection — block localhost and private IPs.

    The 172.16-31.x.x check wraps int() in try/except so malformed hostnames
    (e.g. "172.bad.0.1") fall through instead of raising.
    """
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return False
        host = parsed.hostname.lower() if parsed.hostname else ""
        if host in ("localhost", "127.0.0.1", "0.0.0.0"):
            return False
        if host.startswith("192.168.") or host.startswith("10."):
            return False
        if host.startswith("172."):
            try:
                second_octet = int(host.split(".")[1])
                if 16 <= second_octet <= 31:
                    return False
            except (IndexError, ValueError):
                pass
        return True
    except Exception:
        return False
