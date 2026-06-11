"""Tests for the production fail-closed auth-secret guard in config.Settings."""

import pytest

from app.config import Settings


def test_production_refuses_boot_without_jwt_secret():
    with pytest.raises(ValueError, match="SUPABASE_JWT_SECRET"):
        Settings(environment="production", supabase_jwt_secret="")


def test_production_boots_with_secrets_set():
    settings = Settings(
        environment="production",
        supabase_jwt_secret="x" * 40,
        session_secret="y" * 40,
        internal_service_key="z" * 40,
    )
    assert settings.environment == "production"


def test_production_with_empty_session_secret_boots_but_logs(caplog):
    # SESSION_SECRET / INTERNAL_SERVICE_KEY are dashboard-only; an empty value
    # is logged as an error but does not block boot (avoids a deploy outage).
    with caplog.at_level("ERROR"):
        settings = Settings(
            environment="production",
            supabase_jwt_secret="x" * 40,
            session_secret="",
            internal_service_key="",
        )
    assert settings.supabase_jwt_secret == "x" * 40
    assert "SESSION_SECRET" in caplog.text
    assert "INTERNAL_SERVICE_KEY" in caplog.text


def test_development_allows_empty_secrets():
    settings = Settings(environment="development", supabase_jwt_secret="")
    assert settings.supabase_jwt_secret == ""
