"""Unit tests for snapshot payload assembly (PAGE-ARCHIVE-PRD U1)."""

import base64
import hashlib
from types import SimpleNamespace

from app import snapshots
from app.snapshots import (
    MAX_ARTIFACT_BYTES,
    MAX_COMBINED_BYTES,
    PNG_MAGIC,
    build_snapshot_payload,
    scrape_fuse_seconds,
)


def result_with(mhtml=None, screenshot=None) -> SimpleNamespace:
    return SimpleNamespace(mhtml=mhtml, screenshot=screenshot)


PNG_BYTES = b"\x89PNG\r\n\x1a\nfakepixels"
PNG_B64 = base64.b64encode(PNG_BYTES).decode("ascii")
MHTML_TEXT = "MIME-Version: 1.0\nContent-Type: multipart/related\n\nbody"


def test_happy_path_hashes_cover_exact_bytes():
    payload, err = build_snapshot_payload(result_with(MHTML_TEXT, PNG_B64))
    assert err is None
    assert payload is not None
    mhtml_bytes = base64.b64decode(payload["mhtml_b64"])
    assert mhtml_bytes == MHTML_TEXT.encode("utf-8")
    assert payload["mhtml_sha256"] == hashlib.sha256(mhtml_bytes).hexdigest()
    assert payload["screenshot_sha256"] == hashlib.sha256(PNG_BYTES).hexdigest()
    assert payload["sizes"] == {
        "mhtml": len(mhtml_bytes),
        "screenshot": len(PNG_BYTES),
    }


def test_screenshot_base64_passes_through_verbatim():
    # Decision 9: the exact base64 the renderer produced ships unmodified —
    # no re-encode may sit between render and seal.
    payload, _ = build_snapshot_payload(result_with(MHTML_TEXT, PNG_B64))
    assert payload["screenshot_b64"] is PNG_B64


def test_screenshot_bytes_are_tolerated():
    payload, err = build_snapshot_payload(result_with(MHTML_TEXT, PNG_BYTES))
    assert err is None
    assert base64.b64decode(payload["screenshot_b64"]) == PNG_BYTES
    assert payload["screenshot_sha256"] == hashlib.sha256(PNG_BYTES).hexdigest()


def test_missing_artifacts_report_which_side():
    payload, err = build_snapshot_payload(result_with(None, PNG_B64))
    assert payload is None
    assert err == "capture_incomplete:mhtml=missing,screenshot=present"
    payload, err = build_snapshot_payload(result_with(MHTML_TEXT, None))
    assert payload is None
    assert err == "capture_incomplete:mhtml=present,screenshot=missing"
    # a result with neither attribute at all (non-snapshot CrawlResult)
    payload, err = build_snapshot_payload(SimpleNamespace())
    assert payload is None
    assert err.startswith("capture_incomplete")


def test_invalid_screenshot_base64_is_reported_not_raised():
    payload, err = build_snapshot_payload(result_with(MHTML_TEXT, "not!!base64@@"))
    assert payload is None
    assert err == "screenshot_decode_failed"


def test_per_artifact_cap_enforced_pre_encode():
    big_mhtml = "x" * (MAX_ARTIFACT_BYTES + 1)
    payload, err = build_snapshot_payload(result_with(big_mhtml, PNG_B64))
    assert payload is None
    assert err.startswith("artifact_too_large:mhtml:")

    # Beyond the decode ceiling the screenshot is rejected without decoding.
    big_png = base64.b64encode(
        b"p" * (snapshots.SCREENSHOT_DECODE_CEILING_BYTES + 1)
    ).decode("ascii")
    payload, err = build_snapshot_payload(result_with(MHTML_TEXT, big_png))
    assert payload is None
    assert err.startswith("artifact_too_large:screenshot:")


