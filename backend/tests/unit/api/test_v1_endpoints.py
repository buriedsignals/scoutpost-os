"""
Unit tests for the v1 API router.

Tests cover:
- Key management endpoints (session cookie auth): POST/GET/DELETE /keys
- Scout endpoints (API key auth): GET/POST/DELETE /scouts, POST /scouts/{name}/run
- Unit endpoints (API key auth): GET /units, GET /units/search
- Auth enforcement: session vs API key per endpoint group
- Error responses: structured {error, code} format
- DEV_ prefix in development mode
- Credit validation and deduction
"""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.dependencies import get_current_user, verify_api_key
from app.routers import v1 as v1_module

# ---------------------------------------------------------------------------
# Test app setup
# ---------------------------------------------------------------------------

_test_app = FastAPI()
_test_app.include_router(v1_module.router, prefix="/api/v1")

# Mock users
MOCK_SESSION_USER = {
    "user_id": "user-session-123",
    "muckrock_id": "user-session-123",
    "credits": 100,
    "timezone": "America/New_York",
    "preferred_language": "en",
    "onboarding_completed": True,
    "needs_initialization": False,
    "tier": "pro",
    "excluded_domains": [],
}

MOCK_API_KEY_USER = {
    "user_id": "user-api-456",
    "muckrock_id": "user-api-456",
    "credits": 200,
    "timezone": "Europe/Berlin",
    "preferred_language": "de",
    "onboarding_completed": True,
    "needs_initialization": False,
    "tier": "pro",
    "excluded_domains": [],
}


def _override_session_user():
    """Dependency override for session cookie auth."""
    return MOCK_SESSION_USER


def _override_api_key_user():
    """Dependency override for API key auth."""
    return MOCK_API_KEY_USER


@pytest.fixture(autouse=True)
def reset_singletons():
    """Reset lazy service singletons between tests."""
    v1_module._api_key_service = None
    v1_module._schedule_service = None
    v1_module._feed_search_service = None
    yield
    v1_module._api_key_service = None
    v1_module._schedule_service = None
    v1_module._feed_search_service = None


@pytest.fixture
def session_client():
    """TestClient with session cookie auth overridden."""
    _test_app.dependency_overrides[get_current_user] = _override_session_user
    _test_app.dependency_overrides.pop(verify_api_key, None)
    client = TestClient(_test_app)
    yield client
    _test_app.dependency_overrides.clear()


@pytest.fixture
def api_client():
    """TestClient with API key auth overridden."""
    _test_app.dependency_overrides[verify_api_key] = _override_api_key_user
    _test_app.dependency_overrides.pop(get_current_user, None)
    client = TestClient(_test_app)
    yield client
    _test_app.dependency_overrides.clear()


@pytest.fixture
def both_client():
    """TestClient with both auth types overridden."""
    _test_app.dependency_overrides[get_current_user] = _override_session_user
    _test_app.dependency_overrides[verify_api_key] = _override_api_key_user
    client = TestClient(_test_app)
    yield client
    _test_app.dependency_overrides.clear()


# =============================================================================
# Key Management Tests (session cookie auth)
# =============================================================================


class TestCreateApiKey:
    def test_create_key_returns_raw_key(self, session_client):
        mock_svc = MagicMock()
        mock_svc.create_key.return_value = {
            "raw_key": "cj_test_raw_key_123",
            "key_id": "key-uuid-1",
            "key_prefix": "cj_test",
            "name": "My Key",
            "created_at": "2026-01-01T00:00:00+00:00",
        }

        with patch.object(v1_module, "_get_api_key_service", return_value=mock_svc):
            response = session_client.post(
                "/api/v1/keys", json={"name": "My Key"}
            )

        assert response.status_code == 200
        data = response.json()
        assert data["key"] == "cj_test_raw_key_123"
        assert data["key_id"] == "key-uuid-1"
        assert data["key_prefix"] == "cj_test"
        assert data["name"] == "My Key"
        mock_svc.create_key.assert_called_once_with("user-session-123", name="My Key")

    def test_create_key_default_empty_name(self, session_client):
        mock_svc = MagicMock()
        mock_svc.create_key.return_value = {
            "raw_key": "cj_abc", "key_id": "k1",
            "key_prefix": "cj_abc", "name": "",
            "created_at": "2026-01-01T00:00:00+00:00",
        }

        with patch.object(v1_module, "_get_api_key_service", return_value=mock_svc):
            response = session_client.post("/api/v1/keys", json={})

        assert response.status_code == 200
        mock_svc.create_key.assert_called_once_with("user-session-123", name="")

    def test_create_key_max_reached_returns_400(self, session_client):
        mock_svc = MagicMock()
        mock_svc.create_key.side_effect = ValueError("Maximum of 5 API keys per user reached")

        with patch.object(v1_module, "_get_api_key_service", return_value=mock_svc):
            response = session_client.post("/api/v1/keys", json={"name": "Extra"})

        assert response.status_code == 400
        data = response.json()["detail"]
        assert data["code"] == "MAX_KEYS_REACHED"


