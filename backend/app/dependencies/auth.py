"""
FastAPI auth dependencies.

Every FastAPI route authenticates with a Supabase Bearer JWT via the
`SupabaseAuth` adapter (see `providers.get_auth`).
"""
from fastapi import Request


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
