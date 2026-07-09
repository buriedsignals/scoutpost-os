"""
User router for user-specific settings and preferences.

PURPOSE: GET/PUT /user/preferences for language, timezone, excluded domains,
and CMS configuration. Stores preferences in DynamoDB via UserService.
GET /user/data-export for GDPR Art. 15 right of access.
DELETE /user/delete-account for GDPR Art. 17 right to erasure.

DEPENDS ON: dependencies (session auth), services/user_service (DynamoDB),
    models/responses (UserPreferencesResponse), dependencies/providers (adapters)
USED BY: frontend (settings panel), main.py (router mount)
"""
import asyncio
import ipaddress
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Request, status
from typing import Optional, List
from urllib.parse import urlparse
from pydantic import BaseModel, Field, field_validator
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.config import get_settings
from app.dependencies import get_current_user
from app.dependencies.providers import (
    get_scout_storage,
    get_execution_storage,
    get_run_storage,
    get_unit_storage,
    get_scheduler,
)
from app.models.responses import UserPreferencesResponse
from app.services.snapshot_storage_cleanup import sweep_scout_snapshots
from app.services.user_service import UserService
from app.utils.schedule_naming import build_schedule_name

logger = logging.getLogger(__name__)

limiter = Limiter(key_func=get_remote_address)

router = APIRouter(prefix="/user", tags=["user"])

_user_service: Optional[UserService] = None


def _get_user_service() -> UserService:
    global _user_service
    if _user_service is None:
        _user_service = UserService()
    return _user_service


class UpdatePreferencesRequest(BaseModel):
    """Request to update user preferences (language, timezone, excluded domains, CMS config)."""
    preferred_language: Optional[str] = Field(None, min_length=2, max_length=5, description="ISO 639-1 language code")
    timezone: Optional[str] = Field(None, description="IANA timezone identifier")
    excluded_domains: Optional[List[str]] = Field(None, description="Domains to exclude from Beat results (max 50)")
    cms_api_url: Optional[str] = Field(None, max_length=2000, description="CMS API endpoint URL")
    cms_api_token: Optional[str] = Field(None, max_length=500, description="Bearer token for CMS API")

    @field_validator('cms_api_url')
    @classmethod
    def validate_cms_url(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip()
        if not v:
            return ""  # Empty string clears the URL
        parsed = urlparse(v)
        if parsed.scheme != "https":
            raise ValueError("CMS API URL must use HTTPS")
        hostname = parsed.netloc.lower()
        if not hostname:
            raise ValueError("Invalid URL - no hostname found")
        # Block private/internal IPs
        host = hostname.split(":")[0] if ":" in hostname else hostname
        try:
            ip = ipaddress.ip_address(host)
            if ip.is_private or ip.is_loopback or ip.is_reserved or ip.is_link_local:
                raise ValueError("CMS API URL cannot target private/internal addresses")
        except ValueError as ip_err:
            if "private" in str(ip_err) or "cannot target" in str(ip_err):
                raise
            # hostname is not an IP address — fine
        return v

    @field_validator('excluded_domains')
    @classmethod
    def clean_excluded_domains(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if v is None:
            return None
        cleaned = []
        for domain in v:
            # Strip protocols, www., trailing slashes, lowercase
            d = domain.strip().lower()
            if "://" in d:
                d = urlparse(d).netloc or d.split("://", 1)[1]
            d = d.replace("www.", "").rstrip("/")
            if d and d not in cleaned:
                cleaned.append(d)
        return cleaned[:50]  # Cap at 50


@router.get("/preferences", response_model=UserPreferencesResponse)
async def get_user_preferences(
    user: dict = Depends(get_current_user)
):
    """
    Get user's preferences from DynamoDB.
    """
    user_id = user.get("user_id")

    # Fetch fresh from DynamoDB to get cms_api_url and has_cms_token
    # (get_current_user doesn't include CMS fields)
    user_service = _get_user_service()
    try:
        db_user = await user_service.get_user(user_id)
    except Exception as exc:
        logger.warning(f"Failed to fetch user profile for preferences: {exc}")
        db_user = None

    cms_api_url = db_user.get("cms_api_url") if db_user else None
    has_cms_token = db_user.get("has_cms_token", False) if db_user else False

    return {
        "preferred_language": user.get("preferred_language", "en"),
        "timezone": user.get("timezone"),
        "excluded_domains": user.get("excluded_domains") or [],
        "cms_api_url": cms_api_url,
        "has_cms_token": has_cms_token,
    }


@router.put("/preferences")
async def update_user_preferences(
    payload: UpdatePreferencesRequest,
    user: dict = Depends(get_current_user)
):
    """
    Update user's preferred language, timezone, excluded domains, and/or CMS config in DynamoDB.
    """
    user_id = user.get("user_id")

    has_any_field = (
        payload.preferred_language
        or payload.timezone
        or payload.excluded_domains is not None
        or payload.cms_api_url is not None
        or payload.cms_api_token is not None
    )
    if not has_any_field:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one preference field must be provided"
        )

    # Validate and canonicalize timezone if provided
    canonical_tz = None
    if payload.timezone:
        from app.utils.timezone import validate_timezone
        try:
            canonical_tz = validate_timezone(payload.timezone)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid timezone identifier: {payload.timezone}"
            )

    try:
        # Build kwargs for UserService.update_preferences
        update_kwargs = {}

        if payload.preferred_language:
            update_kwargs["preferred_language"] = payload.preferred_language
        if canonical_tz:
            update_kwargs["timezone"] = canonical_tz
        if payload.excluded_domains is not None:
            update_kwargs["excluded_domains"] = payload.excluded_domains
        if payload.cms_api_url is not None:
            update_kwargs["cms_api_url"] = payload.cms_api_url if payload.cms_api_url else None
        if payload.cms_api_token is not None:
            # Empty string clears the token
            update_kwargs["cms_api_token"] = payload.cms_api_token if payload.cms_api_token else None

        if update_kwargs:
            user_service = _get_user_service()
            await user_service.update_preferences(user_id, **update_kwargs)

        logger.info(f"Updated preferences for user {user_id}: fields={list(update_kwargs.keys())}")

        # Return the updated fields (exclude cms_api_token from response)
        response_fields = {k: v for k, v in update_kwargs.items() if k != "cms_api_token"}
        return {
            "success": True,
            **response_fields,
        }
    except Exception as exc:
        logger.error(f"Failed to update preferences for {user_id}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update preferences"
        )


