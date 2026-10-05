"""Tests for SupabaseUserStorage."""

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest

from app.adapters.supabase.user_storage import SupabaseUserStorage


@pytest.fixture
def mock_pool():
    return AsyncMock()


@pytest.fixture
def storage(mock_pool):
    s = SupabaseUserStorage()
    s.pool = mock_pool
    return s


class TestGetUser:
    @pytest.mark.asyncio
    async def test_returns_user_when_found(self, storage, mock_pool):
        user_id = str(uuid.uuid4())
        mock_pool.fetchrow = AsyncMock(return_value={
            "user_id": user_id,
            "timezone": "America/New_York",
            "preferred_language": "en",
            "notification_email": "test@example.com",
            "default_location": None,
            "excluded_domains": None,
            "cms_api_url": None,
            "cms_api_token": None,
            "preferences": {},
            "onboarding_completed": True,
            "onboarding_tour_completed": True,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
        })

        result = await storage.get_user(user_id)
        assert result["timezone"] == "America/New_York"
        assert result["user_id"] == user_id

    @pytest.mark.asyncio
    async def test_returns_none_when_not_found(self, storage, mock_pool):
        mock_pool.fetchrow = AsyncMock(return_value=None)

        result = await storage.get_user(str(uuid.uuid4()))
        assert result is None


class TestCreateOrUpdateUser:
    @pytest.mark.asyncio
    async def test_creates_new_user(self, storage, mock_pool):
        user_id = str(uuid.uuid4())
        mock_pool.fetchrow = AsyncMock(return_value={
            "user_id": user_id,
            "timezone": "UTC",
            "preferred_language": "en",
            "onboarding_completed": False,
        })

        result = await storage.create_or_update_user(user_id, {
            "timezone": "UTC",
            "preferred_language": "en",
        })

        assert result["user_id"] == user_id
        mock_pool.fetchrow.assert_called_once()
        call_sql = mock_pool.fetchrow.call_args[0][0]
        assert "ON CONFLICT" in call_sql
