"""Supabase scheduler using the same timezone-aware RPC as Edge Functions.

Vault credentials, spreading, and local-time dispatch are owned by PostgreSQL.
"""
from __future__ import annotations

from app.adapters.supabase.connection import get_pool
from app.ports.scheduler import SchedulerPort


class SupabaseScheduler(SchedulerPort):
    """Canonical scout-UUID pg_cron jobs, with transactional schedule updates."""

    def __init__(self):
        self.pool = None

    async def _ensure_pool(self):
        if self.pool is None:
            self.pool = await get_pool()

    async def create_schedule(self, schedule_name: str, cron: str,
                              target_config: dict) -> str:
        scout_id = target_config["scout_id"]
        timezone = target_config.get("timezone", "UTC")
        await self._ensure_pool()
        async with self.pool.acquire() as conn:
            async with conn.transaction():
                # Validate before changing either the stored schedule or the job.
                await conn.execute(
                    "SELECT public.validate_scout_schedule($1::text, $2::text)",
                    cron, timezone,
                )
                row = await conn.fetchrow(
                    """UPDATE public.scouts
                       SET schedule_cron = $2, schedule_timezone = $3, is_active = true
                       WHERE id = $1::uuid RETURNING id""",
                    scout_id, cron, timezone,
                )
                if row is None:
                    raise ValueError("Scout not found")
                await conn.execute(
                    "SELECT public.schedule_scout($1::uuid, $2::text)", scout_id, cron,
                )
        return f"scout-{scout_id}"

    async def delete_schedule(self, schedule_name: str) -> None:
        await self._ensure_pool()
        await self.pool.execute(
            """SELECT cron.unschedule($1::text)
               WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = $1::text)""",
            schedule_name,
        )

    async def update_schedule(self, schedule_name: str, cron: str = None,
                              target_config: dict = None) -> None:
        if cron is None or target_config is None:
            raise ValueError("Updating a schedule requires cron and target_config")
        await self.create_schedule(schedule_name, cron, target_config)
