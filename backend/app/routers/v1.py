"""
v1 external API router.

PURPOSE: Public REST API for programmatic access to coJournalist.
Three endpoint groups:
  1. Key management (POST/GET/DELETE /keys) — session cookie auth
  2. Scout CRUD (GET/POST/DELETE /scouts) — API key auth
  3. Information units (GET /units, GET /units/search) — API key auth

DEPENDS ON: dependencies (get_current_user, verify_api_key, validate_credits),
    services/api_key_service, services/schedule_service, services/feed_search_service,
    services/cron, utils/credits, schemas/v1, config
USED BY: main.py (mounted at /api/v1)
"""
import hashlib
import logging
from typing import NoReturn, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.config import get_settings
from app.dependencies import get_current_user, verify_api_key, validate_credits
from app.schemas.scouts import GeocodedLocation
from app.schemas.v1 import (
    ApiKeyListResponse,
    ApiKeyListItem,
    ApiKeyResponse,
    CreateApiKeyRequest,
    CreateScoutRequest,
    ErrorResponse,
    ScoutDetailResponse,
    ScoutListResponse,
    ScoutResponse,
    ScoutRunResponse,
    ScheduleConfig,
    UnitListResponse,
    UnitResponse,
    UnitSearchResponse,
)
try:
    from app.services.api_key_service import ApiKeyService
except ImportError:
    ApiKeyService = None  # OSS mirror: API key management not available
try:
    from app.services.cron import CronBuilderError, build_scraper_cron
except ImportError:
    # OSS mirror: cron expressions built by SupabaseScheduler adapter
    def build_scraper_cron(*args, **kwargs): return "0 * * * *"
    class CronBuilderError(Exception): pass
from app.services.feed_search_service import FeedSearchService
from app.services.schedule_service import ScheduleService
from app.services.snapshot_storage_cleanup import sweep_scout_snapshots
from app.utils.pricing import CREDIT_COSTS, get_beat_cost, get_social_monitoring_cost

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------


def _api_key_identity(request: Request) -> str:
    """Rate-limit key function that uses API key hash when present."""
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer cj_"):
        return hashlib.sha256(auth.removeprefix("Bearer ").encode()).hexdigest()[:16]
    return get_remote_address(request)


# Separate limiter with API-key-aware identity function.  The
# RateLimitExceeded exception handler registered in main.py catches
# exceptions from all Limiter instances — no need to share a single
# instance or set app.state.limiter to this one.
limiter = Limiter(key_func=_api_key_identity)

router = APIRouter()

# ---------------------------------------------------------------------------
# Lazy service singletons
# ---------------------------------------------------------------------------

_api_key_service: Optional[object] = None
_schedule_service: Optional[ScheduleService] = None
_feed_search_service: Optional[FeedSearchService] = None


def _get_api_key_service():
    global _api_key_service
    if ApiKeyService is None:
        return None
    if _api_key_service is None:
        _api_key_service = ApiKeyService()
    return _api_key_service


def _get_schedule_service() -> ScheduleService:
    global _schedule_service
    if _schedule_service is None:
        _schedule_service = ScheduleService()
    return _schedule_service


def _get_feed_search_service() -> FeedSearchService:
    global _feed_search_service
    if _feed_search_service is None:
        _feed_search_service = FeedSearchService()
    return _feed_search_service


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _error(status_code: int, message: str, code: str) -> NoReturn:
    """Raise an HTTPException with structured error body."""
    raise HTTPException(
        status_code=status_code,
        detail={"error": message, "code": code},
    )


def _scout_to_response(scout: dict) -> ScoutResponse:
    """Map a ScheduleService scout dict to a ScoutResponse."""
    schedule = None
    if scout.get("regularity") and scout.get("time"):
        schedule = ScheduleConfig(
            regularity=scout["regularity"],
            time=scout["time"],
            day_number=scout.get("day_number", 1),
        )

    return ScoutResponse(
        name=scout.get("name", ""),
        type=scout.get("scout_type", "web"),
        status=scout.get("scraper_status"),
        schedule=schedule,
        location=scout.get("location"),
        topic=scout.get("topic"),
        url=scout.get("url"),
        criteria=scout.get("criteria"),
        source_mode=scout.get("source_mode"),
        last_run=scout.get("last_run"),
        card_summary=scout.get("card_summary"),
        created_at=scout.get("created_at"),
    )


