"""
Unit tests for ScheduleService and utility functions.

Tests cover:
- sanitize_name() — character replacement and dash collapsing
- build_schedule_name() — known pairs, max-length truncation, user_ prefix stripping
- convert_floats_to_decimal() — recursive float→Decimal conversion
- validate_url() — SSRF protection (localhost, private IPs, scheme checks)
- sanitize_scout_name_for_sk() — # and | replacement
- create_scout() — SCRAPER# record + EventBridge schedule creation
- list_scouts() — delegates to storage adapter
- get_scout() — single-scout lookup via adapter
- delete_scout() — delegates to scheduler + storage adapters
"""
import json
from decimal import Decimal
from unittest.mock import MagicMock, AsyncMock, patch

import pytest

from app.utils.schedule_naming import (
    sanitize_name,
    build_schedule_name,
    convert_floats_to_decimal,
    validate_url,
    sanitize_scout_name_for_sk,
    convert_decimals,
)
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
    with patch("app.services.schedule_service.get_settings") as mock_settings:
        mock_settings.return_value.aws_region = "eu-central-1"
        mock_settings.return_value.scraper_lambda_arn = "arn:aws:lambda:eu-central-1:123:function:scraper"
        mock_settings.return_value.eventbridge_role_arn = "arn:aws:iam::123:role/eb-role"
        mock_settings.return_value.internal_service_key = "test-service-key"
        service = ScheduleService(
            scout_storage=mock_scout_storage,
            scheduler=mock_scheduler,
        )
    return service


@pytest.fixture
def mock_cron_schedule():
    """Mock CronSchedule object."""
    schedule = MagicMock()
    schedule.expression = "0 10 * * ? *"
    schedule.timezone = "Europe/Oslo"
    return schedule


# ---------------------------------------------------------------------------
# sanitize_name()
# ---------------------------------------------------------------------------

class TestSanitizeName:
    def test_replaces_spaces(self):
        assert sanitize_name("Daily News Report") == "Daily-News-Report"

    def test_replaces_special_chars(self):
        assert sanitize_name("test@#$%^&*()name") == "test-name"

    def test_preserves_allowed_chars(self):
        assert sanitize_name("my-scout_v2.0") == "my-scout_v2.0"

    def test_collapses_consecutive_dashes(self):
        assert sanitize_name("a   b---c") == "a-b-c"

    def test_strips_leading_trailing_dashes(self):
        assert sanitize_name("  hello  ") == "hello"

    def test_empty_string(self):
        assert sanitize_name("") == ""

    def test_only_special_chars(self):
        assert sanitize_name("@#$%") == ""

    def test_preserves_alphanumeric(self):
        assert sanitize_name("abc123XYZ") == "abc123XYZ"

    def test_underscore_preserved(self):
        assert sanitize_name("DEV_Test_Scout") == "DEV_Test_Scout"


# ---------------------------------------------------------------------------
# build_schedule_name()
# ---------------------------------------------------------------------------

class TestBuildScheduleName:
    def test_known_pair_uuid(self):
        """UUID user ID produces correct schedule name."""
        result = build_schedule_name(
            "c6ac7e0c-35fd-48d0-9b76-7eb7acd48f2c",
            "DEV_Tromso Real estate",
        )
        assert result == "scout-c6ac7e0c-35f-255fcbd3-DEV_Tromso-Real-estate"

    def test_known_pair_prefixed_id(self):
        """MuckRock-style user_xxx ID strips prefix."""
        result = build_schedule_name("user_2abc3def", "Daily Zurich News")
        assert result == "scout-2abc3def-9b68f4c1-Daily-Zurich-News"

    def test_max_64_chars(self):
        """Output never exceeds 64 characters."""
        long_name = "A" * 200
        result = build_schedule_name("user_12345678", long_name)
        assert len(result) <= 64

    def test_strips_user_prefix(self):
        """'user_' prefix is removed from uid."""
        result = build_schedule_name("user_abcdef123456", "test")
        assert "user_" not in result
        assert result.startswith("scout-abcdef123456-")

    def test_empty_name_after_sanitize(self):
        """Falls back to uid+hash when name sanitizes to empty."""
        result = build_schedule_name("user_abc", "@#$%")
        # Name part is empty, so format is scout-{uid}-{hash}
        assert result.startswith("scout-abc-")
        assert result.count("-") == 2  # scout-abc-hash

    def test_deterministic(self):
        """Same inputs always produce the same output."""
        a = build_schedule_name("user-123", "test scout")
        b = build_schedule_name("user-123", "test scout")
        assert a == b

    def test_different_names_different_hashes(self):
        """Different scout names produce different hashes."""
        a = build_schedule_name("user-123", "scout A")
        b = build_schedule_name("user-123", "scout B")
        assert a != b

    def test_trailing_dash_stripped_from_truncated_name(self):
        """Name part doesn't end with a dash after truncation."""
        name = "A" * 44 + " "  # space becomes dash, giving 45 chars with trailing dash
        result = build_schedule_name("user_abc", name)
        assert not result.endswith("-")


