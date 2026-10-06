"""Supabase implementation of UserStoragePort.

Uses asyncpg to execute SQL against the PostgreSQL user_preferences table.
Credits and team orgs are owned by Supabase Edge Functions, not this adapter.

DEPENDS ON: connection (get_pool), ports.storage (UserStoragePort)
USED BY: dependencies/providers.py (DI wiring)
"""
from __future__ import annotations

import json
import logging
from typing import Optional

from app.adapters.supabase.connection import get_pool
from app.adapters.supabase.utils import row_to_dict
from app.ports.storage import UserStoragePort

logger = logging.getLogger(__name__)

# Fields that can be set on user_preferences
USER_FIELDS = [
    "timezone", "preferred_language", "notification_email",
    "default_location", "excluded_domains", "cms_api_url",
    "cms_api_token", "preferences", "onboarding_completed",
    "onboarding_tour_completed",
]


def _user_row_to_dict(row) -> dict | None:
    """Convert user_preferences row. Returns None for None (not found)."""
    if row is None:
        return None
    return row_to_dict(row, uuid_fields=("user_id",))


class SupabaseUserStorage(UserStoragePort):
    """PostgreSQL-backed user preference storage using asyncpg."""

    def __init__(self):
        self.pool = None

    async def _ensure_pool(self):
        if self.pool is None:
            self.pool = await get_pool()

    async def get_user(self, user_id: str) -> dict | None:
        """Get user preferences. Returns None if not found."""
        await self._ensure_pool()

        row = await self.pool.fetchrow(
            "SELECT * FROM user_preferences WHERE user_id = $1::uuid",
            user_id,
        )
        return _user_row_to_dict(row)

    async def create_or_update_user(self, user_id: str, data: dict) -> dict:
        """Create or update user preferences using UPSERT.

        On conflict (user already exists), updates the provided fields.
        """
        await self._ensure_pool()

        # Build columns and values from provided data
        columns = ["user_id"]
        placeholders = ["$1::uuid"]
        values: list = [user_id]
        update_clauses = []
        idx = 2

        for field in USER_FIELDS:
            if field in data:
                columns.append(field)
                value = data[field]
                if field in ("default_location", "preferences") and isinstance(value, dict):
                    value = json.dumps(value)
                placeholders.append(f"${idx}")
                update_clauses.append(f"{field} = EXCLUDED.{field}")
                values.append(value)
                idx += 1

        if not update_clauses:
            # Nothing to update, just ensure the row exists
            update_clauses = ["updated_at = NOW()"]

        sql = f"""
            INSERT INTO user_preferences ({', '.join(columns)})
            VALUES ({', '.join(placeholders)})
            ON CONFLICT (user_id) DO UPDATE SET
                {', '.join(update_clauses)}
            RETURNING *
        """
        row = await self.pool.fetchrow(sql, *values)
        return _user_row_to_dict(row)