class TestListApiKeys:
    def test_list_keys_returns_metadata(self, session_client):
        mock_svc = MagicMock()
        mock_svc.list_keys.return_value = [
            {"key_id": "k1", "key_prefix": "cj_abc1", "name": "Prod", "created_at": "2026-01-01T00:00:00"},
            {"key_id": "k2", "key_prefix": "cj_def2", "name": "Dev", "created_at": "2026-01-02T00:00:00"},
        ]

        with patch.object(v1_module, "_get_api_key_service", return_value=mock_svc):
            response = session_client.get("/api/v1/keys")

        assert response.status_code == 200
        data = response.json()
        assert data["count"] == 2
        assert len(data["keys"]) == 2
        assert data["keys"][0]["key_id"] == "k1"
        # No raw keys exposed
        assert "raw_key" not in data["keys"][0]

    def test_list_keys_empty(self, session_client):
        mock_svc = MagicMock()
        mock_svc.list_keys.return_value = []

        with patch.object(v1_module, "_get_api_key_service", return_value=mock_svc):
            response = session_client.get("/api/v1/keys")

        assert response.status_code == 200
        data = response.json()
        assert data["count"] == 0
        assert data["keys"] == []


class TestRevokeApiKey:
    def test_revoke_existing_key(self, session_client):
        mock_svc = MagicMock()
        mock_svc.revoke_key.return_value = True

        with patch.object(v1_module, "_get_api_key_service", return_value=mock_svc):
            response = session_client.delete("/api/v1/keys/key-uuid-1")

        assert response.status_code == 200
        assert response.json()["message"] == "API key revoked"
        mock_svc.revoke_key.assert_called_once_with("user-session-123", "key-uuid-1")

    def test_revoke_nonexistent_key_returns_404(self, session_client):
        mock_svc = MagicMock()
        mock_svc.revoke_key.return_value = False

        with patch.object(v1_module, "_get_api_key_service", return_value=mock_svc):
            response = session_client.delete("/api/v1/keys/nonexistent")

        assert response.status_code == 404
        data = response.json()["detail"]
        assert data["code"] == "NOT_FOUND"


# =============================================================================
# Scout Tests (API key auth)
# =============================================================================


class TestListScouts:
    def test_list_scouts_returns_formatted_response(self, api_client):
        mock_svc = AsyncMock()
        mock_svc.list_scouts.return_value = [
            {
                "name": "My Scout",
                "scout_type": "beat",
                "regularity": "daily",
                "time": "08:00",
                "location": {"displayName": "Vienna", "country": "AT"},
                "topic": None,
                "created_at": "2026-01-01T00:00:00Z",
            },
        ]

        with patch.object(v1_module, "_get_schedule_service", return_value=mock_svc):
            response = api_client.get("/api/v1/scouts")

        assert response.status_code == 200
        data = response.json()
        assert data["count"] == 1
        assert data["scouts"][0]["name"] == "My Scout"
        assert data["scouts"][0]["type"] == "beat"

    def test_list_scouts_empty(self, api_client):
        mock_svc = AsyncMock()
        mock_svc.list_scouts.return_value = []

        with patch.object(v1_module, "_get_schedule_service", return_value=mock_svc):
            response = api_client.get("/api/v1/scouts")

        assert response.status_code == 200
        data = response.json()
        assert data["count"] == 0
        assert data["scouts"] == []


