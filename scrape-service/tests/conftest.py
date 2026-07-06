from types import SimpleNamespace

import httpx
import pytest

from app import pdfparse
from app.config import Settings
from app.main import create_app


@pytest.fixture(autouse=True)
def public_dns(monkeypatch):
    """Mock-transport hosts (council.example) don't resolve; pretend every
    host resolves publicly. Tests for the SSRF guard override this."""
    monkeypatch.setattr(
        pdfparse.socket,
        "getaddrinfo",
        lambda host, port: [(2, 1, 6, "", ("93.184.216.34", 0))],
    )


def build_pdf(text_lines: list[str]) -> bytes:
    """Build a minimal but structurally valid single-page PDF (correct xref),
    so pdftotext parses it without repair heuristics. Empty text_lines yields
    a page with no text operators — the density-guard fixture."""
    content_parts = ["BT /F1 12 Tf 72 720 Td 14 TL"]
    for line in text_lines:
        escaped = line.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        content_parts.append(f"({escaped}) Tj T*")
    content_parts.append("ET")
    content = " ".join(content_parts).encode("latin-1")

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            + b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"
        ),
        b"<< /Length " + str(len(content)).encode() + b" >>stream\n" + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_pos = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_pos}\n%%EOF\n"
    ).encode()
    return bytes(out)


TEXT_PDF = build_pdf(
    [f"Council meeting minutes, agenda item {i}: budget commitment recorded." for i in range(1, 9)]
)
EMPTY_PDF = build_pdf([])


class FakeScraper:
    """Stands in for app.scraper.Scraper; returns canned CrawlResult-shaped objects."""

    def __init__(self, result=None, exc=None) -> None:
        self.result = result
        self.exc = exc
        self.calls: list[tuple[str, int]] = []

    @property
    def warm(self) -> bool:
        return True

    async def run(self, url: str, timeout_ms: int):
        self.calls.append((url, timeout_ms))
        if self.exc is not None:
            raise self.exc
        return self.result

    async def close(self) -> None:
        pass


def crawl_result(**overrides) -> SimpleNamespace:
    base = dict(
        success=True,
        url="https://example.org/final",
        html="<html><body>raw</body></html>",
        cleaned_html="<body>clean</body>",
        markdown=SimpleNamespace(raw_markdown="# Heading\n\nBody text."),
        metadata={"title": "Example Page", "sourceURL": "https://example.org/final"},
        status_code=200,
        error_message=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


TEST_TOKEN = "test-token-123"


def make_settings(**overrides) -> Settings:
    base = dict(
        token=TEST_TOKEN,
        allow_anon=False,
        browser_pool_size=2,
        default_scrape_timeout_ms=25_000,
        parse_download_timeout_s=5.0,
        parse_max_pdf_bytes=50 * 1024 * 1024,
        parse_min_chars_per_page=100,
        gemini_api_key=None,
        gemini_model="gemini-2.5-flash-lite",
        gemini_timeout_s=90.0,
    )
    base.update(overrides)
    return Settings(**base)


@pytest.fixture
def app():
    return create_app(make_settings())


def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {TEST_TOKEN}"}


def mock_http_client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))
