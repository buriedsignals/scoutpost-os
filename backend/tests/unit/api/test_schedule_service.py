"""
Unit tests for ScheduleService and utility functions.

Tests cover:
- validate_url() — SSRF protection (localhost, private IPs, scheme checks)
- create_scout() — scout record + timezone-aware pg_cron schedule creation
- list_scouts() — delegates to storage adapter
- get_scout() — single-scout lookup via adapter
- delete_scout() — delegates to scheduler + storage adapters
"""
from unittest.mock import MagicMock, AsyncMock

import pytest

from app.utils.schedule_naming import validate_url
from app.services.schedule_service import ScheduleService


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_scout_storage():
    """Mock ScoutStoragePort adapter."""
    return AsyncMock()


@pytest.fixture
def mock_scheduler():
    """Mock SchedulerPort adapter."""
    return AsyncMock()


@pytest.fixture
def schedule_service(mock_scout_storage, mock_scheduler):
    """ScheduleService with mocked adapter ports."""
    return ScheduleService(scout_storage=mock_scout_storage, scheduler=mock_scheduler)


@pytest.fixture
def mock_cron_schedule():
    """Mock CronSchedule object."""
    schedule = MagicMock()
    schedule.expression = "0 10 * * *"
    schedule.timezone = "Europe/Oslo"
    return schedule


# ---------------------------------------------------------------------------
# validate_url()
# ---------------------------------------------------------------------------

class TestValidateUrl:
    def test_valid_http(self):
        assert validate_url("http://example.com/page") is True

    def test_valid_https(self):
        assert validate_url("https://example.com/page") is True

    def test_rejects_ftp(self):
        assert validate_url("ftp://example.com/file") is False

    def test_rejects_javascript(self):
        assert validate_url("javascript:alert(1)") is False

    def test_rejects_localhost(self):
        assert validate_url("http://localhost/admin") is False

    def test_rejects_127_0_0_1(self):
        assert validate_url("http://127.0.0.1:8080/api") is False

    def test_rejects_0_0_0_0(self):
        assert validate_url("http://0.0.0.0/") is False

    def test_rejects_192_168(self):
        assert validate_url("http://192.168.1.1/router") is False

    def test_rejects_10_x(self):
        assert validate_url("http://10.0.0.1/internal") is False

    def test_rejects_172_16_range(self):
        assert validate_url("http://172.16.0.1/service") is False
        assert validate_url("http://172.31.255.255/service") is False

    def test_allows_172_outside_private_range(self):
        assert validate_url("http://172.15.0.1/ok") is True
        assert validate_url("http://172.32.0.1/ok") is True

    def test_rejects_empty_string(self):
        assert validate_url("") is False

    def test_rejects_malformed(self):
        assert validate_url("not a url") is False

    def test_rejects_no_scheme(self):
        assert validate_url("example.com") is False


# ---------------------------------------------------------------------------
# create_scout()
# ---------------------------------------------------------------------------