def _unit_to_response(unit: dict) -> UnitResponse:
    """Map a FeedSearchService unit dict to a UnitResponse."""
    return UnitResponse(
        id=unit.get("unit_id", ""),
        statement=unit.get("statement", ""),
        type=unit.get("unit_type", "fact"),
        entities=unit.get("entities", []),
        source_url=unit.get("source_url", ""),
        source_domain=unit.get("source_domain", ""),
        source_title=unit.get("source_title", ""),
        scout_name=unit.get("scout_id", ""),
        topic=unit.get("topic"),
        date=unit.get("date"),
        created_at=unit.get("created_at", ""),
        used_in_article=unit.get("used_in_article", False),
    )


# =============================================================================
# 1. Key Management (session cookie auth)
# =============================================================================


@router.post(
    "/keys",
    response_model=ApiKeyResponse,
    responses={429: {"model": ErrorResponse}},
    tags=["v1-keys"],
    include_in_schema=False,
)
@limiter.limit("10/minute")
async def create_api_key(
    request: Request,
    body: CreateApiKeyRequest,
    user: dict = Depends(get_current_user),
):
    """Generate a new API key. The raw key is returned exactly once."""
    svc = _get_api_key_service()
    if svc is None:
        raise HTTPException(404, "API key management not available")
    try:
        result = svc.create_key(user["user_id"], name=body.name)
    except ValueError as exc:
        _error(status.HTTP_400_BAD_REQUEST, str(exc), "MAX_KEYS_REACHED")

    return ApiKeyResponse(
        key=result["raw_key"],
        key_id=result["key_id"],
        key_prefix=result["key_prefix"],
        name=result["name"],
        created_at=result["created_at"],
    )


@router.get(
    "/keys",
    response_model=ApiKeyListResponse,
    responses={429: {"model": ErrorResponse}},
    tags=["v1-keys"],
    include_in_schema=False,
)
@limiter.limit("10/minute")
async def list_api_keys(
    request: Request,
    user: dict = Depends(get_current_user),
):
    """List all API keys for the authenticated user (prefix only, no raw keys)."""
    svc = _get_api_key_service()
    if svc is None:
        return ApiKeyListResponse(keys=[], count=0)
    keys = svc.list_keys(user["user_id"])
    items = [
        ApiKeyListItem(
            key_id=k["key_id"],
            key_prefix=k["key_prefix"],
            name=k["name"],
            created_at=k["created_at"],
            last_used_at=k.get("last_used_at"),
        )
        for k in keys
    ]
    return ApiKeyListResponse(keys=items, count=len(items))


@router.delete(
    "/keys/{key_id}",
    responses={404: {"model": ErrorResponse}, 429: {"model": ErrorResponse}},
    tags=["v1-keys"],
    include_in_schema=False,
)
@limiter.limit("10/minute")
async def revoke_api_key(
    request: Request,
    key_id: str,
    user: dict = Depends(get_current_user),
):
    """Revoke an API key by its key_id."""
    svc = _get_api_key_service()
    if svc is None:
        raise HTTPException(404, "API key management not available")
    deleted = svc.revoke_key(user["user_id"], key_id)
    if not deleted:
        _error(status.HTTP_404_NOT_FOUND, "API key not found", "NOT_FOUND")
    return {"message": "API key revoked"}


# =============================================================================
# 2. Scout Endpoints (API key auth)
# =============================================================================


@router.get(
    "/scouts",
    response_model=ScoutListResponse,
    responses={429: {"model": ErrorResponse}},
    tags=["v1-scouts"],
)
@limiter.limit("60/minute")
async def list_scouts(
    request: Request,
    user: dict = Depends(verify_api_key),
):
    """List all scouts for the authenticated user."""
    svc = _get_schedule_service()
    scouts = await svc.list_scouts(user["user_id"])
    items = [_scout_to_response(s) for s in scouts]
    return ScoutListResponse(scouts=items, count=len(items))


