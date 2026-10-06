"""Tests for SupabaseScoutStorage."""

import uuid
from datetime import datetime as dt
from unittest.mock import AsyncMock, patch

import pytest

from app.adapters.supabase.scout_storage import SupabaseScoutStorage


@pytest.fixture
def mock_pool():
    pool = AsyncMock()
    return pool


@pytest.fixture
def storage(mock_pool):
    with patch("app.adapters.supabase.scout_storage.get_pool", return_value=mock_pool):
        s = SupabaseScoutStorage()
        s.pool = mock_pool
    return s


class TestListScoutsEnrichment:
    """Tests for list_scouts enrichment with last_run and latest_execution."""

    @pytest.mark.asyncio
    async def test_enriches_with_last_run(self, storage, mock_pool):
        """#40: list_scouts should include last_run data from scout_runs."""
        scout_id = uuid.uuid4()
        started = dt(2026, 4, 1, 20, 29, 52)

        mock_pool.fetch = AsyncMock(side_effect=[
            # Scouts
            [{"id": scout_id, "name": "scout-1", "type": "beat",
              "created_at": "2026-04-01T10:00:00"}],
            # Runs
            [{"scout_id": scout_id, "status": "success", "scraper_status": True,
              "criteria_status": False, "notification_sent": True,
              "articles_count": 5, "error_message": None,
              "started_at": started, "completed_at": started}],
            # Executions
            [],
        ])

        result = await storage.list_scouts("user-1")
        assert result[0]["last_run"] is not None
        assert result[0]["last_run"]["status"] == "success"
        assert result[0]["last_run"]["last_run"] == "04-01-2026 20:29"  # #45 format

    @pytest.mark.asyncio
    async def test_enriches_with_card_summary(self, storage, mock_pool):
        """#44: list_scouts should include card_summary from execution records."""
        scout_id = uuid.uuid4()
        completed = dt(2026, 4, 1, 20, 30, 0)

        mock_pool.fetch = AsyncMock(side_effect=[
            [{"id": scout_id, "name": "scout-1", "type": "web",
              "created_at": "2026-04-01T10:00:00"}],
            [],
            [{"scout_id": scout_id, "summary_text": "No changes detected",
              "is_duplicate": True, "completed_at": completed}],
        ])

        result = await storage.list_scouts("user-1")
        assert result[0]["card_summary"] == "No changes detected"

    @pytest.mark.asyncio
    async def test_normalizes_field_names(self, storage, mock_pool):
        """#34: Output should include both PG and DynamoDB field names."""
        scout_id = uuid.uuid4()
        mock_pool.fetch = AsyncMock(side_effect=[
            [{"id": scout_id, "name": "test", "type": "beat",
              "schedule_cron": "0 8 * * *", "schedule_timezone": "Europe/Zurich",
              "created_at": "2026-04-01T10:00:00"}],
            [], [],
        ])

        result = await storage.list_scouts("user-1")
        scout = result[0]
        # PostgreSQL names
        assert scout["name"] == "test"
        assert scout["type"] == "beat"
        assert scout["schedule_cron"] == "0 8 * * *"
        # DynamoDB aliases
        assert scout["scraper_name"] == "test"
        assert scout["scout_type"] == "beat"
        assert scout["cron_expression"] == "0 8 * * *"
        assert scout["timezone"] == "Europe/Zurich"
        # No runs or executions yet
        assert scout["last_run"] is None
        assert scout["latest_execution"] is None