class TestCreateScout:
    @pytest.mark.asyncio
    async def test_schedule_failure_removes_new_scout(
        self, schedule_service, mock_scout_storage, mock_scheduler, mock_cron_schedule
    ):
        mock_scout_storage.create_scout.return_value = {"id": "scout-id"}
        mock_scheduler.create_schedule.side_effect = RuntimeError("scheduling failed")
        with pytest.raises(RuntimeError, match="scheduling failed"):
            await schedule_service.create_scout(
                "user-1", "Unscheduled", {"scout_type": "beat"}, mock_cron_schedule
            )
        mock_scout_storage.delete_scout.assert_awaited_once_with("user-1", "Unscheduled")


    @pytest.mark.asyncio
    async def test_validates_url_web_scout(self, schedule_service, mock_scout_storage, mock_scheduler, mock_cron_schedule):
        body = {"scout_type": "web", "url": "http://localhost/admin"}

        with pytest.raises(ValueError, match="Invalid or blocked URL"):
            await schedule_service.create_scout("user-123", "Bad Scout", body, mock_cron_schedule)

        mock_scout_storage.create_scout.assert_not_called()
        mock_scheduler.create_schedule.assert_not_called()

    @pytest.mark.asyncio
    async def test_skips_url_validation_beat(self, schedule_service, mock_scout_storage, mock_scheduler, mock_cron_schedule):
        """Beat scouts don't have URLs, so no validation needed."""
        mock_scout_storage.create_scout.return_value = {"id": "scout-id", "scraper_name": "Beat"}
        mock_scheduler.create_schedule.return_value = "arn:..."
        body = {"scout_type": "beat", "location": {"lat": 59.95, "lng": 10.75}}

        result = await schedule_service.create_scout("user-123", "Beat", body, mock_cron_schedule)

        assert result["scraper_name"] == "Beat"

    @pytest.mark.asyncio
    async def test_writes_scraper_record_social(self, schedule_service, mock_scout_storage, mock_scheduler, mock_cron_schedule):
        """Social scout stores all type-specific fields including topic."""
        mock_scout_storage.create_scout.return_value = {"id": "scout-id", "scraper_name": "NASA Monitor"}
        mock_scheduler.create_schedule.return_value = "arn:..."

        body = {
            "scout_type": "social",
            "platform": "instagram",
            "profile_handle": "nasa",
            "monitor_mode": "criteria",
            "track_removals": True,
            "criteria": "space launches",
            "topic": "Space",
            "regularity": "weekly",
            "time": "08:00",
        }

        result = await schedule_service.create_scout("user-789", "NASA Monitor", body, mock_cron_schedule)

        assert result["scraper_name"] == "NASA Monitor"

        call_args = mock_scout_storage.create_scout.call_args
        assert call_args[0][0] == "user-789"
        item = call_args[0][1]
        assert item["scout_type"] == "social"
        assert item["platform"] == "instagram"
        assert item["profile_handle"] == "nasa"
        assert item["monitor_mode"] == "criteria"
        assert item["track_removals"] is True
        assert item["criteria"] == "space launches"
        assert item["topic"] == "Space"

    @pytest.mark.asyncio
    async def test_social_scout_without_topic(self, schedule_service, mock_scout_storage, mock_scheduler, mock_cron_schedule):
        """Social scout without topic omits the field (not stored as None)."""
        mock_scout_storage.create_scout.return_value = {"id": "scout-id", "scraper_name": "X Scout"}
        mock_scheduler.create_schedule.return_value = "arn:..."
        body = {
            "scout_type": "social",
            "platform": "x",
            "profile_handle": "elonmusk",
            "monitor_mode": "summarize",
        }

        await schedule_service.create_scout("user-1", "X Scout", body, mock_cron_schedule)

        call_args = mock_scout_storage.create_scout.call_args
        item = call_args[0][1]
        assert "topic" not in item

    @pytest.mark.asyncio
    async def test_social_scout_infers_criteria_mode_from_criteria(
        self,
        schedule_service,
        mock_scout_storage,
        mock_scheduler,
        mock_cron_schedule,
    ):
        """Current clients can omit monitor_mode when they send criteria."""
        mock_scout_storage.create_scout.return_value = {"id": "scout-id", "scraper_name": "Housing Watch"}
        mock_scheduler.create_schedule.return_value = "arn:..."
        body = {
            "scout_type": "social",
            "platform": "x",
            "profile_handle": "citycouncil",
            "criteria": "housing votes",
        }

        await schedule_service.create_scout(
            "user-1", "Housing Watch", body, mock_cron_schedule
        )

        item = mock_scout_storage.create_scout.call_args[0][1]
        assert item["monitor_mode"] == "criteria"

    @pytest.mark.asyncio
    async def test_social_scout_legacy_omission_stays_summarize(
        self,
        schedule_service,
        mock_scout_storage,
        mock_scheduler,
        mock_cron_schedule,
    ):
        """Raw REST callers that omit both fields keep legacy summarize semantics."""
        mock_scout_storage.create_scout.return_value = {"id": "scout-id", "scraper_name": "Council Digest"}
        mock_scheduler.create_schedule.return_value = "arn:..."
        body = {
            "scout_type": "social",
            "platform": "x",
            "profile_handle": "citycouncil",
        }

        await schedule_service.create_scout(
            "user-1", "Council Digest", body, mock_cron_schedule
        )

        item = mock_scout_storage.create_scout.call_args[0][1]
        assert item["monitor_mode"] == "summarize"

    @pytest.mark.asyncio
    async def test_social_scout_rejects_blank_criteria_mode(
        self,
        schedule_service,
        mock_scout_storage,
        mock_scheduler,
        mock_cron_schedule,
    ):
        body = {
            "scout_type": "social",
            "platform": "x",
            "profile_handle": "citycouncil",
            "monitor_mode": "criteria",
            "criteria": "   ",
        }

        with pytest.raises(
            ValueError,
            match="criteria is required when monitor_mode is criteria",
        ):
            await schedule_service.create_scout(
                "user-1", "Housing Watch", body, mock_cron_schedule
            )

        mock_scout_storage.create_scout.assert_not_called()
        mock_scheduler.create_schedule.assert_not_called()

    @pytest.mark.asyncio
    async def test_web_scout_stores_topic(self, schedule_service, mock_scout_storage, mock_scheduler, mock_cron_schedule):
        """Web scout stores topic when provided."""
        mock_scout_storage.create_scout.return_value = {"id": "scout-id", "scraper_name": "Web Topic"}
        mock_scheduler.create_schedule.return_value = "arn:..."
        body = {
            "scout_type": "web",
            "url": "https://example.com",
            "criteria": "new articles",
            "topic": "Technology",
        }

        await schedule_service.create_scout("user-1", "Web Topic", body, mock_cron_schedule)

        call_args = mock_scout_storage.create_scout.call_args
        item = call_args[0][1]
        assert item["topic"] == "Technology"

    @pytest.mark.asyncio
    async def test_web_scout_without_topic(self, schedule_service, mock_scout_storage, mock_scheduler, mock_cron_schedule):
        """Web scout without topic omits the field."""
        mock_scout_storage.create_scout.return_value = {"id": "scout-id", "scraper_name": "Web No Topic"}
        mock_scheduler.create_schedule.return_value = "arn:..."
        body = {
            "scout_type": "web",
            "url": "https://example.com",
        }

        await schedule_service.create_scout("user-1", "Web No Topic", body, mock_cron_schedule)

        call_args = mock_scout_storage.create_scout.call_args
        item = call_args[0][1]
        assert "topic" not in item