class TestCreateScout:
    def test_create_beat_scout_success(self, api_client):
        mock_svc = AsyncMock()
        mock_svc.get_scout.return_value = None  # No duplicate
        mock_svc.create_scout.return_value = {
            "message": "Scout created successfully",
            "schedule_name": "scout-user-api-456-abc12345-My-Scout",
            "scraper_name": "My Scout",
        }

        mock_settings = MagicMock()
        mock_settings.environment = "production"

        with patch.object(v1_module, "_get_schedule_service", return_value=mock_svc), \
             patch("app.routers.v1.get_settings", return_value=mock_settings), \
             patch("app.routers.v1.validate_credits", new_callable=AsyncMock) as mock_validate:
            mock_validate.return_value = {"current_credits": 200, "required": 2, "remaining_after": 198}

            response = api_client.post("/api/v1/scouts", json={
                "name": "My Scout",
                "type": "beat",
                "schedule": {"regularity": "daily", "time": "08:00"},
                "location": {"displayName": "Vienna, Austria", "country": "AT", "city": "Vienna"},
            })

        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "My Scout"
        assert data["type"] == "beat"
        mock_svc.create_scout.assert_called_once()

    def test_create_web_scout_success(self, api_client):
        mock_svc = AsyncMock()
        mock_svc.get_scout.return_value = None
        mock_svc.create_scout.return_value = {
            "message": "Scout created",
            "schedule_name": "scout-test",
            "scraper_name": "Page Watch",
        }

        mock_settings = MagicMock()
        mock_settings.environment = "production"

        with patch.object(v1_module, "_get_schedule_service", return_value=mock_svc), \
             patch("app.routers.v1.get_settings", return_value=mock_settings), \
             patch("app.routers.v1.validate_credits", new_callable=AsyncMock) as mock_validate:
            mock_validate.return_value = {"current_credits": 200, "required": 1}

            response = api_client.post("/api/v1/scouts", json={
                "name": "Page Watch",
                "type": "web",
                "schedule": {"regularity": "weekly", "time": "10:00", "day_number": 1},
                "url": "https://example.com/news",
            })

        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "Page Watch"
        assert data["type"] == "web"

        # Verify provider defaults to firecrawl_plain for API
        call_args = mock_svc.create_scout.call_args
        body = call_args.kwargs.get("body") or call_args[1].get("body") or call_args[0][2]
        assert body["provider"] == "firecrawl_plain"

    def test_create_social_scout_forwards_criteria_and_normalized_linkedin_handle(
        self, api_client
    ):
        mock_svc = AsyncMock()
        mock_svc.get_scout.return_value = None
        mock_svc.create_scout.return_value = {
            "message": "Scout created",
            "schedule_name": "scout-linkedin",
            "scraper_name": "LinkedIn Watch",
        }

        mock_settings = MagicMock()
        mock_settings.environment = "production"

        with patch.object(v1_module, "_get_schedule_service", return_value=mock_svc), \
             patch("app.routers.v1.get_settings", return_value=mock_settings), \
             patch("app.routers.v1.validate_credits", new_callable=AsyncMock) as mock_validate:
            mock_validate.return_value = {"current_credits": 200, "required": 3}

            response = api_client.post("/api/v1/scouts", json={
                "name": "LinkedIn Watch",
                "type": "social",
                "schedule": {"regularity": "weekly", "time": "09:00"},
                "platform": "linkedin",
                "profile_handle": "https://www.linkedin.com/in/satyanadella/",
                "monitor_mode": "criteria",
                "criteria": "AI infrastructure announcements",
                "topic": "technology",
                "track_removals": True,
            })

        assert response.status_code == 201
        call_args = mock_svc.create_scout.call_args
        body = call_args.kwargs["body"]
        assert body["platform"] == "linkedin"
        assert body["profile_handle"] == "satyanadella"
        assert body["monitor_mode"] == "criteria"
        assert body["criteria"] == "AI infrastructure announcements"
        assert body["topic"] == "technology"
        assert body["track_removals"] is True

    def test_create_social_scout_defaults_to_criteria_and_requires_text(
        self, api_client
    ):
        response = api_client.post("/api/v1/scouts", json={
            "name": "Missing Criteria",
            "type": "social",
            "schedule": {"regularity": "weekly", "time": "09:00"},
            "platform": "linkedin",
            "profile_handle": "satyanadella",
            "topic": "technology",
        })

        assert response.status_code == 422
        assert "criteria" in response.text

    def test_create_social_scout_keeps_explicit_summarize_without_criteria(
        self, api_client
    ):
        mock_svc = AsyncMock()
        mock_svc.get_scout.return_value = None
        mock_svc.create_scout.return_value = {
            "message": "Scout created",
            "schedule_name": "scout-linkedin-digest",
            "scraper_name": "LinkedIn Digest",
        }
        mock_settings = MagicMock()
        mock_settings.environment = "production"

        with patch.object(v1_module, "_get_schedule_service", return_value=mock_svc), \
             patch("app.routers.v1.get_settings", return_value=mock_settings), \
             patch("app.routers.v1.validate_credits", new_callable=AsyncMock):
            response = api_client.post("/api/v1/scouts", json={
                "name": "LinkedIn Digest",
                "type": "social",
                "schedule": {"regularity": "weekly", "time": "09:00"},
                "platform": "linkedin",
                "profile_handle": "satyanadella",
                "monitor_mode": "summarize",
                "topic": "technology",
            })

        assert response.status_code == 201
        body = mock_svc.create_scout.call_args.kwargs["body"]
        assert body["monitor_mode"] == "summarize"
        assert "criteria" not in body

    def test_create_social_scout_rejects_non_profile_linkedin_url(
        self, api_client
    ):
        response = api_client.post("/api/v1/scouts", json={
            "name": "Bad LinkedIn URL",
            "type": "social",
            "schedule": {"regularity": "weekly", "time": "09:00"},
            "platform": "linkedin",
            "profile_handle": "https://www.linkedin.com/feed/",
            "monitor_mode": "summarize",
            "topic": "technology",
        })

        assert response.status_code == 422
        assert "linkedin.com/in/" in response.text

    def test_create_social_scout_keeps_company_page_error(self, api_client):
        response = api_client.post("/api/v1/scouts", json={
            "name": "Company LinkedIn URL",
            "type": "social",
            "schedule": {"regularity": "weekly", "time": "09:00"},
            "platform": "linkedin",
            "profile_handle": "https://www.linkedin.com/company/microsoft/",
            "monitor_mode": "summarize",
            "topic": "technology",
        })

        assert response.status_code == 422
        assert "company pages are not supported" in response.text

    def test_create_scout_duplicate_name_returns_409(self, api_client):
        mock_svc = AsyncMock()
        mock_svc.get_scout.return_value = {"name": "Existing", "scout_type": "web"}

        with patch.object(v1_module, "_get_schedule_service", return_value=mock_svc):
            response = api_client.post("/api/v1/scouts", json={
                "name": "Existing",
                "type": "beat",
                "schedule": {"regularity": "daily", "time": "08:00"},
                "topic": "news",
            })

        assert response.status_code == 409
        data = response.json()["detail"]
        assert data["code"] == "DUPLICATE_NAME"

    def test_create_scout_no_timezone_returns_400(self, api_client):
        user_no_tz = {**MOCK_API_KEY_USER, "timezone": None}
        _test_app.dependency_overrides[verify_api_key] = lambda: user_no_tz

        mock_svc = AsyncMock()
        mock_svc.get_scout.return_value = None

        with patch.object(v1_module, "_get_schedule_service", return_value=mock_svc):
            response = TestClient(_test_app).post("/api/v1/scouts", json={
                "name": "Test",
                "type": "beat",
                "schedule": {"regularity": "daily", "time": "08:00"},
                "topic": "news",
            })

        assert response.status_code == 400
        data = response.json()["detail"]
        assert data["code"] == "TIMEZONE_REQUIRED"
        _test_app.dependency_overrides[verify_api_key] = _override_api_key_user

    def test_create_scout_dev_prefix_in_development(self, api_client):
        mock_svc = AsyncMock()
        mock_svc.get_scout.return_value = None
        mock_svc.create_scout.return_value = {
            "message": "created", "schedule_name": "s", "scraper_name": "DEV_Test",
        }

        mock_settings = MagicMock()
        mock_settings.environment = "development"

        with patch.object(v1_module, "_get_schedule_service", return_value=mock_svc), \
             patch("app.routers.v1.get_settings", return_value=mock_settings), \
             patch("app.routers.v1.validate_credits", new_callable=AsyncMock) as mock_validate:
            mock_validate.return_value = {"current_credits": 200, "required": 2}

            response = api_client.post("/api/v1/scouts", json={
                "name": "Test",
                "type": "beat",
                "schedule": {"regularity": "daily", "time": "08:00"},
                "topic": "news",
            })

        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "DEV_Test"

        # get_scout called with DEV_ prefixed name
        mock_svc.get_scout.assert_called_once_with("user-api-456", "DEV_Test")

    def test_create_scout_dev_prefix_not_doubled(self, api_client):
        """If name already starts with DEV_, don't add it again."""
        mock_svc = AsyncMock()
        mock_svc.get_scout.return_value = None
        mock_svc.create_scout.return_value = {
            "message": "created", "schedule_name": "s", "scraper_name": "DEV_Already",
        }

        mock_settings = MagicMock()
        mock_settings.environment = "development"

        with patch.object(v1_module, "_get_schedule_service", return_value=mock_svc), \
             patch("app.routers.v1.get_settings", return_value=mock_settings), \
             patch("app.routers.v1.validate_credits", new_callable=AsyncMock) as mock_validate:
            mock_validate.return_value = {"current_credits": 200, "required": 2}

            response = api_client.post("/api/v1/scouts", json={
                "name": "DEV_Already",
                "type": "beat",
                "schedule": {"regularity": "daily", "time": "08:00"},
                "topic": "news",
            })

        assert response.status_code == 201
        assert response.json()["name"] == "DEV_Already"

    def test_create_web_scout_requires_url(self, api_client):
        """Web scouts must have a url field."""
        response = api_client.post("/api/v1/scouts", json={
            "name": "No URL",
            "type": "web",
            "schedule": {"regularity": "daily", "time": "08:00"},
        })

        assert response.status_code == 422  # Pydantic validation

    def test_create_beat_scout_requires_location_or_topic(self, api_client):
        """Beat scouts must have at least location or topic."""
        response = api_client.post("/api/v1/scouts", json={
            "name": "Nothing",
            "type": "beat",
            "schedule": {"regularity": "daily", "time": "08:00"},
        })

        assert response.status_code == 422  # Pydantic model_validator

    def test_create_scout_insufficient_credits_returns_402(self, api_client):
        from fastapi import HTTPException

        mock_svc = AsyncMock()
        mock_svc.get_scout.return_value = None

        async def mock_validate_fail(*args, **kwargs):
            raise HTTPException(
                status_code=402,
                detail={"error": "insufficient_credits", "message": "Not enough"},
            )

        with patch.object(v1_module, "_get_schedule_service", return_value=mock_svc), \
             patch("app.routers.v1.validate_credits", side_effect=mock_validate_fail):
            response = api_client.post("/api/v1/scouts", json={
                "name": "Expensive",
                "type": "beat",
                "schedule": {"regularity": "daily", "time": "08:00"},
                "topic": "news",
            })

        assert response.status_code == 402


