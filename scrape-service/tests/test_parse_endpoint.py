import httpx
import pytest
from fastapi.testclient import TestClient

from app import pdfparse
from tests.conftest import EMPTY_PDF, TEXT_PDF, auth_headers, mock_http_client


def pdf_handler(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path == "/minutes.pdf":
        return httpx.Response(200, content=TEXT_PDF)
    if path == "/scanned.pdf":
        return httpx.Response(200, content=EMPTY_PDF)
    if path == "/page.html":
        return httpx.Response(200, content=b"<html>not a pdf</html>")
    if path == "/gone.pdf":
        return httpx.Response(404, content=b"not found")
    if path == "/redir-ok.pdf":
        # Redirect to another PDF on the same public host — must be FOLLOWED.
        return httpx.Response(302, headers={"location": "https://council.example/minutes.pdf"})
    if path == "/redir-file.pdf":
        # Redirect to a non-http(s) scheme — must be BLOCKED (SSRF vector).
        return httpx.Response(302, headers={"location": "file:///etc/passwd"})
    if path == "/redir-metadata.pdf":
        # Redirect to the cloud metadata endpoint — must be BLOCKED per hop.
        return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data/"})
    if path == "/loop.pdf":
        # Endless self-redirect — must terminate at the hop cap with a 502.
        return httpx.Response(302, headers={"location": "https://council.example/loop.pdf"})
    if path == "/refused.pdf":
        raise httpx.ConnectError("connection refused")
    raise httpx.ConnectTimeout("connect timed out")


@pytest.fixture
def client(app):
    app.state.http_client = mock_http_client(pdf_handler)
    return TestClient(app)


def test_parse_happy_path(client):
    res = client.post(
        "/parse", json={"url": "https://council.example/minutes.pdf"}, headers=auth_headers()
    )
    assert res.status_code == 200
    body = res.json()
    assert "Council meeting minutes" in body["markdown"]
    assert "budget commitment" in body["markdown"]
    assert body["pages"] == 1
    assert body["chars"] > 100
    assert body["parser"] == "pdftotext"
    assert body["source_url"] == "https://council.example/minutes.pdf"


def test_parse_is_deterministic(client):
    # civic dedup keys on content_sha256 — two parses must be byte-identical
    a = client.post(
        "/parse", json={"url": "https://council.example/minutes.pdf"}, headers=auth_headers()
    ).json()["markdown"]
    b = client.post(
        "/parse", json={"url": "https://council.example/minutes.pdf"}, headers=auth_headers()
    ).json()["markdown"]
    assert a == b


def test_parse_density_guard_flags_textless_pdf(client):
    res = client.post(
        "/parse", json={"url": "https://council.example/scanned.pdf"}, headers=auth_headers()
    )
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert detail["error"] == "needs_ocr"
    assert detail["pages"] == 1
    assert detail["chars"] < 100


def test_parse_rejects_non_pdf(client):
    res = client.post(
        "/parse", json={"url": "https://council.example/page.html"}, headers=auth_headers()
    )
    assert res.status_code == 415
    assert res.json()["detail"]["error"] == "not_a_pdf"


def test_parse_upstream_404_maps_to_502(client):
    res = client.post(
        "/parse", json={"url": "https://council.example/gone.pdf"}, headers=auth_headers()
    )
    assert res.status_code == 502
    assert "HTTP 404" in res.json()["detail"]


def test_parse_download_timeout_maps_to_504(client):
    # timeouts are transient in the adapter taxonomy → 504
    res = client.post(
        "/parse", json={"url": "https://council.example/other.pdf"}, headers=auth_headers()
    )
    assert res.status_code == 504
    assert "download timed out" in res.json()["detail"]


def test_parse_connection_error_maps_to_502(client):
    res = client.post(
        "/parse", json={"url": "https://council.example/refused.pdf"}, headers=auth_headers()
    )
    assert res.status_code == 502
    assert "connection refused" in res.json()["detail"]


# ---- OpenRouter/Google Vertex native-PDF fallback --------------------------

def openrouter_handler(
    openrouter_status=200,
    openrouter_text="# Transcribed\n\nScanned page text.",
):
    """Mock transport answering both the PDF download and OpenRouter."""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "openrouter.ai":
            if openrouter_status >= 400:
                return httpx.Response(openrouter_status, json={"error": "boom"})
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {"content": openrouter_text},
                            "finish_reason": "stop",
                        }
                    ]
                },
            )
        # the scanned PDF: valid PDF, no extractable text
        return httpx.Response(200, content=EMPTY_PDF)
    return handler


