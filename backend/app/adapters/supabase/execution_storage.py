"""Supabase implementation of ExecutionStoragePort.

Uses asyncpg for storage. Embeddings are stored in the 768d shadow column.
Duplicate detection that previously lived in ExecutionDeduplicationService (deleted
post-cutover) now runs inside Supabase Edge Functions; this adapter exposes
get_recent_embeddings() for that purpose.

DEPENDS ON: connection (get_pool), ports.storage (ExecutionStoragePort)
USED BY: dependencies/providers.py (DI wiring)
"""
from __future__ import annotations

import logging
from typing import Optional

from app.adapters.supabase.connection import get_pool
from app.adapters.supabase.utils import row_to_dict
from app.ports.storage import ExecutionStoragePort
from app.services.embedding_utils import EMBEDDING_MODEL_TAG

logger = logging.getLogger(__name__)


class SupabaseExecutionStorage(ExecutionStoragePort):
    """PostgreSQL-backed execution record storage with pgvector."""

    def __init__(self):
        self.pool = None

    async def _ensure_pool(self):
        if self.pool is None:
            self.pool = await get_pool()

    async def store_execution(self, user_id: str, scout_name: str, scout_type: str,
                              summary_text: str, is_duplicate: bool, started_at: str,
                              embedding: list[float] | None = None,
                              content_hash: str | None = None,
                              provider: str | None = None) -> dict:
        """Insert an execution record with optional embedding.

        Matches the ExecutionStoragePort signature from Phase 1. The scout_name
        is resolved to scout_id via a subquery.
        """
        await self._ensure_pool()

        # pgvector expects the embedding as a string representation: '[0.1,0.2,...]'
        embedding_str = f"[{','.join(str(v) for v in embedding)}]" if embedding else None

        row = await self.pool.fetchrow(
            """
            INSERT INTO execution_records (
                user_id, scout_id, scout_type, summary_text,
                embedding_v2, embedding_model_v2, content_hash, is_duplicate,
                metadata, completed_at
            )
            VALUES (
                $1::uuid,
                (SELECT id FROM scouts WHERE user_id = $1::uuid AND name = $2),
                $3, $4, $5::vector, $6, $7, $8,
                jsonb_build_object('provider', $9, 'started_at', $10),
                NOW()
            )
            RETURNING *
            """,
            user_id, scout_name, scout_type, summary_text,
            embedding_str, EMBEDDING_MODEL_TAG, content_hash, is_duplicate,
            provider, started_at,
        )
        return row_to_dict(row)

    async def get_recent_executions(self, user_id: str, scout_id: str,
                                     limit: int = 5) -> list[dict]:
        """Get recent execution records for a scout."""
        await self._ensure_pool()
        rows = await self.pool.fetch(
            """
            SELECT id, scout_id, user_id, scout_type, summary_text,
                   content_hash, is_duplicate, metadata, completed_at
            FROM execution_records
            WHERE user_id = $1::uuid AND scout_id = $2::uuid
            ORDER BY completed_at DESC
            LIMIT $3
            """,
            user_id, scout_id, limit,
        )
        return [row_to_dict(row) for row in rows]

    async def get_recent_embeddings(self, user_id: str, scout_name: str,
                                     limit: int = 20) -> list[dict]:
        """Return recent execution records with embeddings for dedup comparison.

        Similarity computation now happens in Supabase Edge Functions; this
        method exposes the raw rows they need.
        """
        await self._ensure_pool()
        rows = await self.pool.fetch(
            """
            SELECT id, summary_text, embedding_v2 AS embedding, completed_at
            FROM execution_records
            WHERE user_id = $1::uuid
                AND scout_id = (SELECT id FROM scouts WHERE user_id = $1::uuid AND name = $2)
                AND embedding_v2 IS NOT NULL
            ORDER BY completed_at DESC
            LIMIT $3
            """,
            user_id, scout_name, limit,
        )
        return [row_to_dict(row) for row in rows]

    async def get_latest_content_hash(self, user_id: str, scout_id: str) -> Optional[str]:
        """Get the content hash from the most recent execution."""
        await self._ensure_pool()
        return await self.pool.fetchval(
            """
            SELECT content_hash FROM execution_records
            WHERE user_id = $1::uuid AND scout_id = $2::uuid AND content_hash IS NOT NULL
            ORDER BY completed_at DESC
            LIMIT 1
            """,
            user_id, scout_id,
        )

    async def delete_executions_for_scout(self, user_id: str, scout_name: str) -> None:
        """Delete all execution records for a scout by name."""
        await self._ensure_pool()
        await self.pool.execute(
            """
            DELETE FROM execution_records
            WHERE user_id = $1::uuid
                AND scout_id = (SELECT id FROM scouts WHERE user_id = $1::uuid AND name = $2)
            """,
            user_id, scout_name,
        )