# ---------------------------------------------------------------------------
# convert_floats_to_decimal()
# ---------------------------------------------------------------------------

class TestConvertFloatsToDecimal:
    def test_simple_float(self):
        result = convert_floats_to_decimal(3.14)
        assert result == Decimal("3.14")
        assert isinstance(result, Decimal)

    def test_nested_dict(self):
        data = {"lat": 59.95, "lng": 10.75}
        result = convert_floats_to_decimal(data)
        assert result == {"lat": Decimal("59.95"), "lng": Decimal("10.75")}

    def test_nested_list(self):
        data = [1.0, 2.5, 3.7]
        result = convert_floats_to_decimal(data)
        assert all(isinstance(v, Decimal) for v in result)

    def test_deeply_nested(self):
        data = {"location": {"coordinates": [59.95, 10.75]}}
        result = convert_floats_to_decimal(data)
        assert isinstance(result["location"]["coordinates"][0], Decimal)

    def test_preserves_non_float_types(self):
        data = {"name": "test", "count": 42, "active": True, "items": None}
        result = convert_floats_to_decimal(data)
        assert result == data

    def test_empty_dict(self):
        assert convert_floats_to_decimal({}) == {}

    def test_empty_list(self):
        assert convert_floats_to_decimal([]) == []

    def test_string_unchanged(self):
        assert convert_floats_to_decimal("hello") == "hello"


# ---------------------------------------------------------------------------
# convert_decimals() — reverse direction
# ---------------------------------------------------------------------------

class TestConvertDecimals:
    def test_decimal_with_fraction_to_float(self):
        result = convert_decimals(Decimal("3.14"))
        assert result == 3.14
        assert isinstance(result, float)

    def test_decimal_integer_to_int(self):
        result = convert_decimals(Decimal("42"))
        assert result == 42
        assert isinstance(result, int)

    def test_nested_dict(self):
        data = {"lat": Decimal("59.95"), "count": Decimal("5")}
        result = convert_decimals(data)
        assert result == {"lat": 59.95, "count": 5}

    def test_nested_list(self):
        data = [Decimal("1.0"), Decimal("2")]
        result = convert_decimals(data)
        assert result == [1.0, 2]


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
# sanitize_scout_name_for_sk()
# ---------------------------------------------------------------------------

class TestSanitizeScoutNameForSk:
    def test_replaces_hash(self):
        assert sanitize_scout_name_for_sk("test#name") == "test-name"

    def test_replaces_pipe(self):
        assert sanitize_scout_name_for_sk("test|name") == "test-name"

    def test_replaces_both(self):
        assert sanitize_scout_name_for_sk("a#b|c#d") == "a-b-c-d"

    def test_strips_whitespace(self):
        assert sanitize_scout_name_for_sk("  name  ") == "name"

    def test_preserves_other_chars(self):
        assert sanitize_scout_name_for_sk("my-scout_v2") == "my-scout_v2"

    def test_empty_string(self):
        assert sanitize_scout_name_for_sk("") == ""


# ---------------------------------------------------------------------------
# create_scout()
# ---------------------------------------------------------------------------

