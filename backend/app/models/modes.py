"""
Mode definitions and enums.

PURPOSE: Literal types and enums shared across request models and services
for scout type, schedule regularity, and monitoring channel.

DEPENDS ON: (stdlib only)
USED BY: models/responses.py, schemas/beat.py, schemas/social.py,
    schemas/v1.py, services/cron.py
"""
from enum import Enum
from typing import Literal


# Scraper regularity types
RegularityType = Literal["daily", "weekly", "monthly"]

# Monitoring types
MonitoringType = Literal["EMAIL", "SMS", "WEBHOOK"]

# Scout types for different monitoring strategies
ScoutType = Literal["web", "beat", "social", "civic"]

# Social media monitoring types
SocialPlatform = Literal["instagram", "x", "facebook", "tiktok", "linkedin"]
SocialMonitorMode = Literal["summarize", "criteria"]


class ScoutMode(str, Enum):
    """Scout execution mode for local news features."""
    BEAT = "beat"  # Local Beat - no custom prompt, daily digest