def test_combined_cap_enforced():
    # Each artifact under the per-artifact cap; together over the combined cap.
    half = (MAX_COMBINED_BYTES // 2) + 1
    assert half <= MAX_ARTIFACT_BYTES
    mhtml = "m" * half
    png = base64.b64encode(PNG_MAGIC + b"p" * half).decode("ascii")
    payload, err = build_snapshot_payload(result_with(mhtml, png))
    assert payload is None
    # The screenshot budget is the combined cap minus the MHTML; a screenshot
    # that cannot be re-encoded under it is reported as too large.
    assert err == f"artifact_too_large:screenshot:{len(PNG_MAGIC) + half}"


def test_screenshot_error_card_is_rejected_not_sealed():
    # crawl4ai never fails a screenshot loudly: capture errors return a black
    # JPEG error card. Sealing that with a valid hash would present a fake
    # artifact as evidence — the payload requires PNG magic.
    jpeg_card = base64.b64encode(b"\xff\xd8\xff\xe0fake-jpeg-error-card").decode("ascii")
    payload, err = build_snapshot_payload(result_with(MHTML_TEXT, jpeg_card))
    assert payload is None
    assert err == "screenshot_not_png:ffd8ffe0"


def test_multibyte_mhtml_hits_post_encode_cap():
    # chars pass the cheap pre-guard, utf-8 bytes exceed the cap.
    over = (MAX_ARTIFACT_BYTES // 2) + 1
    payload, err = build_snapshot_payload(result_with("\u00e9" * over, PNG_B64))
    assert payload is None
    assert err == f"artifact_too_large:mhtml:{over * 2}"


def _png(width: int, height: int) -> bytes:
    import io

    from PIL import Image

    image = Image.new("RGB", (width, height))
    pixels = image.load()
    for x in range(width):
        for y in range(height):
            pixels[x, y] = ((x * 7) % 256, (y * 13) % 256, (x * y) % 256)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_over_budget_screenshot_is_re_encoded_not_dropped(monkeypatch):
    png = _png(160, 120)
    monkeypatch.setattr(snapshots, "MAX_ARTIFACT_BYTES", len(png) - 1)
    monkeypatch.setattr(snapshots, "MAX_COMBINED_BYTES", len(png) * 2)
    payload, err = build_snapshot_payload(result_with(MHTML_TEXT, png))
    assert err is None
    shrunk = base64.b64decode(payload["screenshot_b64"])
    assert shrunk[: len(PNG_MAGIC)] == PNG_MAGIC
    assert len(shrunk) < len(png)
    assert payload["sizes"]["screenshot"] == len(shrunk)
    assert payload["screenshot_sha256"] == hashlib.sha256(shrunk).hexdigest()
    encoding = payload["screenshot_encoding"]
    assert encoding["palette_colors"] == 256
    assert encoding["original_bytes"] == len(png)
    assert encoding["original_size"] == [160, 120]
    assert encoding["scale"] in snapshots.SCREENSHOT_SHRINK_SCALES


def test_screenshot_budget_respects_combined_cap(monkeypatch):
    png = _png(160, 120)
    monkeypatch.setattr(snapshots, "MAX_ARTIFACT_BYTES", len(png) * 4)
    monkeypatch.setattr(snapshots, "MAX_COMBINED_BYTES", len(png) + len(MHTML_TEXT) - 1)
    payload, err = build_snapshot_payload(result_with(MHTML_TEXT, png))
    assert err is None
    assert payload["sizes"]["mhtml"] + payload["sizes"]["screenshot"] <= (
        snapshots.MAX_COMBINED_BYTES
    )


def test_screenshot_that_cannot_shrink_enough_is_reported(monkeypatch):
    png = _png(160, 120)
    monkeypatch.setattr(snapshots, "MAX_ARTIFACT_BYTES", 64)
    monkeypatch.setattr(snapshots, "MAX_COMBINED_BYTES", 64 + len(MHTML_TEXT))
    payload, err = build_snapshot_payload(result_with(MHTML_TEXT, png))
    assert payload is None
    assert err == f"artifact_too_large:screenshot:{len(png)}"


def test_oversized_screenshot_bytes_hit_post_check():
    # bytes input skips the base64 estimate guard; the post-materialization
    # check must still catch it.
    big = PNG_MAGIC + b"p" * MAX_ARTIFACT_BYTES
    payload, err = build_snapshot_payload(result_with(MHTML_TEXT, big))
    assert payload is None
    assert err == f"artifact_too_large:screenshot:{len(big)}"


def test_scrape_fuse_budgets_snapshot_phases():
    assert scrape_fuse_seconds(25_000, snapshot=False) == 30.0
    assert scrape_fuse_seconds(25_000, snapshot=True) == 70.0
    assert scrape_fuse_seconds(60_000, snapshot=True) == 140.0
