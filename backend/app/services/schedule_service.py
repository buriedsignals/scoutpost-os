"""
Schedule service for the remaining Python API routes.

The core storage/scheduling implementation is now adapter-driven. Supabase is
the default runtime; the legacy EventBridge wording only applies when the old
AWS-backed deployment target is still in use.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Optional

from app.config import get_settings
from app.utils.schedule_naming import (
    build_schedule_name,
    convert_floats_to_decimal,
    convert_decimals,
    validate_url,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# ScheduleService
# ---------------------------------------------------------------------------

class ScheduleService:
    """Manages scout schedules through the active storage/scheduler adapters."""

    def __init__(self, scout_storage=None, scheduler=None):
        settings = get_settings()
        self.internal_service_key = settings.internal_service_key
        # AWS EventBridge/Lambda ARNs are only read by the legacy non-Supabase
        # scheduler adapter (unreachable while `deployment_target == "supabase"`
        # is hardcoded). Kept as empty strings so the target_config dict at the
        # EventBridge call site still has the expected keys.
        self.scraper_lambda_arn = ""
        self.eventbridge_role_arn = ""

        if scout_storage is None:
            from app.dependencies.providers import get_scout_storage
            scout_storage = get_scout_storage()
        self.scout_storage = scout_storage

        if scheduler is None:
            from app.dependencies.providers import get_scheduler
            scheduler = get_scheduler()
        self.scheduler = scheduler

    # ------------------------------------------------------------------
    # create_scout
    # ------------------------------------------------------------------

    async def create_scout(
        self,
        user_id: str,
        scraper_name: str,
        body: dict,
        cron_schedule,
    ) -> dict:
        """Create a scout using the active storage and scheduler adapters.

        Args:
            user_id: Owner's user ID (PK).
            scraper_name: Scout name (used in SK as SCRAPER#{name}).
            body: Scout configuration (scout_type, url, criteria, location, etc.)
            cron_schedule: CronSchedule from services/cron.py.

        Returns:
            Dict with schedule_name and confirmation.

        Raises:
            ValueError: If URL validation fails (web scouts), or criteria mode
                is selected for a social scout without criteria text.
        """
        scout_type = body.get("scout_type", "web")
        social_monitor_mode = None
        if scout_type == "social":
            social_criteria = body.get("criteria")
            has_social_criteria = (
                isinstance(social_criteria, str) and bool(social_criteria.strip())
            )
            social_monitor_mode = body.get("monitor_mode") or (
                "criteria" if has_social_criteria else "summarize"
            )
            if social_monitor_mode == "criteria" and not has_social_criteria:
                raise ValueError(
                    "criteria is required when monitor_mode is criteria"
                )

        # Validate URL for web scouts (SSRF protection)
        if scout_type == "web":
            url = body.get("url")
            if url and not validate_url(url):
                raise ValueError(f"Invalid or blocked URL: {url}")

        # 1. Write SCRAPER# record via storage adapter
        item = {
            "scraper_name": scraper_name,
            "scout_type": scout_type,
            "regularity": body.get("regularity", "daily"),
            "time": body.get("time"),
            "monitoring": body.get("monitoring", "EMAIL"),
            "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "preferred_language": body.get("preferred_language", "en"),
            "cron_expression": cron_schedule.expression,
            "timezone": cron_schedule.timezone,
        }

        if scout_type == "web":
            item["url"] = body.get("url")
            item["criteria"] = body.get("criteria")
            if body.get("provider"):
                item["provider"] = body["provider"]
            if body.get("location"):
                item["location"] = body.get("location")
            if body.get("topic"):
                item["topic"] = body.get("topic")
        elif scout_type == "beat":
            item["location"] = body.get("location")
            if body.get("topic"):
                item["topic"] = body.get("topic")
            if body.get("excluded_domains"):
                item["excluded_domains"] = body["excluded_domains"]
            if body.get("priority_sources"):
                item["priority_sources"] = body["priority_sources"]
            if body.get("source_mode"):
                item["source_mode"] = body["source_mode"]
            if body.get("criteria"):
                item["criteria"] = body["criteria"]
        elif scout_type == "social":
            item["platform"] = body.get("platform", "instagram")
            item["profile_handle"] = body.get("profile_handle", "")
            item["monitor_mode"] = social_monitor_mode
            item["track_removals"] = body.get("track_removals", False)
            if body.get("criteria"):
                item["criteria"] = body["criteria"]
            if body.get("topic"):
                item["topic"] = body["topic"]
        elif scout_type == "civic":
            item["root_domain"] = body.get("root_domain", "")
            item["tracked_urls"] = body.get("tracked_urls") or []
            item["criteria"] = body.get("criteria", "")
            item["content_hash"] = body.get("content_hash", "")
            item["processed_pdf_urls"] = body.get("processed_pdf_urls") or []
            if body.get("location"):
                item["location"] = body["location"]
            if body.get("topic"):
                item["topic"] = body["topic"]

        settings = get_settings()
        if settings.deployment_target == "supabase":
            await self.scout_storage.create_scout(user_id, item)
        else:
            await self.scout_storage.create_scout(user_id, convert_floats_to_decimal(item))

        # 2. Create the schedule via the active scheduler adapter
        rule_name = build_schedule_name(user_id, scraper_name)
        input_template = json.dumps({
            "user_id": user_id,
            "scraper_name": scraper_name,
            "scout_type": scout_type,
            "url": body.get("url"),
            "location": body.get("location"),
            "topic": body.get("topic"),
            "criteria": body.get("criteria"),
            "preferred_language": body.get("preferred_language", "en"),
            "provider": body.get("provider"),
            "excluded_domains": body.get("excluded_domains"),
            "priority_sources": body.get("priority_sources"),
            "source_mode": body.get("source_mode"),
            "platform": body.get("platform"),
            "profile_handle": body.get("profile_handle"),
            "monitor_mode": social_monitor_mode
            if scout_type == "social"
            else body.get("monitor_mode"),
            "track_removals": body.get("track_removals", False),
            "tracked_urls": body.get("tracked_urls", []),
            "root_domain": body.get("root_domain", ""),
        })

        if settings.deployment_target == "supabase":
            cron_expr = cron_schedule.expression
        else:
            cron_expr = f"cron({cron_schedule.expression})"
        target_config = {
            "lambda_arn": self.scraper_lambda_arn,
            "role_arn": self.eventbridge_role_arn,
            "input": input_template,
            # Also pass timezone for the scheduler adapter
            "timezone": cron_schedule.timezone,
        }
        await self.scheduler.create_schedule(rule_name, cron_expr, target_config)

        logger.info(
            "Created scout '%s' for user %s (schedule: %s)",
            scraper_name, user_id, rule_name,
        )

        return {
            "message": "Scout created successfully",
            "schedule_name": rule_name,
            "scraper_name": scraper_name,
        }

    # ------------------------------------------------------------------
    # list_scouts
    # ------------------------------------------------------------------

    async def list_scouts(self, user_id: str) -> list[dict]:
        """List all scouts for a user with latest run and summary data."""
        return await self.scout_storage.list_scouts(user_id)

    # ------------------------------------------------------------------
    # get_scout
    # ------------------------------------------------------------------

    async def get_scout(self, user_id: str, scraper_name: str) -> Optional[dict]:
        """Get a single scout with recent run and execution data."""
        return await self.scout_storage.get_scout(user_id, scraper_name)

    # ------------------------------------------------------------------
    # delete_scout
    # ------------------------------------------------------------------

    async def delete_scout(self, user_id: str, scraper_name: str) -> dict:
        """Delete a scout: EventBridge schedule + all DynamoDB records."""
        rule_name = build_schedule_name(user_id, scraper_name)

        # 1. Delete EventBridge schedule (ignore if not found)
        await self.scheduler.delete_schedule(rule_name)

        # 2. Delete all storage records (cascades internally in adapter)
        result = await self.scout_storage.delete_scout(user_id, scraper_name)

        # Normalize result to expected format
        if isinstance(result, dict) and "records_deleted" in result:
            return result

        return {
            "message": "Scout deleted successfully",
            "scraper_name": scraper_name,
            "records_deleted": result if isinstance(result, dict) else {},
        }
