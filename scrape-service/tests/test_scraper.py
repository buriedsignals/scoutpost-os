import sys
from types import SimpleNamespace

import pytest

from app.scraper import Scraper, _disclosure_js_for_url


class FakeCrawlerRunConfig:
    def __init__(self, **kwargs) -> None:
        self.__dict__.update(kwargs)


class FakeCrawler:
    def __init__(self, result) -> None:
        self.result = result
        self.calls = []

    async def arun(self, *, url, config):
        self.calls.append((url, config))
        return self.result


@pytest.mark.parametrize(
    ("snapshot", "expected_snapshot_flag", "expected_max_scroll_steps"),
    [
        (False, False, None),
        (True, True, 30),
    ],
)
async def test_run_expands_bounded_disclosures_before_capture(
    monkeypatch,
    snapshot,
    expected_snapshot_flag,
    expected_max_scroll_steps,
):
    cache_mode = SimpleNamespace(BYPASS=object())
    monkeypatch.setitem(
        sys.modules,
        "crawl4ai",
        SimpleNamespace(
            CacheMode=cache_mode,
            CrawlerRunConfig=FakeCrawlerRunConfig,
        ),
    )
    expected_result = object()
    crawler = FakeCrawler(expected_result)
    scraper = Scraper(pool_size=1)
    scraper._crawler = crawler

    result = await scraper.run(
        "https://www.tiktok.com/safety/en/policies-and-engagement/",
        timeout_ms=12_345,
        snapshot=snapshot,
    )

    assert result is expected_result
    assert len(crawler.calls) == 1
    url, config = crawler.calls[0]
    assert url == "https://www.tiktok.com/safety/en/policies-and-engagement/"
    assert config.cache_mode is cache_mode.BYPASS
    assert config.page_timeout == 12_345
    assert config.capture_mhtml is expected_snapshot_flag
    assert config.screenshot is expected_snapshot_flag
    assert config.scan_full_page is expected_snapshot_flag
    assert config.max_scroll_steps == expected_max_scroll_steps
    assert 'details:not([open])' in config.js_code
    assert '[data-testid="marcom-web-collapse-panel"] > button' in config.js_code
    assert '[aria-expanded=' not in config.js_code


@pytest.mark.parametrize(
    ("url", "expects_tiktok_script"),
    [
        ("https://tiktok.com/safety", True),
        ("https://www.tiktok.com/safety", True),
        ("https://www.tiktok.com./safety", True),
        ("https://example.com/disclosures", False),
        ("https://tiktok.com.example.org/disclosures", False),
        (r"https://evil.com\@tiktok.com/safety", False),
        ("https://[invalid/disclosures", False),
    ],
)
def test_tiktok_custom_disclosures_are_host_scoped(url, expects_tiktok_script):
    script = _disclosure_js_for_url(url)

    assert 'details:not([open])' in script
    assert (
        '[data-testid="marcom-web-collapse-panel"]' in script
    ) is expects_tiktok_script
    if expects_tiktok_script:
        assert "window.location.hostname" in script
