"""Tests for Supabase adapter utilities."""
from datetime import datetime, date
from uuid import uuid4

from app.adapters.supabase.utils import row_to_dict


class TestRowToDict:
    def test_returns_none_for_none_input(self):
        assert row_to_dict(None) is None

    def test_converts_uuid_fields_to_strings(self):
        uid = uuid4()
        result = row_to_dict({"id": uid, "name": "test"})
        assert result["id"] == str(uid)
        assert result["name"] == "test"

    def test_parses_jsonb_string_to_dict(self):
        """#50: JSONB fields returned as strings should be parsed."""
        result = row_to_dict({
            "id": uuid4(),
            "location": '{"lat": 40.7, "lng": -74.0, "displayName": "New York"}',
            "config": '{"key": "value"}',
        })
        assert isinstance(result["location"], dict)
        assert result["location"]["lat"] == 40.7
        assert result["location"]["displayName"] == "New York"
        assert isinstance(result["config"], dict)

    def test_leaves_already_parsed_jsonb_alone(self):
        """If JSONB is already a dict (not a string), don't re-parse."""
        result = row_to_dict({
            "id": uuid4(),
            "location": {"lat": 40.7, "lng": -74.0},
        })
        assert isinstance(result["location"], dict)
        assert result["location"]["lat"] == 40.7

    def test_handles_invalid_json_string_gracefully(self):
        """Non-JSON strings in JSONB fields should be left as-is."""
        result = row_to_dict({
            "id": uuid4(),
            "config": "not-valid-json",
        })
        assert result["config"] == "not-valid-json"

    def test_converts_datetime_to_iso_string(self):
        """Datetime objects should be converted to ISO strings."""
        dt = datetime(2026, 4, 1, 10, 30, 0)
        result = row_to_dict({"id": uuid4(), "created_at": dt})
        assert result["created_at"] == "2026-04-01T10:30:00"

    def test_converts_date_to_iso_string(self):
        """Date objects should be converted to ISO strings."""
        d = date(2026, 4, 1)
        result = row_to_dict({"id": uuid4(), "event_date": d})
        assert result["event_date"] == "2026-04-01"

    def test_custom_uuid_fields(self):
        """Custom uuid_fields parameter should be respected; unlisted UUIDs stay as-is."""
        uid = uuid4()
        aid = uuid4()
        sid = uuid4()
        result = row_to_dict(
            {"id": uid, "article_id": aid, "scout_id": sid, "name": "test"},
            uuid_fields=("id", "article_id"),
        )
        assert result["id"] == str(uid)
        assert result["article_id"] == str(aid)
        assert result["scout_id"] == sid

    def test_non_jsonb_strings_left_alone(self):
        """String fields not in _JSONB_FIELDS should not be parsed."""
        result = row_to_dict({
            "id": uuid4(),
            "name": '{"looks": "like json"}',
        })
        # name is not a JSONB field, should stay as string
        assert result["name"] == '{"looks": "like json"}'
