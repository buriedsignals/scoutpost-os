"""Supabase implementation of ScoutStoragePort.

Uses asyncpg to execute SQL against the PostgreSQL scouts table.

DEPENDS ON: connection (get_pool), ports.storage (ScoutStoragePort)
USED BY: dependencies/providers.py (DI wiring)
"""
from __future__ import annotations

import logging

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
