"""
Pricing constants and cost calculation functions.

Pure data and math — no AWS or external service dependencies.
Extracted from credits.py so routers can import without pulling in
boto3/UserService (which are stripped in the OSS mirror).
"""
from typing import Optional


# Credit costs — repriced for $10/1000 credits ($0.01/credit)
CREDIT_COSTS = {
    # Web Scout (type web) — $0.002 cost, 80% margin
    "website_extraction": 1,

    # Beat Scout (type beat) — standardized cost across all modes
    "beat": 7,

    # Social Scout monitoring — platform-tiered
    "social_monitoring_instagram": 2,   # $0.012 cost, 55% margin
    "social_monitoring_x": 2,           # $0.009 cost, 66% margin
    "social_monitoring_facebook": 15,   # $0.121 cost, 40% margin

    # Social Scout monitoring — TikTok
    "social_monitoring_tiktok": 2,      # $0.01 cost, 50% margin

    # Social Scout monitoring — LinkedIn (harvestapi, $0.002/post × 20)
    "social_monitoring_linkedin": 7,    # $0.04005 cost, 43% margin

    # Data Extractor (Scrape panel) — channel-tiered
    "social_extraction": 2,             # X/Twitter scrape
    "instagram_extraction": 2,          # Instagram scrape
    "facebook_extraction": 15,          # Facebook scrape
    "tiktok_extraction": 2,             # TikTok scrape
    "instagram_comments_extraction": 15, # IG comments (50 items)

    # Feed
    "feed_export": 1,

    # Civic Scout (type civic) — council meeting monitoring
    "civic": 20,
    "civic_discover": 10,
}

# Platform → credit key mapping for social monitoring
SOCIAL_MONITORING_KEYS = {
    "instagram": "social_monitoring_instagram",
    "x": "social_monitoring_x",
    "twitter": "social_monitoring_x",
    "facebook": "social_monitoring_facebook",
    "tiktok": "social_monitoring_tiktok",
    "linkedin": "social_monitoring_linkedin",
}

# Channel → credit key mapping for data extraction
EXTRACTION_KEYS = {
    "website": "website_extraction",
    "social": "social_extraction",
    "instagram": "instagram_extraction",
    "facebook": "facebook_extraction",
    "instagram_comments": "instagram_comments_extraction",
    "tiktok": "tiktok_extraction",
}


def get_beat_cost(source_mode: Optional[str], has_location: bool) -> int:
    """Get credit cost for a beat scout run.

    All modes now run similar workload — single standardized cost.
    """
    return CREDIT_COSTS["beat"]


def get_social_monitoring_cost(platform: str) -> int:
    """Get credit cost for a social scout run by platform."""
    key = SOCIAL_MONITORING_KEYS.get(platform, "social_monitoring_instagram")
    return CREDIT_COSTS[key]


def get_extraction_cost(channel: str) -> int:
    """Get credit cost for a data extraction by channel."""
    key = EXTRACTION_KEYS.get(channel, "website_extraction")
    return CREDIT_COSTS[key]


def calculate_monitoring_cost(per_run_cost: int, regularity: str) -> int:
    multipliers = {"daily": 30, "weekly": 4, "monthly": 1}
    return per_run_cost * multipliers.get(regularity.lower(), 1)
