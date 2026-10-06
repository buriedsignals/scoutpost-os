"""Supabase implementation of RunStoragePort.

Read-only access to the PostgreSQL scout_runs table; runs are written by
Supabase Edge Functions.

DEPENDS ON: connection (get_pool), ports.storage (RunStoragePort)
USED BY: dependencies/providers.py (DI wiring)
"""
from __future__ import annotations

import logging

from app.adapters.supabase.connection import get_pool
from app.adapters.supabase.utils import row_to_dict
from app.ports.storage import RunStoragePort

logger = logging.getLogger(__name__)


class SupabaseRunStorage(RunStoragePort):
    """PostgreSQL-backed scout run storage using asyncpg."""

    def __init__(self):
        self.pool = None

    async def _ensure_pool(self):
        if self.pool is None:
            self.pool = await get_pool()

    async def get_latest_runs(self, user_id: str, limit: int = 10) -> list[dict]:
        """Get the most recent runs for a user across all scouts."""
        await self._ensure_pool()
        rows = await self.pool.fetch(
            """
            SELECT * FROM scout_runs
            WHERE user_id = $1::uuid
            ORDER BY started_at DESC
            LIMIT $2
            """,
            user_id, limit,
        )
        return [row_to_dict(row) for row in rows]
