"""Narrow client for the crawler-worker control boundary and signed uploads."""

import base64
import binascii
import gzip
import hashlib
import json
import os
import uuid
from typing import Any

import httpx

MiB = 1024 * 1024
COMPRESSED_ARTIFACT_MAX = 50 * MiB
RESULT_JSON_DECODED_MAX = 16 * MiB
SNAPSHOT_ARTIFACT_DECODED_MAX = 25 * MiB
SNAPSHOT_COMBINED_DECODED_MAX = 30 * MiB


class SignedUploadError(RuntimeError):
    pass


class ArtifactLimitError(RuntimeError):
    pass


class CallbackTimeoutError(RuntimeError):
    pass


class WorkflowClient:
    def __init__(self, proxy_url: str) -> None:
        self.base = os.environ["WORKFLOW_WORKER_URL"]
        token = os.environ["WORKFLOW_WORKER_TOKEN"]
        self.execution_id = str(uuid.uuid4())
        self.control_http = httpx.AsyncClient(
            timeout=60,
            headers={"authorization": f"Bearer {token}"},
            proxy=proxy_url,
        )
        # This client intentionally has no default Authorization header.
        self.upload_http = httpx.AsyncClient(timeout=120, proxy=proxy_url)

    async def claim(self, batch_id: str) -> list[dict[str, Any]]:
        response = await self.control_http.post(
            self.base,
            json={
                "action": "claim",
                "batch_id": batch_id,
                "execution_id": self.execution_id,
            },
        )
        response.raise_for_status()
        jobs = response.json().get("jobs")
        if not isinstance(jobs, list) or len(jobs) > 20:
            raise RuntimeError("invalid crawler claim response")
        return jobs

    async def _upload(
        self, target: dict[str, str], body: bytes, content_type: str
    ) -> dict[str, int | str]:
        if not body or len(body) > COMPRESSED_ARTIFACT_MAX:
            raise ArtifactLimitError("compressed artifact outside limit")
        try:
            response = await self.upload_http.put(
                target["url"], content=body, headers={"content-type": content_type}
            )
        except (httpx.HTTPError, KeyError):
            # HTTPX exceptions can include the full signed query string.
            raise SignedUploadError("signed_upload_transport") from None
        if response.status_code not in (200, 201, 204):
            status = response.status_code
            await response.aclose()
            raise SignedUploadError(f"signed_upload_http_{status}")
        return {"sha256": hashlib.sha256(body).hexdigest(), "bytes": len(body)}

    async def upload(
        self, job: dict[str, Any], result: dict[str, Any]
    ) -> dict[str, Any]:
        document = dict(result)
        raw_snapshot = document.get("snapshot")
        snapshot = dict(raw_snapshot or {})
        try:
            mhtml = (
                base64.b64decode(snapshot.pop("mhtml_b64"), validate=True)
                if "mhtml_b64" in snapshot
                else None
            )
            screenshot = (
                base64.b64decode(snapshot.pop("screenshot_b64"), validate=True)
                if "screenshot_b64" in snapshot
                else None
            )
        except (binascii.Error, ValueError):
            raise ArtifactLimitError("invalid snapshot encoding") from None
        if raw_snapshot is not None:
            document["snapshot"] = snapshot

        if mhtml is not None and len(mhtml) > SNAPSHOT_ARTIFACT_DECODED_MAX:
            raise ArtifactLimitError("MHTML artifact outside limit")
        if screenshot is not None and len(screenshot) > SNAPSHOT_ARTIFACT_DECODED_MAX:
            raise ArtifactLimitError("screenshot artifact outside limit")
        if len(mhtml or b"") + len(screenshot or b"") > SNAPSHOT_COMBINED_DECODED_MAX:
            raise ArtifactLimitError("snapshot bundle outside limit")
        if screenshot is not None and not screenshot.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ArtifactLimitError("screenshot is not PNG")

        raw_result = json.dumps(document, separators=(",", ":")).encode()
        if len(raw_result) > RESULT_JSON_DECODED_MAX:
            raise ArtifactLimitError("result JSON outside limit")
        body = gzip.compress(raw_result, 6)
        artifacts = [
            {
                "kind": "result",
                **await self._upload(
                    job["uploads"]["result"], body, "application/gzip"
                ),
            }
        ]
        if mhtml is not None:
            artifacts.append(
                {
                    "kind": "mhtml",
                    **await self._upload(
                        job["uploads"]["mhtml"],
                        gzip.compress(mhtml, 6),
                        "application/gzip",
                    ),
                }
            )
        if screenshot is not None:
            artifacts.append(
                {
                    "kind": "screenshot",
                    **await self._upload(
                        job["uploads"]["screenshot"], screenshot, "image/png"
                    ),
                }
            )
        return {
            "job_id": job["id"],
            "attempt_id": job["attempt_id"],
            "execution_id": job["execution_id"],
            "ok": True,
            "artifacts": artifacts,
        }

    async def complete(
        self,
        batch_id: str,
        result: dict[str, Any],
        *,
        response_delay_ms: int = 0,
        timeout_seconds: float | None = None,
    ) -> None:
        body = {"action": "complete", "batch_id": batch_id, "results": [result]}
        if response_delay_ms:
            body["response_delay_ms"] = response_delay_ms
        try:
            response = await self.control_http.post(
                self.base,
                json=body,
                timeout=timeout_seconds,
            )
        except httpx.TimeoutException:
            raise CallbackTimeoutError("crawler_callback_timeout") from None
        response.raise_for_status()

    async def close(self) -> None:
        await self.control_http.aclose()
        await self.upload_http.aclose()
