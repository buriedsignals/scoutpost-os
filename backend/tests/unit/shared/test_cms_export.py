"""Tests for UpdatePreferencesRequest CMS URL validation (routers/user.py)."""

import pytest
from pydantic import ValidationError


# ===========================================================================
# CMS URL Validation in UpdatePreferencesRequest
# ===========================================================================

class TestCmsUrlValidation:
    """Tests for cms_api_url field validator in UpdatePreferencesRequest."""

    def test_valid_https_url(self):
        from app.routers.user import UpdatePreferencesRequest
        req = UpdatePreferencesRequest(cms_api_url="https://my-cms.com/api/import")
        assert req.cms_api_url == "https://my-cms.com/api/import"

    def test_rejects_http_url(self):
        from app.routers.user import UpdatePreferencesRequest
        with pytest.raises(ValidationError, match="HTTPS"):
            UpdatePreferencesRequest(cms_api_url="http://my-cms.com/api/import")

    def test_rejects_private_ip(self):
        from app.routers.user import UpdatePreferencesRequest
        with pytest.raises(ValidationError, match="private"):
            UpdatePreferencesRequest(cms_api_url="https://192.168.1.1/api")

    def test_rejects_loopback_ip(self):
        from app.routers.user import UpdatePreferencesRequest
        with pytest.raises(ValidationError, match="private"):
            UpdatePreferencesRequest(cms_api_url="https://127.0.0.1/api")

    def test_rejects_link_local_ip(self):
        from app.routers.user import UpdatePreferencesRequest
        with pytest.raises(ValidationError, match="private"):
            UpdatePreferencesRequest(cms_api_url="https://169.254.1.1/api")

    def test_allows_hostname(self):
        """Non-IP hostnames should pass (DNS resolution is not checked at validation time)."""
        from app.routers.user import UpdatePreferencesRequest
        req = UpdatePreferencesRequest(cms_api_url="https://cms.newsroom.com/api/v2")
        assert req.cms_api_url == "https://cms.newsroom.com/api/v2"

    def test_none_passes_through(self):
        from app.routers.user import UpdatePreferencesRequest
        req = UpdatePreferencesRequest(preferred_language="en")
        assert req.cms_api_url is None

    def test_empty_string_clears_url(self):
        from app.routers.user import UpdatePreferencesRequest
        req = UpdatePreferencesRequest(cms_api_url="")
        assert req.cms_api_url == ""

    def test_whitespace_trimmed(self):
        from app.routers.user import UpdatePreferencesRequest
        req = UpdatePreferencesRequest(cms_api_url="  https://cms.example.com/api  ")
        assert req.cms_api_url == "https://cms.example.com/api"

    def test_rejects_no_hostname(self):
        from app.routers.user import UpdatePreferencesRequest
        with pytest.raises(ValidationError, match="hostname"):
            UpdatePreferencesRequest(cms_api_url="https://")
