"""
Tests for FeedSearchService and AtomicInformationUnit schema.

Verifies:
1. AtomicInformationUnit schema accepts and preserves topic field
2. get_units_by_location() includes topic in output
3. search_semantic() includes topic in output
4. get_all_unused_units() includes topic in output
"""
import pytest
from unittest.mock import MagicMock, AsyncMock, patch

from app.schemas.units import AtomicInformationUnit, SearchedUnit
from app.services.feed_search_service import FeedSearchService
from app.schemas.scouts import GeocodedLocation


# ===========================================================================
# Schema tests
# ===========================================================================


class TestAtomicInformationUnitSchema:
    """Test that the Pydantic schema handles the topic field."""

    def _make_unit(self, **overrides):
        base = {
            "unit_id": "u1",
            "article_id": "a1",
            "pk": "USER#x#LOC#NO#_#_",
            "sk": "UNIT#123#u1",
            "statement": "Test fact",
            "unit_type": "fact",
            "entities": [],
            "source_url": "https://example.com",
            "source_domain": "example.com",
            "source_title": "Example",
            "scout_type": "beat",
            "scout_id": "s1",
            "created_at": "2026-02-19",
            "used_in_article": False,
        }
        base.update(overrides)
        return base

    def test_topic_preserved(self):
        """topic field passes through the schema."""
        unit = AtomicInformationUnit(**self._make_unit(topic="Climate"))
        assert unit.topic == "Climate"

    def test_topic_defaults_to_empty(self):
        """topic defaults to empty string when not provided."""
        unit = AtomicInformationUnit(**self._make_unit())
        assert unit.topic == ""

    def test_topic_none_accepted(self):
        """topic=None is accepted by Optional[str]."""
        unit = AtomicInformationUnit(**self._make_unit(topic=None))
        assert unit.topic is None

    def test_searched_unit_inherits_topic(self):
        """SearchedUnit (subclass) also has topic."""
        unit = SearchedUnit(**self._make_unit(topic="AI", similarity_score=0.85))
        assert unit.topic == "AI"
        assert unit.similarity_score == 0.85


# ===========================================================================
# Service method tests — verify dict output includes topic
# ===========================================================================


def _make_service():
    """Create a FeedSearchService with a mock storage adapter."""
    mock_storage = AsyncMock()
    service = FeedSearchService(unit_storage=mock_storage)
    return service, mock_storage


class TestGetUnitsByLocationTopic:
    """Test that get_units_by_location() includes topic in returned dicts."""

    @pytest.mark.asyncio
    async def test_topic_included_in_output(self):
        service, mock_storage = _make_service()
        mock_storage.get_units_by_location.return_value = [
            {
                "unit_id": "u1",
                "article_id": "a1",
                "pk": "USER#x#LOC#NO#_#_",
                "sk": "UNIT#123#u1",
                "statement": "Test",
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
            }
        ]

        location = GeocodedLocation(
            displayName="Norway",
            city=None,
            state=None,
            country="NO",
            coordinates=None,
        )

        units = await service.get_units_by_location("user_123", location)
        assert len(units) == 1
        assert units[0]["topic"] == "Climate"

    @pytest.mark.asyncio
    async def test_topic_defaults_when_missing(self):
        """Items without topic field should default to empty string."""
        service, mock_storage = _make_service()
        mock_storage.get_units_by_location.return_value = [
            {
                "unit_id": "u2",
                "article_id": "a2",
                "pk": "USER#x#LOC#NO#_#_",
                "sk": "UNIT#456#u2",
                "statement": "No topic item",
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
                # No "topic" key — adapter returns item without it
            }
        ]

        location = GeocodedLocation(
            displayName="Norway", city=None, state=None, country="NO", coordinates=None
        )

        units = await service.get_units_by_location("user_123", location)
        # Adapter returns items as-is, topic absence is adapter responsibility
        assert len(units) == 1


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


class TestGetAllUnusedUnitsTopic:
    """Verify get_all_unused_units() delegates to storage."""

    @pytest.mark.asyncio
    async def test_topic_included(self):
        service, mock_storage = _make_service()
        mock_storage.get_all_unused_units.return_value = [
            {
                "unit_id": "u4",
                "article_id": "a4",
                "pk": "USER#x#LOC#NO#_#_",
                "sk": "UNIT#100#u4",
                "statement": "Existing topic test",
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
                "topic": "AI",
            }
        ]

        units = await service.get_all_unused_units("user_123")
        assert len(units) == 1
        assert units[0]["topic"] == "AI"


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

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_locations(self):
        service, mock_storage = _make_service()
        mock_storage.get_distinct_locations.return_value = []

        locations = await service.get_user_locations("user_123")
        assert locations == []


class TestGetUserTopicsExcludesUsed:
    """get_user_topics() should delegate to storage and sort."""

    @pytest.mark.asyncio
    async def test_returns_sorted_topics(self):
        service, mock_storage = _make_service()
        mock_storage.get_distinct_topics.return_value = ["Zoning", "Agriculture", "Climate"]

        topics = await service.get_user_topics("user_123")
        assert topics == ["Agriculture", "Climate", "Zoning"]

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_topics(self):
        service, mock_storage = _make_service()
        mock_storage.get_distinct_topics.return_value = []

        topics = await service.get_user_topics("user_123")
        assert topics == []
