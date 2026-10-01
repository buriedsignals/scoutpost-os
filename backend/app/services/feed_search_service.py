"""
Feed Search Service

PURPOSE: All Feed panel queries — location listing, topic listing, unit
retrieval, semantic search, and mark-as-used. The single service backing
the /api/units/* router endpoints.

DEPENDS ON: schemas/scouts (GeocodedLocation),
    embedding_utils (generate_embedding, cosine_similarity, decompress_embedding)
USED BY: routers/units.py

Delegates all storage to the UnitStoragePort adapter (Supabase PostgreSQL).
"""
import logging
from typing import Optional

from app.schemas.scouts import GeocodedLocation
from app.services.embedding_utils import generate_embedding, cosine_similarity, decompress_embedding

logger = logging.getLogger(__name__)


class FeedSearchService:
    """Search information units for the Feed panel."""

    def __init__(self, unit_storage=None):
        if unit_storage is None:
            from app.dependencies.providers import get_unit_storage
            unit_storage = get_unit_storage()
        self.storage = unit_storage

    async def search_semantic(
        self,
        user_id: str,
        query: str,
        location: Optional[GeocodedLocation] = None,
        topic: Optional[str] = None,
        limit: int = 20,
        min_similarity: float = 0.3,
    ) -> dict:
        """
        Semantic search across user's information units.

        If location provided: search that location only
        If no location: search all user's units via GSI

        Returns:
            Dict with units list (includes similarity_score), count, and query
        """
        try:
            query_embedding = await generate_embedding(query, "RETRIEVAL_QUERY")

            # Build filters for the adapter
            filters = {"user_id": user_id}
            if location:
                filters["location"] = location
            if topic:
                filters["topic"] = topic

            raw_units = await self.storage.search_units(
                user_id=user_id,
                query_embedding=query_embedding,
                filters=filters,
                limit=200,
            )

            scored_units = []
            for item in raw_units:
                if item.get("used_in_article"):
                    continue

                compressed = item.get("embedding_compressed")
                if not compressed:
                    continue

                stored_embedding = decompress_embedding(compressed)
                similarity = cosine_similarity(query_embedding, stored_embedding)
                statement = item.get("statement", "")
                text_match = query.lower() in statement.lower()

                if similarity >= min_similarity or text_match:
                    final_score = max(similarity, min_similarity) if text_match else similarity
                    scored_units.append({
                        "unit_id": item["unit_id"],
                        "article_id": item.get("article_id", ""),
                        "pk": item.get("pk", item.get("PK", "")),
                        "sk": item.get("sk", item.get("SK", "")),
                        "statement": statement,
                        "unit_type": item.get("unit_type", "fact"),
                        "entities": item.get("entities", []),
                        "source_url": item.get("source_url", ""),
                        "source_domain": item.get("source_domain", ""),
                        "source_title": item.get("source_title", ""),
                        "additional_sources": item.get("additional_sources", []),
                        "scout_type": item.get("scout_type", ""),
                        "scout_id": item.get("scout_id", ""),
                        "created_at": item.get("created_at", ""),
                        "used_in_article": False,
                        "topic": item.get("topic", ""),
                        "date": item.get("date") or item.get("date_value"),
                        "similarity_score": round(final_score, 3),
                    })

            scored_units.sort(key=lambda x: x["similarity_score"], reverse=True)
            result_units = scored_units[:limit]

            logger.info(f"Semantic search '{query[:30]}' found {len(result_units)} units")
            return {"units": result_units, "count": len(result_units), "query": query}

        except Exception as e:
            logger.error(f"Semantic search failed: {e}")
            return {"units": [], "count": 0, "query": query}

    async def get_all_unused_units(self, user_id: str, limit: int = 50) -> list[dict]:
        """Get all unused units for a user (no location/topic filter), newest first."""
        try:
            return await self.storage.get_all_unused_units(user_id, limit=limit)
        except Exception as e:
            logger.error(f"Failed to get all unused units for {user_id}: {e}")
            return []

    # =========================================================================
    # Compose Panel Queries
    # =========================================================================

    async def get_units_by_location(
        self,
        user_id: str,
        location: GeocodedLocation,
        limit: int = 50,
    ) -> list[dict]:
        """Query atomic units for Compose panel (newest first)."""
        try:
            return await self.storage.get_units_by_location(
                user_id=user_id,
                country=location.country,
                state=location.state,
                city=location.city,
                limit=limit,
            )
        except Exception as e:
            logger.error(f"Failed to query units: {e}")
            return []

    async def get_units_by_article(self, article_id: str) -> list[dict]:
        """Get all units from a specific article."""
        try:
            return await self.storage.get_units_for_article(article_id)
        except Exception as e:
            logger.error(f"Failed to query units by article: {e}")
            return []

    async def get_user_locations(self, user_id: str) -> list[str]:
        """Get distinct locations for user's Compose dropdown."""
        try:
            locations = await self.storage.get_distinct_locations(user_id)
            # Adapter returns list of dicts or strings — normalise to strings
            result = []
            for loc in locations:
                if isinstance(loc, dict):
                    # e.g. {"country": "NO", "state": "_", "city": "_"}
                    result.append(f"{loc.get('country', '')}#{loc.get('state', '_')}#{loc.get('city', '_')}")
                else:
                    result.append(str(loc))
            return result
        except Exception as e:
            logger.error(f"Failed to get user locations: {e}")
            return []

    async def get_user_topics(self, user_id: str) -> list[str]:
        """Get distinct topics for user's Compose dropdown."""
        try:
            topics = await self.storage.get_distinct_topics(user_id)
            return sorted(topics)
        except Exception as e:
            logger.error(f"Failed to get user topics: {e}")
            return []

    async def get_units_by_topic(self, user_id: str, topic: str, limit: int = 50) -> dict:
        """Get information units for a specific topic."""
        try:
            units = await self.storage.get_units_by_topic(user_id=user_id, topic=topic, limit=limit)
            return {"units": units, "count": len(units)}
        except Exception as e:
            logger.error(f"Failed to get units by topic: {e}")
            return {"units": [], "count": 0}

    async def get_units_by_scout(
        self, user_id: str, scout_name: str, limit: int = 50
    ) -> list[dict]:
        """Query scout-units-index GSI for units produced by a specific scout."""
        try:
            return await self.storage.get_units_by_scout(
                user_id=user_id, scout_id=scout_name, limit=limit
            )
        except Exception as e:
            logger.error(f"Failed to get units by scout {scout_name} for {user_id}: {e}")
            return []

    async def mark_used_in_article(self, unit_keys: list[tuple[str, str]]) -> int:
        """Mark units as used in article (sets 60-day TTL)."""
        if not unit_keys:
            return 0

        try:
            await self.storage.mark_used(unit_keys)
            marked_count = len(unit_keys)
            logger.info(f"Marked {marked_count}/{len(unit_keys)} units as used (60-day TTL)")
            return marked_count
        except Exception as e:
            logger.error(f"Failed to mark units as used: {e}")
            return 0


# Module-level singleton — lazy init (None until first use)
feed_search_service = None
