"""
API response models.

PURPOSE: Pydantic request/response models for schedule management,
credit operations, auth status, and user preferences.

DEPENDS ON: models/modes (RegularityType, MonitoringType, ScoutType),
    schemas/scouts (GeocodedLocation)
USED BY: routers/user.py
"""
from typing import Optional, Any, List
from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field, model_validator
from app.models.modes import RegularityType, MonitoringType, ScoutType
from app.schemas.scouts import GeocodedLocation


class ScraperCreate(BaseModel):
    """Request model for creating a scraper."""
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "url": "https://example.com",
                "criteria": "Find articles about AI",
                "regularity": "weekly",
                "day_number": 1,
                "time": "12:00",
                "monitoring": "EMAIL"
            }
        }
    )

    url: str = Field(..., description="URL to scrape")
    criteria: str = Field(..., description="Scraping criteria or prompt")
    regularity: RegularityType
    day_number: int = Field(..., ge=1, le=31, description="Day of week (1-7) or day of month (1-31)")
    time: str = Field(..., pattern=r"^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$", description="Time in HH:MM format (UTC)")
    monitoring: MonitoringType

class ScraperResponse(BaseModel):
    """Response model for scraper data."""
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    name: str
    criteria: str
    regularity: RegularityType
    day_number: int
    time_utc: str
    scraper_service: Optional[str] = None
    prompt_summary: Optional[str] = None
    monitoring: bool
    created_at: datetime

class ScraperListResponse(BaseModel):
    """Response model for list of scrapers."""
    scrapers: list[ScraperResponse]
    count: int


class MonitoringScheduleRequest(BaseModel):
    """Request payload for creating/updating a monitoring schedule."""
    name: str = Field(..., min_length=1, max_length=120)
    regularity: RegularityType
    day_number: int = Field(..., ge=1, le=31)
    time: str = Field(..., pattern=r"^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$")
    monitoring: MonitoringType
    scout_type: ScoutType = Field(default="web", description="Type of scout to run")
    url: Optional[str] = None
    criteria: Optional[str] = None
    channel: Optional[str] = Field(
        default=None,
        pattern=r"^(website|social)$",
        description="Scraping channel (website or social)."
    )
    # Local scout specific fields
    location: Optional[GeocodedLocation] = Field(default=None, description="Location data for local scouts")
    topic: Optional[str] = Field(default=None, max_length=200, description="Topic for topic-based scouts")
    # Web scout first-run behavior
    content_hash: Optional[str] = Field(default=None, description="Content hash from test scrape for baseline (web scouts only)")
    source_mode: Optional[str] = Field(default="niche", pattern=r"^(reliable|niche)$", description="Source mode for beat scouts")
    excluded_domains: Optional[list[str]] = Field(default=None, description="Per-scout domain blacklist for beat scouts")
    priority_sources: Optional[list[str]] = Field(default=None, description="Domains to boost in AI filter ranking for beat scouts")
    # Provider detection (web scouts)
    provider: Optional[str] = Field(default=None, pattern=r"^(firecrawl|firecrawl_plain)$", description="Detected scraping provider for web scouts")
    # Social scout fields
    platform: Optional[str] = None
    profile_handle: Optional[str] = None
    monitor_mode: Optional[str] = None
    track_removals: bool = False
    baseline_posts: Optional[list] = Field(default=None, description="Baseline post snapshot from test scan (social scouts only)")
    # Civic scout fields
    root_domain: Optional[str] = None
    tracked_urls: Optional[list[str]] = None
    import_current_items: Optional[bool] = Field(default=None, description="Import the server-owned Civic preview snapshot; never submit extracted item text")
    preview_snapshot_token: Optional[str] = Field(default=None, description="Opaque Civic preview token required when import_current_items is true")

    @model_validator(mode="after")
    def web_scout_requires_url(self) -> "MonitoringScheduleRequest":
        if self.scout_type == "web" and not (self.url and self.url.strip()):
            raise ValueError("URL is required for web scouts")
        return self

    @model_validator(mode="after")
    def web_scout_requires_location_or_topic(self) -> "MonitoringScheduleRequest":
        """Web scouts must have location or topic for Feed discoverability."""
        if self.scout_type == "web" and not self.location and not self.topic:
            raise ValueError("Web scouts require a location or topic for Feed organization")
        return self


class MonitoringScheduleResponse(BaseModel):
    """Response payload summarising a generated monitoring schedule."""
    name: str
    scout_type: ScoutType = "web"
    url: Optional[str] = None
    criteria: Optional[str] = None
    channel: Optional[str] = None
    monitoring: MonitoringType
    regularity: RegularityType
    day_number: int
    time: str
    timezone: str
    cron_expression: str
    metadata: dict[str, Any]
    # Local scout specific response fields
    location: Optional[GeocodedLocation] = None
    topic: Optional[str] = None


class CreditChargeRequest(BaseModel):
    """Request to deduct credits for a scrape action."""
    amount: int = Field(..., gt=0, description="Number of credits to deduct")


class CreditBalanceResponse(BaseModel):
    """Response containing updated credit balance."""
    credits: int


class ErrorResponse(BaseModel):
    """Standard error response."""
    error: str
    detail: Optional[str] = None
    status_code: int = 500


class HealthResponse(BaseModel):
    """Health check response."""
    status: str
    service: str
    timestamp: Optional[datetime] = None


# =============================================================================
# Endpoint Response Models
# =============================================================================


class ValidateCreditsResponse(BaseModel):
    """Response from POST /scrapers/monitoring/validate."""
    valid: bool
    per_run_cost: int
    monthly_cost: int
    current_credits: int
    remaining_after: int


class RunNowResponse(BaseModel):
    """Response from POST /scrapers/run-now."""
    scraper_status: bool
    criteria_status: bool
    summary: str = ""
    notification_sent: Optional[bool] = None
    change_status: Optional[str] = None
    # Social scout fields
    new_posts: Optional[int] = None
    removed_posts: Optional[int] = None
    total_posts: Optional[int] = None


class AuthStatusUser(BaseModel):
    """User data returned by GET /auth/status."""
    user_id: Optional[str] = None
    email: Optional[str] = None
    credits: Optional[int] = None
    timezone: Optional[str] = None
    needs_initialization: bool = False
    onboarding_completed: bool = False
    tier: str = "free"
    beta_user: bool = False


class AuthStatusResponse(BaseModel):
    """Response from GET /auth/status."""
    authenticated: bool
    user: Optional[AuthStatusUser] = None


class UserPreferencesResponse(BaseModel):
    """Response from GET /user/preferences."""
    preferred_language: Optional[str] = None
    timezone: Optional[str] = None
    excluded_domains: List[str] = Field(default_factory=list)
    cms_api_url: Optional[str] = None
    has_cms_token: bool = False