class TestGetScoutDetail:
    def test_get_existing_scout(self, api_client):
        mock_svc = AsyncMock()
        mock_svc.get_scout.return_value = {
            "name": "My Scout",
            "scout_type": "beat",
            "regularity": "daily",
            "time": "08:00",
            "location": {"displayName": "Vienna", "country": "AT"},
            "scraper_status": True,
            "criteria_status": True,
            "card_summary": "Latest findings...",
            "last_run": "01-15-2026 08:00",
            "created_at": "2026-01-01T00:00:00Z",
        }

        with patch.object(v1_module, "_get_schedule_service", return_value=mock_svc):
            response = api_client.get("/api/v1/scouts/My Scout")

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "My Scout"
        assert data["type"] == "beat"
        assert len(data["recent_runs"]) == 1
        assert data["recent_runs"][0]["scraper_status"] is True

    def test_get_nonexistent_scout_returns_404(self, api_client):
        mock_svc = AsyncMock()
        mock_svc.get_scout.return_value = None

        with patch.object(v1_module, "_get_schedule_service", return_value=mock_svc):
            response = api_client.get("/api/v1/scouts/Nonexistent")

        assert response.status_code == 404
        data = response.json()["detail"]
        assert data["code"] == "NOT_FOUND"


class TestDeleteScout:
    def test_delete_existing_scout(self, api_client):
        mock_svc = AsyncMock()
        mock_svc.get_scout.return_value = {"name": "Doomed", "scout_type": "web"}
        mock_svc.delete_scout.return_value = {"message": "deleted"}

        with patch.object(v1_module, "_get_schedule_service", return_value=mock_svc):
            response = api_client.delete("/api/v1/scouts/Doomed")

        assert response.status_code == 200
        assert response.json()["message"] == "Scout deleted"

    def test_delete_nonexistent_scout_returns_404(self, api_client):
        mock_svc = AsyncMock()
        mock_svc.get_scout.return_value = None

        with patch.object(v1_module, "_get_schedule_service", return_value=mock_svc):
            response = api_client.delete("/api/v1/scouts/Ghost")

        assert response.status_code == 404


