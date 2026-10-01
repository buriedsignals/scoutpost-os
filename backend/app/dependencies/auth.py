"""
FastAPI auth dependencies.

In the current architecture the primary public auth path is Supabase Auth.
This module remains as the legacy/optional FastAPI auth layer used by the
Python add-on routes and any remaining session-cookie surfaces.
"""
import logging
import secrets
from typing import Optional

from fastapi import Header, HTTPException, Request, status

from app.config import get_settings
try:
    from app.services.api_key_service import ApiKeyService
except ImportError:
    ApiKeyService = None  # OSS mirror: API key auth not available
from app.services.session_service import SessionService
from app.services.user_service import UserService

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Lazy service initialization
# ---------------------------------------------------------------------------
_session_service: Optional[SessionService] = None
_user_service: Optional[UserService] = None
_api_key_service: Optional[ApiKeyService] = None


def _get_services() -> tuple[SessionService, UserService]:
    global _session_service, _user_service
    if _session_service is None:
        s = get_settings()
        _session_service = SessionService(secret=s.session_secret, max_age=s.session_max_age)
        _user_service = UserService()
    return _session_service, _user_service


def _get_api_key_service():
    global _api_key_service
    if _api_key_service is None:
        if ApiKeyService is None:
            return None
        _api_key_service = ApiKeyService()
    return _api_key_service


# ---------------------------------------------------------------------------
# User authentication via session cookie
# ---------------------------------------------------------------------------

async def build_user_response(user_svc, user_id: str) -> dict:
    """Build the flat user response dict with needs_initialization.

    Shared by /auth/me, /auth/status, and /onboarding/initialize.
    """
    user = await user_svc.get_user(user_id)
    if not user:
        return None

    credits = user.get("credits")
    onboarding_completed = user.get("onboarding_completed", False)
    if get_settings().deployment_target == "supabase":
        needs_init = not onboarding_completed
    else:
        needs_init = credits is None or not onboarding_completed

    user["needs_initialization"] = needs_init

    # Normalize deprecated timezone aliases (e.g. "Asia/Calcutta" → "Asia/Kolkata")
    from app.utils.timezone import normalize_timezone
    tz = user.get("timezone")
    if tz:
        user["timezone"] = normalize_timezone(tz)

    # Team credits: if user has org_id, show org pool balance
    org_id = user.get("org_id")
    if org_id:
        org_info = await user_svc.get_org_credits_info(org_id)
        if org_info:
            user["credits"] = org_info["balance"]
            user["team"] = {
                "org_id": org_id,
                "org_name": org_info["org_name"],
                "seat_count": org_info["seated_count"],
            }
        else:
            # ORG# record gone (cancelled) — clear stale org_id
            user["org_id"] = None
            user["team"] = None
    else:
        user["team"] = None

    # Add upgrade URLs for frontend (config-driven, avoids frontend env vars)
    s = get_settings()
    upgrade_url = s.muckrock_pro_plan_url
    if upgrade_url and "?" not in upgrade_url:
        upgrade_url = f"{upgrade_url}?source=cojournalist"
    elif upgrade_url and "source=" not in upgrade_url:
        upgrade_url = f"{upgrade_url}&source=cojournalist"
    user["upgrade_url"] = upgrade_url

    team_upgrade_url = s.muckrock_team_plan_url
    if team_upgrade_url and "?" not in team_upgrade_url:
        team_upgrade_url = f"{team_upgrade_url}?source=cojournalist"
    elif team_upgrade_url and "source=" not in team_upgrade_url:
        team_upgrade_url = f"{team_upgrade_url}&source=cojournalist"
    user["team_upgrade_url"] = team_upgrade_url

    return user


async def get_current_user(request: Request) -> dict:
    """
    Dependency to get the current authenticated user.

    Delegates to the deployment-target-aware auth adapter:
      - Supabase: validates Bearer JWT, fetches from Postgres
      - Legacy AWS/MuckRock path: validates session cookie

    Returns:
        User dict with user_id, timezone, etc.

    Raises:
        HTTPException 401: If not authenticated or user not found.
    """
    from app.dependencies.providers import get_auth

    settings = get_settings()
    if settings.deployment_target == "supabase":
        auth = get_auth()
        return await auth.get_current_user(request)

    # MuckRock / AWS path — session cookie
    session_service, user_service = _get_services()

    token = request.cookies.get("session")
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing session cookie",
        )

    claims = session_service.validate_session(token)
    if claims is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session",
        )

    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid session: missing user ID",
        )

    user = await build_user_response(user_service, user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )

    # org_id comes from build_user_response (stored profile = source of truth).
    # Do NOT override from JWT — stale sessions would bypass cancellation cleanup.

    return user


