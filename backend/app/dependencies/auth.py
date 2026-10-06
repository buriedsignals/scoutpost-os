"""
FastAPI auth dependencies.

Every FastAPI route authenticates with a Supabase Bearer JWT via the
`SupabaseAuth` adapter (see `providers.get_auth`).
"""
from fastapi import Request

from app.config import get_settings


async def build_user_response(user_svc, user_id: str) -> dict:
    """Build the flat user response dict with needs_initialization.

    Used by /onboarding/initialize.
    """
    user = await user_svc.get_user(user_id)
    if not user:
        return None

    user["needs_initialization"] = not user.get("onboarding_completed", False)

    # Normalize deprecated timezone aliases (e.g. "Asia/Calcutta" → "Asia/Kolkata")
    from app.utils.timezone import normalize_timezone
    tz = user.get("timezone")
    if tz:
        user["timezone"] = normalize_timezone(tz)

    # user_preferences has no org_id column, so no team is attached here.
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

    Validates the Supabase Bearer JWT and loads the user's preferences row.

    Returns:
        User dict with user_id, timezone, etc.

    Raises:
        HTTPException 401: If not authenticated or user not found.
    """
    from app.dependencies.providers import get_auth

    return await get_auth().get_current_user(request)
