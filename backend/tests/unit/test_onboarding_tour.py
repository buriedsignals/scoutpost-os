"""
Unit tests for the onboarding router (DynamoDB-backed).

Verifies:
1. POST /initialize validates timezone and calls UserService.update_preferences
2. POST /initialize returns 400 for invalid timezone
3. POST /initialize returns 500 when UserService fails
4. POST /initialize passes location when provided
5. GET /status returns onboarding_completed from user dict
6. POST /tour-complete calls UserService.update_preferences with tour flag
7. POST /tour-complete returns 500 when UserService fails
"""
import pytest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.routers.onboarding import (
    complete_onboarding_tour,
    get_onboarding_status,
    initialize_user,
    InitializeUserRequest,
)


# ---------------------------------------------------------------------------
# Module path constant for patching
# ---------------------------------------------------------------------------
_MOD = "app.routers.onboarding"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_user(overrides=None):
    """Build a mock authenticated user dict (as returned by get_current_user)."""
    base = {
        "user_id": "user_test123",
        "muckrock_id": "user_test123",
        "credits": 50,
        "timezone": "Europe/Zurich",
        "onboarding_completed": True,
        "needs_initialization": False,
        "preferred_language": "en",
        "tier": "free",
        "excluded_domains": [],
    }
    if overrides:
        base.update(overrides)
    return base


# =============================================================================
# POST /initialize
# =============================================================================


class TestInitialize:
    """Tests for the POST /initialize endpoint."""

    @pytest.mark.asyncio
    @patch(f"{_MOD}.build_user_response", new_callable=AsyncMock)
    @patch(f"{_MOD}.UserService")
    async def test_initialize_calls_update_preferences(self, mock_user_service_cls, mock_build_response):
        """initialize should call update_preferences with timezone, language, onboarding_completed."""
        mock_service = AsyncMock()
        mock_user_service_cls.return_value = mock_service
        mock_build_response.return_value = {
            "user_id": "user_test123",
            "credits": 50,
            "timezone": "Europe/Zurich",
            "onboarding_completed": True,
            "needs_initialization": False,
            "preferred_language": "de",
            "tier": "free",
            "excluded_domains": [],
            "muckrock_id": "user_test123",
            "default_location": None,
            "cms_api_url": None,
            "has_cms_token": False,
        }

        payload = InitializeUserRequest(timezone="Europe/Zurich", preferred_language="de")
        user = _make_user({"onboarding_completed": False})

        result = await initialize_user(payload=payload, user=user)

        assert result["onboarding_completed"] is True
        assert result["needs_initialization"] is False
        mock_service.update_preferences.assert_called_once_with(
            "user_test123",
            timezone="Europe/Zurich",
            preferred_language="de",
            onboarding_completed=True,
        )

    @pytest.mark.asyncio
    @patch(f"{_MOD}.build_user_response", new_callable=AsyncMock)
    @patch(f"{_MOD}.UserService")
    async def test_initialize_with_location(self, mock_user_service_cls, mock_build_response):
        """initialize should pass default_location when location is provided."""
        mock_service = AsyncMock()
        mock_user_service_cls.return_value = mock_service
        mock_build_response.return_value = {
            "user_id": "user_test123",
            "credits": 50,
            "timezone": "America/New_York",
            "onboarding_completed": True,
            "needs_initialization": False,
            "preferred_language": "en",
            "tier": "free",
            "excluded_domains": [],
            "muckrock_id": "user_test123",
            "default_location": {
                "displayName": "New York, USA",
                "country": "US",
                "locationType": "city",
                "maptilerId": "abc123",
                "city": "New York",
                "state": "New York",
            },
            "cms_api_url": None,
            "has_cms_token": False,
        }

        payload = InitializeUserRequest(
            timezone="America/New_York",
            location={
                "displayName": "New York, USA",
                "country": "US",
                "locationType": "city",
                "maptilerId": "abc123",
                "city": "New York",
                "state": "New York",
            },
        )
        user = _make_user({"onboarding_completed": False})

        result = await initialize_user(payload=payload, user=user)

        assert result["onboarding_completed"] is True
        assert result["needs_initialization"] is False
        call_kwargs = mock_service.update_preferences.call_args
        assert call_kwargs[1]["default_location"]["displayName"] == "New York, USA"
        assert call_kwargs[1]["onboarding_completed"] is True

    @pytest.mark.asyncio
    async def test_initialize_rejects_invalid_timezone(self):
        """initialize should return 400 for an invalid timezone."""
        payload = InitializeUserRequest(timezone="Not/A/Timezone")
        user = _make_user()

        with pytest.raises(HTTPException) as exc_info:
            await initialize_user(payload=payload, user=user)

        assert exc_info.value.status_code == 400
        assert "Invalid timezone" in exc_info.value.detail

    @pytest.mark.asyncio
    @patch(f"{_MOD}.UserService")
    async def test_initialize_returns_500_on_service_failure(self, mock_user_service_cls):
        """initialize should return 500 when UserService raises."""
        mock_service = AsyncMock()
        mock_service.update_preferences.side_effect = Exception("DynamoDB down")
        mock_user_service_cls.return_value = mock_service

        payload = InitializeUserRequest(timezone="Europe/Zurich")
        user = _make_user()

        with pytest.raises(HTTPException) as exc_info:
            await initialize_user(payload=payload, user=user)

        assert exc_info.value.status_code == 500

    @pytest.mark.asyncio
    @patch(f"{_MOD}.build_user_response", new_callable=AsyncMock)
    @patch(f"{_MOD}.UserService")
    async def test_initialize_normalizes_deprecated_timezone(self, mock_user_service_cls, mock_build_response):
        """initialize should normalize deprecated timezone names before storing."""
        mock_service = AsyncMock()
        mock_user_service_cls.return_value = mock_service
        mock_build_response.return_value = _make_user({
            "timezone": "America/Argentina/Buenos_Aires",
        })

        payload = InitializeUserRequest(timezone="America/Buenos_Aires")
        user = _make_user({"onboarding_completed": False})

        await initialize_user(payload=payload, user=user)

        call_kwargs = mock_service.update_preferences.call_args[1]
        assert call_kwargs["timezone"] == "America/Argentina/Buenos_Aires"

    @pytest.mark.asyncio
    @patch(f"{_MOD}.build_user_response", new_callable=AsyncMock)
    @patch(f"{_MOD}.UserService")
    async def test_initialize_defaults_language_to_en(self, mock_user_service_cls, mock_build_response):
        """initialize should default preferred_language to 'en'."""
        mock_service = AsyncMock()
        mock_user_service_cls.return_value = mock_service
        mock_build_response.return_value = _make_user()

        payload = InitializeUserRequest(timezone="Europe/Zurich")
        user = _make_user()

        await initialize_user(payload=payload, user=user)

        call_kwargs = mock_service.update_preferences.call_args
        assert call_kwargs[1]["preferred_language"] == "en"


