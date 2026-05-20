"""
Session management using signed JWTs in httpOnly cookies.

PURPOSE: Creates and validates session tokens stored as httpOnly cookies.
Sessions are HS256-signed JWTs containing user identity and session metadata.

DEPENDS ON: PyJWT (jwt)
USED BY: dependencies/auth.py (session cookie encode/decode for
    local_auth + muckrock_proxy routers)
"""
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt

logger = logging.getLogger(__name__)
STRICT_HS256_JWT = jwt.PyJWT(options={"enforce_minimum_key_length": True})


class SessionService:
    """Manages user sessions via signed HS256 JWTs."""

    def __init__(self, secret: str, max_age: int = 86400 * 7):
        """Initialize session service.

        Args:
            secret: HMAC secret for signing JWTs.
            max_age: Session lifetime in seconds (default 7 days).
        """
        self.secret = secret
        self.max_age = max_age

    def create_session(self, user_id: str, org_id: str = None) -> str:
        """Create a signed session JWT.

        Args:
            user_id: The authenticated user's ID (stored as 'sub' claim).
            org_id: Optional organization ID for team members (stored as 'org_id' claim).

        Returns:
            Encoded JWT string.
        """
        now = datetime.now(timezone.utc)
        payload = {
            "sub": user_id,
            "sid": str(uuid.uuid4()),
            "iat": now,
            "exp": now + timedelta(seconds=self.max_age),
        }
        if org_id:
            payload["org_id"] = org_id
        return STRICT_HS256_JWT.encode(payload, self.secret, algorithm="HS256")

    def validate_session(self, token: str) -> Optional[dict]:
        """Validate and decode a session JWT.

        Args:
            token: Encoded JWT string.

        Returns:
            Claims dict (sub, sid, iat, exp) if valid, None otherwise.
        """
        try:
            claims = STRICT_HS256_JWT.decode(token, self.secret, algorithms=["HS256"])
            return claims
        except jwt.PyJWTError:
            logger.debug("Session validation failed", exc_info=True)
            return None
