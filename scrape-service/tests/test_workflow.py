import os
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import ClassVar

import pytest
from app import workflow


class FakeCloseable:
    def __init__(self, *args, **kwargs):
        pass

    async def close(self):
        pass

    async def aclose(self):
        pass


@pytest.mark.parametrize("previous_display", [":old", None])
async def test_virtual_display_scopes_display_to_browser_task(
    monkeypatch, previous_display
):
    class FakeStdout:
        async def readline(self):
            return b"77\n"

    class FakeProcess:
        stdout = FakeStdout()
        returncode = None
        terminated = False

        def terminate(self):
            self.terminated = True

        async def wait(self):
            return 0

    process = FakeProcess()
    command = None

    async def fake_subprocess(*args, **_kwargs):
        nonlocal command
        command = args
        return process

    monkeypatch.setattr(workflow.asyncio, "create_subprocess_exec", fake_subprocess)
    if previous_display is None:
        monkeypatch.delenv("DISPLAY", raising=False)
    else:
        monkeypatch.setenv("DISPLAY", previous_display)

    async with workflow.virtual_display():
        assert os.environ["DISPLAY"] == ":77"

    assert os.environ.get("DISPLAY") == previous_display
    assert command[0] == "Xvfb"
    assert process.terminated


def test_peak_memory_falls_back_to_v1(monkeypatch):
    values = {
        "/sys/fs/cgroup/memory.peak": FileNotFoundError(),
        "/sys/fs/cgroup/memory.max_usage_in_bytes": "123",
    }
    monkeypatch.setattr(
        workflow.Path,
        "read_text",
        lambda path: (
            (_ for _ in ()).throw(values[str(path)])
            if isinstance(values[str(path)], Exception)
            else values[str(path)]
        ),
    )
    assert workflow.cgroup_peak_bytes() == 123


def test_peak_memory_missing(monkeypatch):
    monkeypatch.setattr(
        workflow.Path,
        "read_text",
        lambda _path: (_ for _ in ()).throw(FileNotFoundError()),
    )
    assert workflow.cgroup_peak_bytes() is None


async def test_task_wrapper_enters_display_and_egress(monkeypatch):
    events = []

    @asynccontextmanager
    async def display():
        events.append("display")
        yield

    @asynccontextmanager
    async def egress():
        events.append("egress")
        yield SimpleNamespace(
            proxy_url="http://proxy",
            stats=SimpleNamespace(
                outbound_bytes=321,
                allowed=4,
                blocked=7,
            ),
        )

    async def guarded(batch_id, proxy_url, _stats):
        return {"batch_id": batch_id, "proxy": proxy_url}

    monkeypatch.setattr(workflow, "virtual_display", display)
    monkeypatch.setattr(workflow, "guarded_egress", egress)
    monkeypatch.setattr(workflow, "_crawl_batch_guarded", guarded)
    assert await workflow.crawl_batch.__wrapped__("batch") == {
        "batch_id": "batch",
        "proxy": "http://proxy",
        "outbound_bytes": 321,
        "allowed_connections": 4,
        "blocked_connections": 7,
    }
    assert events == ["display", "egress"]


def test_failed_completion_is_content_free():
    result = workflow._failed_completion(
        {"id": "job", "attempt_id": "attempt", "execution_id": "execution"},
        "retryable",
        "x" * 2000,
    )
    assert result["job_id"] == "job"
    assert len(result["error"]) == 1500