# =============================================================================
# Unit Tests (API key auth)
# =============================================================================


class TestListUnits:
    def test_list_all_units(self, api_client):
        mock_svc = MagicMock()
        mock_svc.get_all_unused_units = AsyncMock(return_value=[
            {
                "unit_id": "u1", "statement": "Fact one", "unit_type": "fact",
                "entities": ["City"], "source_url": "https://example.com/1",
                "source_domain": "example.com", "source_title": "Title",
                "scout_id": "scout-1", "topic": "news",
                "created_at": "2026-01-01T00:00:00", "used_in_article": False,
                "date": "2026-01-01",
            },
        ])

        with patch.object(v1_module, "_get_feed_search_service", return_value=mock_svc):
            response = api_client.get("/api/v1/units")

        assert response.status_code == 200
        data = response.json()
        assert data["count"] == 1
        assert data["units"][0]["id"] == "u1"
        assert data["units"][0]["statement"] == "Fact one"

    def test_list_units_by_topic(self, api_client):
        mock_svc = MagicMock()
        mock_svc.get_units_by_topic = AsyncMock(return_value={
            "units": [
                {
                    "unit_id": "u2", "statement": "Topic fact", "unit_type": "event",
                    "entities": [], "source_url": "https://example.com/2",
                    "source_domain": "example.com", "source_title": "T2",
                    "scout_id": "", "topic": "climate",
                    "created_at": "2026-01-02T00:00:00", "used_in_article": False,
                },
            ],
            "count": 1,
        })

        with patch.object(v1_module, "_get_feed_search_service", return_value=mock_svc):
            response = api_client.get("/api/v1/units?topic=climate")

        assert response.status_code == 200
        data = response.json()
        assert data["count"] == 1
        mock_svc.get_units_by_topic.assert_called_once_with("user-api-456", "climate", limit=50)

    def test_list_units_by_country(self, api_client):
        mock_svc = MagicMock()
        mock_svc.get_units_by_location = AsyncMock(return_value=[
            {
                "unit_id": "u3", "statement": "Local fact", "unit_type": "fact",
                "entities": [], "source_url": "https://local.at/3",
                "source_domain": "local.at", "source_title": "T3",
                "scout_id": "", "created_at": "2026-01-03T00:00:00",
                "used_in_article": False,
            },
        ])

        with patch.object(v1_module, "_get_feed_search_service", return_value=mock_svc):
            response = api_client.get("/api/v1/units?country=AT&city=Vienna")

        assert response.status_code == 200
        data = response.json()
        assert data["count"] == 1

    def test_list_units_by_scout_name(self, api_client):
        mock_svc = MagicMock()
        mock_svc.get_units_by_scout = AsyncMock(return_value=[
            {
                "unit_id": "u4", "statement": "Scout fact", "unit_type": "fact",
                "entities": [], "source_url": "https://example.com/4",
                "source_domain": "example.com", "source_title": "T4",
                "scout_id": "My Scout", "created_at": "2026-01-04T00:00:00",
                "used_in_article": False,
            },
        ])

        with patch.object(v1_module, "_get_feed_search_service", return_value=mock_svc):
            response = api_client.get("/api/v1/units?scout_name=My Scout")

        assert response.status_code == 200
        data = response.json()
        assert data["count"] == 1
        mock_svc.get_units_by_scout.assert_called_once_with("user-api-456", "My Scout", limit=50)

    def test_list_units_custom_limit(self, api_client):
        mock_svc = MagicMock()
        mock_svc.get_all_unused_units = AsyncMock(return_value=[])

        with patch.object(v1_module, "_get_feed_search_service", return_value=mock_svc):
            response = api_client.get("/api/v1/units?limit=10")

        assert response.status_code == 200
        mock_svc.get_all_unused_units.assert_called_once_with("user-api-456", limit=10)


