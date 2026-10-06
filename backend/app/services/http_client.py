"""
Shared HTTP client with connection pooling.

PURPOSE: Keepalive-enabled client for embedding calls and other APIs that make
many sequential calls to the same host.

DEPENDS ON: (stdlib + httpx only — no app imports)
USED BY: services/embedding_utils.py, main.py (shutdown hook)

CRITICAL: Do not create standalone httpx.AsyncClient instances in services.
Always use get_http_client() and ensure proper shutdown.
"""
import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# Shared client instances (created on first use)
_default_client: Optional[httpx.AsyncClient] = None


async def get_http_client() -> httpx.AsyncClient:
    """
    Get shared HTTP client for general API calls (Firecrawl, Resend, and other
    non-LLM services).

    Keepalive enabled — these services make many sequential calls to the
    same hosts and benefit from connection reuse.

    Returns:
        httpx.AsyncClient: Shared async HTTP client
    """
    global _default_client
    if _default_client is None:
        _default_client = httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=10.0),
            limits=httpx.Limits(
                max_connections=100,
                max_keepalive_connections=20,
                keepalive_expiry=30.0,
            ),
            follow_redirects=True,
        )
        logger.info("Initialized default HTTP client (keepalive enabled)")
    return _default_client


async def close_http_client() -> None:
    """
    Close the shared HTTP client.

    Should be called during application shutdown to properly
    close all connections.
    """
    global _default_client
    if _default_client is not None:
        await _default_client.aclose()
        _default_client = None
        logger.info("Closed default HTTP client")