async def test_batch_commits_each_job_and_returns_only_counters(monkeypatch):
    exits = []

    class FakeClient:
        execution_id = "execution"
        completions: ClassVar[list[dict]] = []
        callback_attempts = 0

        def __init__(self, _proxy):
            pass

        async def claim(self, _batch):
            return [
                {
                    "id": "job",
                    "attempt_id": "attempt",
                    "execution_id": "execution",
                    "operation": "scrape",
                    "url": "https://example.test/private",
                    "timeout_ms": 1000,
                    "fault_callback_timeout": True,
                    "fault_exit_after": 1,
                }
            ]

        async def upload(self, job, _result):
            return {
                "job_id": job["id"],
                "attempt_id": job["attempt_id"],
                "execution_id": job["execution_id"],
                "ok": True,
                "artifacts": [],
            }

        async def complete(self, _batch, result, **kwargs):
            FakeClient.callback_attempts += 1
            if kwargs.get("response_delay_ms"):
                raise workflow.CallbackTimeoutError("injected")
            self.completions.append(result)

        async def close(self):
            pass

    async def run(*_args, **_kwargs):
        return {
            "ok": True,
            "result": {
                "markdown": "private content",
                "source_url": "https://example.test/private",
            },
        }

    monkeypatch.setattr(workflow, "WorkflowClient", FakeClient)
    monkeypatch.setattr(workflow, "Scraper", FakeCloseable)
    monkeypatch.setattr(workflow.httpx, "AsyncClient", FakeCloseable)
    monkeypatch.setattr(workflow, "load_settings", lambda: SimpleNamespace())
    monkeypatch.setattr(workflow, "run_item_safely", run)
    monkeypatch.setattr(workflow, "cgroup_peak_bytes", lambda: 100)
    monkeypatch.setattr(workflow.os, "_exit", lambda code: exits.append(code))

    report = await workflow._crawl_batch_guarded("batch", "http://proxy")
    assert report["processed"] == 1
    assert report["succeeded"] == 1
    assert "private content" not in str(report)
    assert "example.test" not in str(report)
    assert len(FakeClient.completions) == 1
    assert FakeClient.callback_attempts == 2
    assert exits == [86]


async def test_batch_maps_snapshot_and_upload_failures(monkeypatch):
    egress_stats = SimpleNamespace(blocked=0)

    class FakeClient:
        execution_id = "execution"
        completions: ClassVar[list[dict]] = []

        def __init__(self, _proxy):
            pass

        async def claim(self, _batch):
            return [
                job("snapshot", "snapshot"),
                job("large"),
                job("transport"),
                job("crawl"),
                job("blocked"),
            ]

        async def upload(self, item, _result):
            if item["id"] == "large":
                raise workflow.ArtifactLimitError("large")
            if item["id"] == "transport":
                raise workflow.SignedUploadError("transport")
            raise AssertionError("unexpected upload")

        async def complete(self, _batch, result):
            self.completions.append(result)

        async def close(self):
            pass

    async def run(_scraper, item, **_kwargs):
        if item.id == "blocked":
            egress_stats.blocked += 1
            return {"ok": False, "error_class": "retryable"}
        if item.id == "crawl":
            return {"ok": False, "error_class": "timeout"}
        return {
            "ok": True,
            "result": {"markdown": "ok", "source_url": "https://example.test"},
        }

    def job(identifier, operation="scrape"):
        return {
            "id": identifier,
            "attempt_id": f"attempt-{identifier}",
            "execution_id": "execution",
            "operation": operation,
            "url": "https://example.test",
            "timeout_ms": 1000,
        }

    monkeypatch.setattr(workflow, "WorkflowClient", FakeClient)
    monkeypatch.setattr(workflow, "Scraper", FakeCloseable)
    monkeypatch.setattr(workflow.httpx, "AsyncClient", FakeCloseable)
    monkeypatch.setattr(workflow, "load_settings", lambda: SimpleNamespace())
    monkeypatch.setattr(workflow, "run_item_safely", run)
    monkeypatch.setattr(workflow, "cgroup_peak_bytes", lambda: None)
    report = await workflow._crawl_batch_guarded(
        "batch", "http://proxy", egress_stats
    )
    assert report["processed"] == 5
    assert [item["error_class"] for item in FakeClient.completions] == [
        "retryable",
        "terminal",
        "retryable",
        "timeout",
        "terminal",
    ]


async def test_benchmark_delay_is_task_wrapper_only(monkeypatch):
    slept = []

    async def fake_sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr(workflow.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(workflow.time, "monotonic", lambda: 10.0)
    await workflow._apply_benchmark_delay(100, 9.95)
    assert slept == [pytest.approx(0.05)]