def test_parse_openrouter_native_fallback_on_scanned_pdf(app):
    from app.main import create_app
    from tests.conftest import make_settings

    app = create_app(make_settings(openrouter_api_key="or-key"))
    app.state.http_client = mock_http_client(openrouter_handler())
    res = TestClient(app).post(
        "/parse", json={"url": "https://council.example/scanned.pdf"}, headers=auth_headers()
    )
    assert res.status_code == 200
    body = res.json()
    assert body["parser"] == "openrouter"
    assert "Transcribed" in body["markdown"]


def test_parse_keeps_pdftotext_primary_when_openrouter_key_present():
    from app.main import create_app
    from tests.conftest import make_settings

    def text_pdf_only(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "council.example"
        return httpx.Response(200, content=TEXT_PDF)

    app = create_app(make_settings(openrouter_api_key="or-key"))
    app.state.http_client = mock_http_client(text_pdf_only)
    res = TestClient(app).post(
        "/parse", json={"url": "https://council.example/minutes.pdf"}, headers=auth_headers()
    )
    assert res.status_code == 200
    assert res.json()["parser"] == "pdftotext"


def test_parse_openrouter_fallback_failure_maps_to_502(app):
    from app.main import create_app
    from tests.conftest import make_settings

    app = create_app(make_settings(openrouter_api_key="or-key"))
    app.state.http_client = mock_http_client(
        openrouter_handler(openrouter_status=500)
    )
    res = TestClient(app).post(
        "/parse", json={"url": "https://council.example/scanned.pdf"}, headers=auth_headers()
    )
    assert res.status_code == 502
    assert "openrouter transcribe failed" in res.json()["detail"]


def test_parse_scanned_still_422_without_openrouter_key(client):
    # Default client has no OpenRouter key, so the density guard remains 422.
    res = client.post(
        "/parse", json={"url": "https://council.example/scanned.pdf"}, headers=auth_headers()
    )
    assert res.status_code == 422
    assert res.json()["detail"]["error"] == "needs_ocr"


def test_parse_size_cap_streams_and_aborts():
    from app.main import create_app
    from tests.conftest import make_settings

    def big_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"%PDF" + b"0" * 2048)

    app = create_app(make_settings(parse_max_pdf_bytes=1024))
    app.state.http_client = mock_http_client(big_handler)
    res = TestClient(app).post(
        "/parse", json={"url": "https://council.example/huge.pdf"}, headers=auth_headers()
    )
    assert res.status_code == 413
    assert res.json()["detail"]["error"] == "pdf_too_large"


def test_parse_rejects_non_http_scheme(app):
    res = TestClient(app).post(
        "/parse", json={"url": "file:///etc/passwd"}, headers=auth_headers()
    )
    assert res.status_code == 422


async def test_run_pdftotext_timeout(monkeypatch):
    with pytest.raises(pdfparse.PdfTimeoutError, match="timed out"):
        await pdfparse.run_pdftotext(TEXT_PDF, timeout_s=0.0001)


async def test_run_pdftotext_bad_input_exits_nonzero():
    # pdftotext -q on garbage: poppler exits 1 with empty output
    with pytest.raises(pdfparse.PdfDownloadError, match="pdftotext exited"):
        await pdfparse.run_pdftotext(b"%PDF-1.4 garbage without structure")


def test_count_pages_from_text():
    # pdftotext emits one \f per page — the correct denominator even for
    # PDF 1.5+ compressed object streams where byte-scans find nothing.
    assert pdfparse.count_pages_from_text("no form feeds") == 1
    assert pdfparse.count_pages_from_text("page one\fpage two\f") == 2
    assert pdfparse.count_pages_from_text("") == 1


def test_parse_blocks_private_addresses(client, monkeypatch):
    monkeypatch.setattr(
        pdfparse.socket,
        "getaddrinfo",
        lambda host, port: [(2, 1, 6, "", ("127.0.0.1", 0))],
    )
    res = client.post(
        "/parse", json={"url": "https://internal.example/x.pdf"}, headers=auth_headers()
    )
    assert res.status_code == 422
    assert res.json()["detail"]["error"] == "private_address"


