"""
Legacy user/profile service for the optional FastAPI surface.

The primary OSS runtime now uses Supabase Auth plus Postgres-backed adapters.
This service remains because some Python routes still delegate user/profile
and credit logic through the historical storage port abstraction.
"""
import logging
from datetime import datetime, timezone
from typing import Optional

from app.config import get_settings

logger = logging.getLogger(__name__)


class InsufficientCreditsError(Exception):
    """The storage adapter refused a credit decrement because the balance is too low."""


# Tier hierarchy for resolution
TIER_RANK = {"free": 0, "pro": 1, "team": 2}
DEFAULT_FREE_CREDITS = 100
DEFAULT_PRO_CREDITS = 1000
DEFAULT_TEAM_CREDITS = 5000


def _apply_admin_override(email: str, tier: str, monthly_cap: int) -> tuple:
    """Upgrade admin emails to pro if below pro tier.

    Exact email match only (no @domain patterns). Does not downgrade
    team users who already have higher credits.
    """
    if not email:
        return tier, monthly_cap
    admin_raw = get_settings().admin_emails.strip()
    if not admin_raw:
        return tier, monthly_cap
    admin_list = [e.strip().lower() for e in admin_raw.split(",") if e.strip()]
    if email.lower() in admin_list and TIER_RANK.get(tier, 0) < TIER_RANK["pro"]:
        logger.info("Admin override: %s upgraded from %s to pro", email, tier)
        return "pro", DEFAULT_PRO_CREDITS
    return tier, monthly_cap


def resolve_tier(organizations: list) -> tuple:
    """
    Determine highest coJournalist tier from MuckRock org entitlements.

    Returns (tier_name, monthly_credit_cap, update_on, org_uuid).
    Team > Pro > Free.
    Ignores non-coJournalist entitlements (e.g., "muckrock-pro").
    org_uuid is the UUID of the team org (None for free/pro tiers).
    """
    best_tier = "free"
    best_credits = DEFAULT_FREE_CREDITS
    best_update_on = None
    best_org_uuid = None

    for org in organizations:
        for ent in org.get("entitlements", []):
            name = ent.get("name", "")
            resources = ent.get("resources", {})

            if name == "cojournalist-team":
                if TIER_RANK["team"] > TIER_RANK[best_tier]:
                    best_tier = "team"
                    best_credits = resources.get("monthly_credits", DEFAULT_TEAM_CREDITS)
                    best_update_on = ent.get("update_on")
                    best_org_uuid = org.get("uuid")
            elif name == "cojournalist-pro":
                if TIER_RANK["pro"] > TIER_RANK[best_tier]:
                    best_tier = "pro"
                    best_credits = resources.get("monthly_credits", DEFAULT_PRO_CREDITS)
                    best_update_on = ent.get("update_on")

    return best_tier, best_credits, best_update_on, best_org_uuid


