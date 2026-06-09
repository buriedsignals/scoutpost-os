"""
Application configuration using environment variables.

PURPOSE: Single Settings class loaded from environment variables via
pydantic_settings. Provides API keys, feature flags, and credit amounts
used throughout the application.

DEPENDS ON: (pydantic_settings only — no app imports)
USED BY: Nearly all services and routers (imported as `settings` or `get_settings()`)
"""
import os
from pathlib import Path
from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict


BASE_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=BASE_DIR.parent / ".env",
        case_sensitive=False,
        extra="ignore",
    )

    # App settings
    app_name: str = "coJournalist API"
    debug: bool = False
    environment: str = os.getenv("ENVIRONMENT", "development")

    # MuckRock OAuth
    muckrock_client_id: str = os.getenv("MUCKROCK_CLIENT_ID", "")
    muckrock_client_secret: str = os.getenv("MUCKROCK_CLIENT_SECRET", "")
    session_secret: str = os.getenv("SESSION_SECRET", "")
    muckrock_base_url: str = os.getenv("MUCKROCK_BASE_URL", "https://accounts.muckrock.com")
    oauth_redirect_base: str = os.getenv("OAUTH_REDIRECT_BASE", "")  # e.g. http://localhost:5173
    local_muckrock_auth_broker: bool = os.getenv("LOCAL_MUCKROCK_AUTH_BROKER", "false").lower() == "true"
    session_max_age: int = int(os.getenv("SESSION_MAX_AGE", str(86400 * 7)))  # 7 days

    # Email allowlist — comma-separated emails and/or @domain patterns.
    # Entries starting with @ match any email from that domain (e.g. @muckrock.com).
    # Empty string = no restriction (all MuckRock users allowed).
    email_allowlist: str = os.getenv("EMAIL_ALLOWLIST", "")

    # Admin emails — comma-separated exact emails that receive Pro tier (1,000 credits)
    # regardless of their MuckRock entitlements. Does not downgrade team users.
    # Empty string = no overrides.
    admin_emails: str = os.getenv("ADMIN_EMAILS", "")


    # User Defaults
    default_credits: int = int(os.getenv("DEFAULT_USER_CREDITS", "100"))
    default_timezone: str = os.getenv("DEFAULT_USER_TIMEZONE", "UTC")

    # MuckRock Plan URLs (Sunlight pattern)
    muckrock_pro_plan_url: str = os.getenv(
        "MUCKROCK_PRO_PLAN_URL",
        "https://accounts.muckrock.com/plans/70-cojournalist-pro/"  # Plan ID 70 confirmed by MuckRock 2026-03-25
    )
    muckrock_team_plan_url: str = os.getenv(
        "MUCKROCK_TEAM_PLAN_URL",
        "https://accounts.muckrock.com/plans/71-cojournalist-team/"
    )


    # Firecrawl
    firecrawl_api_key: str = os.getenv("FIRECRAWL_API_KEY", "")

    # Apify
    apify_api_token: str = os.getenv("APIFY_API_TOKEN", "")

    # LLM model — Gemini models (gemini-*) route to Google AI direct API,
    # all others route to OpenRouter. 
    llm_model: str = os.getenv("LLM_MODEL", "gemini-2.5-flash-lite")

    # Scout service settings
    openrouter_api_key: str = os.getenv("OPENROUTER_API_KEY", "")
    gemini_api_key: str = os.getenv("GEMINI_API_KEY", "")
    resend_api_key: str = os.getenv("RESEND_API_KEY", "")
    internal_service_key: str = os.getenv("INTERNAL_SERVICE_KEY", "")

    # Deployment target — retained as a hard-coded constant after AWS retirement,
    # so existing `settings.deployment_target == "supabase"` checks keep working
    # while v2 refactoring is in progress. Remove once all branches are cleaned up.
    deployment_target: str = "supabase"

    # Supabase / asyncpg
    database_url: str = os.getenv("DATABASE_URL", "")
    supabase_url: str = os.getenv("SUPABASE_URL", "")
    supabase_service_key: str = os.getenv("SUPABASE_SERVICE_KEY", os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""))
    supabase_anon_key: str = os.getenv("SUPABASE_ANON_KEY", "")
    supabase_jwt_secret: str = os.getenv("SUPABASE_JWT_SECRET", "")
    public_mcp_base_url: str = os.getenv("PUBLIC_MCP_BASE_URL", "https://scoutpost.ai/mcp")

    # Auth broker — post-login redirect target (frontend route that reads hash tokens).
    # Renamed from SUPABASE_POST_LOGIN_REDIRECT — Supabase reserves SUPABASE_*
    # for its own env-var injection and rejects user-set names there.
    app_post_login_redirect: str = os.getenv("APP_POST_LOGIN_REDIRECT", "")

    # MuckRock webhook pause — set to true during cutover window.
    # When true, /api/auth/webhook returns 503 without processing.
    # Flipped to false after PR 2a (webhook port) ships post-cutover.
    muckrock_webhook_paused: bool = os.getenv("MUCKROCK_WEBHOOK_PAUSED", "true").lower() == "true"

    # Linear (feedback)
    linear_api_key: str = os.getenv("LINEAR_API_KEY", "")

    # CORS — explicit origins only (no wildcards that match unrelated apps)
    allowed_origins: list[str] = [
        "http://localhost:5173",  # SvelteKit dev
        "http://localhost:7860",  # HF Spaces local
        "https://cojournalist.onrender.com",  # Production backend
        "https://scoutpost.ai",  # Production frontend (apex)
        "https://www.scoutpost.ai",  # Production frontend (www)
        "https://cojournalist.ai",  # Legacy migration origin
        "https://www.cojournalist.ai",  # Legacy migration origin (www)
    ]

# Global settings instance
settings = Settings()


def get_settings() -> Settings:
    """Get the global settings instance."""
    return settings
