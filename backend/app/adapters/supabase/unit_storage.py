"""Supabase implementation of UnitStoragePort.

Uses asyncpg with pgvector for semantic search over information units.
This is the most complex storage adapter: it handles bulk inserts,
multi-dimensional filtering (location, topic), and vector similarity search.

DEPENDS ON: connection (get_pool), ports.storage (UnitStoragePort)
USED BY: dependencies/providers.py (DI wiring)
"""
from __future__ import annotations

import json
import logging
from datetime import date as date_type
from typing import Optional

from app.adapters.supabase.connection import get_pool
from app.adapters.supabase.utils import row_to_dict
from app.ports.storage import UnitStoragePort

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

    async def store_units(self, user_id: str, scout_id: str, units: list[dict]) -> None:
        """Bulk insert information units with embeddings."""
        await self._ensure_pool()

        if not units:
            return

        # Build values for executemany
        records = []
        for unit in units:
            embedding = unit.get("embedding")
            embedding_str = None
            if embedding:
                embedding_str = f"[{','.join(str(v) for v in embedding)}]"

            # Fix #36: convert string event_date to datetime.date for asyncpg
            event_date_raw = unit.get("event_date")
            event_date = None
            if event_date_raw:
                if isinstance(event_date_raw, str):
                    try:
                        event_date = date_type.fromisoformat(event_date_raw)
                    except ValueError:
                        event_date = None
                elif isinstance(event_date_raw, date_type):
                    event_date = event_date_raw

            # Fix #32: empty string → None for UUID cast
            article_id = unit.get("article_id") or None

            records.append((
                user_id,
                scout_id,
                unit.get("scout_type"),
                article_id,
                unit["statement"],
                unit["type"],
                unit.get("entities"),
                embedding_str,
                unit.get("source_url"),
                unit.get("source_domain"),
                unit.get("source_title"),
                event_date,
                unit.get("country"),
                unit.get("state"),
                unit.get("city"),
                unit.get("topic"),
                unit.get("dataset_id"),
            ))

        await self.pool.executemany(
            """
            INSERT INTO information_units (
                user_id, scout_id, scout_type, article_id,
                statement, type, entities, embedding_v2, embedding_model_v2,
                source_url, source_domain, source_title,
                event_date, country, state, city, topic, dataset_id
            )
            VALUES (
                $1::uuid, $2::uuid, $3, $4::uuid,
                $5, $6, $7, $8::vector,
                CASE WHEN $8 IS NULL THEN NULL ELSE 'embeddinggemma-300m-768-int8-onnx-task-prefix-v1' END,
                $9, $10, $11,
                $12, $13, $14, $15, $16, $17
            )
            """,
            records,
        )
        logger.info(f"Stored {len(records)} information units for scout {scout_id}")

    async def search_units(self, user_id: str, query_embedding: list[float],
                            filters: dict = None, limit: int = 20) -> list[dict]:
        """Semantic search using pgvector cosine similarity.

        Optionally filters by topic. Returns results ranked by similarity.
        """
        await self._ensure_pool()

        embedding_str = f"[{','.join(str(v) for v in query_embedding)}]"
        filters = filters or {}

        # Build WHERE clause dynamically
        conditions = ["user_id = $1::uuid", "embedding_v2 IS NOT NULL"]
        params: list = [user_id]
        idx = 2

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

    async def get_units_by_scout(self, user_id: str, scout_id: str, limit: int = 50) -> list[dict]:
        """Get information units for a specific scout."""
        await self._ensure_pool()
        rows = await self.pool.fetch(
            """
            SELECT id, user_id, scout_id, scout_type, article_id,
                   statement, type, entities, source_url, source_domain,
                   source_title, event_date, country, state, city, topic,
                   used_in_article, created_at
            FROM information_units
            WHERE user_id = $1::uuid AND scout_id = $2::uuid
            ORDER BY created_at DESC
            LIMIT $3
            """,
            user_id, scout_id, limit,
        )
        return [row_to_dict(row, _UNIT_UUID_FIELDS) for row in rows]
