"""
Timezone normalization utilities.

PURPOSE: Map deprecated IANA timezone names to their canonical equivalents.
The python:3.13-slim Docker image used on Render strips backward-compatible
symlinks from /usr/share/zoneinfo. The tzdata PyPI package restores acceptance
of deprecated names, but ZoneInfo does NOT canonicalize them — e.g.
ZoneInfo("Asia/Calcutta").key returns "Asia/Calcutta", not "Asia/Kolkata".

This module provides a thin normalization layer so storage always holds
canonical IANA identifiers.

DEPENDS ON: zoneinfo (stdlib), tzdata (PyPI — required on slim images)
USED BY: routers/onboarding.py, routers/user.py, dependencies/auth.py
"""
from __future__ import annotations

from zoneinfo import ZoneInfo

# Deprecated IANA names commonly returned by browsers via
# Intl.DateTimeFormat().resolvedOptions().timeZone.
# Source: IANA tzdb "backward" file — subset covering names that modern
# browsers (Chrome/Firefox/Safari) actually emit.
TIMEZONE_ALIASES: dict[str, str] = {
    # Americas
    "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
    "America/Catamarca": "America/Argentina/Catamarca",
    "America/Cordoba": "America/Argentina/Cordoba",
    "America/Jujuy": "America/Argentina/Jujuy",
    "America/Mendoza": "America/Argentina/Mendoza",
    "America/Indianapolis": "America/Indiana/Indianapolis",
    "America/Fort_Wayne": "America/Indiana/Indianapolis",
    "America/Knox_IN": "America/Indiana/Knox",
    "America/Louisville": "America/Kentucky/Louisville",
    "America/Ensenada": "America/Tijuana",
    "America/Porto_Acre": "America/Rio_Branco",
    "America/Rosario": "America/Argentina/Cordoba",
    "America/Virgin": "America/Puerto_Rico",
    # Asia
    "Asia/Calcutta": "Asia/Kolkata",
    "Asia/Saigon": "Asia/Ho_Chi_Minh",
    "Asia/Katmandu": "Asia/Kathmandu",
    "Asia/Dacca": "Asia/Dhaka",
    "Asia/Rangoon": "Asia/Yangon",
    "Asia/Thimbu": "Asia/Thimphu",
    "Asia/Ujung_Pandang": "Asia/Makassar",
    "Asia/Ulan_Bator": "Asia/Ulaanbaatar",
    "Asia/Ashkhabad": "Asia/Ashgabat",
    "Asia/Chungking": "Asia/Chongqing",
    "Asia/Macao": "Asia/Macau",
    # Europe
    "Europe/Kiev": "Europe/Kyiv",
    # Atlantic
    "Atlantic/Faeroe": "Atlantic/Faroe",
    # Pacific
    "Pacific/Ponape": "Pacific/Pohnpei",
    "Pacific/Truk": "Pacific/Chuuk",
    "Pacific/Yap": "Pacific/Chuuk",
    "Pacific/Samoa": "Pacific/Pago_Pago",
}


def normalize_timezone(tz: str | None) -> str | None:
    """Map a deprecated IANA timezone name to its canonical equivalent.

    Returns the input unchanged if it is None, empty, or not in the alias map.
    """
    if not tz:
        return tz
    return TIMEZONE_ALIASES.get(tz, tz)


def validate_timezone(tz: str) -> str:
    """Normalize and validate a timezone identifier.

    Returns the canonical IANA name. Raises ValueError if the timezone
    is not recognized (even after normalization and with tzdata installed).
    """
    canonical = normalize_timezone(tz) or tz
    try:
        ZoneInfo(canonical)
    except KeyError:
        raise ValueError(f"Invalid timezone identifier: {tz}")
    return canonical
