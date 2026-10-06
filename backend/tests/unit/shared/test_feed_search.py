"""
Tests for FeedSearchService.

Verifies:
1. search_semantic() includes topic in output and degrades to an empty result
2. get_user_locations() / get_user_topics() delegate to storage (topics sorted)
"""
import pytest
from unittest.mock import AsyncMock, patch

from app.services.feed_search_service import FeedSearchService
from app.schemas.scouts import GeocodedLocation


def _make_service():
    """Create a FeedSearchService with a mock storage adapter."""
    mock_storage = AsyncMock()
    service = FeedSearchService(unit_storage=mock_storage)
    return service, mock_storage


class TestSearchSemanticTopic:
    """Test that search_semantic() includes topic in returned dicts."""

    @pytest.mark.asyncio
    async def test_topic_included_in_search_results(self):
        service, mock_storage = _make_service()

        fake_embedding = [0.1] * 256
        fake_compressed = b"fake"

        mock_storage.search_units.return_value = [
            {
                "unit_id": "u3",
                "article_id": "a3",
                "pk": "USER#x#LOC#NO#_#_",
                "sk": "UNIT#789#u3",
                "statement": "climate change impacts",
                "unit_type": "fact",
                "entities": [],
                "source_url": "https://example.com",
                "source_domain": "example.com",
                "source_title": "Example",
                "additional_sources": [],
                "scout_type": "beat",
                "scout_id": "s1",
                "created_at": "2026-02-19",
                "used_in_article": False,
                "topic": "Climate",
                "embedding_compressed": fake_compressed,
            }
        ]

        with patch(
            "app.services.feed_search_service.generate_embedding",
            new_callable=AsyncMock,
            return_value=fake_embedding,
        ), patch(
            "app.services.feed_search_service.decompress_embedding",
            return_value=fake_embedding,
        ), patch(
            "app.services.feed_search_service.cosine_similarity",
            return_value=0.85,
        ):
            location = GeocodedLocation(
                displayName="Norway", city=None, state=None, country="NO", coordinates=None
            )

            result = await service.search_semantic("user_123", "climate", location=location)

            assert len(result["units"]) == 1
            assert result["units"][0]["topic"] == "Climate"

    @pytest.mark.asyncio
    async def test_embedding_failure_preserves_empty_semantic_search_response(self):
        service, mock_storage = _make_service()

        with patch(
            "app.services.feed_search_service.generate_embedding",
            new_callable=AsyncMock,
            side_effect=RuntimeError("provider unavailable"),
        ):
            result = await service.search_semantic("user_123", "climate")

        assert result == {"units": [], "count": 0, "query": "climate"}
        mock_storage.search_units.assert_not_awaited()


# ===========================================================================
# Filter tests — verify storage is called correctly
# ===========================================================================


class TestGetUserLocationsExcludesUsed:
    """get_user_locations() should delegate to storage."""

    @pytest.mark.asyncio
    async def test_returns_locations_from_storage(self):
        service, mock_storage = _make_service()
        mock_storage.get_distinct_locations.return_value = ["NO#_#_"]

        locations = await service.get_user_locations("user_123")
        assert len(locations) == 1
        mock_storage.get_distinct_locations.assert_called_once_with("user_123")

        mock_storage.get_distinct_locations.return_value = []
        assert await service.get_user_locations("user_123") == []


class TestGetUserTopicsExcludesUsed:
    """get_user_topics() should delegate to storage and sort."""

    @pytest.mark.asyncio
    async def test_returns_sorted_topics(self):
        service, mock_storage = _make_service()
        mock_storage.get_distinct_topics.return_value = ["Zoning", "Agriculture", "Climate"]

        topics = await service.get_user_topics("user_123")
        assert topics == ["Agriculture", "Climate", "Zoning"]

        mock_storage.get_distinct_topics.return_value = []
        assert await service.get_user_topics("user_123") == []
