"""Tests for SupabaseUnitStorage."""

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest

from app.adapters.supabase.unit_storage import SupabaseUnitStorage


@pytest.fixture
def mock_pool():
    return AsyncMock()


@pytest.fixture
def storage(mock_pool):
    s = SupabaseUnitStorage()
    s.pool = mock_pool
    return s


class TestSearchUnits:
    @pytest.mark.asyncio
    async def test_semantic_search_returns_ranked_results(self, storage, mock_pool):
        mock_pool.fetch = AsyncMock(return_value=[
            {
                "id": uuid.uuid4(),
                "statement": "Council voted on budget",
                "type": "fact",
                "similarity": 0.92,
                "source_url": "https://example.com/1",
                "created_at": datetime.now(timezone.utc),
            },
        ])

        query_embedding = [0.1] * 768
        result = await storage.search_units("user-1", query_embedding, limit=20)
        assert len(result) == 1
        assert result[0]["similarity"] == 0.92

    @pytest.mark.asyncio
    async def test_search_with_topic_filter(self, storage, mock_pool):
        mock_pool.fetch = AsyncMock(return_value=[])

        query_embedding = [0.1] * 768
        result = await storage.search_units(
            "user-1", query_embedding, filters={"topic": "government"}, limit=10
        )
        assert result == []
        # Verify the query included a topic filter
        call_sql = mock_pool.fetch.call_args[0][0]
        assert "topic" in call_sql


class TestGetDistinctTopics:
    @pytest.mark.asyncio
    async def test_returns_distinct_topics(self, storage, mock_pool):
        mock_pool.fetch = AsyncMock(return_value=[
            {"topic": "government"},
            {"topic": "community"},
        ])

        result = await storage.get_distinct_topics("user-1")
        assert result == ["government", "community"]
