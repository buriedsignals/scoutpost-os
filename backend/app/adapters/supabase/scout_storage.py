"""Supabase implementation of ScoutStoragePort.

Uses asyncpg to execute SQL against the PostgreSQL scouts table.

DEPENDS ON: connection (get_pool), ports.storage (ScoutStoragePort)
USED BY: dependencies/providers.py (DI wiring)
"""
from __future__ import annotations

import json
import logging
from typing import Optional

from app.adapters.supabase.connection import get_pool
from app.adapters.supabase.utils import row_to_dict
from app.ports.storage import ScoutStoragePort

logger = logging.getLogger(__name__)

# Columns to SELECT in scout queries (avoids SELECT *)
SCOUT_COLUMNS = """
    id, user_id, name, type, criteria, preferred_language,
    regularity, schedule_cron, schedule_timezone, topic,
    url, source_mode, excluded_domains, priority_sources,
    platform, profile_handle, monitor_mode, track_removals,
    root_domain, tracked_urls, processed_pdf_urls,
    location, config, is_active, consecutive_failures,
    baseline_established_at, created_at, updated_at
"""

# Fields that map directly from input dict to SQL columns
SCOUT_INSERT_FIELDS = [
    "name", "type", "criteria", "preferred_language",
    "regularity", "schedule_cron", "schedule_timezone", "topic",
    "url", "source_mode", "excluded_domains", "priority_sources",
    "platform", "profile_handle", "monitor_mode", "track_removals",
    "root_domain", "tracked_urls", "processed_pdf_urls",
    "location", "config",
]

# Map DynamoDB-style field names (from ScheduleService) to PostgreSQL column names
DYNAMO_TO_PG = {
    "scraper_name": "name",
    "scout_type": "type",
    "cron_expression": "schedule_cron",
    "timezone": "schedule_timezone",
}

# Reverse: PostgreSQL column names back to DynamoDB-style for API responses
PG_TO_DYNAMO = {v: k for k, v in DYNAMO_TO_PG.items()}


def _normalize_scout_output(scout: dict) -> dict:
    """Add DynamoDB-style field aliases to a scout dict for API compatibility."""
    if scout is None:
        return scout
    # Add DynamoDB aliases alongside PostgreSQL names
    if "name" in scout:
        scout["scraper_name"] = scout["name"]
    if "type" in scout:
        scout["scout_type"] = scout["type"]
    if "schedule_cron" in scout:
        scout["cron_expression"] = scout["schedule_cron"]
    if "schedule_timezone" in scout:
        scout["timezone"] = scout["schedule_timezone"]
    return scout


