from types import SimpleNamespace

from app.mapping import crawl_failure_detail, map_crawl_result
from app import main_content
from tests.conftest import crawl_result


def test_maps_all_fields_per_ktd2():
    mapped = map_crawl_result(crawl_result(), requested_url="https://example.org")
    assert mapped["markdown"] == "# Heading\n\nBody text."
    assert mapped["comparison_markdown"] is None
    assert mapped["comparison_strategy"] == "full"
    assert mapped["comparison_ratio"] == 1.0
    assert mapped["rawHtml"] == "<html><body>raw</body></html>"
    assert mapped["html"] == "<body>clean</body>"
    assert mapped["title"] == "Example Page"
    assert mapped["metadata"]["sourceURL"] == "https://example.org/final"
    assert mapped["requested_url"] == "https://example.org"
    assert mapped["source_url"] == "https://example.org/final"
    assert mapped["status_code"] == 200
    assert "T" in mapped["fetched_at"]  # ISO timestamp


def test_markdown_variants():
    plain = crawl_result(markdown="plain string md")
    assert map_crawl_result(plain, "u")["markdown"] == "plain string md"

    absent = crawl_result(markdown=None)
    assert map_crawl_result(absent, "u")["markdown"] == ""


def test_unknown_markdown_shape_fails_loud():
    # Upstream API drift must surface as an error (→502 at the endpoint),
    # never as repr() garbage flowing into content-hash-keyed dedup.
    import pytest

    odd = crawl_result(markdown=SimpleNamespace(other="x"))
    with pytest.raises(ValueError, match="unexpected crawl markdown shape"):
        map_crawl_result(odd, "u")


def test_never_uses_fit_markdown():
    # The Zermatt lesson: main-content filtering destroyed the page under
    # Firecrawl. raw_markdown must win even when fit_markdown is present.
    md = SimpleNamespace(raw_markdown="full page", fit_markdown="stripped")
    mapped = map_crawl_result(crawl_result(markdown=md), "u")
    assert mapped["markdown"] == "full page"


def test_maps_quality_gated_main_content(monkeypatch):
    body = " ".join(f"policy{index}" for index in range(100))
    monkeypatch.setattr(
        main_content,
        "_convert_with_crawl4ai",
        lambda html, _base_url: html,
    )
    result = crawl_result(
        html=f"<nav>Navigation</nav><main>{body}</main><footer>Submit</footer>",
        markdown=SimpleNamespace(
            raw_markdown=f"Navigation\n\n{body}\n\nSubmit"
        ),
    )

    mapped = map_crawl_result(result, "https://example.org")
    assert mapped["comparison_strategy"] == "main"
    assert "policy99" in mapped["comparison_markdown"]
    assert "Submit" not in mapped["comparison_markdown"]
    # The fixture has 806 alphanumeric characters in the full markdown and
    # 798 in the deterministic serialized <main> projection, rounded to 4dp.
    assert mapped["comparison_ratio"] == 0.9901


def test_missing_metadata_and_url_fall_back():
    result = crawl_result(metadata=None, url=None, status_code=None)
    mapped = map_crawl_result(result, requested_url="https://req.example")
    assert mapped["metadata"] == {}
    assert mapped["title"] is None
    assert mapped["source_url"] == "https://req.example"
    assert mapped["status_code"] is None


def test_non_dict_metadata_is_dropped():
    mapped = map_crawl_result(crawl_result(metadata="weird"), "u")
    assert mapped["metadata"] == {}
    assert mapped["title"] is None


def test_failure_detail_variants():
    assert crawl_failure_detail(crawl_result(status_code=403, error_message="blocked")) == (
        "status 403; blocked"
    )
    assert crawl_failure_detail(crawl_result(status_code=None, error_message="boom")) == "boom"
    assert crawl_failure_detail(crawl_result(status_code=None, error_message=None)) == (
        "crawl failed without detail"
    )