# =============================================================================
# GDPR Endpoints
# =============================================================================


@router.get("/data-export")
@limiter.limit("1/hour")
async def data_export(
    request: Request,
    user: dict = Depends(get_current_user),
):
    """Export all user data (GDPR Art. 15 right of access).

    Aggregates data from all storage adapters for the authenticated user.
    Rate-limited to 1 request per hour.
    """
    user_id = user.get("user_id")

    scout_storage = get_scout_storage()
    execution_storage = get_execution_storage()
    run_storage = get_run_storage()
    unit_storage = get_unit_storage()

    # Collect all user data via existing adapter methods
    scouts = await scout_storage.list_scouts(user_id)

    # Gather execution history for each scout (last 50 per scout)
    executions = []
    for scout in scouts:
        scout_id = scout.get("scout_id") or scout.get("id") or scout.get("name", "")
        try:
            scout_execs = await execution_storage.get_recent_executions(
                user_id, scout_id, limit=50
            )
            executions.extend(scout_execs)
        except Exception as exc:
            logger.warning("Failed to fetch executions for scout %s: %s", scout_id, exc)

    # Gather recent runs (last 100)
    try:
        runs = await run_storage.get_latest_runs(user_id, limit=100)
    except Exception as exc:
        logger.warning("Failed to fetch runs for user %s: %s", user_id, exc)
        runs = []

    # Gather information units — all unused + by scout
    try:
        units = await unit_storage.get_all_unused_units(user_id, limit=500)
    except Exception as exc:
        logger.warning("Failed to fetch units for user %s: %s", user_id, exc)
        units = []

    # Gather distinct locations and topics
    try:
        locations = await unit_storage.get_distinct_locations(user_id)
    except Exception as exc:
        logger.warning("Failed to fetch locations for user %s: %s", user_id, exc)
        locations = []

    try:
        topics = await unit_storage.get_distinct_topics(user_id)
    except Exception as exc:
        logger.warning("Failed to fetch topics for user %s: %s", user_id, exc)
        topics = []

    # User profile (already fetched via get_current_user, but get fresh from DB
    # to include all fields like CMS config)
    user_service = _get_user_service()
    try:
        profile = await user_service.get_user(user_id)
    except Exception as exc:
        logger.warning("Failed to fetch user profile for export: %s", exc)
        profile = user

    # Strip sensitive fields from profile
    if profile:
        profile.pop("cms_api_token", None)
        profile.pop("has_cms_token", None)

    # NOTE: PostSnapshot data (social scout baselines) and SeenRecord data
    # (dedup hashes) are internal operational data, not user-facing content.
    # They are omitted from the export. If needed in the future, add via
    # get_post_snapshot_storage().get_snapshot() and iterate scouts.

    return {
        "user_id": user_id,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "profile": profile,
        "scouts": scouts,
        "executions": executions,
        "runs": runs,
        "units": units,
        "locations": locations,
        "topics": topics,
    }