class TestSearchUnits:
    def test_semantic_search(self, api_client):
        mock_svc = MagicMock()
        mock_svc.search_semantic = AsyncMock(return_value={
            "units": [
                {"unit_id": "u5", "statement": "Related fact", "similarity_score": 0.85},
            ],
            "count": 1,
            "query": "climate change",
        })

        with patch.object(v1_module, "_get_feed_search_service", return_value=mock_svc):
            response = api_client.get("/api/v1/units/search?q=climate change")

        assert response.status_code == 200
        data = response.json()
        assert data["count"] == 1
        assert data["query"] == "climate change"
        assert data["units"][0]["similarity_score"] == 0.85

    def test_search_with_location_filter(self, api_client):
        mock_svc = MagicMock()
        mock_svc.search_semantic = AsyncMock(return_value={
            "units": [], "count": 0, "query": "flood",
        })

        with patch.object(v1_module, "_get_feed_search_service", return_value=mock_svc):
            response = api_client.get("/api/v1/units/search?q=flood&country=AT&city=Vienna")

        assert response.status_code == 200
        call_kwargs = mock_svc.search_semantic.call_args.kwargs
        assert call_kwargs["location"] is not None
        assert call_kwargs["location"].country == "AT"
        assert call_kwargs["location"].city == "Vienna"

    def test_search_with_topic_filter(self, api_client):
        mock_svc = MagicMock()
        mock_svc.search_semantic = AsyncMock(return_value={
            "units": [], "count": 0, "query": "budget",
        })

        with patch.object(v1_module, "_get_feed_search_service", return_value=mock_svc):
            response = api_client.get("/api/v1/units/search?q=budget&topic=finance")

        assert response.status_code == 200
        call_kwargs = mock_svc.search_semantic.call_args.kwargs
        assert call_kwargs["topic"] == "finance"

    def test_search_requires_query(self, api_client):
        response = api_client.get("/api/v1/units/search")
        assert response.status_code == 422  # Missing required query param