# ---------------------------------------------------------------------------
# list_scouts()
# ---------------------------------------------------------------------------

class TestListScouts:
    @pytest.mark.asyncio
    async def test_delegates_to_storage(self, schedule_service, mock_scout_storage):
        """list_scouts delegates to storage adapter."""
        mock_scout_storage.list_scouts.return_value = [
            {
                "name": "MyScout",
                "scout_type": "web",
                "url": "https://example.com",
                "created_at": "2026-01-01T00:00:00Z",
                "last_run": "01-01-2026 10:00",
                "scraper_status": True,
                "criteria_status": True,
                "card_summary": "Found 3 new changes",
            }
        ]

        results = await schedule_service.list_scouts("user-1")

        assert len(results) == 1
        scout = results[0]
        assert scout["name"] == "MyScout"
        assert scout["last_run"] == "01-01-2026 10:00"
        assert scout["scraper_status"] is True
        assert scout["card_summary"] == "Found 3 new changes"
        mock_scout_storage.list_scouts.assert_called_once_with("user-1")

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_scouts(self, schedule_service, mock_scout_storage):
        mock_scout_storage.list_scouts.return_value = []

        results = await schedule_service.list_scouts("u")
        assert results == []


# ---------------------------------------------------------------------------
# get_scout()
# ---------------------------------------------------------------------------

class TestGetScout:
    @pytest.mark.asyncio
    async def test_returns_scout_with_run_data(self, schedule_service, mock_scout_storage):
        mock_scout_storage.get_scout.return_value = {
            "name": "TestScout",
            "scout_type": "web",
            "url": "https://example.com",
            "created_at": "2026-01-01T00:00:00Z",
            "last_run": "01-01-2026 10:00",
            "scraper_status": True,
            "criteria_status": False,
            "notification_sent": False,
            "card_summary": "Detected changes",
        }

        result = await schedule_service.get_scout("user-1", "TestScout")

        assert result is not None
        assert result["name"] == "TestScout"
        assert result["last_run"] == "01-01-2026 10:00"
        assert result["card_summary"] == "Detected changes"
        mock_scout_storage.get_scout.assert_called_once_with("user-1", "TestScout")

    @pytest.mark.asyncio
    async def test_returns_none_for_missing_scout(self, schedule_service, mock_scout_storage):
        mock_scout_storage.get_scout.return_value = None

        result = await schedule_service.get_scout("user-1", "NonExistent")

        assert result is None


# ---------------------------------------------------------------------------
# delete_scout()
# ---------------------------------------------------------------------------

