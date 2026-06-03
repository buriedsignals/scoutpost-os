"""Unit tests for LicenseKeyService.

Tests cover:
- License validation (valid key, invalid key, last_validated_at update)
"""
import hashlib
from unittest.mock import MagicMock, patch

import pytest

from app.services.license_key_service import LicenseKeyService


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_table():
    """Mock DynamoDB table."""
    return MagicMock()


@pytest.fixture
def license_service(mock_table):
    """LicenseKeyService with mocked DynamoDB table."""
    with patch("app.services.license_key_service.get_settings") as mock_settings, \
         patch("app.services.license_key_service.boto3") as mock_boto:
        mock_settings.return_value.aws_region = "eu-central-1"
        mock_boto.resource.return_value.Table.return_value = mock_table
        service = LicenseKeyService()
    return service


# ---------------------------------------------------------------------------
# validate_key()
# ---------------------------------------------------------------------------

class TestValidateKey:
    def test_returns_record_for_valid_key(self, license_service, mock_table):
        """validate_key returns the LICENSE# record when key exists."""
        raw_key = "cjl_testkey1-testkey2-testkey3-testkey4"
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()

        mock_table.get_item.return_value = {
            "Item": {
                "PK": f"LICENSE#{key_hash}",
                "SK": "META",
                "status": "active",
                "expires_at": "2027-03-29T00:00:00+00:00",
                "customer_email": "editor@newsroom.org",
            }
        }

        result = license_service.validate_key(raw_key)

        assert result is not None
        assert result["status"] == "active"
        assert result["customer_email"] == "editor@newsroom.org"

        # Verify it looked up by hash
        mock_table.get_item.assert_called_once_with(
            Key={"PK": f"LICENSE#{key_hash}", "SK": "META"}
        )

    def test_returns_none_for_invalid_key(self, license_service, mock_table):
        """validate_key returns None when key does not exist."""
        mock_table.get_item.return_value = {}

        result = license_service.validate_key("cjl_invalid-key-here-nope")
        assert result is None

    def test_updates_last_validated_at(self, license_service, mock_table):
        """validate_key updates last_validated_at timestamp on valid key."""
        raw_key = "cjl_testkey1-testkey2-testkey3-testkey4"
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()

        mock_table.get_item.return_value = {
            "Item": {
                "PK": f"LICENSE#{key_hash}",
                "SK": "META",
                "status": "active",
            }
        }

        license_service.validate_key(raw_key)

        # Verify update_item was called to update last_validated_at
        mock_table.update_item.assert_called_once()
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert call_kwargs["Key"] == {"PK": f"LICENSE#{key_hash}", "SK": "META"}
        assert "last_validated_at" in call_kwargs["UpdateExpression"]

    def test_validation_succeeds_even_if_timestamp_update_fails(self, license_service, mock_table):
        """validate_key still returns the record if last_validated_at update throws."""
        raw_key = "cjl_testkey1-testkey2-testkey3-testkey4"
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()

        mock_table.get_item.return_value = {
            "Item": {"PK": f"LICENSE#{key_hash}", "SK": "META", "status": "active"}
        }
        mock_table.update_item.side_effect = Exception("DynamoDB throttled")

        result = license_service.validate_key(raw_key)
        assert result is not None
        assert result["status"] == "active"
