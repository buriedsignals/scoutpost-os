"""The Python API must produce pg_cron local-clock expressions, not EventBridge."""
import pytest

from app.services.cron import CronBuilderError, build_scraper_cron, parse_time_string


@pytest.mark.parametrize("zone,regularity,day,time,expected", [
    ("America/New_York", "daily", 1, "08:15", "15 8 * * *"),
    ("Asia/Kathmandu", "weekly", 1, "00:15", "15 0 * * 1"),
    ("Europe/Zurich", "weekly", 7, "08:15", "15 8 * * 0"),
    ("Asia/Kolkata", "monthly", 31, "00:15", "15 0 31 * *"),
    ("UTC", "daily", 1, "00:00", "0 0 * * *"),
])
def test_schedule_keeps_wall_clock_and_calendar(zone, regularity, day, time, expected):
    schedule = build_scraper_cron(zone, regularity, day, time)
    assert schedule.expression == expected
    assert schedule.timezone == zone


@pytest.mark.parametrize("zone", ["Mars/Olympus", "", "EST", "+05:45"])
def test_invalid_timezone_is_not_silently_utc(zone):
    with pytest.raises(CronBuilderError, match="IANA"):
        build_scraper_cron(zone, "daily", 1, "08:15")


def test_omitted_timezone_preserves_utc_contract():
    schedule = build_scraper_cron(None, "daily", 1, "08:15")
    assert schedule.timezone == "UTC"
    assert schedule.expression == "15 8 * * *"


@pytest.mark.parametrize("regularity,day", [("weekly", 0), ("weekly", 8), ("monthly", 0), ("monthly", 32)])
def test_calendar_boundaries(regularity, day):
    with pytest.raises(CronBuilderError, match="between"):
        build_scraper_cron("UTC", regularity, day, "08:15")


@pytest.mark.parametrize("time", ["8pm", "24:00", "12:60", "-1:00"])
def test_invalid_time(time):
    with pytest.raises(CronBuilderError):
        parse_time_string(time)


def test_unsupported_regularity():
    with pytest.raises(CronBuilderError, match="Unsupported regularity"):
        build_scraper_cron("UTC", "hourly", 1, "08:15")
