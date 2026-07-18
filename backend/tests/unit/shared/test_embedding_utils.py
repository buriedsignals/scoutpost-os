"""Contract tests for OpenRouter Gemini embeddings and vector utilities."""

import base64
import math
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

import app.services.embedding_utils as embedding_utils
from app.config import settings
from app.services.embedding_utils import (
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL_TAG,
    OPENROUTER_EMBEDDING_MODEL,
    EmbeddingError,
    compress_embedding,
    cosine_similarity,
    decompress_embedding,
    generate_embedding,
    generate_embeddings_batch,
    normalize_embedding,
)

VECTOR_A = [1.0] + [0.0] * (EMBEDDING_DIMENSIONS - 1)
VECTOR_B = [0.0, 1.0] + [0.0] * (EMBEDDING_DIMENSIONS - 2)


def _response(*items: tuple[int, list[float]], status_code: int = 200) -> MagicMock:
    response = MagicMock()
    response.status_code = status_code
    response.text = "upstream body must stay private"
    response.json.return_value = {
        "model": "gemini-embedding-001",
        "data": [{"index": index, "embedding": vector} for index, vector in items],
        "usage": {"prompt_tokens": 4, "total_tokens": 4, "cost": 0.0000006},
    }
    return response


def _install_client(monkeypatch: pytest.MonkeyPatch, response: MagicMock) -> AsyncMock:
    client = AsyncMock()
    client.post = AsyncMock(return_value=response)
    monkeypatch.setattr(
        embedding_utils,
        "get_http_client",
        AsyncMock(return_value=client),
    )
    return client


def _configure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "openrouter_api_key", "openrouter-token")


class TestEmbeddingConstants:
    def test_model_and_storage_tag_pin_openrouter_gemini_768_zdr(self):
        assert EMBEDDING_DIMENSIONS == 768
        assert OPENROUTER_EMBEDDING_MODEL == "google/gemini-embedding-001"
        assert EMBEDDING_MODEL_TAG == (
            "openrouter-google-gemini-embedding-001-768-zdr-v1"
        )


class TestEmbeddingCompression:
    def test_roundtrip_preserves_existing_float32_format(self):
        original = [0.1, 0.2, 0.3, -0.5, 1.0]
        decompressed = decompress_embedding(compress_embedding(original))
        assert len(decompressed) == len(original)
        for expected, actual in zip(original, decompressed):
            assert abs(expected - actual) < 1e-6

    def test_compressed_value_is_base64(self):
        base64.b64decode(compress_embedding([0.1, 0.2]))


class TestCosineSimilarity:
    def test_identical_vectors(self):
        vector = [1.0, 2.0, 3.0]
        assert abs(cosine_similarity(vector, vector) - 1.0) < 1e-6

    def test_orthogonal_and_zero_vectors(self):
        assert abs(cosine_similarity([1.0, 0.0], [0.0, 1.0])) < 1e-6
        assert cosine_similarity([0.0, 0.0], [1.0, 2.0]) == 0.0


class TestNormalizeEmbedding:
    def test_normalizes_to_unit_length_and_preserves_zero_vector(self):
        result = normalize_embedding([3.0, 4.0])
        assert math.isclose(sum(value * value for value in result), 1.0, abs_tol=1e-6)
        assert normalize_embedding([0.0, 0.0]) == [0.0, 0.0]