@router.delete("/delete-account")
async def delete_account(
    request: Request,
    user: dict = Depends(get_current_user),
):
    """Delete user account and all associated data (GDPR Art. 17 right to erasure).

    Deletes all scouts (cascading to executions, runs, units, seen records,
    post snapshots, and promises), cleans up schedules, and removes the user
    profile. This action is irreversible.
    """
    user_id = user.get("user_id")

    scout_storage = get_scout_storage()
    settings = get_settings()

    # 1. Get all scouts to iterate deletion
    try:
        scouts = await scout_storage.list_scouts(user_id)
    except Exception as exc:
        logger.error("Failed to list scouts for account deletion (user %s): %s", user_id, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve scouts for deletion",
        )

    # 2. Delete each scout's schedule + all associated storage records
    scheduler = get_scheduler()
    deleted_scouts = []
    failed_scouts = []

    for scout in scouts:
        scout_name = scout.get("name", "")
        scout_id = scout.get("id")
        try:
            # Delete the scheduler entry (EventBridge or Supabase pg_cron)
            rule_name = build_schedule_name(user_id, scout_name)
            try:
                await scheduler.delete_schedule(rule_name)
            except Exception as sched_exc:
                logger.warning(
                    "Failed to delete schedule for scout %s (user %s): %s",
                    scout_name, user_id, sched_exc,
                )

            # Sweep Page Archive evidence objects BEFORE the row delete. FK
            # cascade removes page_snapshots rows but never the storage objects
            # (GDPR Art. 17 requires the bytes go too); this is the only sweep on
            # the FastAPI deletion path. Best-effort — never raises.
            if scout_id:
                await sweep_scout_snapshots(user_id, scout_id)

            # Delete scout + cascaded records (EXEC#, TIME#, SEEN#, POSTS#, PROMISE#)
            await scout_storage.delete_scout(user_id, scout_name)
            deleted_scouts.append(scout_name)
        except Exception as exc:
            logger.error(
                "Failed to delete scout %s for user %s: %s",
                scout_name, user_id, exc,
            )
            failed_scouts.append(scout_name)

    # 3. Delete user profile record
    # NOTE: UserStoragePort does not currently have a delete_user() method.
    # The profile record (PROFILE# in DynamoDB, or users row in Supabase)
    # remains. A delete_user() method should be added to UserStoragePort
    # and both adapters to complete this. For now, we clear sensitive fields.
    user_service = _get_user_service()
    try:
        await user_service.update_preferences(
            user_id,
            cms_api_url=None,
            cms_api_token=None,
            excluded_domains=[],
        )
    except Exception as exc:
        logger.warning("Failed to clear user preferences for %s: %s", user_id, exc)

    if failed_scouts:
        logger.error(
            "Account deletion incomplete for user %s: failed scouts: %s",
            user_id, failed_scouts,
        )

    logger.info(
        "Account deletion completed for user %s: %d scouts deleted, %d failed",
        user_id, len(deleted_scouts), len(failed_scouts),
    )

    return {
        "status": "deleted" if not failed_scouts else "partial",
        "user_id": user_id,
        "scouts_deleted": len(deleted_scouts),
        "scouts_failed": failed_scouts if failed_scouts else None,
    }