# =============================================================================
# GET /status
# =============================================================================


class TestStatus:
    """Tests for the GET /status endpoint."""

    @pytest.mark.asyncio
    async def test_status_returns_completed_true(self):
        """status should return onboarding_completed: True when user is initialized."""
        user = _make_user({"onboarding_completed": True})
        result = await get_onboarding_status(user=user)

        assert result["onboarding_completed"] is True
        assert result["needs_initialization"] is False

    @pytest.mark.asyncio
    async def test_status_returns_completed_false(self):
        """status should return needs_initialization: True when user is not initialized."""
        user = _make_user({"onboarding_completed": False})
        result = await get_onboarding_status(user=user)

        assert result["onboarding_completed"] is False
        assert result["needs_initialization"] is True

    @pytest.mark.asyncio
    async def test_status_defaults_to_not_completed(self):
        """status should default to not completed when key is missing."""
        user = {"user_id": "user_test123", "muckrock_id": "user_test123"}
        result = await get_onboarding_status(user=user)

        assert result["onboarding_completed"] is False
        assert result["needs_initialization"] is True


# =============================================================================
# POST /tour-complete
# =============================================================================


class TestTourComplete:
    """Tests for the POST /tour-complete endpoint."""

    @pytest.mark.asyncio
    @patch(f"{_MOD}.UserService")
    async def test_sets_tour_completed_in_dynamodb(self, mock_user_service_cls):
        """tour-complete should call update_preferences with onboarding_tour_completed=True."""
        mock_service = AsyncMock()
        mock_user_service_cls.return_value = mock_service

        result = await complete_onboarding_tour(user=_make_user())

        assert result == {"status": "completed"}
        mock_service.update_preferences.assert_called_once_with(
            "user_test123",
            onboarding_tour_completed=True,
        )

    @pytest.mark.asyncio
    @patch(f"{_MOD}.UserService")
    async def test_returns_500_when_service_fails(self, mock_user_service_cls):
        """tour-complete should return 500 if UserService raises."""
        mock_service = AsyncMock()
        mock_service.update_preferences.side_effect = Exception("DynamoDB down")
        mock_user_service_cls.return_value = mock_service

        with pytest.raises(HTTPException) as exc_info:
            await complete_onboarding_tour(user=_make_user())

        assert exc_info.value.status_code == 500
