"""Build five-field pg_cron expressions in the user's local wall clock.

Timezone conversion belongs to the database dispatcher at execution time,
never to a one-time UTC offset at creation.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from app.models.modes import RegularityType


class CronBuilderError(ValueError):
    """Raised when a cron expression cannot be generated from the provided data."""


@dataclass
class CronSchedule:
    """Represents a cron schedule together with helper metadata."""
    expression: str
    timezone: str
    hour: int
    minute: int
    day_of_week: Optional[int] = None
    day_of_month: Optional[int] = None

    def metadata(self) -> dict:
        """Return serialisable metadata."""
        return {
            "hour": self.hour,
            "minute": self.minute,
            "day_of_week": self.day_of_week,
            "day_of_month": self.day_of_month,
            "timezone": self.timezone,
        }


def parse_time_string(time_str: str) -> tuple[int, int]:
    """Parse HH:MM time strings."""
    try:
        hour_str, minute_str = time_str.split(":")
        hour, minute = int(hour_str), int(minute_str)
    except (ValueError, AttributeError):
        raise CronBuilderError("Time must be provided in HH:MM format") from None

    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise CronBuilderError("Time must be between 00:00 and 23:59")

    return hour, minute


def build_scraper_cron(
    timezone: str | None,
    regularity: RegularityType,
    day_number: int,
    time_str: str,
) -> CronSchedule:
    """Build a local schedule; weekly input uses 1=Monday through 7=Sunday."""
    tz = timezone if timezone is not None else "UTC"
    try:
        if tz != "UTC" and "/" not in tz:
            raise ValueError("not an IANA timezone")
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        raise CronBuilderError("schedule_timezone must be a valid IANA timezone (or UTC)") from None
    hour, minute = parse_time_string(time_str)

    if regularity == "daily":
        expression = f"{minute} {hour} * * *"
        return CronSchedule(
            expression=expression,
            timezone=tz,
            hour=hour,
            minute=minute,
        )

    if regularity == "weekly":
        if not (1 <= day_number <= 7):
            raise CronBuilderError("Day of week must be between 1 (Mon) and 7 (Sun)")
        cron_day = day_number % 7
        expression = f"{minute} {hour} * * {cron_day}"
        return CronSchedule(
            expression=expression,
            timezone=tz,
            hour=hour,
            minute=minute,
            day_of_week=cron_day,
        )

    if regularity == "monthly":
        if not (1 <= day_number <= 31):
            raise CronBuilderError("Day of month must be between 1 and 31")
        expression = f"{minute} {hour} {day_number} * *"
        return CronSchedule(
            expression=expression,
            timezone=tz,
            hour=hour,
            minute=minute,
            day_of_month=day_number,
        )

    raise CronBuilderError(f"Unsupported regularity: {regularity}")
