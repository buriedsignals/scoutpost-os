"""Pydantic schemas for API requests and responses."""
from app.schemas.common import AINewsArticle
from app.schemas.scouts import (
    GeocodedLocation,
    Coordinates,
)
from app.schemas.units import (
    AtomicInformationUnit,
    UnitsResponse,
    LocationsResponse,
    UnitKey,
    MarkUsedRequest,
    MarkUsedResponse,
)

__all__ = [
    # Shared schemas
    "AINewsArticle",
    "GeocodedLocation",
    "Coordinates",
    # Unit schemas
    "AtomicInformationUnit",
    "UnitsResponse",
    "LocationsResponse",
    "UnitKey",
    "MarkUsedRequest",
    "MarkUsedResponse",
]
