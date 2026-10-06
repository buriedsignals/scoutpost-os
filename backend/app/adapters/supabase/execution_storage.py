"""Supabase implementation of ExecutionStoragePort.

Read-only: execution records are written by Supabase Edge Functions.

DEPENDS ON: connection (get_pool), ports.storage (ExecutionStoragePort)
USED BY: dependencies/providers.py (DI wiring)
"""
from __future__ import annotations

import logging

from app.adapters.supabase.connection import get_pool
from app.adapters.supabase.utils import row_to_dict
from app.ports.storage import ExecutionStoragePort

logger = logging.getLogger(__name__)


class SupabaseExecutionStorage(ExecutionStoragePort):
    """PostgreSQL-backed execution record storage with pgvector."""

    def __init__(self):
        self.pool = None

    async def _ensure_pool(self):
        if self.pool is None:
            self.pool = await get_pool()

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
