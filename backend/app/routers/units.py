"""
Information units API endpoints for Feed panel.

PURPOSE: CRUD operations for atomic information units — list locations/topics,
retrieve units by location or topic, semantic search, and mark-as-used.
Backs the entire Feed sidebar panel in the frontend.

DEPENDS ON: dependencies (session cookie auth), services/feed_search_service,
    schemas/scouts (GeocodedLocation), schemas/units (request/response models)
USED BY: frontend (Feed panel), main.py (router mount)
"""
import logging
from fastapi import APIRouter, Depends, HTTPException, Query, status
from typing import Optional

from app.dependencies import get_current_user
from app.services.feed_search_service import FeedSearchService
from app.schemas.scouts import GeocodedLocation
from app.schemas.units import (
    AtomicInformationUnit,
    UnitsResponse,
    LocationsResponse,
    TopicsResponse,
    MarkUsedRequest,
    MarkUsedResponse,
    SearchedUnit,
    SearchUnitsResponse,
)

logger = logging.getLogger(__name__)
router = APIRouter()
feed_service = FeedSearchService()


def _normalize_unit(u: dict, user_id: str = "") -> dict:
    """Normalize a unit dict from Supabase adapter to match DynamoDB schema expectations."""
    # Map PostgreSQL field names to DynamoDB equivalents
    if "id" in u and "unit_id" not in u:
        u["unit_id"] = str(u["id"])
    if "type" in u and "unit_type" not in u:
        u["unit_type"] = u["type"]
    if "scout_id" in u and isinstance(u["scout_id"], str):
        pass  # Already string

    # Build DynamoDB-compatible pk and sk
    uid = u.get("user_id", user_id)
    if "pk" not in u or not u["pk"]:
        u["pk"] = f"USER#{uid}#"
    if "sk" not in u or not u["sk"]:
        created = u.get("created_at", "")
        unit_id = u.get("unit_id", u.get("id", ""))
        u["sk"] = f"UNIT#{created}#{unit_id}"

    # Ensure created_at is a string
    if "created_at" in u and not isinstance(u["created_at"], str):
        u["created_at"] = str(u["created_at"])

    # Ensure article_id is a string
    if "article_id" in u:
        u["article_id"] = str(u["article_id"]) if u["article_id"] else ""

    # Map event_date to date field
    if "event_date" in u and "date" not in u:
        ed = u["event_date"]
        u["date"] = str(ed) if ed else None

    return u


@router.get("/units/locations", response_model=LocationsResponse)
async def get_user_locations(
    user: dict = Depends(get_current_user),
):
    """
    Get distinct locations where user has information units.

    Used to populate the Compose panel location dropdown.

    Returns:
        LocationsResponse with list of location strings (e.g., "US#CA#San Francisco")
    """
    user_id = user.get("user_id")

    try:
        locations = await feed_service.get_user_locations(user_id)
        return LocationsResponse(locations=locations)

    except Exception as e:
        logger.error(f"Failed to get locations for {user_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve locations",
        )


@router.get("/units/topics", response_model=TopicsResponse)
async def get_user_topics(
    user: dict = Depends(get_current_user),
):
    """Get distinct topics where user has information units."""
    user_id = user.get("user_id")

    try:
        topics = await feed_service.get_user_topics(user_id)
        return TopicsResponse(topics=topics)

    except Exception as e:
        logger.error(f"Failed to get topics for {user_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve topics",
        )


@router.get("/units/by-topic", response_model=UnitsResponse)
async def get_units_by_topic(
    user: dict = Depends(get_current_user),
    topic: str = Query(..., description="Topic string"),
    limit: int = Query(50, ge=1, le=100, description="Max units to return"),
):
    """Get information units for a specific topic."""
    user_id = user.get("user_id")

    try:
        result = await feed_service.get_units_by_topic(
            user_id=user_id,
            topic=topic,
            limit=limit,
        )

        units = [AtomicInformationUnit(**_normalize_unit(u, user_id)) for u in result["units"]]
        return UnitsResponse(units=units, count=len(units))

    except Exception as e:
        logger.error(f"Failed to get units by topic for {user_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve units",
        )


