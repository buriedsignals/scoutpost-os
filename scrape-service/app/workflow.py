"""Production Render Workflow definition for durable crawler batches."""

import asyncio
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from render_sdk import Retry, Workflows

from .config import load_settings
from .crawl_runner import CrawlItem, run_item_safely
from .network_policy import EgressStats, guarded_egress
from .scraper import Scraper
from .workflow_client import (
    ArtifactLimitError,
    CallbackTimeoutError,
    SignedUploadError,
    WorkflowClient,
)

app = Workflows(
    default_plan="standard",
    default_timeout=540,
    # Supabase is the only retry owner. Render must never replay a whole batch.
    default_retry=Retry(max_retries=0, wait_duration_ms=1_000),
)


@asynccontextmanager
async def virtual_display():
    """Start Xvfb inside task execution, after the SDK task server boots."""
    process = await asyncio.create_subprocess_exec(
        "Xvfb",
        "-displayfd",
        "1",
        "-screen",
        "0",
        "1920x1080x24",
        "-ac",
        "-nolisten",
        "tcp",
        stdout=asyncio.subprocess.PIPE,
    )
    assert process.stdout is not None
    display_number = int(
        (await asyncio.wait_for(process.stdout.readline(), timeout=5)).strip()
    )
    previous_display = os.environ.get("DISPLAY")
    os.environ["DISPLAY"] = f":{display_number}"
    try:
        yield
    finally:
        if previous_display is None:
            os.environ.pop("DISPLAY", None)
        else:
            os.environ["DISPLAY"] = previous_display
        if process.returncode is None:
            process.terminate()
        await process.wait()


def cgroup_peak_bytes() -> int | None:
    for path in (
        Path("/sys/fs/cgroup/memory.peak"),
        Path("/sys/fs/cgroup/memory.max_usage_in_bytes"),
    ):
        try:
            return int(path.read_text().strip())
        except (FileNotFoundError, ValueError):
            pass
    return None


@app.task(name="crawl_batch", plan="standard", timeout_seconds=540)
async def crawl_batch(batch_id: str) -> dict:
    return await _crawl_batch(batch_id)


async def _crawl_batch(batch_id: str) -> dict:
    async with virtual_display(), guarded_egress() as egress:
        result = await _crawl_batch_guarded(batch_id, egress.proxy_url, egress.stats)
        result["outbound_bytes"] = egress.stats.outbound_bytes
        result["allowed_connections"] = egress.stats.allowed
        result["blocked_connections"] = egress.stats.blocked
        return result


async def _crawl_batch_guarded(
    batch_id: str, proxy_url: str, egress_stats: EgressStats | None = None
) -> dict:
    client = WorkflowClient(proxy_url)
    scraper = Scraper(pool_size=1, proxy_server=proxy_url)
    settings = load_settings()
    pdf_client = httpx.AsyncClient(
        proxy=proxy_url,
        headers={
            "user-agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/126.0.0.0 Safari/537.36"
            )
        },
    )
    started = time.monotonic()
    processed = 0
    succeeded = 0
    try:
        jobs = await client.claim(batch_id)
        for job in jobs:
            item_started = time.monotonic()
            blocked_before = egress_stats.blocked if egress_stats else 0
            outcome = await run_item_safely(
                scraper,
                CrawlItem(
                    id=job["id"],
                    operation=job["operation"],
                    url=job["url"],
                    timeout_ms=job["timeout_ms"],
                ),
                pdf_client=pdf_client,
                settings=settings,
            )
            if (
                not outcome["ok"]
                and egress_stats
                and egress_stats.blocked > blocked_before
            ):
                outcome["error_class"] = "terminal"
            await _apply_benchmark_delay(
                job.get("minimum_duration_ms", 0), item_started
            )
            if outcome["ok"] and job["operation"] == "snapshot" and (
                outcome["result"].get("snapshot") is None
            ):
                # The Edge Function requires all three snapshot artifacts; a
                # markdown-only upload would be rejected there. Fail the item
                # with the capture reason instead.
                completion = _failed_completion(
                    job,
                    "terminal",
                    "snapshot capture failed: "
                    + str(outcome["result"].get("snapshot_error") or "unknown"),
                )
            elif outcome["ok"]:
                try:
                    completion = await client.upload(job, outcome["result"])
                except ArtifactLimitError as exc:
                    completion = _failed_completion(job, "terminal", str(exc))
                except SignedUploadError as exc:
                    completion = _failed_completion(job, "retryable", str(exc))
            else:
                completion = _failed_completion(
                    job,
                    outcome["error_class"],
                    outcome.get("error", "crawl failed"),
                )
            # Commit each item before starting the next; a crash reclaims only
            # the unfinished suffix through its existing durable lease.
            if job.get("fault_callback_timeout"):
                try:
                    await client.complete(
                        batch_id,
                        completion,
                        response_delay_ms=1_000,
                        timeout_seconds=0.1,
                    )
                except CallbackTimeoutError:
                    # The first callback may have committed before its response
                    # was lost. Retrying proves the lease CAS is exactly-once.
                    await client.complete(batch_id, completion)
            else:
                await client.complete(batch_id, completion)
            processed += 1
            succeeded += int(completion["ok"])
            if job.get("fault_exit_after") == processed:
                os._exit(86)
        return {
            "batch_id": batch_id,
            "execution_id": client.execution_id,
            "processed": processed,
            "succeeded": succeeded,
            "elapsed_ms": round((time.monotonic() - started) * 1_000),
            "memory_peak_bytes": cgroup_peak_bytes(),
        }
    finally:
        await scraper.close()
        await pdf_client.aclose()
        await client.close()


async def _apply_benchmark_delay(minimum_ms: int, started: float) -> None:
    """Pad owned Gate B fixture work without changing production crawl DTOs."""
    remaining_ms = minimum_ms - (time.monotonic() - started) * 1_000
    if remaining_ms > 0:
        await asyncio.sleep(remaining_ms / 1_000)


def _failed_completion(job: dict, error_class: str, error: str) -> dict:
    return {
        "job_id": job["id"],
        "attempt_id": job["attempt_id"],
        "execution_id": job["execution_id"],
        "ok": False,
        "error_class": error_class,
        "error": error[:1_500],
    }


if __name__ == "__main__":  # pragma: no cover - Render process entry point
    app.start()
