"""
User preferences service for the residual FastAPI routes.

Reads and updates user_preferences through the storage port. Tiers, credits,
and team orgs are owned by Supabase Edge Functions.
"""
from typing import Optional


class UserService:
    def __init__(self, user_storage=None):
        if user_storage is None:
            from app.dependencies.providers import get_user_storage
            user_storage = get_user_storage()
        self.storage = user_storage

    async def get_user(self, user_id: str) -> Optional[dict]:
        """Fetch the user's preferences row from the storage adapter."""
        return await self.storage.get_user(user_id)

    async def update_preferences(self, user_id: str, **kwargs) -> None:
        """Update user preferences (timezone, language, location, etc.)."""
        if not kwargs:
            return
        await self.storage.update_profile(user_id, kwargs)