def test_parse_follows_public_redirect(client):
    # A 30x to another public PDF is followed (regression: manual redirect
    # handling must not break legitimate redirects).
    res = client.post(
        "/parse", json={"url": "https://council.example/redir-ok.pdf"}, headers=auth_headers()
    )
    assert res.status_code == 200
    assert "Council meeting minutes" in res.json()["markdown"]


def test_parse_blocks_ssrf_via_redirect_to_metadata(app, monkeypatch):
    # A public URL that 302s to the cloud metadata IP must be blocked at the
    # REDIRECT TARGET — the initial-host guard alone would miss it.
    def resolve(host, port):
        if host == "169.254.169.254":
            return [(2, 1, 6, "", ("169.254.169.254", 0))]  # link-local
        return [(2, 1, 6, "", ("93.184.216.34", 0))]  # public

    monkeypatch.setattr(pdfparse.socket, "getaddrinfo", resolve)
    app.state.http_client = mock_http_client(pdf_handler)
    res = TestClient(app).post(
        "/parse", json={"url": "https://council.example/redir-metadata.pdf"}, headers=auth_headers()
    )
    assert res.status_code == 422
    assert res.json()["detail"]["error"] == "private_address"


def test_parse_blocks_non_http_redirect(client):
    # A 302 to file:// (or any non-http(s) scheme) is an SSRF vector → blocked.
    res = client.post(
        "/parse", json={"url": "https://council.example/redir-file.pdf"}, headers=auth_headers()
    )
    assert res.status_code == 422
    assert res.json()["detail"]["error"] == "private_address"


def test_parse_redirect_loop_maps_to_502(client):
    res = client.post(
        "/parse", json={"url": "https://council.example/loop.pdf"}, headers=auth_headers()
    )
    assert res.status_code == 502
    assert "redirects" in res.json()["detail"]


def test_parse_redirect_without_location_maps_to_502(app):
    # A 302 with no Location header is malformed — surface a clear 502, don't
    # try to read a body from it.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, content=b"")

    app.state.http_client = mock_http_client(handler)
    res = TestClient(app).post(
        "/parse", json={"url": "https://council.example/bad-redir.pdf"}, headers=auth_headers()
    )
    assert res.status_code == 502
    assert "redirect without Location" in res.json()["detail"]


async def test_parse_pdf_url_skips_openrouter_when_over_inline_limit():
    # A scanned PDF larger than the proven inline limit must not be sent to
    # OpenRouter; it surfaces needs_ocr without selecting another PDF parser.
    called = False

    async def transcribe(pdf_bytes: bytes) -> str:
        nonlocal called
        called = True
        return "should not be called"

    client = mock_http_client(lambda req: httpx.Response(200, content=EMPTY_PDF))
    with pytest.raises(pdfparse.NeedsOcrError):
        await pdfparse.parse_pdf_url(
            client,
            "https://council.example/scanned.pdf",
            timeout_s=5,
            max_bytes=50 * 1024 * 1024,
            min_chars_per_page=100,
            transcribe=transcribe,
            transcribe_max_bytes=1,  # EMPTY_PDF is comfortably larger than 1 byte
        )
    assert called is False


async def test_parse_pdf_url_uses_openrouter_when_under_inline_limit():
    called = False

    async def transcribe(pdf_bytes: bytes) -> str:
        nonlocal called
        called = True
        return "# Transcribed\n\nbody"

    client = mock_http_client(lambda req: httpx.Response(200, content=EMPTY_PDF))
    parsed = await pdfparse.parse_pdf_url(
        client,
        "https://council.example/scanned.pdf",
        timeout_s=5,
        max_bytes=50 * 1024 * 1024,
        min_chars_per_page=100,
        transcribe=transcribe,
        transcribe_max_bytes=50 * 1024 * 1024,
    )
    assert called is True
    assert parsed.parser == "openrouter"


def test_parse_unresolvable_host_maps_to_502(client, monkeypatch):
    def boom(host, port):
        raise OSError("no such host")

    monkeypatch.setattr(pdfparse.socket, "getaddrinfo", boom)
    res = client.post(
        "/parse", json={"url": "https://nowhere.example/x.pdf"}, headers=auth_headers()
    )
    assert res.status_code == 502
    assert "cannot resolve" in res.json()["detail"]


def test_download_client_sends_browser_ua(app):
    # council/document hosts 403 library-default agents (observed on U1 smoke):
    # the contract is simply that create_app's client carries a browser UA.
    assert "Mozilla/5.0" in app.state.http_client.headers.get("user-agent", "")