async def get_optional_user(request: Request) -> Optional[dict]:
    """
    Dependency to get the current user if authenticated, otherwise None.
    Use this for endpoints that support both authenticated and anonymous access.

    Returns:
        User dict or None if not authenticated.
    """
    try:
        return await get_current_user(request)
    except HTTPException:
        return None


# =============================================================================
# Internal Service Key Verification
# =============================================================================

def verify_service_key(
    x_service_key: Optional[str] = Header(None, alias="X-Service-Key")
) -> None:
    """
    Verify the internal service key (X-Service-Key) for internal API calls.

    Use as a FastAPI dependency to protect endpoints called by internal services.

    Args:
        x_service_key: Service key from X-Service-Key header

    Raises:
        HTTPException: If service key is invalid
    """
    settings = get_settings()

    if not settings.internal_service_key:
        logger.error("INTERNAL_SERVICE_KEY not configured - rejecting request")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Service configuration error"
        )

    if not x_service_key or not secrets.compare_digest(x_service_key, settings.internal_service_key):
        logger.warning("Invalid service key attempted")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid service key"
        )


def _verify_key_against(
    x_service_key: Optional[str],
    *valid_keys: str,
    key_name: str = "service",
) -> None:
    """Check header value against one or more configured keys (skips empty).

    Keys are checked in order: per-function key first, then fallback.
    Logs a deprecation warning when the fallback key is used and the
    per-function key IS configured (helps track migration progress).
    """
    if not x_service_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid service key"
        )

    primary_configured = bool(valid_keys[0]) if valid_keys else False
    for i, key in enumerate(valid_keys):
        if key and secrets.compare_digest(x_service_key, key):
            if i > 0 and primary_configured:
                logger.warning(
                    "Request authenticated via fallback INTERNAL_SERVICE_KEY — "
                    "migrate to per-function key (%s)", key_name
                )
            return

    logger.warning("Invalid service key attempted")
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid service key"
    )


# =============================================================================
# External API Key Verification
# =============================================================================

async def verify_api_key(request: Request) -> dict:
    """
    Verify an external API key for programmatic access.

    Extracts the Bearer token from the Authorization header, validates it
    via ApiKeyService, then loads the user profile from storage.

    Returns:
        User dict (same shape as get_current_user).

    Raises:
        HTTPException 401: If no key, invalid format, invalid key, or user not found.
    """
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer cj_"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid API key",
        )

    raw_key = auth.removeprefix("Bearer ")
    api_key_service = _get_api_key_service()
    if api_key_service is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API key auth not available",
        )
    user_id = api_key_service.validate_key(raw_key)

    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
        )

    _, user_service = _get_services()
    user = await build_user_response(user_service, user_id)

    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )

    return user


# =============================================================================
# User Utility Functions (Async)
# =============================================================================

async def get_user_email(user_id: str) -> Optional[str]:
    """Fetch user's email.

    Supabase: queries auth.users via adapter.
    AWS/SaaS: calls MuckRock API on-demand (email not stored locally).
    """
    settings = get_settings()
    if settings.deployment_target == "supabase":
        try:
            from app.dependencies.providers import get_auth
            auth_adapter = get_auth()
            return await auth_adapter.get_user_email(user_id)
        except Exception as e:
            logger.error(f"Failed to fetch email from Supabase for {user_id}: {e}")
            return None

    try:
        from app.services.muckrock_client import MuckRockClient
    except ImportError:
        return None
    try:
        client = MuckRockClient(
            settings.muckrock_client_id,
            settings.muckrock_client_secret,
            settings.muckrock_base_url,
        )
        user_data = await client.fetch_user_data(user_id)
        return user_data.get("email")
    except Exception as e:
        logger.error(f"Failed to fetch email from MuckRock for {user_id}: {e}")
        return None


# ---------------------------------------------------------------------------
# Admin-only dependency
# ---------------------------------------------------------------------------

async def require_admin(request: Request) -> dict:
    """Gate admin-only endpoints. Checks ADMIN_EMAILS env var.

    Fetches user email from MuckRock (not stored locally) and compares
    against the admin list. Returns 403 if not an admin.
    """
    user = await get_current_user(request)
    user_id = user.get("user_id")

    settings = get_settings()
    admin_raw = settings.admin_emails.strip()
    if not admin_raw:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")

    admin_list = {e.strip().lower() for e in admin_raw.split(",") if e.strip()}

    email = await get_user_email(user_id)
    if not email or email.lower() not in admin_list:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")

    logger.info("Admin access: user_id=%s, endpoint=%s", user_id, request.url.path)
    return user
