"""Tests for SupabaseAuth."""

import hmac
import time
import warnings
from unittest.mock import AsyncMock, MagicMock, patch

import jwt
import pytest

from app.adapters.supabase.auth import SupabaseAuth


@pytest.fixture
def mock_settings():
    settings = MagicMock()
    settings.supabase_jwt_secret = "test-jwt-secret-key-for-testing-only"
    settings.supabase_url = "https://test.supabase.co"
    settings.supabase_service_key = "test-service-key"
    settings.internal_service_key = "test-internal-key"
    return settings


@pytest.fixture
def mock_user_storage():
    storage = AsyncMock()
    return storage


@pytest.fixture
def auth_adapter(mock_settings, mock_user_storage):
    with patch("app.adapters.supabase.auth.get_settings", return_value=mock_settings):
        adapter = SupabaseAuth(user_storage=mock_user_storage)
    return adapter


def _make_jwt(payload: dict, secret: str) -> str:
    """Helper to create a test JWT."""
    return jwt.encode(payload, secret, algorithm="HS256")


class TestGetCurrentUser:
    @pytest.mark.asyncio
    async def test_returns_user_for_valid_token(self, auth_adapter, mock_settings, mock_user_storage):
        token = _make_jwt(
            {"sub": "user-123", "exp": int(time.time()) + 3600},
            mock_settings.supabase_jwt_secret,
        )
        request = MagicMock()
        request.headers.get.return_value = f"Bearer {token}"

        mock_user_storage.get_user.return_value = {
            "user_id": "user-123",
            "timezone": "UTC",
        }

        result = await auth_adapter.get_current_user(request)
        assert result["user_id"] == "user-123"

    @pytest.mark.asyncio
    async def test_raises_for_missing_token(self, auth_adapter):
        request = MagicMock()
        request.headers.get.return_value = ""

        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc_info:
            await auth_adapter.get_current_user(request)
        assert exc_info.value.status_code == 401

    @pytest.mark.asyncio
    async def test_rejects_hs256_token_when_legacy_secret_is_too_short(
        self,
        mock_settings,
        mock_user_storage,
    ):
        mock_settings.supabase_jwt_secret = "short"
        with patch("app.adapters.supabase.auth.get_settings", return_value=mock_settings):
            adapter = SupabaseAuth(user_storage=mock_user_storage)

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            token = _make_jwt(
                {"sub": "user-123", "exp": int(time.time()) + 3600},
                "short",
            )
        request = MagicMock()
        request.headers.get.return_value = f"Bearer {token}"

        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc_info:
            await adapter.get_current_user(request)
        assert exc_info.value.status_code == 401

    @pytest.mark.asyncio
    async def test_rejects_hs256_token_when_secret_unset(
        self,
        mock_settings,
        mock_user_storage,
    ):
        # When SUPABASE_JWT_SECRET is unset, HS256 verification must be
        # disabled so no HS256 token is accepted regardless of what key signed
        # it -- closing the fail-open path where an empty server secret would
        # verify an attacker-forged token.
        mock_settings.supabase_jwt_secret = ""
        with patch("app.adapters.supabase.auth.get_settings", return_value=mock_settings):
            adapter = SupabaseAuth(user_storage=mock_user_storage)
        assert adapter._hs256_enabled is False

        token = _make_jwt(
            {"sub": "victim-user", "exp": int(time.time()) + 3600},
            "attacker-chosen-signing-key-not-the-server-secret",
        )
        request = MagicMock()
        request.headers.get.return_value = f"Bearer {token}"

        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc_info:
            await adapter.get_current_user(request)
        assert exc_info.value.status_code == 401
        mock_user_storage.get_user.assert_not_called()

    @pytest.mark.asyncio
    async def test_raises_for_expired_token(self, auth_adapter, mock_settings):
        token = _make_jwt(
            {"sub": "user-123", "exp": int(time.time()) - 3600},
            mock_settings.supabase_jwt_secret,
        )
        request = MagicMock()
        request.headers.get.return_value = f"Bearer {token}"

        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc_info:
            await auth_adapter.get_current_user(request)
        assert exc_info.value.status_code == 401


class TestGetUserEmail:
    @pytest.mark.asyncio
    async def test_returns_email_from_supabase(self, auth_adapter):
        mock_user = MagicMock()
        mock_user.user.email = "journalist@newsroom.org"

        mock_client = MagicMock()
        mock_client.auth.admin.get_user_by_id = AsyncMock(return_value=mock_user)
        auth_adapter._supabase_client = mock_client

        email = await auth_adapter.get_user_email("user-123")

        assert email == "journalist@newsroom.org"


class TestVerifyServiceKey:
    @pytest.mark.asyncio
    async def test_returns_true_for_valid_key(self, auth_adapter, mock_settings):
        result = await auth_adapter.verify_service_key(mock_settings.internal_service_key)
        assert result is True

    @pytest.mark.asyncio
    async def test_returns_false_for_invalid_key(self, auth_adapter):
        result = await auth_adapter.verify_service_key("wrong-key")
        assert result is False