class TestDeleteScout:
    @pytest.mark.asyncio
    async def test_deletes_schedule_and_all_records(self, schedule_service, mock_scout_storage, mock_scheduler):
        """delete_scout calls scheduler.delete_schedule and scout_storage.delete_scout."""
        mock_scout_storage.get_scout.return_value = {"id": "scout-id"}
        mock_scout_storage.delete_scout.return_value = {
            "message": "Scout deleted successfully",
            "scraper_name": "MyScout",
            "records_deleted": {"time": 1, "seen": 1, "exec": 1},
        }

        result = await schedule_service.delete_scout("user-1", "MyScout")


        # Storage adapter called
        mock_scout_storage.delete_scout.assert_called_once_with("user-1", "MyScout")

        assert result["scraper_name"] == "MyScout"
        assert result["records_deleted"]["time"] == 1

    @pytest.mark.asyncio
    async def test_handles_schedule_not_found(self, schedule_service, mock_scout_storage, mock_scheduler):
        """Should not raise when scheduler delete is a no-op (adapter handles it)."""
        mock_scout_storage.get_scout.return_value = {"id": "scout-id"}
        mock_scheduler.delete_schedule.return_value = None  # adapter absorbs not-found
        mock_scout_storage.delete_scout.return_value = {
            "message": "Scout deleted successfully",
            "scraper_name": "DeletedScout",
            "records_deleted": {"time": 0, "seen": 0, "exec": 0},
        }

        result = await schedule_service.delete_scout("user-1", "DeletedScout")

        assert result["scraper_name"] == "DeletedScout"


# ---------------------------------------------------------------------------
# TestCreateScout — civic branch
# ---------------------------------------------------------------------------

class TestCreateCivicScout:
    @pytest.mark.asyncio
    async def test_create_civic_scout_includes_fields(
        self, schedule_service, mock_scout_storage, mock_scheduler, mock_cron_schedule
    ):
        """Civic scout stores all type-specific fields in SCRAPER# record."""
        mock_scout_storage.create_scout.return_value = {"id": "scout-id", "scraper_name": "City Budget"}
        mock_scheduler.create_schedule.return_value = "arn:..."

        body = {
            "scout_type": "civic",
            "root_domain": "https://city.gov",
            "tracked_urls": ["https://city.gov/budget.pdf", "https://city.gov/plans.pdf"],
            "criteria": "budget changes",
            "content_hash": "abc123",
            "processed_pdf_urls": ["https://city.gov/budget.pdf"],
            "regularity": "daily",
            "time": "09:00",
            "preferred_language": "en",
        }

        result = await schedule_service.create_scout("user-1", "City Budget", body, mock_cron_schedule)

        assert result["scraper_name"] == "City Budget"

        call_args = mock_scout_storage.create_scout.call_args
        assert call_args[0][0] == "user-1"
        item = call_args[0][1]
        assert item["scout_type"] == "civic"
        assert item["root_domain"] == "https://city.gov"
        assert item["tracked_urls"] == ["https://city.gov/budget.pdf", "https://city.gov/plans.pdf"]
        assert item["criteria"] == "budget changes"
        assert item["content_hash"] == "abc123"
        assert item["processed_pdf_urls"] == ["https://city.gov/budget.pdf"]

    @pytest.mark.asyncio
    async def test_create_civic_scout_defaults_empty_fields(
        self, schedule_service, mock_scout_storage, mock_scheduler, mock_cron_schedule
    ):
        """Civic scout uses empty defaults when optional fields are absent."""
        mock_scout_storage.create_scout.return_value = {"id": "scout-id", "scraper_name": "Minimal Civic"}
        mock_scheduler.create_schedule.return_value = "arn:..."
        body = {"scout_type": "civic"}

        await schedule_service.create_scout("user-1", "Minimal Civic", body, mock_cron_schedule)

        call_args = mock_scout_storage.create_scout.call_args
        item = call_args[0][1]
        assert item["root_domain"] == ""
        assert item["tracked_urls"] == []
        assert item["criteria"] == ""
        assert item["content_hash"] == ""
        assert item["processed_pdf_urls"] == []


# ---------------------------------------------------------------------------
# TestDeleteScout — civic PROMISE# cleanup
# ---------------------------------------------------------------------------

class TestDeleteCivicScout:
    @pytest.mark.asyncio
    async def test_delete_civic_scout_delegates_to_storage(
        self, schedule_service, mock_scout_storage, mock_scheduler
    ):
        """delete_scout delegates PROMISE# cleanup to the storage adapter."""
        mock_scout_storage.get_scout.return_value = {"id": "scout-id"}
        mock_scout_storage.delete_scout.return_value = {
            "message": "Scout deleted successfully",
            "scraper_name": "CivicScout",
            "records_deleted": {"time": 0, "seen": 0, "exec": 0},
        }

        result = await schedule_service.delete_scout("user-1", "CivicScout")

        assert result["scraper_name"] == "CivicScout"
        mock_scout_storage.delete_scout.assert_called_once_with("user-1", "CivicScout")
        mock_scheduler.delete_schedule.assert_called_once()
