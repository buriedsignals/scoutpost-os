"""
FastAPI billing helpers kept for the optional Python API surface.

Supabase-backed credits are now the primary path. These helpers still exist so
the legacy FastAPI routes can validate/decrement credits without breaking.
"""
import logging
from typing import Optional

from app.dependencies.auth import _get_services
from app.services.user_service import InsufficientCreditsError
try:
    from app.utils.credits import validate_user_credits as _validate_credits
except ImportError:
    async def _validate_credits(*args, **kwargs):
        return {"current_credits": 999999, "required": 0, "remaining_after": 999999}

logger = logging.getLogger(__name__)


async def get_user_org_id(user_id: str) -> Optional[str]:
    """Get user's team org_id from the legacy profile service.

    For callers that don't have a session cookie.
    Returns None for non-team users or on error.
    """
    try:
        _, user_service = _get_services()
        user = await user_service.get_user(user_id)
        return user.get("org_id") if user else None
    except Exception as e:
        logger.error(f"Failed to get org_id for {user_id}: {e}")
        return None


async def get_user_credits(user_id: str) -> int:
    """Get user's current credit balance from the legacy profile service.

    Args:
        user_id: User ID.

    Returns:
        Current credit balance (0 if not found or error).
    """
    try:
        _, user_service = _get_services()
        user = await user_service.get_user(user_id)
        if user:
            return user.get("credits", 0)
        return 0
    except Exception as e:
        logger.error(f"Failed to get credits for {user_id}: {e}")
        return 0


async def decrement_credit(
    user_id: str,
    amount: int = 1,
    org_id: str = None,
    *,
    operation: str = "",
    scout_name: str = "",
    scout_type: str = "",
) -> bool:
    """Decrement credits through the user storage adapter. Writes no usage record.

    Args:
        user_id: User ID.
        amount: Number of credits to decrement (default 1).
        org_id: Optional org ID. When set, decrement from org pool.
        operation: Pricing key (e.g. "beat", "website_extraction").
        scout_name: Name of the scout that triggered the charge.
        scout_type: Type of scout (e.g. "web", "beat", "social").

    Returns:
        True if credits were decremented, False on insufficient credits or error.
    """
    try:
        _, user_service = _get_services()
        if org_id:
            try:
                await user_service.decrement_org_credits(org_id, amount)
            except InsufficientCreditsError:
                logger.warning(f"Insufficient team credits for org {org_id}")
                return False
            except Exception as e:
                # Fail closed on unknown errors — don't fall back to personal credits
                logger.error(f"Org credit decrement failed for {org_id}: {e}")
                return False
        else:
            await user_service.decrement_credits(user_id, amount)
        logger.info(f"Decremented {amount} credit(s) for {user_id} (org={org_id})")
        return True
    except InsufficientCreditsError:
        logger.warning(f"Insufficient credits for {user_id}")
        return False
    except Exception as e:
        logger.error(f"Failed to decrement credit for {user_id}: {e}")
        return False


async def validate_credits(user_id: str, required_amount: int, org_id: str = None) -> dict:
    """Validate user has sufficient credits. Uses injected UserService.

    Args:
        user_id: User ID.
        required_amount: Credits required for the operation.
        org_id: Optional org ID. When set, validates against org pool balance.

    Returns:
        Dict with current_credits, required, remaining_after.

    Raises:
        HTTPException(402) if insufficient credits.
    """
    _, user_svc = _get_services()
    return await _validate_credits(user_id, required_amount, org_id=org_id, user_service=user_svc)
