"""Supabase implementation of UnitStoragePort.

Uses asyncpg with pgvector for semantic search over information units.
Units are inserted by Supabase Edge Functions; this adapter handles
multi-dimensional filtering (location, topic), vector similarity search, and
marking units as used.

DEPENDS ON: connection (get_pool), ports.storage (UnitStoragePort)
USED BY: dependencies/providers.py (DI wiring)
"""
from __future__ import annotations

import json
import logging
from typing import Optional

from app.adapters.supabase.connection import get_pool
from app.adapters.supabase.utils import row_to_dict
from app.ports.storage import UnitStoragePort
from app.services.embedding_utils import EMBEDDING_MODEL_TAG

logger = logging.getLogger(__name__)

# UnitStorage needs article_id in UUID conversion
_UNIT_UUID_FIELDS = ("id", "user_id", "scout_id", "article_id")


class SupabaseUnitStorage(UnitStoragePort):
    """PostgreSQL-backed information unit storage with pgvector semantic search."""

    def __init__(self):
        self.pool = None

    async def _ensure_pool(self):
        if self.pool is None:
            self.pool = await get_pool()

    async def search_units(self, user_id: str, query_embedding: list[float],
                            filters: dict = None, limit: int = 20) -> list[dict]:
        """Semantic search using pgvector cosine similarity.

        Optionally filters by topic. Returns results ranked by similarity.
        """
        await self._ensure_pool()

        embedding_str = f"[{','.join(str(v) for v in query_embedding)}]"
        filters = filters or {}

        # Build WHERE clause dynamically
        conditions = [
            "user_id = $1::uuid",
            "embedding_v2 IS NOT NULL",
            "embedding_model_v2 = $2",
        ]
        params: list = [user_id, EMBEDDING_MODEL_TAG]
        idx = 3

        if "topic" in filters:
            conditions.append(f"topic = ${idx}")
            params.append(filters["topic"])
            idx += 1

        if "scout_id" in filters:
            conditions.append(f"scout_id = ${idx}::uuid")
            params.append(filters["scout_id"])
            idx += 1

        params.append(embedding_str)
        embedding_param = f"${idx}"
        idx += 1

        params.append(limit)
        limit_param = f"${idx}"

        where_clause = " AND ".join(conditions)

        rows = await self.pool.fetch(
            f"""
            SELECT id, user_id, scout_id, scout_type, article_id,
                   statement, type, entities, source_url, source_domain,
                   source_title, event_date, country, state, city, topic,
                   used_in_article, created_at,
                   1 - (embedding_v2 <=> {embedding_param}::vector) AS similarity
            FROM information_units
            WHERE {where_clause}
            ORDER BY embedding_v2 <=> {embedding_param}::vector
            LIMIT {limit_param}
            """,
            *params,
        )
        return [row_to_dict(row, _UNIT_UUID_FIELDS) for row in rows]

    async def get_units_for_article(self, article_id: str) -> list[dict]:
        """Get all information units associated with an article."""
        await self._ensure_pool()
        rows = await self.pool.fetch(
            """
            SELECT id, user_id, scout_id, scout_type, article_id,
                   statement, type, entities, source_url, source_domain,
                   source_title, event_date, country, state, city, topic,
                   used_in_article, created_at
            FROM information_units
            WHERE article_id = $1::uuid
            ORDER BY created_at DESC
            """,
            article_id,
        )
        return [row_to_dict(row, _UNIT_UUID_FIELDS) for row in rows]

    async def get_units_by_location(self, user_id: str, country: str,
                                     state: str = None, city: str = None,
                                     limit: int = 50) -> list[dict]:
        """Get information units filtered by location hierarchy."""
        await self._ensure_pool()

        conditions = ["user_id = $1::uuid", "country = $2"]
        params: list = [user_id, country]
        idx = 3

        if state:
            conditions.append(f"state = ${idx}")
            params.append(state)
            idx += 1

        if city:
            conditions.append(f"city = ${idx}")
            params.append(city)
            idx += 1

        params.append(limit)
        limit_param = f"${idx}"

        where_clause = " AND ".join(conditions)

        rows = await self.pool.fetch(
            f"""
            SELECT id, user_id, scout_id, scout_type, article_id,
                   statement, type, entities, source_url, source_domain,
                   source_title, event_date, country, state, city, topic,
                   used_in_article, created_at
            FROM information_units
            WHERE {where_clause}
            ORDER BY created_at DESC
            LIMIT {limit_param}
            """,
            *params,
        )
        return [row_to_dict(row, _UNIT_UUID_FIELDS) for row in rows]

    async def get_units_by_topic(self, user_id: str, topic: str,
                                  limit: int = 50) -> list[dict]:
        """Get information units filtered by topic."""
        await self._ensure_pool()
        rows = await self.pool.fetch(
            """
            SELECT id, user_id, scout_id, scout_type, article_id,
                   statement, type, entities, source_url, source_domain,
                   source_title, event_date, country, state, city, topic,
                   used_in_article, created_at
            FROM information_units
            WHERE user_id = $1::uuid AND topic = $2
            ORDER BY created_at DESC
            LIMIT $3
            """,
            user_id, topic, limit,
        )
        return [row_to_dict(row, _UNIT_UUID_FIELDS) for row in rows]

    async def get_distinct_locations(self, user_id: str) -> list[dict]:
        """Get distinct location combinations for a user's units."""
        await self._ensure_pool()
        rows = await self.pool.fetch(
            """
            SELECT DISTINCT country, state, city
            FROM information_units
            WHERE user_id = $1::uuid
                AND country IS NOT NULL
            ORDER BY country, state, city
            """,
            user_id,
        )
        return [dict(row) for row in rows]

    async def get_distinct_topics(self, user_id: str) -> list[str]:
        """Get distinct topics for a user's units."""
        await self._ensure_pool()
        rows = await self.pool.fetch(
            """
            SELECT DISTINCT topic
            FROM information_units
            WHERE user_id = $1::uuid
                AND topic IS NOT NULL
            ORDER BY topic
            """,
            user_id,
        )
        return [row["topic"] for row in rows]

    async def mark_used(self, unit_keys: list[tuple[str, str]]) -> None:
        """Mark information units as used in an article."""
        await self._ensure_pool()
        if not unit_keys:
            return
        # Extract unit_ids from SK: UNIT#{timestamp}#{unit_id}
        unit_ids = []
        for _pk, sk in unit_keys:
            parts = sk.split("#")
            unit_ids.append(parts[-1] if len(parts) >= 3 else sk)
        # Build parameterized IN clause with UUID casts
        placeholders = ", ".join(f"${i+1}::uuid" for i in range(len(unit_ids)))
        await self.pool.execute(
            f"""
            UPDATE information_units
            SET used_in_article = TRUE
            WHERE id IN ({placeholders})
            """,
            *unit_ids,
        )

    async def get_all_unused_units(self, user_id: str, limit: int = 50) -> list[dict]:
        """Get all unused information units for a user."""
        await self._ensure_pool()
        rows = await self.pool.fetch(
            """
            SELECT id, user_id, scout_id, scout_type, article_id,
                   statement, type, entities, source_url, source_domain,
                   source_title, event_date, country, state, city, topic,
                   used_in_article, created_at
            FROM information_units
            WHERE user_id = $1::uuid AND used_in_article = FALSE
            ORDER BY created_at DESC
            LIMIT $2
            """,
            user_id, limit,
        )
        return [row_to_dict(row, _UNIT_UUID_FIELDS) for row in rows]