class SupabaseScoutStorage(ScoutStoragePort):
    """PostgreSQL-backed scout storage using asyncpg."""

    def __init__(self):
        self.pool = None

    async def _ensure_pool(self):
        if self.pool is None:
            self.pool = await get_pool()

    async def create_scout(self, user_id: str, data: dict) -> dict:
        """Insert a new scout and return the created row."""
        await self._ensure_pool()

        # Translate DynamoDB-style keys to PostgreSQL column names
        translated = {}
        for key, value in data.items():
            pg_key = DYNAMO_TO_PG.get(key, key)
            translated[pg_key] = value

        # Build dynamic INSERT from provided fields
        columns = ['"user_id"']
        placeholders = ["$1::uuid"]
        values = [user_id]
        idx = 2

        for field in SCOUT_INSERT_FIELDS:
            if field in translated:
                value = translated[field]
                # Skip empty strings and None (but keep False and 0)
                if value is None or (isinstance(value, str) and value == ""):
                    continue
                columns.append(f'"{field}"')
                # JSONB fields need JSON serialization
                if field in ("location", "config") and isinstance(value, dict):
                    value = json.dumps(value)
                placeholders.append(f"${idx}")
                values.append(value)
                idx += 1

        sql = f"""
            INSERT INTO scouts ({', '.join(columns)})
            VALUES ({', '.join(placeholders)})
            RETURNING {SCOUT_COLUMNS}
        """
        row = await self.pool.fetchrow(sql, *values)
        return _normalize_scout_output(row_to_dict(row))

    async def get_scout(self, user_id: str, scout_name: str) -> Optional[dict]:
        """Get a scout by user_id and name."""
        await self._ensure_pool()
        row = await self.pool.fetchrow(
            f"SELECT {SCOUT_COLUMNS} FROM scouts WHERE user_id = $1::uuid AND name = $2",
            user_id, scout_name,
        )
        return _normalize_scout_output(row_to_dict(row))

    async def get_scout_by_id(self, scout_id: str) -> Optional[dict]:
        """Get a scout by its UUID."""
        await self._ensure_pool()
        row = await self.pool.fetchrow(
            f"SELECT {SCOUT_COLUMNS} FROM scouts WHERE id = $1::uuid",
            scout_id,
        )
        return _normalize_scout_output(row_to_dict(row))

    async def list_scouts(self, user_id: str) -> list[dict]:
        """List all scouts for a user with last_run and latest_execution data."""
        await self._ensure_pool()
        rows = await self.pool.fetch(
            f"SELECT {SCOUT_COLUMNS} FROM scouts WHERE user_id = $1::uuid ORDER BY created_at DESC",
            user_id,
        )
        scouts = [_normalize_scout_output(row_to_dict(row)) for row in rows]

        if not scouts:
            return scouts

        # Batch-fetch latest run per scout
        scout_ids = [s["id"] for s in scouts]
        placeholders = ", ".join(f"${i+1}::uuid" for i in range(len(scout_ids)))

        run_rows = await self.pool.fetch(
            f"""
            SELECT DISTINCT ON (scout_id) scout_id, status, scraper_status,
                   criteria_status, notification_sent, articles_count,
                   error_message, started_at, completed_at
            FROM scout_runs
            WHERE scout_id IN ({placeholders})
            ORDER BY scout_id, started_at DESC
            """,
            *scout_ids,
        )
        runs_by_scout = {}
        for r in run_rows:
            sid = str(r["scout_id"])
            started = r["started_at"]
            runs_by_scout[sid] = {
                "status": r["status"],
                "scraper_status": r["scraper_status"],
                "criteria_status": r["criteria_status"],
                "notification_sent": r["notification_sent"],
                "articles_count": r["articles_count"],
                "error_message": r["error_message"],
                "last_run": started.strftime("%m-%d-%Y %H:%M") if started else None,
            }

        # Batch-fetch latest execution per scout
        exec_rows = await self.pool.fetch(
            f"""
            SELECT DISTINCT ON (scout_id) scout_id, summary_text,
                   is_duplicate, completed_at
            FROM execution_records
            WHERE scout_id IN ({placeholders})
            ORDER BY scout_id, completed_at DESC
            """,
            *scout_ids,
        )
        execs_by_scout = {}
        for e in exec_rows:
            sid = str(e["scout_id"])
            execs_by_scout[sid] = {
                "summary_text": e["summary_text"],
                "is_duplicate": e["is_duplicate"],
                "completed_at": e["completed_at"].isoformat() if e["completed_at"] else None,
            }

        # Enrich scouts
        for scout in scouts:
            sid = scout["id"]
            run_data = runs_by_scout.get(sid)
            exec_data = execs_by_scout.get(sid)

            scout["last_run"] = run_data
            scout["latest_execution"] = exec_data

            # card_summary for frontend status cascade
            if exec_data:
                scout.setdefault("card_summary", exec_data.get("summary_text"))

        return scouts

    async def delete_scout(self, user_id: str, scout_name: str) -> None:
        """Delete a scout by user_id and name. CASCADE deletes related records."""
        await self._ensure_pool()
        await self.pool.execute(
            "DELETE FROM scouts WHERE user_id = $1::uuid AND name = $2",
            user_id, scout_name,
        )

    async def update_scout(self, user_id: str, scout_name: str, updates: dict) -> Optional[dict]:
        """Update scout fields and return the updated row."""
        await self._ensure_pool()

        if not updates:
            return await self.get_scout(user_id, scout_name)

        # Translate DynamoDB-style keys
        translated = {}
        for key, value in updates.items():
            pg_key = DYNAMO_TO_PG.get(key, key)
            translated[pg_key] = value

        set_clauses = []
        values = []
        idx = 1

        for field, value in translated.items():
            if field in ("location", "config") and isinstance(value, dict):
                value = json.dumps(value)
            set_clauses.append(f'"{field}" = ${idx}')
            values.append(value)
            idx += 1

        values.append(user_id)
        values.append(scout_name)

        sql = f"""
            UPDATE scouts
            SET {', '.join(set_clauses)}
            WHERE user_id = ${idx}::uuid AND name = ${idx + 1}
            RETURNING {SCOUT_COLUMNS}
        """
        row = await self.pool.fetchrow(sql, *values)
        return _normalize_scout_output(row_to_dict(row))

    async def deactivate_scout(self, scout_id: str) -> None:
        """Set is_active = FALSE for a scout by ID."""
        await self._ensure_pool()
        await self.pool.execute(
            'UPDATE scouts SET is_active = FALSE WHERE id = $1::uuid',
            scout_id,
        )
