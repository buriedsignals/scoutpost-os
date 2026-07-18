"""
Shared HTTP clients with connection pooling.

PURPOSE: Two client pools with different connection reuse strategies:
- Default client: Keepalive ON for embedding calls, Firecrawl, Resend, and other
  APIs that make many sequential calls to the same host.
- LLM client: Keepalive OFF for OpenRouter LLM calls. Prevents HTTP/1.1
  connection contention when concurrent LLM requests (e.g. news +
  government categories via asyncio.gather) share a kept-alive connection,
  which causes response body reads to hang indefinitely.

DEPENDS ON: (stdlib + httpx only — no app imports)
USED BY: services/embedding_utils.py, main.py (shutdown hook)

CRITICAL: Do not create standalone httpx.AsyncClient instances in services.
Always use get_http_client() or get_llm_client() and ensure proper shutdown.
"""
import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# Shared client instances (created on first use)
_default_client: Optional[httpx.AsyncClient] = None
_llm_client: Optional[httpx.AsyncClient] = None


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


async def get_llm_client() -> httpx.AsyncClient:
    """
    Get HTTP client for LLM calls (OpenRouter).

    Keepalive disabled to prevent HTTP/1.1 connection contention.
    When two concurrent LLM requests reuse a kept-alive connection to
    the same host, one response body read can hang indefinitely.

    Returns:
        httpx.AsyncClient: LLM-specific async HTTP client
    """
    global _llm_client
    if _llm_client is None:
        _llm_client = httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=10.0),
            limits=httpx.Limits(
                max_connections=20,
                max_keepalive_connections=0,
            ),
            follow_redirects=True,
        )
        logger.info("Initialized LLM HTTP client (keepalive disabled)")
    return _llm_client


async def close_http_client() -> None:
    """
    Close all shared HTTP clients.

    Should be called during application shutdown to properly
    close all connections.
    """
    global _default_client, _llm_client
    if _default_client is not None:
        await _default_client.aclose()
        _default_client = None
        logger.info("Closed default HTTP client")
    if _llm_client is not None:
        await _llm_client.aclose()
        _llm_client = None
        logger.info("Closed LLM HTTP client")