# =============================================================================
# Auth Enforcement Tests
# =============================================================================


class TestAuthEnforcement:
    """Verify that key management uses session auth and scout/unit endpoints use API key auth."""

    def test_keys_endpoint_requires_session_auth(self):
        """Keys endpoints should fail without any auth override."""
        _test_app.dependency_overrides.clear()
        client = TestClient(_test_app, raise_server_exceptions=False)

        # POST /keys without session should fail
        response = client.post("/api/v1/keys", json={"name": "test"})
        # Should get 401 (no session cookie)
        assert response.status_code == 401

    def test_scout_endpoints_accept_api_key_auth(self, api_client):
        """Scout endpoints should work with API key auth override."""
        mock_svc = AsyncMock()
        mock_svc.list_scouts.return_value = []

        with patch.object(v1_module, "_get_schedule_service", return_value=mock_svc):
            response = api_client.get("/api/v1/scouts")

        assert response.status_code == 200

    def test_unit_endpoints_accept_api_key_auth(self, api_client):
        """Unit endpoints should work with API key auth override."""
        mock_svc = MagicMock()
        mock_svc.get_all_unused_units = AsyncMock(return_value=[])

        with patch.object(v1_module, "_get_feed_search_service", return_value=mock_svc):
            response = api_client.get("/api/v1/units")

        assert response.status_code == 200
