"""
User onboarding router.

PURPOSE: Handles onboarding initialization, status checks, and tour completion.
All user state is stored in DynamoDB via UserService.

DEPENDS ON: dependencies (get_current_user), UserService
USED BY: frontend (onboarding modal), main.py (router mount)
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.dependencies import get_current_user, build_user_response
from app.services.user_service import UserService

logger = logging.getLogger(__name__)

router = APIRouter()


class LocationData(BaseModel):
    """Location data from Maptiler geocoding."""
    displayName: str
    city: str | None = None
    state: str | None = None
    country: str
    locationType: str  # 'city' | 'state' | 'country'
    maptilerId: str
    coordinates: dict | None = None  # { lat: float, lon: float }


class InitializeUserRequest(BaseModel):
    """Request model for user initialization."""
    timezone: str = Field(
        ...,
        min_length=2,
        max_length=120,
        description="IANA timezone identifier (e.g., 'America/New_York', 'Europe/London')"
    )
    location: LocationData | None = Field(
        default=None,
        description="Optional default location for scouts"
    )
    preferred_language: str = Field(
        "en",
        min_length=2,
        max_length=5,
        description="ISO 639-1 language code (e.g., 'en', 'de', 'fr')"
    )


@router.post("/initialize")
async def initialize_user(
    payload: InitializeUserRequest,
    user: dict = Depends(get_current_user),
):
    """
    Initialize a new user's preferences after signup.

    Sets timezone, preferred language, optional default location, and marks
    onboarding as completed. Credits are already set during the OAuth callback.
    This endpoint is idempotent.
    """
    # Validate and canonicalize timezone identifier
    from app.utils.timezone import validate_timezone
    try:
        canonical_tz = validate_timezone(payload.timezone)
    except ValueError:
        logger.error(f"Invalid timezone '{payload.timezone}'")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid timezone identifier: {payload.timezone}",
        )

    user_id = user["user_id"]

    try:
        prefs: dict = {
            "timezone": canonical_tz,
            "preferred_language": payload.preferred_language,
            "onboarding_completed": True,
        }
        if payload.location:
            prefs["default_location"] = payload.location.model_dump()

        user_service = UserService()
        await user_service.update_preferences(user_id, **prefs)

        logger.info(f"Initialized user {user_id} preferences")

        # Return full updated user dict
        updated_user = await build_user_response(user_service, user_id)
        return updated_user

    except Exception as exc:
        logger.error(f"Failed to initialize user {user_id}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to initialize user. Please try again.",
        )


@router.get("/status")
async def get_onboarding_status(user: dict = Depends(get_current_user)):
    """
    Check if user has completed onboarding/initialization.
    Reads directly from the user dict (fetched from DynamoDB by get_current_user).
    """
    completed = user.get("onboarding_completed", False)
    return {
        "needs_initialization": not completed,
        "onboarding_completed": completed,
    }


@router.post("/tour-complete")
async def complete_onboarding_tour(user: dict = Depends(get_current_user)):
    """
    Mark the onboarding tour as completed in DynamoDB.
    """
    user_id = user["user_id"]

    try:
        user_service = UserService()
        await user_service.update_preferences(user_id, onboarding_tour_completed=True)

        logger.info(f"Marked onboarding tour complete for user {user_id}")
        return {"status": "completed"}

    except Exception as exc:
        logger.error(f"Failed to update tour completion for {user_id}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update onboarding tour status. Please try again.",
        )