@router.post(
    "/scouts",
    response_model=ScoutResponse,
    status_code=status.HTTP_201_CREATED,
    responses={
        400: {"model": ErrorResponse},
        402: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
    },
    tags=["v1-scouts"],
)
@limiter.limit("10/minute")
async def create_scout(
    request: Request,
    body: CreateScoutRequest,
    user: dict = Depends(verify_api_key),
):
    """Create a new scout with schedule."""
    settings = get_settings()

    # 1. Validate timezone
    user_timezone = user.get("timezone")
    if not user_timezone:
        _error(
            status.HTTP_400_BAD_REQUEST,
            "Timezone not set. Please set your timezone before creating scouts.",
            "TIMEZONE_REQUIRED",
        )

    # 2. Apply DEV_ prefix in development
    scraper_name = body.name
    if settings.environment == "development" and not scraper_name.startswith("DEV_"):
        scraper_name = f"DEV_{scraper_name}"

    # 3. Check for duplicate name
    svc = _get_schedule_service()
    existing = await svc.get_scout(user["user_id"], scraper_name)
    if existing is not None:
        _error(
            status.HTTP_409_CONFLICT,
            f"A scout named '{scraper_name}' already exists",
            "DUPLICATE_NAME",
        )

    # 4. Validate credits (informational, no deduction)
    org_id = user.get("org_id")
    if body.type == "beat":
        cost = get_beat_cost(body.source_mode, body.location is not None)
    elif body.type == "social":
        cost = get_social_monitoring_cost(getattr(body, "platform", "instagram"))
    else:
        cost = CREDIT_COSTS.get("website_extraction", 1)
    await validate_credits(user["user_id"], cost, org_id=org_id)

    # 5. Build cron schedule
    try:
        cron_schedule = build_scraper_cron(
            timezone=user_timezone,
            regularity=body.schedule.regularity,
            day_number=body.schedule.day_number,
            time_str=body.schedule.time,
        )
    except CronBuilderError as exc:
        _error(status.HTTP_400_BAD_REQUEST, str(exc), "INVALID_SCHEDULE")

    # 6. Build body for ScheduleService
    scout_body: dict = {
        "scout_type": body.type,
        "regularity": body.schedule.regularity,
        "time": body.schedule.time,
        "monitoring": "EMAIL",
        "preferred_language": user.get("preferred_language", "en"),
    }

    if body.type == "web":
        scout_body["url"] = body.url
        scout_body["criteria"] = body.criteria
        # Default provider for API — no double-probe
        scout_body["provider"] = "firecrawl_plain"
    elif body.type == "beat":
        if body.location:
            scout_body["location"] = body.location.model_dump(exclude_none=True)
        if body.topic:
            scout_body["topic"] = body.topic
        if body.criteria:
            scout_body["criteria"] = body.criteria
        if body.excluded_domains:
            scout_body["excluded_domains"] = body.excluded_domains
        if body.priority_sources:
            scout_body["priority_sources"] = body.priority_sources
        if body.source_mode and body.source_mode != "niche":
            scout_body["source_mode"] = body.source_mode

    # 7. Create scout via ScheduleService
    try:
        result = await svc.create_scout(
            user_id=user["user_id"],
            scraper_name=scraper_name,
            body=scout_body,
            cron_schedule=cron_schedule,
        )
    except ValueError as exc:
        _error(status.HTTP_400_BAD_REQUEST, str(exc), "INVALID_URL")
    except Exception as exc:
        logger.exception("Failed to create scout: %s", exc)
        _error(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Failed to create scout",
            "INTERNAL_ERROR",
        )

    # 8. Return scout response
    return ScoutResponse(
        name=scraper_name,
        type=body.type,
        status=None,
        schedule=body.schedule,
        location=body.location,
        topic=body.topic,
        url=body.url,
        criteria=body.criteria,
        source_mode=body.source_mode if body.type == "beat" else None,
        last_run=None,
        card_summary=None,
        created_at=None,
    )


@router.get(
    "/scouts/{name}",
    response_model=ScoutDetailResponse,
    responses={404: {"model": ErrorResponse}, 429: {"model": ErrorResponse}},
    tags=["v1-scouts"],
)
@limiter.limit("60/minute")
async def get_scout_detail(
    request: Request,
    name: str,
    user: dict = Depends(verify_api_key),
):
    """Get detailed information about a single scout, including recent runs."""
    svc = _get_schedule_service()
    scout = await svc.get_scout(user["user_id"], name)
    if scout is None:
        _error(status.HTTP_404_NOT_FOUND, "Scout not found", "NOT_FOUND")

    schedule = None
    if scout.get("regularity") and scout.get("time"):
        schedule = ScheduleConfig(
            regularity=scout["regularity"],
            time=scout["time"],
            day_number=scout.get("day_number", 1),
        )

    # Build recent runs from TIME# data if available
    recent_runs = []
    if scout.get("scraper_status") is not None:
        recent_runs.append(
            ScoutRunResponse(
                scraper_status=scout.get("scraper_status", False),
                criteria_status=scout.get("criteria_status", False),
                summary=scout.get("card_summary", ""),
                notification_sent=scout.get("notification_sent"),
            )
        )

    return ScoutDetailResponse(
        name=scout.get("name", name),
        type=scout.get("scout_type", "web"),
        status=scout.get("scraper_status"),
        schedule=schedule,
        location=scout.get("location"),
        topic=scout.get("topic"),
        url=scout.get("url"),
        criteria=scout.get("criteria"),
        source_mode=scout.get("source_mode"),
        last_run=scout.get("last_run"),
        card_summary=scout.get("card_summary"),
        created_at=scout.get("created_at"),
        recent_runs=recent_runs,
    )


