"""Tests for asyncpg connection pool singleton."""
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def reset_pool():
    """Reset the pool singleton between tests."""
    import app.adapters.supabase.connection as conn_module
    conn_module._pool = None
    yield
    conn_module._pool = None


@pytest.mark.asyncio
async def test_get_pool_creates_pool_with_correct_params():
    """get_pool() should create pool with required parameters including statement_cache_size=0."""
    mock_pool = MagicMock()
    mock_settings = MagicMock()
    mock_settings.database_url = "postgresql://user:pass@localhost/db"

    with patch("asyncpg.create_pool", new_callable=AsyncMock, return_value=mock_pool) as mock_create:
        with patch("app.adapters.supabase.connection.get_settings", return_value=mock_settings):
            from app.adapters.supabase.connection import get_pool

            result = await get_pool()

    assert result is mock_pool
    mock_create.assert_awaited_once_with(
        dsn="postgresql://user:pass@localhost/db",
        min_size=2,
        max_size=10,
        command_timeout=30,
        statement_cache_size=0,  # PgBouncer/Supavisor transaction pooling
        server_settings={"jit": "off"},  # Supavisor cold-connection warm-up tax
    )


@pytest.mark.asyncio
async def test_get_pool_returns_same_pool_on_second_call():
    """Second call to get_pool() should return the same pool without creating a new one."""
    mock_pool = MagicMock()
    mock_settings = MagicMock()
    mock_settings.database_url = "postgresql://user:pass@localhost/db"

    with patch("asyncpg.create_pool", new_callable=AsyncMock, return_value=mock_pool) as mock_create:
        with patch("app.adapters.supabase.connection.get_settings", return_value=mock_settings):
            from app.adapters.supabase.connection import get_pool

            first = await get_pool()
            second = await get_pool()

    assert first is second
    # create_pool should only be called once
    assert mock_create.await_count == 1
