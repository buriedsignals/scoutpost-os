"""
Unit tests for the session service.

These tests verify that:
1. Create/validate roundtrip works correctly
2. Tampered tokens are rejected
3. Expired tokens are rejected
4. Wrong secret tokens are rejected
5. Each session gets a unique session ID
"""
import time
import warnings

import jwt
import pytest

from app.services.session_service import SessionService


@pytest.fixture
def service():
    """SessionService with a test secret and default max_age."""
    return SessionService(secret="test-secret-key-for-unit-tests-32b")


class TestCreateValidateRoundtrip:
    """Tests for session creation and validation."""

    def test_roundtrip(self, service):
        """A freshly created token should validate and return correct sub."""
        token = service.create_session("user-123")
        claims = service.validate_session(token)
        assert claims is not None
        assert claims["sub"] == "user-123"

    def test_claims_contain_required_fields(self, service):
        """Token claims should include sub, sid, iat, and exp."""
        token = service.create_session("user-456")
        claims = service.validate_session(token)
        assert "sub" in claims
        assert "sid" in claims
        assert "iat" in claims
        assert "exp" in claims

    def test_exp_is_in_future(self, service):
        """Expiration should be in the future."""
        token = service.create_session("user-789")
        claims = service.validate_session(token)
        assert claims["exp"] > time.time()


class TestSecretStrength:
    """Tests for HS256 signing secret guardrails."""

    def test_rejects_short_secret_on_create(self):
        """Session creation should fail fast when HS256 is configured weakly."""
        service = SessionService(secret="short")
        with pytest.raises(jwt.InvalidKeyError):
            service.create_session("user-123")

    def test_rejects_token_signed_with_short_secret(self):
        """Session validation should reject weak-key HS256 tokens."""
        service = SessionService(secret="short")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            token = jwt.encode(
                {"sub": "user-123", "exp": time.time() + 3600},
                "short",
                algorithm="HS256",
            )
        assert service.validate_session(token) is None


class TestTamperedToken:
    """Tests for tampered token rejection."""

    def test_tampered_payload(self, service):
        """Modifying the payload should cause validation to fail."""
        token = service.create_session("user-123")
        # Tamper by flipping a character in the middle (payload section)
        parts = token.split(".")
        payload = parts[1]
        # Flip a character
        tampered = payload[:-1] + ("A" if payload[-1] != "A" else "B")
        tampered_token = f"{parts[0]}.{tampered}.{parts[2]}"
        assert service.validate_session(tampered_token) is None

    def test_tampered_signature(self, service):
        """Modifying the signature should cause validation to fail."""
        token = service.create_session("user-123")
        parts = token.split(".")
        sig = parts[2]
        # Flip multiple characters to ensure decoded bytes actually change
        tampered_sig = sig[:4] + ("XXXX" if sig[4:8] != "XXXX" else "YYYY") + sig[8:]
        tampered_token = f"{parts[0]}.{parts[1]}.{tampered_sig}"
        assert service.validate_session(tampered_token) is None


class TestExpiredToken:
    """Tests for expired token rejection."""

    def test_expired_token(self):
        """Token with max_age=0 should expire immediately."""
        # Create a service with 0 second max_age
        service = SessionService(secret="test-secret-minimum-32-bytes-long", max_age=0)
        token = service.create_session("user-123")
        # The token is created with exp = now + 0 seconds, so it's already expired
        # (PyJWT has a default leeway of 0, so exp == iat means expired)
        # We need to wait just a moment for the clock to advance
        time.sleep(1)
        assert service.validate_session(token) is None

    def test_manually_expired_token(self):
        """Manually crafted expired JWT should be rejected."""
        service = SessionService(secret="test-secret-minimum-32-bytes-long")
        # Create a token that expired 1 hour ago
        expired_payload = {
            "sub": "user-123",
            "sid": "fake-sid",
            "iat": time.time() - 7200,
            "exp": time.time() - 3600,
        }
        token = jwt.encode(expired_payload, "test-secret-minimum-32-bytes-long", algorithm="HS256")
        assert service.validate_session(token) is None


class TestWrongSecret:
    """Tests for wrong secret rejection."""

    def test_wrong_secret(self):
        """Token signed with different secret should be rejected."""
        creator = SessionService(secret="secret-A-minimum-32-bytes-long!!")
        validator = SessionService(secret="secret-B-minimum-32-bytes-long!!")
        token = creator.create_session("user-123")
        assert validator.validate_session(token) is None


class TestUniqueSessionIds:
    """Tests for session ID uniqueness."""

    def test_unique_sids(self, service):
        """Each call to create_session should produce a unique sid."""
        tokens = [service.create_session("user-123") for _ in range(10)]
        sids = set()
        for token in tokens:
            claims = service.validate_session(token)
            sids.add(claims["sid"])
        assert len(sids) == 10

    def test_same_user_different_sessions(self, service):
        """Same user_id should get different session tokens."""
        t1 = service.create_session("user-123")
        t2 = service.create_session("user-123")
        assert t1 != t2


class TestCustomMaxAge:
    """Tests for configurable session lifetime."""

    def test_custom_max_age(self):
        """Custom max_age should be reflected in token expiration."""
        service = SessionService(secret="test-secret-minimum-32-bytes-long", max_age=3600)  # 1 hour
        token = service.create_session("user-123")
        claims = service.validate_session(token)
        # exp - iat should be approximately 3600
        diff = claims["exp"] - claims["iat"]
        assert 3599 <= diff <= 3601


class TestMalformedInput:
    """Tests for handling malformed tokens gracefully."""

    def test_empty_string(self, service):
        """Empty string should return None."""
        assert service.validate_session("") is None

    def test_garbage_string(self, service):
        """Random garbage should return None."""
        assert service.validate_session("not.a.jwt") is None

    def test_none_like_input(self, service):
        """Completely invalid input should return None."""
        assert service.validate_session("abcdefg") is None