@router.get("/units/all", response_model=UnitsResponse)
async def get_all_unused_units(
    user: dict = Depends(get_current_user),
    limit: int = Query(50, ge=1, le=100, description="Max units to return"),
):
    """
    Get all unused information units for the current user (no location/topic filter).

    Used by Compose panel to show all available units on initial load.
    """
    user_id = user.get("user_id")

    try:
        units_data = await feed_service.get_all_unused_units(
            user_id=user_id,
            limit=limit,
        )
        units = [AtomicInformationUnit(**_normalize_unit(u, user_id)) for u in units_data]
        return UnitsResponse(units=units, count=len(units))

    except Exception as e:
        logger.error(f"Failed to get all units for {user_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve units",
        )


@router.get("/units", response_model=UnitsResponse)
async def get_units_by_location(
    user: dict = Depends(get_current_user),
    country: str = Query(..., description="Country code (e.g., US)"),
    state: Optional[str] = Query(None, description="State code (e.g., CA)"),
    city: Optional[str] = Query(None, description="City name"),
    display_name: str = Query(..., alias="displayName", description="Full display name"),
    limit: int = Query(50, ge=1, le=100, description="Max units to return"),
):
    """
    Get information units for a specific location.

    Used by Compose panel to display available units for article generation.

    Args:
        country: Country code (required)
        state: State code (optional)
        city: City name (optional)
        display_name: Full display name from MapTiler
        limit: Max units to return (default 50)

    Returns:
        UnitsResponse with list of InformationUnit objects
    """
    user_id = user.get("user_id")

    # Build GeocodedLocation from query params
    location = GeocodedLocation(
        displayName=display_name,
        city=city,
        state=state,
        country=country,
    )

    try:
        units_data = await feed_service.get_units_by_location(
            user_id=user_id,
            location=location,
            limit=limit,
        )

        # Convert to response model
        units = [AtomicInformationUnit(**_normalize_unit(u, user_id)) for u in units_data]

        return UnitsResponse(units=units, count=len(units))

    except Exception as e:
        logger.error(f"Failed to get units for {user_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve units",
        )


@router.get("/units/search", response_model=SearchUnitsResponse)
async def search_units_semantic(
    user: dict = Depends(get_current_user),
    country: Optional[str] = Query(None, description="Country code (optional)"),
    state: Optional[str] = Query(None, description="State code (optional)"),
    city: Optional[str] = Query(None, description="City name (optional)"),
    display_name: Optional[str] = Query(None, alias="displayName", description="Full display name"),
    topic: Optional[str] = Query(None, description="Topic filter (optional)"),
    query: str = Query(..., min_length=2, max_length=200, description="Search query"),
    limit: int = Query(20, ge=1, le=50, description="Max units to return"),
):
    """
    Semantic search across information units.

    Uses embedding similarity to find relevant units based on query.
    Location is optional - if omitted, searches ALL user's units.
    Returns units sorted by similarity score (highest first).

    Args:
        country: Country code (optional - if omitted, searches all locations)
        state: State code (optional)
        city: City name (optional)
        display_name: Full display name from MapTiler
        query: Search query text (2-200 chars)
        limit: Max units to return (default 20)

    Returns:
        SearchUnitsResponse with units (including similarity_score), count, and query
    """
    user_id = user.get("user_id")

    # Build GeocodedLocation from query params (only if country provided)
    location = None
    if country:
        location = GeocodedLocation(
            displayName=display_name or "",
            city=city,
            state=state,
            country=country,
        )

    try:
        result = await feed_service.search_semantic(
            user_id=user_id,
            query=query,
            location=location,
            topic=topic,
            limit=limit,
        )

        # Convert to response model
        units = [SearchedUnit(**_normalize_unit(u, user_id)) for u in result["units"]]

        return SearchUnitsResponse(
            units=units,
            count=result["count"],
            query=result["query"],
        )

    except Exception as e:
        logger.error(f"Failed to search units for {user_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to search units",
        )