class TestCreateScout:
    @pytest.mark.asyncio
    async def test_writes_scraper_record_web(self, schedule_service, mock_scout_storage, mock_scheduler, mock_cron_schedule):
        mock_scout_storage.create_scout.return_value = {"scraper_name": "My Scout"}
        mock_scheduler.create_schedule.return_value = "arn:aws:scheduler:..."

        body = {
            "scout_type": "web",
            "url": "https://example.com",
            "criteria": "Breaking news",
            "regularity": "daily",
            "time": "10:00",
            "preferred_language": "en",
            "provider": "firecrawl_plain",
        }

        result = await schedule_service.create_scout("user-123", "My Scout", body, mock_cron_schedule)

        assert result["scraper_name"] == "My Scout"
        assert "schedule_name" in result

        # Verify storage adapter was called
        mock_scout_storage.create_scout.assert_called_once()
        call_args = mock_scout_storage.create_scout.call_args
        assert call_args[0][0] == "user-123"  # user_id
        item = call_args[0][1]
        assert item["scraper_name"] == "My Scout"
        assert item["scout_type"] == "web"
        assert item["url"] == "https://example.com"
        assert item["criteria"] == "Breaking news"
        assert item["provider"] == "firecrawl_plain"
        assert item["cron_expression"] == "0 10 * * ? *"
        assert item["timezone"] == "Europe/Oslo"

    @pytest.mark.skip(reason="AWS-specific (Decimal coercion for DynamoDB); v2 uses Supabase floats")
    @pytest.mark.asyncio
    async def test_writes_scraper_record_beat(self, schedule_service, mock_scout_storage, mock_scheduler, mock_cron_schedule):
        mock_scout_storage.create_scout.return_value = {"scraper_name": "Oslo News"}
        mock_scheduler.create_schedule.return_value = "arn:..."

        body = {
            "scout_type": "beat",
            "location": {"lat": 59.95, "lng": 10.75, "name": "Oslo"},
            "topic": "real estate",
            "criteria": "new listings",
            "regularity": "weekly",
            "time": "08:00",
            "source_mode": "niche",
            "excluded_domains": ["example.com"],
        }

        result = await schedule_service.create_scout("user-456", "Oslo News", body, mock_cron_schedule)

        call_args = mock_scout_storage.create_scout.call_args
        item = call_args[0][1]
        assert item["scout_type"] == "beat"
        assert item["topic"] == "real estate"
        assert item["criteria"] == "new listings"
        assert item["source_mode"] == "niche"
        assert item["excluded_domains"] == ["example.com"]
        # Location floats should be converted to Decimal
        assert isinstance(item["location"]["lat"], Decimal)

    @pytest.mark.skip(reason="AWS-specific (EventBridge lambda target); v2 uses pg_cron + Edge Functions")
    @pytest.mark.asyncio
    async def test_creates_eventbridge_schedule(self, schedule_service, mock_scout_storage, mock_scheduler, mock_cron_schedule):
        mock_scout_storage.create_scout.return_value = {"scraper_name": "Test"}
        mock_scheduler.create_schedule.return_value = "arn:..."

        body = {"scout_type": "web", "url": "https://example.com"}

        await schedule_service.create_scout("user-123", "Test", body, mock_cron_schedule)

        mock_scheduler.create_schedule.assert_called_once()
        call_args = mock_scheduler.create_schedule.call_args
        schedule_name = call_args[0][0]
        cron_expr = call_args[0][1]
        target_config = call_args[0][2]

        assert cron_expr == "cron(0 10 * * ? *)"
        assert target_config["lambda_arn"] == "arn:aws:lambda:eu-central-1:123:function:scraper"
        assert target_config["role_arn"] == "arn:aws:iam::123:role/eb-role"
        assert "input" in target_config

        # Input template should be valid JSON
        input_json = json.loads(target_config["input"])
        assert input_json["user_id"] == "user-123"
        assert input_json["scraper_name"] == "Test"

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
        mock_scout_storage.create_scout.return_value = {"scraper_name": "Beat"}
        mock_scheduler.create_schedule.return_value = "arn:..."
        body = {"scout_type": "beat", "location": {"lat": 59.95, "lng": 10.75}}

        result = await schedule_service.create_scout("user-123", "Beat", body, mock_cron_schedule)

        assert result["scraper_name"] == "Beat"

    @pytest.mark.asyncio
    async def test_writes_scraper_record_social(self, schedule_service, mock_scout_storage, mock_scheduler, mock_cron_schedule):
        """Social scout stores all type-specific fields including topic."""
        mock_scout_storage.create_scout.return_value = {"scraper_name": "NASA Monitor"}
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
        mock_scout_storage.create_scout.return_value = {"scraper_name": "X Scout"}
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
        mock_scout_storage.create_scout.return_value = {"scraper_name": "Housing Watch"}
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
        target_config = mock_scheduler.create_schedule.call_args[0][2]
        input_json = json.loads(target_config["input"])
        assert input_json["monitor_mode"] == "criteria"

    @pytest.mark.asyncio
    async def test_social_scout_legacy_omission_stays_summarize(
        self,
        schedule_service,
        mock_scout_storage,
        mock_scheduler,
        mock_cron_schedule,
    ):
        """Raw REST callers that omit both fields keep legacy summarize semantics."""
        mock_scout_storage.create_scout.return_value = {"scraper_name": "Council Digest"}
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
        target_config = mock_scheduler.create_schedule.call_args[0][2]
        input_json = json.loads(target_config["input"])
        assert input_json["monitor_mode"] == "summarize"

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
        mock_scout_storage.create_scout.return_value = {"scraper_name": "Web Topic"}
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
        mock_scout_storage.create_scout.return_value = {"scraper_name": "Web No Topic"}
        mock_scheduler.create_schedule.return_value = "arn:..."
        body = {
            "scout_type": "web",
            "url": "https://example.com",
        }

        await schedule_service.create_scout("user-1", "Web No Topic", body, mock_cron_schedule)

        call_args = mock_scout_storage.create_scout.call_args
        item = call_args[0][1]
        assert "topic" not in item

    @pytest.mark.asyncio
    async def test_eventbridge_input_includes_topic_all_types(self, schedule_service, mock_scout_storage, mock_scheduler, mock_cron_schedule):
        """EventBridge input template includes topic for all scout types."""
        mock_scout_storage.create_scout.return_value = {}
        mock_scheduler.create_schedule.return_value = "arn:..."

        for scout_type, extra_fields in [
            ("web", {"url": "https://example.com"}),
            ("beat", {"location": {"lat": 59.95, "lng": 10.75}}),
            ("social", {"platform": "instagram", "profile_handle": "test"}),
        ]:
            mock_scheduler.reset_mock()
            body = {"scout_type": scout_type, "topic": "MyTopic", **extra_fields}

            await schedule_service.create_scout("user-1", f"{scout_type}-scout", body, mock_cron_schedule)

            call_args = mock_scheduler.create_schedule.call_args
            target_config = call_args[0][2]
            input_json = json.loads(target_config["input"])
            assert input_json["topic"] == "MyTopic", (
                f"EventBridge input missing topic for {scout_type} scout"
            )


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
        mock_scout_storage.delete_scout.return_value = {
            "message": "Scout deleted successfully",
            "scraper_name": "MyScout",
            "records_deleted": {"time": 1, "seen": 1, "exec": 1},
        }

        result = await schedule_service.delete_scout("user-1", "MyScout")

        # EventBridge schedule deleted
        mock_scheduler.delete_schedule.assert_called_once()
        schedule_name = mock_scheduler.delete_schedule.call_args[0][0]
        assert "scout" in schedule_name.lower() or "MyScout" in schedule_name or "user" in schedule_name.lower()

        # Storage adapter called
        mock_scout_storage.delete_scout.assert_called_once_with("user-1", "MyScout")

        assert result["scraper_name"] == "MyScout"
        assert result["records_deleted"]["time"] == 1

    @pytest.mark.asyncio
    async def test_handles_schedule_not_found(self, schedule_service, mock_scout_storage, mock_scheduler):
        """Should not raise when scheduler delete is a no-op (adapter handles it)."""
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
        mock_scout_storage.create_scout.return_value = {"scraper_name": "City Budget"}
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
        mock_scout_storage.create_scout.return_value = {"scraper_name": "Minimal Civic"}
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
        mock_scout_storage.delete_scout.return_value = {
            "message": "Scout deleted successfully",
            "scraper_name": "CivicScout",
            "records_deleted": {"time": 0, "seen": 0, "exec": 0},
        }

        result = await schedule_service.delete_scout("user-1", "CivicScout")

        assert result["scraper_name"] == "CivicScout"
        mock_scout_storage.delete_scout.assert_called_once_with("user-1", "CivicScout")
        mock_scheduler.delete_schedule.assert_called_once()