class TestGenerateEmbedding:
    @pytest.mark.asyncio
    async def test_single_request_enforces_vertex_zdr_768(self, monkeypatch):
        _configure(monkeypatch)
        client = _install_client(monkeypatch, _response((0, VECTOR_A)))

        result = await generate_embedding(
            "body text", "RETRIEVAL_DOCUMENT", title="Council Minutes"
        )

        assert result == VECTOR_A
        assert client.post.call_args.args == (
            "https://openrouter.ai/api/v1/embeddings",
        )
        assert client.post.call_args.kwargs["headers"]["Authorization"] == (
            "Bearer openrouter-token"
        )
        assert client.post.call_args.kwargs["headers"]["X-OpenRouter-Cache"] == "false"
        assert client.post.call_args.kwargs["json"] == {
            "model": "google/gemini-embedding-001",
            "input": ["title: Council Minutes | text: body text"],
            "dimensions": 768,
            "input_type": "search_document",
            "provider": {
                "only": ["google-vertex"],
                "allow_fallbacks": False,
                "zdr": True,
                "data_collection": "deny",
            },
        }

    @pytest.mark.asyncio
    async def test_response_is_normalized_after_shape_validation(self, monkeypatch):
        _configure(monkeypatch)
        vector = [3.0, 4.0] + [0.0] * (EMBEDDING_DIMENSIONS - 2)
        _install_client(monkeypatch, _response((0, vector)))
        result = await generate_embedding("normalize me")
        assert math.isclose(sum(value * value for value in result), 1.0, abs_tol=1e-6)

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "vector",
        [
            [1.0] * (EMBEDDING_DIMENSIONS - 1),
            [float("nan")] + [0.0] * (EMBEDDING_DIMENSIONS - 1),
            [True] + [0.0] * (EMBEDDING_DIMENSIONS - 1),
        ],
    )
    async def test_rejects_invalid_vector_shape(self, monkeypatch, vector):
        _configure(monkeypatch)
        _install_client(monkeypatch, _response((0, vector)))
        with pytest.raises(EmbeddingError, match="invalid vector"):
            await generate_embedding("test")

    @pytest.mark.asyncio
    async def test_missing_configuration_fails_before_client(self, monkeypatch):
        monkeypatch.setattr(settings, "openrouter_api_key", "")
        get_client = AsyncMock()
        monkeypatch.setattr(embedding_utils, "get_http_client", get_client)
        with pytest.raises(EmbeddingError, match="OPENROUTER_API_KEY"):
            await generate_embedding("test")
        get_client.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_errors_do_not_expose_content_or_token(self, monkeypatch, caplog):
        _configure(monkeypatch)
        response = _response(status_code=401)
        response.text = "private prompt and openrouter-token"
        _install_client(monkeypatch, response)
        with pytest.raises(EmbeddingError) as error:
            await generate_embedding("private prompt")
        combined = f"{error.value} {caplog.text}"
        assert "status 401" in combined
        assert response.text not in combined
        assert "openrouter-token" not in combined
        assert "private prompt" not in combined

    @pytest.mark.asyncio
    async def test_transport_and_malformed_json_errors_are_safe(self, monkeypatch):
        _configure(monkeypatch)
        client = AsyncMock()
        client.post = AsyncMock(
            side_effect=httpx.RequestError(
                "request contained openrouter-token",
                request=httpx.Request("POST", "https://openrouter.ai/api/v1/embeddings"),
            )
        )
        monkeypatch.setattr(
            embedding_utils, "get_http_client", AsyncMock(return_value=client)
        )
        with pytest.raises(EmbeddingError, match="OpenRouter embedding request failed"):
            await generate_embedding("private prompt")

        malformed = _response((0, VECTOR_A))
        malformed.json.side_effect = ValueError("private parser detail")
        _install_client(monkeypatch, malformed)
        with pytest.raises(EmbeddingError, match="malformed JSON") as error:
            await generate_embedding("test")
        assert "private parser detail" not in str(error.value)


class TestGenerateEmbeddingsBatch:
    @pytest.mark.asyncio
    async def test_empty_batch_does_not_call_service(self, monkeypatch):
        get_client = AsyncMock()
        monkeypatch.setattr(embedding_utils, "get_http_client", get_client)
        assert await generate_embeddings_batch([]) == []
        get_client.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_batch_preserves_inputs_and_response_order(self, monkeypatch):
        _configure(monkeypatch)
        client = _install_client(monkeypatch, _response((1, VECTOR_B), (0, VECTOR_A)))
        result = await generate_embeddings_batch(
            ["alpha", "beta"], "RETRIEVAL_DOCUMENT", titles=["Title A", None]
        )
        assert result == [VECTOR_A, VECTOR_B]
        assert client.post.call_args.kwargs["json"]["input"] == [
            "title: Title A | text: alpha",
            "beta",
        ]

    @pytest.mark.asyncio
    async def test_titles_length_must_match_inputs(self):
        with pytest.raises(ValueError, match="titles must be the same length"):
            await generate_embeddings_batch(["alpha"], titles=["one", "two"])

    @pytest.mark.asyncio
    async def test_http_failure_preserves_best_effort_empty_batch(self, monkeypatch):
        _configure(monkeypatch)
        _install_client(monkeypatch, _response(status_code=529))
        assert await generate_embeddings_batch(["alpha"]) == []
