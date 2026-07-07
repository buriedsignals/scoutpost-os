"""Snapshot payload assembly (PAGE-ARCHIVE-PRD U1, KTD1/KTD2).

The capture fetch returns its artifacts INLINE — the service keeps zero
snapshot state (no tmp files, no pickup endpoint, no sweeper), which is what
lets it scale horizontally (KTD2 / Decision 8). Hashes are computed over the
exact bytes the Edge Function will verify and store (hash-before-store, R2).

Screenshot integrity: crawl4ai's screenshot helpers never fail loudly — on
capture errors they return a black JPEG "error card" with the exception text
drawn on it. Sealing that with a valid SHA-256 would present a fake artifact
as evidence, so the payload REQUIRES PNG magic bytes (both genuine capture
paths produce a PNG container; the error card is JPEG) and degrades with a
structured error otherwise. Fidelity note (Decision 9, as amended): for
scrollable pages crawl4ai's full-page compositor internally stitches
JPEG-q85 segments into the final PNG — the hash covers exactly the stored
bytes, and the compositor's behavior is disclosed in the runbook and feature
docs; MHTML remains the primary fidelity artifact.

Caps are enforced with cheap pre-checks BEFORE materializing multi-MB
buffers (R8): 25 MB per artifact, 30 MB combined. An over-cap or incomplete
capture never fails the scrape — the payload is omitted and a structured
`snapshot_error` string is returned instead, so change detection proceeds
and the run degrades to a markdown_only record (KTD9).
"""

import base64
import binascii
import hashlib

MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
MAX_COMBINED_BYTES = 30 * 1024 * 1024

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_snapshot_payload(result) -> tuple[dict | None, str | None]:
    """Assemble the inline snapshot payload from a CrawlResult.

    Returns (payload, None) on success, (None, snapshot_error) on any
    incomplete/over-cap/non-genuine capture. Never raises for capture
    problems — the scrape response must still carry the markdown either way.
    """
    mhtml_text = getattr(result, "mhtml", None)
    screenshot_raw = getattr(result, "screenshot", None)
    if not mhtml_text or not screenshot_raw:
        return None, (
            "capture_incomplete:mhtml="
            + ("present" if mhtml_text else "missing")
            + ",screenshot="
            + ("present" if screenshot_raw else "missing")
        )

    # Pre-materialization size guards (R8): utf-8 encodes to >= 1 byte per
    # character, and base64 decodes to ~3/4 of its length — both bound the
    # artifact size from below WITHOUT allocating multi-MB buffers first.
    if len(mhtml_text) > MAX_ARTIFACT_BYTES:
        return None, f"artifact_too_large:mhtml:{len(mhtml_text)}"
    if not isinstance(screenshot_raw, (bytes, bytearray)):
        estimated = (len(screenshot_raw) * 3) // 4
        if estimated > MAX_ARTIFACT_BYTES:
            return None, f"artifact_too_large:screenshot:{estimated}"

    mhtml_bytes = mhtml_text.encode("utf-8")
    # crawl4ai returns the screenshot as a base64 string; tolerate raw bytes
    # from future versions. Either way the hash covers the decoded PNG bytes —
    # exactly what the Edge Function decodes, verifies, and stores.
    if isinstance(screenshot_raw, (bytes, bytearray)):
        screenshot_bytes = bytes(screenshot_raw)
        screenshot_b64 = base64.b64encode(screenshot_bytes).decode("ascii")
    else:
        try:
            screenshot_bytes = base64.b64decode(screenshot_raw, validate=True)
        except (binascii.Error, ValueError):
            return None, "screenshot_decode_failed"
        screenshot_b64 = screenshot_raw

    if screenshot_bytes[: len(PNG_MAGIC)] != PNG_MAGIC:
        # Almost certainly crawl4ai's JPEG error card — a capture failure
        # dressed as success. Never seal it as evidence.
        return None, "screenshot_not_png:" + screenshot_bytes[:4].hex()

    for label, size in (
        ("mhtml", len(mhtml_bytes)),
        ("screenshot", len(screenshot_bytes)),
    ):
        if size > MAX_ARTIFACT_BYTES:
            return None, f"artifact_too_large:{label}:{size}"
    combined = len(mhtml_bytes) + len(screenshot_bytes)
    if combined > MAX_COMBINED_BYTES:
        return None, f"payload_too_large:combined:{combined}"

    return {
        "mhtml_b64": base64.b64encode(mhtml_bytes).decode("ascii"),
        "mhtml_sha256": _sha256_hex(mhtml_bytes),
        "screenshot_b64": screenshot_b64,
        "screenshot_sha256": _sha256_hex(screenshot_bytes),
        "sizes": {"mhtml": len(mhtml_bytes), "screenshot": len(screenshot_bytes)},
    }, None


def scrape_fuse_seconds(timeout_ms: int, snapshot: bool) -> float:
    """Outer wait_for budget for a scrape request.

    Snapshot fetches run extra phases crawl4ai times SEPARATELY from the
    page_timeout: the full-page scan runs under its own wait_for bounded by
    another page_timeout, MHTML capture adds ~11s of fixed readiness waits,
    and the screenshot compositor scrolls and stitches. Budgeting only
    timeout+5s would 504 heavy captures and lose the markdown with them —
    the exact 'capture failure kills the scrape' outcome U1 forbids.
    """
    if snapshot:
        return (timeout_ms * 2) / 1000 + 20
    return timeout_ms / 1000 + 5