@router.patch("/units/mark-used", response_model=MarkUsedResponse)
async def mark_units_used(
    request: MarkUsedRequest,
    user: dict = Depends(get_current_user),
):
    """
    Mark units as used in an article.

    This sets a 60-day TTL on the units (from time of use).
    Used after article generation in the Compose panel.

    Args:
        request: MarkUsedRequest with list of unit keys (pk, sk)

    Returns:
        MarkUsedResponse with count of marked units
    """
    user_id = user.get("user_id")

    # Convert request to list of tuples
    unit_keys = [(key.pk, key.sk) for key in request.unit_keys]

    # Validate user owns these units (pk should start with USER#{user_id})
    expected_prefix = f"USER#{user_id}#"
    for pk, _ in unit_keys:
        if not pk.startswith(expected_prefix):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Cannot modify units belonging to another user",
            )

    try:
        marked_count = await feed_service.mark_used_in_article(unit_keys)

        return MarkUsedResponse(
            marked_count=marked_count,
            total_requested=len(unit_keys),
        )

    except Exception as e:
        logger.error(f"Failed to mark units for {user_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to mark units as used",
        )


@router.get("/units/by-article/{article_id}", response_model=UnitsResponse)
async def get_units_by_article(
    article_id: str,
    user: dict = Depends(get_current_user),
):
    """
    Get all units extracted from a specific article.

    Useful for viewing the atomic units that were extracted from a single source.

    Args:
        article_id: The article ID to query

    Returns:
        UnitsResponse with list of units from that article
    """
    user_id = user.get("user_id")

    try:
        units_data = await feed_service.get_units_by_article(article_id)

        # Verify user owns these units
        if units_data and units_data[0].get("pk"):
            expected_prefix = f"USER#{user_id}#"
            if not units_data[0]["pk"].startswith(expected_prefix):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Cannot access units belonging to another user",
                )

        units = [AtomicInformationUnit(**_normalize_unit(u, user_id)) for u in units_data]
        return UnitsResponse(units=units, count=len(units))

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get units by article for {user_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve units",
        )


@router.get("/units/unused", response_model=UnitsResponse)
async def get_unused_units(
    user: dict = Depends(get_current_user),
    country: str = Query(..., description="Country code (e.g., US)"),
    state: Optional[str] = Query(None, description="State code (e.g., CA)"),
    city: Optional[str] = Query(None, description="City name"),
    display_name: str = Query(..., alias="displayName", description="Full display name"),
    limit: int = Query(50, ge=1, le=100, description="Max units to return"),
):
    """
    Get only unused information units for a specific location.

    Filters to units where used_in_article=false.
    Used by Compose panel to show only fresh units for article generation.

    Args:
        country: Country code (required)
        state: State code (optional)
        city: City name (optional)
        display_name: Full display name from MapTiler
        limit: Max units to return (default 50)

    Returns:
        UnitsResponse with list of unused AtomicInformationUnit objects
    """
    user_id = user.get("user_id")

    # Build GeocodedLocation from query params
    location = GeocodedLocation(
        displayName=display_name,
        city=city,
        state=state,
        country=country,
    )

    try:
        units_data = await feed_service.get_units_by_location(
            user_id=user_id,
            location=location,
            limit=limit,
        )

        # Filter to unused units only
        unused_units = [u for u in units_data if not u.get("used_in_article", False)]
        units = [AtomicInformationUnit(**_normalize_unit(u, user_id)) for u in unused_units]

        return UnitsResponse(units=units, count=len(units))

    except Exception as e:
        logger.error(f"Failed to get unused units for {user_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve units",
        )
