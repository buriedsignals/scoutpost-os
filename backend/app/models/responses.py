"""
API response models.

PURPOSE: Pydantic response model for user preferences.

DEPENDS ON: (pydantic only — no app imports)
USED BY: routers/user.py
"""
from typing import Optional, List
from pydantic import BaseModel, Field


class UserPreferencesResponse(BaseModel):
    """Response from GET /user/preferences."""
    preferred_language: Optional[str] = None
    timezone: Optional[str] = None
    excluded_domains: List[str] = Field(default_factory=list)
    cms_api_url: Optional[str] = None
    has_cms_token: bool = False
