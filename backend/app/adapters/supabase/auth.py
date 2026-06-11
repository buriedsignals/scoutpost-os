"""Supabase implementation of AuthPort.

Uses Supabase JWT validation for user authentication. Gets email from
auth.users via supabase-py admin API. Service key verification uses
HMAC comparison identical to the AWS adapter.

DEPENDS ON: config (supabase_jwt_secret, supabase_url, supabase_service_key,
            internal_service_key), ports.auth (AuthPort)
USED BY: dependencies/providers.py (DI wiring)
"""
from __future__ import annotations

import hmac
import logging
from typing import Optional

import jwt as pyjwt
from fastapi import HTTPException, Request, status
from jwt import PyJWKClient
from supabase import AsyncClient, acreate_client

from app.config import get_settings
from app.ports.auth import AuthPort

logger = logging.getLogger(__name__)
STRICT_HS256_JWT = pyjwt.PyJWT(options={"enforce_minimum_key_length": True})


class SupabaseAuth(AuthPort):
    """Supabase JWT-based authentication."""

    # Minimum length for the symmetric HS256 secret. An empty or trivially
    # short secret is treated as "no HS256 support" so a misconfigured
    # SUPABASE_JWT_SECRET cannot be used to forge tokens (PyJWT accepts an
    # empty HMAC key, which would otherwise fail open).
    _MIN_HS256_SECRET_LEN = 32

    def __init__(self, user_storage=None):
        settings = get_settings()
        self.jwt_secret = settings.supabase_jwt_secret
        self.internal_service_key = settings.internal_service_key
        self.user_storage = user_storage
        self._supabase_url = settings.supabase_url
        self._supabase_service_key = settings.supabase_service_key
        self._supabase_client: AsyncClient | None = None
        self._jwks_client: PyJWKClient | None = None
        self._hs256_enabled = bool(self.jwt_secret) and len(self.jwt_secret) >= self._MIN_HS256_SECRET_LEN
        if not self._hs256_enabled:
            logger.warning(
                "SUPABASE_JWT_SECRET is unset or shorter than %d chars; legacy "
                "HS256 token verification is disabled (ES256/JWKS still works).",
                self._MIN_HS256_SECRET_LEN,
            )

    def _get_jwks_client(self) -> PyJWKClient:
        """Lazy-init JWKS client for ES256 verification.

        Supabase rotates signing keys infrequently; a 1h cache is plenty.
        The endpoint is publicly accessible (project-scoped, no auth).
        """
        if self._jwks_client is None:
            jwks_url = f"{self._supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"
            self._jwks_client = PyJWKClient(jwks_url, lifespan=3600)
        return self._jwks_client

    async def get_current_user(self, request: Request) -> dict:
        """Validate Supabase JWT from Authorization header and return user data.

        The frontend sends the Supabase access token as a Bearer token.
        We decode it using the Supabase JWT secret and look up the user
        in user_preferences.

        Returns:
            User dict with user_id, timezone, preferences, etc.

        Raises:
            HTTPException 401: If token is missing, invalid, or user not found.
        """
        auth_header = request.headers.get("Authorization", "")
        token = auth_header.replace("Bearer ", "") if auth_header.startswith("Bearer ") else ""

        if not token:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Missing authorization token",
            )

        try:
            # Sniff alg first so we use the right key for the right algorithm.
            # Supabase issues ES256 (asymmetric) for new projects via JWKS.
            # Legacy projects (and any pre-asymmetric token still in flight)
            # remain HS256 against the shared jwt_secret. PyJWT would refuse
            # to verify an ES256 token with the symmetric secret, so we
            # branch instead of merging both algs into a single decode call.
            header = pyjwt.get_unverified_header(token)
            alg = header.get("alg")
            if alg == "ES256":
                signing_key = (
                    self._get_jwks_client().get_signing_key_from_jwt(token).key
                )
                payload = pyjwt.decode(
                    token,
                    signing_key,
                    algorithms=["ES256"],
                    options={"verify_aud": False, "require": ["exp", "sub"]},
                )
            elif alg == "HS256":
                if not self._hs256_enabled:
                    raise HTTPException(
                        status_code=status.HTTP_401_UNAUTHORIZED,
                        detail="Invalid token: HS256 verification unavailable",
                    )
                payload = STRICT_HS256_JWT.decode(
                    token,
                    self.jwt_secret,
                    algorithms=["HS256"],
                    options={"verify_aud": False, "require": ["exp", "sub"]},
                )
            else:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail=f"Invalid token: unsupported alg {alg!r}",
                )
        except pyjwt.ExpiredSignatureError:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token has expired",
            )
        except pyjwt.InvalidTokenError as e:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=f"Invalid token: {e}",
            )
        except pyjwt.PyJWTError as e:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=f"Invalid token: {e}",
            )

        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token: missing sub claim",
            )

        user = await self.user_storage.get_user(user_id)
        if not user:
            # First-time user -- create preferences record
            user = await self.user_storage.create_or_update_user(user_id, {})

        user["user_id"] = user_id
        return user

    async def get_user_email(self, user_id: str) -> Optional[str]:
        """Get user email from Supabase auth.users via async admin API.

        Uses the async Supabase client (acreate_client) to avoid blocking
        the event loop. The client is lazily initialized on first call.
        """
        try:
            if self._supabase_client is None:
                self._supabase_client = await acreate_client(
                    self._supabase_url,
                    self._supabase_service_key,
                )
            result = await self._supabase_client.auth.admin.get_user_by_id(user_id)
            return result.user.email
        except Exception as e:
            logger.error(f"Failed to fetch email from Supabase for {user_id}: {e}")
            return None

    async def verify_service_key(self, key: str) -> bool:
        """Verify internal service key using constant-time comparison."""
        if not self.internal_service_key or not key:
            return False
        return hmac.compare_digest(key, self.internal_service_key)