@router.delete(
    "/scouts/{name}",
    responses={404: {"model": ErrorResponse}, 429: {"model": ErrorResponse}},
    tags=["v1-scouts"],
)
@limiter.limit("10/minute")
async def delete_scout(
    request: Request,
    name: str,
    user: dict = Depends(verify_api_key),
):
    """Delete a scout and its associated schedule."""
    svc = _get_schedule_service()

    # Verify scout exists
    existing = await svc.get_scout(user["user_id"], name)
    if existing is None:
        _error(status.HTTP_404_NOT_FOUND, "Scout not found", "NOT_FOUND")

    try:
        # Sweep Page Archive evidence objects before the row delete — FK cascade
        # removes page_snapshots rows but never the storage objects, and this
        # FastAPI path never invokes the Edge Function's deleteScoutSnapshots.
        # Best-effort: never raises, so it can't block the delete.
        scout_id = existing.get("id")
        if scout_id:
            await sweep_scout_snapshots(user["user_id"], scout_id)

        await svc.delete_scout(user["user_id"], name)
    except Exception as exc:
        logger.exception("Failed to delete scout: %s", exc)
        _error(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Failed to delete scout",
            "INTERNAL_ERROR",
        )

    return {"message": "Scout deleted"}


# =============================================================================
# 3. Information Unit Endpoints (API key auth)
# =============================================================================


@router.get(
    "/units",
    response_model=UnitListResponse,
    responses={429: {"model": ErrorResponse}},
    tags=["v1-units"],
)
@limiter.limit("60/minute")
async def list_units(
    request: Request,
    country: Optional[str] = Query(None, description="ISO country code filter"),
    state: Optional[str] = Query(None, description="State/region filter"),
    city: Optional[str] = Query(None, description="City filter"),
    topic: Optional[str] = Query(None, description="Topic filter"),
    scout_name: Optional[str] = Query(None, description="Scout name filter"),
    limit: int = Query(50, ge=1, le=200, description="Max results"),
    user: dict = Depends(verify_api_key),
):
    """List information units, optionally filtered by location, topic, or scout."""
    feed_svc = _get_feed_search_service()
    user_id = user["user_id"]

    if scout_name:
        # Query by scout name via GSI
        raw_units = await feed_svc.get_units_by_scout(user_id, scout_name, limit=limit)
    elif country:
        # Query by location
        location = GeocodedLocation(
            displayName=f"{city or ''}, {state or ''}, {country}".strip(", "),
            city=city,
            state=state,
            country=country,
        )
        raw_units = await feed_svc.get_units_by_location(user_id, location, limit=limit)
    elif topic:
        # Query by topic
        result = await feed_svc.get_units_by_topic(user_id, topic, limit=limit)
        raw_units = result.get("units", [])
    else:
        # All unused units
        raw_units = await feed_svc.get_all_unused_units(user_id, limit=limit)

    units = [_unit_to_response(u) for u in raw_units]
    return UnitListResponse(units=units, count=len(units))


@router.get(
    "/units/search",
    response_model=UnitSearchResponse,
    responses={429: {"model": ErrorResponse}},
    tags=["v1-units"],
)
@limiter.limit("30/minute")
async def search_units(
    request: Request,
    q: str = Query(..., min_length=1, max_length=500, description="Search query"),
    country: Optional[str] = Query(None, description="ISO country code filter"),
    state: Optional[str] = Query(None, description="State/region filter"),
    city: Optional[str] = Query(None, description="City filter"),
    topic: Optional[str] = Query(None, description="Topic filter"),
    limit: int = Query(20, ge=1, le=100, description="Max results"),
    user: dict = Depends(verify_api_key),
):
    """Semantic search across information units."""
    feed_svc = _get_feed_search_service()

    location = None
    if country:
        location = GeocodedLocation(
            displayName=f"{city or ''}, {state or ''}, {country}".strip(", "),
            city=city,
            state=state,
            country=country,
        )

    result = await feed_svc.search_semantic(
        user_id=user["user_id"],
        query=q,
        location=location,
        topic=topic,
        limit=limit,
    )

    return UnitSearchResponse(
        units=result.get("units", []),
        count=result.get("count", 0),
        query=result.get("query", q),
    )
