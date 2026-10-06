"""
Schemas for information units API (Feed panel).

PURPOSE: Request/response models for the /api/units/* endpoints.
Defines the AtomicInformationUnit model (the core data structure for
extracted facts/events) and its list/search response wrappers.

DEPENDS ON: (pydantic only — no app imports)
USED BY: routers/units.py
"""
from pydantic import BaseModel, Field
from typing import Literal, Optional


class AdditionalSource(BaseModel):
    """Additional source for a merged unit."""

    url: str
    domain: str
    title: str
    added_at: str


class AtomicInformationUnit(BaseModel):
    """Atomic information unit extracted from article."""

    unit_id: str = ""
    article_id: str = Field(default="", description="Links units from same article")
    pk: str = Field(default="", description="Partition key for updates")
    sk: str = Field(default="", description="Sort key for updates")

    # Content
    statement: str = Field(..., description="Concise factual statement (1-2 sentences)")
    unit_type: Literal["fact", "event", "entity_update"] = "fact"
    entities: list[str] = Field(default_factory=list)

    # Source attribution
    source_url: str = ""
    source_domain: str = ""
    source_title: str = ""
    additional_sources: list[AdditionalSource] = Field(default_factory=list)

    # Metadata
    scout_type: str = ""
    scout_id: str = ""
    created_at: str = ""
    used_in_article: bool = False
    topic: Optional[str] = ""
    date: Optional[str] = None


class UnitsResponse(BaseModel):
    """Response containing list of atomic information units."""

    units: list[AtomicInformationUnit]
    count: int


class LocationsResponse(BaseModel):
    """Response containing user's distinct locations."""

    locations: list[str]


class TopicsResponse(BaseModel):
    """Response containing user's distinct topics."""

    topics: list[str]


class UnitKey(BaseModel):
    """Reference to a specific unit for updates."""

    pk: str = Field(..., description="Partition key")
    sk: str = Field(..., description="Sort key")


class MarkUsedRequest(BaseModel):
    """Request to mark units as used in article."""

    unit_keys: list[UnitKey] = Field(..., min_length=1, max_length=100)


class MarkUsedResponse(BaseModel):
    """Response after marking units as used."""

    marked_count: int
    total_requested: int


class SearchedUnit(AtomicInformationUnit):
    """Unit with similarity score from semantic search."""

    similarity_score: float = Field(..., ge=0, le=1)


class SearchUnitsResponse(BaseModel):
    """Response from semantic search endpoint."""

    units: list[SearchedUnit]
    count: int
    query: str
