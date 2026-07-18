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


class TestStoreUnits:
    @pytest.mark.asyncio
    async def test_stores_multiple_units(self, storage, mock_pool):
        mock_pool.executemany = AsyncMock()

        units = [
            {
                "statement": "City council approved new budget",
                "type": "fact",
                "entities": ["city council"],
                "embedding": [0.1] * 768,
                "source_url": "https://example.com/article",
                "source_domain": "example.com",
                "source_title": "Budget News",
                "country": "US",
                "state": "CA",
                "city": "San Francisco",
                "topic": "government",
            },
            {
                "statement": "New park opening next month",
                "type": "event",
                "entities": ["parks department"],
                "embedding": [0.2] * 768,
                "source_url": "https://example.com/parks",
                "source_domain": "example.com",
                "source_title": "Park News",
                "country": "US",
                "state": "CA",
                "city": "San Francisco",
                "topic": "community",
            },
        ]

        await storage.store_units("user-1", str(uuid.uuid4()), units)
        mock_pool.executemany.assert_called_once()

    @pytest.mark.asyncio
    async def test_stores_empty_list_without_error(self, storage, mock_pool):
        await storage.store_units("user-1", str(uuid.uuid4()), [])
        mock_pool.executemany.assert_not_called()


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


class TestGetUnitsByLocation:
    @pytest.mark.asyncio
    async def test_returns_units_by_location(self, storage, mock_pool):
        mock_pool.fetch = AsyncMock(return_value=[
            {"id": uuid.uuid4(), "statement": "Local news", "country": "US"},
        ])

        result = await storage.get_units_by_location("user-1", "US", state="CA", city="SF")
        assert len(result) == 1


class TestGetUnitsByTopic:
    @pytest.mark.asyncio
    async def test_returns_units_by_topic(self, storage, mock_pool):
        mock_pool.fetch = AsyncMock(return_value=[
            {"id": uuid.uuid4(), "statement": "Government update", "topic": "government"},
        ])

        result = await storage.get_units_by_topic("user-1", "government")
        assert len(result) == 1


class TestGetDistinctLocations:
    @pytest.mark.asyncio
    async def test_returns_distinct_locations(self, storage, mock_pool):
        mock_pool.fetch = AsyncMock(return_value=[
            {"country": "US", "state": "CA", "city": "San Francisco"},
            {"country": "US", "state": "NY", "city": "New York"},
        ])

        result = await storage.get_distinct_locations("user-1")
        assert len(result) == 2


class TestGetDistinctTopics:
    @pytest.mark.asyncio
    async def test_returns_distinct_topics(self, storage, mock_pool):
        mock_pool.fetch = AsyncMock(return_value=[
            {"topic": "government"},
            {"topic": "community"},
        ])

        result = await storage.get_distinct_topics("user-1")
        assert result == ["government", "community"]


class TestGetUnitsForArticle:
    @pytest.mark.asyncio
    async def test_returns_units_for_article(self, storage, mock_pool):
        article_id = str(uuid.uuid4())
        mock_pool.fetch = AsyncMock(return_value=[
            {"id": uuid.uuid4(), "statement": "Fact 1", "article_id": article_id},
        ])

        result = await storage.get_units_for_article(article_id)
        assert len(result) == 1


class TestStoreUnitsDateConversion:
    """#36: String dates should be converted to datetime.date for asyncpg."""

    @pytest.mark.asyncio
    async def test_converts_string_date_to_date_object(self, storage, mock_pool):
        mock_pool.executemany = AsyncMock()

        await storage.store_units("user-1", "scout-1", [{
            "statement": "Test fact",
            "type": "fact",
            "event_date": "2026-04-01",  # String date
            "source_url": "https://example.com",
        }])

        records = mock_pool.executemany.call_args[0][1]
        from datetime import date
        # event_date is at index 12 after embedding_model_v2.
        event_date = records[0][12]
        assert isinstance(event_date, date)
        assert event_date == date(2026, 4, 1)

    @pytest.mark.asyncio
    async def test_handles_none_event_date(self, storage, mock_pool):
        mock_pool.executemany = AsyncMock()

        await storage.store_units("user-1", "scout-1", [{
            "statement": "Test fact",
            "type": "fact",
            "event_date": None,
        }])

        records = mock_pool.executemany.call_args[0][1]
        assert records[0][12] is None

    @pytest.mark.asyncio
    async def test_handles_invalid_date_string(self, storage, mock_pool):
        mock_pool.executemany = AsyncMock()

        await storage.store_units("user-1", "scout-1", [{
            "statement": "Test fact",
            "type": "fact",
            "event_date": "not-a-date",
        }])

        records = mock_pool.executemany.call_args[0][1]
        assert records[0][12] is None  # Invalid date -> None


class TestStoreUnitsArticleId:
    """#32: Empty article_id should be converted to None for UUID cast."""

    @pytest.mark.asyncio
    async def test_converts_empty_article_id_to_none(self, storage, mock_pool):
        mock_pool.executemany = AsyncMock()

        await storage.store_units("user-1", "scout-1", [{
            "statement": "Test fact",
            "type": "fact",
            "article_id": "",  # Empty string
        }])

        records = mock_pool.executemany.call_args[0][1]
        assert records[0][3] is None  # article_id at index 3

    @pytest.mark.asyncio
    async def test_preserves_valid_article_id(self, storage, mock_pool):
        mock_pool.executemany = AsyncMock()

        article_id = str(uuid.uuid4())
        await storage.store_units("user-1", "scout-1", [{
            "statement": "Test fact",
            "type": "fact",
            "article_id": article_id,
        }])

        records = mock_pool.executemany.call_args[0][1]
        assert records[0][3] == article_id


class TestMarkUsed:
    @pytest.mark.asyncio
    async def test_marks_units_as_used(self, storage, mock_pool):
        mock_pool.execute = AsyncMock(return_value="UPDATE 3")

        unit_keys = [
            (f"USER#u1#LOC#US#CA#LA", f"UNIT#1234#{uuid.uuid4()}")
            for _ in range(3)
        ]
        await storage.mark_used(unit_keys)
        mock_pool.execute.assert_called_once()
