"""Tests for SupabaseExecutionStorage."""

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

from app.adapters.supabase.execution_storage import SupabaseExecutionStorage


@pytest.fixture
def mock_pool():
    return AsyncMock()


@pytest.fixture
def storage(mock_pool):
    s = SupabaseExecutionStorage()
    s.pool = mock_pool
    return s


class TestStoreExecution:
    @pytest.mark.asyncio
    async def test_stores_execution_record(self, storage, mock_pool):
        exec_id = uuid.uuid4()
        embedding = [0.1] * 1536
        mock_pool.fetchrow = AsyncMock(return_value={
            "id": exec_id,
            "scout_id": uuid.uuid4(),
            "user_id": uuid.uuid4(),
            "summary_text": "Test summary",
            "is_duplicate": False,
            "completed_at": datetime.now(timezone.utc),
        })

        result = await storage.store_execution(
            user_id="user-1",
            scout_name="my-scout",
            scout_type="beat",
            summary_text="Test summary",
            is_duplicate=False,
            started_at="2026-03-29T10:00:00Z",
            embedding=embedding,
            content_hash="abc123",
            provider="firecrawl",
        )

        assert result["summary_text"] == "Test summary"
        assert result["is_duplicate"] is False
        mock_pool.fetchrow.assert_called_once()
        assert mock_pool.fetchrow.await_args.args[6] == (
            "embeddinggemma-300m-768-int8-onnx-task-prefix-v1"
        )


class TestGetRecentExecutions:
    @pytest.mark.asyncio
    async def test_returns_recent_executions(self, storage, mock_pool):
        mock_pool.fetch = AsyncMock(return_value=[
            {"id": uuid.uuid4(), "summary_text": "Summary 1", "is_duplicate": False},
            {"id": uuid.uuid4(), "summary_text": "Summary 2", "is_duplicate": True},
        ])

        result = await storage.get_recent_executions("user-1", str(uuid.uuid4()), limit=5)
        assert len(result) == 2


class TestGetRecentEmbeddings:
    @pytest.mark.asyncio
    async def test_returns_records_with_embeddings(self, storage, mock_pool):
        mock_pool.fetch = AsyncMock(return_value=[
            {
                "id": uuid.uuid4(),
                "summary_text": "Summary 1",
                "embedding": [0.1] * 1536,
                "completed_at": datetime.now(timezone.utc),
            },
        ])

        result = await storage.get_recent_embeddings("user-1", "my-scout", limit=20)
        assert len(result) == 1
        assert "embedding" in result[0]


class TestDeleteExecutionsForScout:
    @pytest.mark.asyncio
    async def test_deletes_executions(self, storage, mock_pool):
        mock_pool.execute = AsyncMock(return_value="DELETE 5")

        await storage.delete_executions_for_scout("user-1", "my-scout")
        mock_pool.execute.assert_called_once()


class TestGetLatestContentHash:
    @pytest.mark.asyncio
    async def test_returns_hash_when_exists(self, storage, mock_pool):
        mock_pool.fetchval = AsyncMock(return_value="abc123")

        result = await storage.get_latest_content_hash("user-1", str(uuid.uuid4()))
        assert result == "abc123"

    @pytest.mark.asyncio
    async def test_returns_none_when_no_hash(self, storage, mock_pool):
        mock_pool.fetchval = AsyncMock(return_value=None)

        result = await storage.get_latest_content_hash("user-1", str(uuid.uuid4()))
        assert result is None