class UserService:
    def __init__(self, user_storage=None):
        if user_storage is None:
            from app.dependencies.providers import get_user_storage
            user_storage = get_user_storage()
        self.storage = user_storage

    async def get_or_create_user(self, userinfo: dict) -> dict:
        """
        Create or update a legacy MuckRock-backed user record.

        - Creates USER#/PROFILE and USER#/CREDITS if new user
        - Preserves existing preferences (timezone, language, location) on returning user
        - Recalculates tier from current entitlements
        """
        user_id = userinfo["uuid"]
        orgs = userinfo.get("organizations", [])
        tier, monthly_cap, update_on, org_uuid = resolve_tier(orgs)
        email = userinfo.get("email", "")
        tier, monthly_cap = _apply_admin_override(email, tier, monthly_cap)

        # Check for existing profile (single read, reused by team flow below)
        existing = await self.storage.get_user(user_id)

        # Team login flow
        org_id = None
        if tier == "team" and org_uuid:
            team_org = next((o for o in orgs if o.get("uuid") == org_uuid), {})
            org_name = team_org.get("name", "")

            await self.storage.create_org(
                org_id=org_uuid, monthly_cap=monthly_cap,
                update_on=update_on, org_name=org_name,
            )

            tier_before = existing.get("tier", "free") if existing else "free"
            await self.storage.claim_seat(org_uuid, user_id, tier_before)
            org_id = org_uuid

        now = datetime.now(timezone.utc).isoformat()

        if existing:
            # Returning user — update tier, preserve preferences
            update_data = {
                "tier": tier,
                "muckrock_id": user_id,
                "org_id": org_id,  # None clears org_id on downgrade
            }
            username = userinfo.get("preferred_username")
            if username:
                update_data["username"] = username
            await self.storage.update_profile(user_id, update_data)

            # Update credit cap if tier changed
            await self.storage.update_credits(user_id, {
                "monthly_cap": monthly_cap,
                "tier": tier,
                "update_on": update_on,
            })

            # Cap balance on downgrade
            current_balance = await self.storage.get_balance(user_id)
            if current_balance > monthly_cap:
                await self.storage.update_credits(user_id, {"balance": monthly_cap})

            final_balance = await self.storage.get_balance(user_id)
            return {
                "user_id": user_id,
                "muckrock_id": user_id,
                "username": username or existing.get("username"),
                "tier": tier,
                "credits": final_balance,
                "timezone": existing.get("timezone"),
                "preferred_language": existing.get("preferred_language", "en"),
                "onboarding_completed": existing.get("onboarding_completed", False),
                "default_location": existing.get("default_location"),
                "excluded_domains": existing.get("excluded_domains") or [],
                "org_id": org_id,
            }
        else:
            # New user — create profile + credits
            profile_data = {
                "muckrock_id": user_id,
                "username": userinfo.get("preferred_username"),
                "tier": tier,
                "timezone": None,
                "preferred_language": "en",
                "onboarding_completed": False,
                "default_location": None,
                "excluded_domains": [],
                "created_at": now,
            }
            if org_id:
                profile_data["org_id"] = org_id
            await self.storage.create_or_update_user(user_id, profile_data)

            await self.storage.create_credits(
                user_id=user_id,
                monthly_cap=monthly_cap,
                tier=tier,
                update_on=update_on,
            )

            return {
                "user_id": user_id,
                "muckrock_id": user_id,
                "tier": tier,
                "credits": monthly_cap,
                "timezone": None,
                "preferred_language": "en",
                "onboarding_completed": False,
                "default_location": None,
                "excluded_domains": [],
                "org_id": org_id,
            }

    async def get_user(self, user_id: str) -> Optional[dict]:
        """Fetch user profile + credits from the storage adapter."""
        return await self.storage.get_user(user_id)

    async def get_cms_config(self, user_id: str) -> dict:
        """Fetch CMS configuration (URL + token) from user profile."""
        return await self.storage.get_cms_config(user_id)

    async def update_preferences(self, user_id: str, **kwargs) -> None:
        """Update user preferences (timezone, language, location, etc.)."""
        if not kwargs:
            return
        await self.storage.update_profile(user_id, kwargs)

    async def update_tier_from_org(self, user_id: str, org_data: dict) -> None:
        """
        Update a user's tier from a single org's entitlements.

        Called by the webhook handler when an individual org changes.
        Handles both upgrades and downgrades (caps balance on downgrade).
        """
        tier, monthly_cap, update_on, org_uuid = resolve_tier([org_data])

        await self.storage.update_profile(user_id, {"tier": tier})
        await self.storage.update_credits(user_id, {
            "monthly_cap": monthly_cap,
            "tier": tier,
            "update_on": update_on,
        })

        # Cap balance on downgrade
        current_balance = await self.storage.get_balance(user_id)
        if current_balance > monthly_cap:
            await self.storage.update_credits(user_id, {"balance": monthly_cap})
            logger.info("Capped balance for %s: %d → %d", user_id, current_balance, monthly_cap)

    async def decrement_credits(self, user_id: str, amount: int) -> None:
        """
        Atomically decrement user credits.

        Raises InsufficientCreditsError if the adapter refuses the decrement.
        """
        success = await self.storage.decrement_credits(user_id, amount)
        if not success:
            raise InsufficientCreditsError("Insufficient credits")

    async def _get_balance(self, user_id: str) -> int:
        """Get current credit balance."""
        return await self.storage.get_balance(user_id)

    # --- ORG# Record CRUD ---

    async def create_org_if_not_exists(
        self,
        org_id: str,
        monthly_cap: int,
        update_on: Optional[str],
        org_name: str,
    ) -> None:
        """
        Create ORG#{org_id}/CREDITS record if it doesn't already exist.

        Idempotent: the adapter ignores an existing record.
        """
        await self.storage.create_org(
            org_id=org_id, monthly_cap=monthly_cap,
            update_on=update_on, org_name=org_name,
        )

    async def _get_org_balance(self, org_id: str) -> int:
        """Get current org credit balance. Returns 0 if not found."""
        return await self.storage.get_org_balance(org_id)

    async def get_org_credits_info(self, org_id: str) -> Optional[dict]:
        """
        Read ORG#{org_id}/CREDITS and return info dict.

        Returns None if the org record doesn't exist.
        """
        return await self.storage.get_org_credits(org_id)

    async def decrement_org_credits(self, org_id: str, amount: int) -> None:
        """
        Atomically decrement org credits.

        Raises InsufficientCreditsError if the adapter refuses the decrement.
        """
        success = await self.storage.decrement_org_credits(org_id, amount)
        if not success:
            raise InsufficientCreditsError("Insufficient org credits")

    async def claim_seat(self, org_id: str, user_id: str, tier_before_team: str) -> bool:
        """
        Atomically claim a seat in a team org.

        Returns True on success or if user is already a member (re-login).
        Returns False if the ORG# record doesn't exist.
        """
        return await self.storage.claim_seat(org_id, user_id, tier_before_team)

    async def update_org_credits(self, org_id: str, new_cap: int, new_update_on: str) -> None:
        """Update ORG# CREDITS cap and update_on. Top up balance on upgrade, clamp on downgrade."""
        await self.storage.update_org_credits(org_id, new_cap, new_update_on)

    async def cancel_team_org(self, org_id: str) -> None:
        """Cancel team org: revert all members to their pre-team tier, delete ORG# records."""
        await self.storage.cancel_team_org(org_id)
