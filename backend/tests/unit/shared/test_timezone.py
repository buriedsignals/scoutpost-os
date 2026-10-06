"""
Unit tests for timezone normalization utilities.

Verifies:
1. normalize_timezone maps deprecated IANA names to canonical equivalents
2. normalize_timezone passes through canonical names and None/empty
3. validate_timezone normalizes then validates via ZoneInfo
4. validate_timezone raises ValueError for truly invalid names
5. The 3 actual offenders from Render logs are handled
"""
import pytest

from app.utils.timezone import normalize_timezone, validate_timezone


# ---------------------------------------------------------------------------
# normalize_timezone
# ---------------------------------------------------------------------------

class TestNormalizeTimezone:
    """Tests for the normalize_timezone function."""

    def test_maps_deprecated_americas(self):
        assert normalize_timezone("America/Buenos_Aires") == "America/Argentina/Buenos_Aires"
        assert normalize_timezone("America/Indianapolis") == "America/Indiana/Indianapolis"
        assert normalize_timezone("America/Louisville") == "America/Kentucky/Louisville"

    def test_maps_deprecated_asia(self):
        assert normalize_timezone("Asia/Calcutta") == "Asia/Kolkata"
        assert normalize_timezone("Asia/Saigon") == "Asia/Ho_Chi_Minh"
        assert normalize_timezone("Asia/Katmandu") == "Asia/Kathmandu"

    def test_maps_deprecated_europe(self):
        assert normalize_timezone("Europe/Kiev") == "Europe/Kyiv"

    def test_maps_deprecated_pacific(self):
        assert normalize_timezone("Pacific/Ponape") == "Pacific/Pohnpei"

    def test_passthrough_canonical(self):
        assert normalize_timezone("America/New_York") == "America/New_York"
        assert normalize_timezone("Europe/Zurich") == "Europe/Zurich"
        assert normalize_timezone("Asia/Kolkata") == "Asia/Kolkata"
        assert normalize_timezone("UTC") == "UTC"

    def test_none_returns_none(self):
        assert normalize_timezone(None) is None

    def test_empty_returns_empty(self):
        assert normalize_timezone("") == ""

    def test_unknown_passthrough(self):
        assert normalize_timezone("Mars/Olympus_Mons") == "Mars/Olympus_Mons"


# ---------------------------------------------------------------------------
# validate_timezone
# ---------------------------------------------------------------------------

class TestValidateTimezone:
    """Tests for the validate_timezone function."""

    def test_accepts_canonical(self):
        assert validate_timezone("America/New_York") == "America/New_York"
        assert validate_timezone("Europe/Zurich") == "Europe/Zurich"
        assert validate_timezone("UTC") == "UTC"

    def test_normalizes_and_accepts_deprecated(self):
        """The 3 actual offenders from Render logs."""
        assert validate_timezone("America/Buenos_Aires") == "America/Argentina/Buenos_Aires"
        assert validate_timezone("Asia/Calcutta") == "Asia/Kolkata"
        assert validate_timezone("America/Indianapolis") == "America/Indiana/Indianapolis"

    def test_rejects_invalid(self):
        with pytest.raises(ValueError, match="Invalid timezone"):
            validate_timezone("Not/A/Timezone")

    def test_rejects_empty_string(self):
        with pytest.raises(ValueError):
            validate_timezone("")
