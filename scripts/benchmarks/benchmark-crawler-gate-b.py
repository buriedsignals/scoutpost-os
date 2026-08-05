"""Bounded, content-free Gate B driver for the production crawler control plane."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
import subprocess
import time
import uuid
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

import httpx

PEAK_PAGES = 7_690
BATCH_SIZE = 20
MAX_RESERVATIONS = 400
MAX_DRAIN_SECONDS = 25 * 60
MAX_METRICS_SECONDS = 5 * 60
STANDARD_DOLLARS_PER_SECOND = 0.20 / 3_600
MAX_TEST_DOLLARS = 12.00
GATE_A_SECONDS_PER_PAGE = 4.9766
GATE_A_PEAK_TASK_SECONDS = 35_855.559
MONDAY_LATENCY_MS = [3_000] * 50 + [5_000] * 40 + [9_907] * 5 + [12_000] * 4 + [14_133]
GATE_A_STARTUP_SECONDS_PER_TASK = (
    GATE_A_PEAK_TASK_SECONDS
    - sum(
        MONDAY_LATENCY_MS[index % len(MONDAY_LATENCY_MS)] for index in range(PEAK_PAGES)
    )
    / 1_000
) / 385
OUTBOUND_OVERAGE_DOLLARS_PER_GB = 0.15
TERMINAL = {"succeeded", "terminal_failed"}
ALL_STATUSES = (
    "queued",
    "batched",
    "running",
    "succeeded",
    "fallback_required",
    "retryable_failed",
    "terminal_failed",
)


class GateBClient:
    def __init__(self) -> None:
        self.base = required_env("SUPABASE_URL").rstrip("/")
        self.key = required_env("SUPABASE_SERVICE_ROLE_KEY")
        self.internal_key = required_env("INTERNAL_SERVICE_KEY")
        self.http = httpx.Client(timeout=60)
        self.rest_headers = {
            "authorization": f"Bearer {self.key}",
            "apikey": self.key,
            "content-type": "application/json",
        }

    def rpc_response(
        self, name: str, body: dict | None = None
    ) -> httpx.Response:
        response = self.http.post(
            f"{self.base}/rest/v1/rpc/{name}",
            headers=self.rest_headers,
            json=body or {},
        )
        response.raise_for_status()
        return response

    def rpc(self, name: str, body: dict | None = None):
        return self.rpc_response(name, body).json()

    def insert_jobs(self, rows: list[dict]) -> None:
        response = self.http.post(
            f"{self.base}/rest/v1/crawler_jobs",
            headers={**self.rest_headers, "prefer": "return=minimal"},
            json=rows,
        )
        response.raise_for_status()

    def update_job(self, job_id: str, values: dict) -> None:
        response = self.http.patch(
            f"{self.base}/rest/v1/crawler_jobs",
            headers={**self.rest_headers, "prefer": "return=minimal"},
            params={"id": f"eq.{job_id}"},
            json=values,
        )
        response.raise_for_status()

    def dispatch(self, mode: str = "scheduled", operation: str = "scrape") -> dict:
        body = {"mode": mode}
        if mode == "single":
            body["operation"] = operation
        response = self.http.post(
            f"{self.base}/functions/v1/crawler-dispatch",
            headers={
                "x-service-key": self.internal_key,
                "content-type": "application/json",
            },
            json=body,
            timeout=120,
        )
        response.raise_for_status()
        return response.json()

    def worker(self, body: dict, token: str | None = None) -> httpx.Response:
        return self.http.post(
            required_env("WORKFLOW_WORKER_URL"),
            headers={
                "authorization": f"Bearer {token or required_env('WORKFLOW_WORKER_TOKEN')}",
                "content-type": "application/json",
            },
            json=body,
            timeout=30,
        )

    def resource_sample(self) -> dict:
        response = self.http.get(
            f"{self.base}/customer/v1/privileged/metrics",
            auth=httpx.BasicAuth("service_role", self.key),
            timeout=30,
        )
        response.raise_for_status()
        cpu = defaultdict(float)
        memory = {}
        for line in response.text.splitlines():
            if not line or line.startswith("#"):
                continue
            name = line.split("{", 1)[0]
            try:
                value = float(line.rsplit(" ", 1)[1])
            except (IndexError, ValueError):
                continue
            if name == "node_cpu_seconds_total" and 'mode="' in line:
                mode = line.split('mode="', 1)[1].split('"', 1)[0]
                cpu[mode] += value
            elif name in {
                "node_memory_MemAvailable_bytes",
                "node_memory_MemTotal_bytes",
            }:
                memory[name] = value
        total = memory.get("node_memory_MemTotal_bytes", 0)
        available = memory.get("node_memory_MemAvailable_bytes", 0)
        if not cpu or total <= 0 or not 0 <= available <= total:
            raise RuntimeError("Supabase Metrics API omitted CPU or memory counters")
        return {
            "at": datetime.now(timezone.utc).isoformat(),
            "cpu_seconds": dict(cpu),
            "memory_percent": 100 * (1 - available / total),
        }

    def start_task_without_acknowledgement(self, batch_id: str) -> None:
        response = self.http.post(
            "https://api.render.com/v1/task-runs",
            headers={
                "authorization": f"Bearer {required_env('RENDER_WORKFLOW_API_KEY')}",
                "content-type": "application/json",
            },
            json={
                "task": required_env("RENDER_CRAWLER_TASK_SLUG"),
                "input": [batch_id],
            },
            timeout=30,
        )
        response.raise_for_status()
        # Deliberately discard the accepted task ID. This models a response
        # lost after Render accepted the start; the reservation cannot POST again.
        response.close()

    def count_jobs(self, continuation: str, status: str) -> int:
        return self.exact_count(
            "crawler_jobs",
            {
                "continuation_key": f"eq.{continuation}",
                "status": f"eq.{status}",
            },
        )

    def exact_count(self, table: str, params: dict) -> int:
        response = self.http.get(
            f"{self.base}/rest/v1/{table}",
            headers={**self.rest_headers, "prefer": "count=exact", "range": "0-0"},
            params={"select": "id", **params},
        )
        response.raise_for_status()
        return int(response.headers.get("content-range", "0-0/0").rsplit("/", 1)[1])

    def rows(self, table: str, *, params: dict, page_size: int = 1000) -> list[dict]:
        output: list[dict] = []
        offset = 0
        while True:
            response = self.http.get(
                f"{self.base}/rest/v1/{table}",
                headers={
                    **self.rest_headers,
                    "range": f"{offset}-{offset + page_size - 1}",
                },
                params=params,
            )
            response.raise_for_status()
            page = response.json()
            output.extend(page)
            if len(page) < page_size:
                return output
            offset += page_size

    def batch_rows(self, batch_ids: set[str]) -> list[dict]:
        output = []
        for batch_id_chunk in chunks(sorted(batch_ids), 100):
            output.extend(
                self.rows(
                    "crawler_batches",
                    params={
                        "select": "id,status,render_task_run_id,render_metrics,render_terminal,created_at",
                        "id": f"in.({','.join(batch_id_chunk)})",
                    },
                )
            )
        return output

    def delete_gate_rows(self, continuation: str, batch_ids: set[str]) -> None:
        jobs = self.rows(
            "crawler_jobs",
            params={
                "select": "result_manifest",
                "continuation_key": f"eq.{continuation}",
            },
        )
        paths = [
            artifact["path"]
            for row in jobs
            for artifact in (row.get("result_manifest") or {}).get("artifacts", [])
            if isinstance(artifact, dict) and isinstance(artifact.get("path"), str)
        ]
        for chunk in chunks(paths, 100):
            response = self.http.request(
                "DELETE",
                f"{self.base}/storage/v1/object/crawler-results",
                headers=self.rest_headers,
                json={"prefixes": chunk},
            )
            response.raise_for_status()
        response = self.http.delete(
            f"{self.base}/rest/v1/crawler_jobs",
            headers=self.rest_headers,
            params={"continuation_key": f"eq.{continuation}"},
        )
        response.raise_for_status()
        for chunk in chunks(sorted(batch_ids), 100):
            response = self.http.delete(
                f"{self.base}/rest/v1/crawler_batches",
                headers=self.rest_headers,
                params={"id": f"in.({','.join(chunk)})"},
            )
            response.raise_for_status()


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def release_id() -> str:
    return required_env("GATE_B_RELEASE")


def chunks(values: list, size: int):
    for index in range(0, len(values), size):
        yield values[index : index + size]


def iso(value: str) -> datetime:
    normalized = value.replace("Z", "+00:00")
    # PostgREST may return more than Python's six-digit microsecond precision.
    if "." in normalized:
        head, tail = normalized.split(".", 1)
        fraction = tail.split("+", 1)[0].split("-", 1)[0]
        if len(fraction) > 6:
            normalized = f"{head}.{fraction[:6]}{tail[len(fraction):]}"
    return datetime.fromisoformat(normalized)


def build_jobs(run_id: str, fixture_url: str, pages: int) -> list[dict]:
    continuation = f"gate-b:{run_id}"
    return [
        {
            "dedupe_key": f"{continuation}:{index}",
            "request_kind": "benchmark",
            "tenant_key": f"gate-b-tenant:{index % 326}",
            "continuation_key": continuation,
            "operation": "scrape",
            "pipeline_stage": "gate_b_peak",
            "url": fixture_url,
            "options": {
                "timeout_ms": 25_000,
                "minimum_duration_ms": MONDAY_LATENCY_MS[
                    index % len(MONDAY_LATENCY_MS)
                ],
            },
            "priority": 0,
            "max_attempts": 3,
        }
        for index in range(pages)
    ]


def assert_preflight(client: GateBClient) -> None:
    row = first(client.rpc("crawler_gate_b_preflight"))
    if row.get("recurring_cron_exists"):
        raise RuntimeError("crawler Workflow recurring cron must be absent")
    if int(row.get("workflow_scout_runs", 0)) != 0:
        raise RuntimeError("production Scout runs are already routed to Workflow")
    if int(row.get("unpinned_scout_runs", 0)) != 0:
        raise RuntimeError("an unpinned Scout run exists")


def first(value):
    return value[0] if isinstance(value, list) and value else value or {}


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        raise ValueError("cannot calculate a percentile without samples")
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def summarize_resources(samples: list[dict]) -> dict:
    memory = [float(sample["memory_percent"]) for sample in samples]
    cpu = []
    for before, after in zip(samples, samples[1:]):  # noqa: RUF007 - Python 3.9.
        modes = set(before["cpu_seconds"]) | set(after["cpu_seconds"])
        deltas = {
            mode: max(
                0.0,
                float(after["cpu_seconds"].get(mode, 0))
                - float(before["cpu_seconds"].get(mode, 0)),
            )
            for mode in modes
        }
        total = sum(deltas.values())
        if total > 0:
            idle = deltas.get("idle", 0) + deltas.get("iowait", 0)
            cpu.append(100 * (1 - idle / total))
    if len(cpu) < 2 or len(memory) < 3:
        raise RuntimeError("Supabase resource sampling was incomplete")
    return {
        "samples": len(samples),
        "cpu_percent_p95": round(percentile(cpu, 0.95), 3),
        "cpu_percent_max": round(max(cpu), 3),
        "memory_percent_p95": round(percentile(memory, 0.95), 3),
        "memory_percent_max": round(max(memory), 3),
    }


def remember_batches(batch_ids: set[str], dispatch: dict) -> None:
    batch_ids.update(
        value
        for value in dispatch.get("batch_ids", [])
        if isinstance(value, str)
    )


def wait_render_metrics(client: GateBClient, batch_ids: set[str]) -> list[dict]:
    if not batch_ids:
        raise RuntimeError("no Gate B batches were recorded")
    deadline = time.monotonic() + MAX_METRICS_SECONDS
    while True:
        batches = client.batch_rows(batch_ids)
        pending = [
            row
            for row in batches
            if row.get("render_task_run_id") and not row.get("render_terminal")
        ]
        if not pending:
            return batches
        if time.monotonic() >= deadline:
            raise RuntimeError(
                f"Render metrics deadline exceeded for {len(pending)} batches"
            )
        remember_batches(batch_ids, client.dispatch("scheduled"))
        time.sleep(5)


def concatenated_json(raw: str) -> list[dict]:
    decoder = json.JSONDecoder()
    values = []
    index = 0
    while index < len(raw):
        while index < len(raw) and raw[index].isspace():
            index += 1
        if index >= len(raw):
            break
        value, index = decoder.raw_decode(raw, index)
        if isinstance(value, dict):
            values.append(value)
        elif value is not None:
            raise RuntimeError("Render logs returned an unexpected JSON shape")
    return values


def fetch_render_log_slice(
    service_id: str,
    start: datetime,
    end: datetime,
    limit: int,
) -> list[dict]:
    """Fetch one bounded Render log interval.

    Render's Logs API rejects limits above 1,000.  Keep that provider limit
    local to the collector rather than relying on a caller to know it.
    """
    command = [
        "render",
        "logs",
        "--resources",
        service_id,
        "--start",
        start.isoformat(),
        "--end",
        end.isoformat(),
        "--text",
        "workload_class",
        "--direction",
        "forward",
        "--limit",
        str(limit),
        "--output",
        "json",
    ]
    try:
        result = subprocess.run(
            command,
            text=True,
            capture_output=True,
            check=False,
            timeout=120,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Render content-free log export timed out") from exc
    if result.returncode:
        raise RuntimeError("Render content-free log export failed")
    return concatenated_json(result.stdout)


def fetch_render_logs(
    service_id: str,
    start: datetime,
    end: datetime,
    limit: int,
) -> list[dict]:
    """Fetch an interval, splitting it when it reaches the provider limit."""
    records = fetch_render_log_slice(service_id, start, end, limit)
    if len(records) < limit:
        return records
    if end - start <= timedelta(minutes=1):
        raise RuntimeError(
            "Render log volume exceeds the limit in a one-minute slice; "
            "increase observability granularity before collecting arrivals"
        )
    midpoint = start + (end - start) / 2
    midpoint = midpoint.replace(second=0, microsecond=0)
    if midpoint <= start or midpoint >= end:
        raise RuntimeError("could not split Render log interval at a minute boundary")
    return fetch_render_logs(service_id, start, midpoint, limit) + fetch_render_logs(
        service_id, midpoint, end, limit
    )


def collect_arrivals(args: argparse.Namespace) -> dict:
    start = iso(args.start)
    end = iso(args.end)
    now_floor = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    if (
        end - start != timedelta(days=7)
        or start.second
        or start.microsecond
        or end.second
        or end.microsecond
        or end > now_floor - timedelta(minutes=1)
    ):
        raise SystemExit("collect requires seven complete aligned UTC days")

    counts = Counter()
    heartbeat_minutes = set()
    log_ids = set()
    cursor = start
    while cursor < end:
        slice_end = min(end, cursor + timedelta(hours=1))
        records = fetch_render_logs(
            args.service_id, cursor, slice_end, args.slice_limit
        )
        for record in records:
            record_id = record.get("id")
            if not isinstance(record_id, str) or record_id in log_ids:
                continue
            message = record.get("message")
            if not isinstance(message, str) or "{" not in message:
                raise RuntimeError("operation log record has no JSON payload")
            payload, consumed = json.JSONDecoder().raw_decode(
                message, message.index("{")
            )
            if message[consumed:].strip() or set(payload) != {
                "minute",
                "operation",
                "workload_class",
            }:
                raise RuntimeError(
                    "operation log contains fields outside the counter contract"
                )
            minute = iso(str(payload["minute"]))
            operation = str(payload["operation"])
            workload = str(payload["workload_class"])
            if (
                minute < start
                or minute >= end
                or operation not in {
                    "scrape",
                    "snapshot",
                    "parse_pdf",
                    "heartbeat",
                }
                or workload not in {"scout", "utility", "system"}
            ):
                continue
            log_ids.add(record_id)
            if operation == "heartbeat":
                if workload != "system":
                    raise RuntimeError("operation heartbeat has an invalid workload")
                heartbeat_minutes.add(minute)
                continue
            counts[(minute.isoformat(), operation, workload)] += 1
        cursor = slice_end

    expected_heartbeats = {
        start + timedelta(minutes=offset)
        for offset in range(7 * 24 * 60)
    }
    if heartbeat_minutes != expected_heartbeats:
        raise RuntimeError(
            "content-free counter heartbeat coverage is incomplete: "
            f"expected {len(expected_heartbeats)}, observed {len(heartbeat_minutes)}"
        )

    client = GateBClient()
    preflight = first(client.rpc("crawler_gate_b_preflight"))
    assert_preflight(client)
    report = {
        "window_start": start.isoformat(),
        "window_end": end.isoformat(),
        "complete_minutes": len(heartbeat_minutes),
        "observed_active_scouts": int(preflight["observed_active_scouts"]),
        "observed_users": int(preflight["observed_users"]),
        "rows": [
            {
                "minute": minute,
                "operation": operation,
                "workload_class": workload,
                "count": count,
            }
            for (minute, operation, workload), count in sorted(counts.items())
        ],
    }
    args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return report


def run_full(args: argparse.Namespace) -> dict:
    expected_host = required_env("GATE_B_FIXTURE_HOST")
    if urlsplit(args.fixture_url).hostname != expected_host:
        raise SystemExit(f"fixture must use owned host {expected_host}")
    expected_batches = math.ceil(args.pages / BATCH_SIZE)
    if expected_batches + args.fault_reservations > MAX_RESERVATIONS:
        raise SystemExit("Gate B reservation liability exceeds 400")
    if MAX_RESERVATIONS * 540 * STANDARD_DOLLARS_PER_SECOND > MAX_TEST_DOLLARS:
        raise SystemExit("Gate B configured liability exceeds $12")

    client = GateBClient()
    assert_preflight(client)
    run_id = str(uuid.uuid4())
    continuation = f"gate-b:{run_id}"
    enqueued_at = datetime.now(timezone.utc)
    resource_samples = [client.resource_sample()]
    for chunk in chunks(build_jobs(run_id, args.fixture_url, args.pages), 250):
        client.insert_jobs(chunk)

    reservations = 0
    batch_ids: set[str] = set()
    minute = 0
    while True:
        counts = {
            status: client.count_jobs(continuation, status) for status in ALL_STATUSES
        }
        if sum(counts[status] for status in TERMINAL) == args.pages:
            break
        if (
            datetime.now(timezone.utc) - enqueued_at
        ).total_seconds() >= MAX_DRAIN_SECONDS:
            raise RuntimeError(f"drain deadline exceeded: {counts}")
        window_started = time.monotonic()
        calls = [client.dispatch("scheduled")]
        calls.extend(client.dispatch("single") for _ in range(6))
        for call in calls:
            remember_batches(batch_ids, call)
        reservations += sum(reservation_count(item) for item in calls)
        resource_samples.append(client.resource_sample())
        if reservations > MAX_RESERVATIONS:
            raise RuntimeError("Gate B reservation budget exceeded")
        print(
            json.dumps(
                {
                    "stage": "dispatch",
                    "minute": minute,
                    "reservations": reservations,
                    "counts": counts,
                }
            ),
            flush=True,
        )
        minute += 1
        remaining = 60 - (time.monotonic() - window_started)
        if remaining > 0:
            time.sleep(remaining)

    batches = wait_render_metrics(client, batch_ids)
    resource_samples.append(client.resource_sample())

    jobs = client.rows(
        "crawler_jobs",
        params={
            "select": "id,batch_id,status,attempts,available_at,batched_at,started_at,completed_at,error_class",
            "continuation_key": f"eq.{continuation}",
            "order": "created_at.asc",
        },
    )
    assert_preflight(client)
    report = summarize_full(
        run_id,
        continuation,
        enqueued_at,
        jobs,
        batches,
        reservations,
        args.pages,
        resource_samples,
    )
    args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    if args.cleanup:
        client.delete_gate_rows(continuation, batch_ids)
    return report


def benchmark_job(
    continuation: str,
    name: str,
    index: int,
    url: str,
    options: dict | None = None,
) -> dict:
    return {
        "dedupe_key": f"{continuation}:{name}:{index}",
        "request_kind": "benchmark",
        "tenant_key": f"gate-b-fault:{name}",
        "continuation_key": continuation,
        "operation": "scrape",
        "pipeline_stage": name,
        "url": url,
        "options": options or {"timeout_ms": 25_000},
        "priority": 0,
        "max_attempts": 3,
    }


def reservation_count(result: dict) -> int:
    # Every attempted Render start consumes one reservation, including starts
    # that Render definitively rejects and the dispatcher immediately releases.
    return (
        int(result.get("submitted", 0))
        + int(result.get("released", 0))
        + int(result.get("ambiguous", 0))
    )


def timed_rpc(client: GateBClient, name: str, body: dict | None = None):
    started = time.perf_counter()
    response = client.rpc_response(name, body)
    end_to_end_ms = (time.perf_counter() - started) * 1_000
    upstream = response.headers.get("x-envoy-upstream-service-time")
    if upstream is None:
        raise RuntimeError("Supabase response omitted upstream service timing")
    return response.json(), float(upstream), end_to_end_ms


def run_boundaries(args: argparse.Namespace) -> dict:
    client = GateBClient()
    assert_preflight(client)
    run_id = str(uuid.uuid4())
    fairness_key = f"gate-b-boundaries:{run_id}"
    fairness_rows = [
        benchmark_job(
            fairness_key,
            "fairness_heavy",
            index,
            f"https://example.test/heavy/{index}",
        )
        for index in range(193)
    ]
    fairness_rows.extend(
        benchmark_job(
            fairness_key,
            f"fairness_small_{index}",
            0,
            f"https://example.test/small/{index}",
        )
        for index in range(100)
    )
    for chunk in chunks(fairness_rows, 250):
        client.insert_jobs(chunk)

    def form_batches(_index: int):
        return timed_rpc(
            client,
            "create_crawler_batches",
            {"p_operation": "scrape", "p_batch_size": 20, "p_job_limit": 293},
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        concurrent = list(pool.map(form_batches, range(2)))
    responses = [item[0] for item in concurrent]
    dispatch_ms = [item[1] for item in concurrent]
    dispatch_end_to_end_ms = [item[2] for item in concurrent]
    assigned = [
        job_id
        for response in responses
        for batch in response
        for job_id in batch["job_ids"]
    ]
    jobs = client.rows(
        "crawler_jobs",
        params={
            "select": "id,tenant_key,batch_id,status",
            "continuation_key": f"eq.{fairness_key}",
        },
    )
    tenants = {job["id"]: job["tenant_key"] for job in jobs}
    first_cycle = [tenants[job_id] for job_id in assigned[:101]]
    batch_ids = {
        job["batch_id"] for job in jobs if isinstance(job.get("batch_id"), str)
    }

    claim_ms = []
    claim_end_to_end_ms = []
    completion_ms = []
    completion_end_to_end_ms = []
    completion_changed = []
    for batch_id in sorted(batch_ids):
        claims, upstream_ms, end_to_end_ms = timed_rpc(
            client,
            "claim_crawler_batch",
            {"p_batch_id": batch_id, "p_lease_seconds": 600},
        )
        claim_ms.append(upstream_ms)
        claim_end_to_end_ms.append(end_to_end_ms)
        for claim in claims:
            changed, upstream_ms, end_to_end_ms = timed_rpc(
                client,
                "complete_crawler_job",
                {
                    "p_job_id": claim["id"],
                    "p_lease_token": claim["lease_token"],
                    "p_ok": True,
                    "p_manifest": {"artifacts": []},
                },
            )
            completion_ms.append(upstream_ms)
            completion_end_to_end_ms.append(end_to_end_ms)
            completion_changed.append(bool(changed))
    for _ in range(98):
        _, upstream_ms, end_to_end_ms = timed_rpc(
            client,
            "create_crawler_batches",
            {"p_operation": "scrape", "p_batch_size": 20, "p_job_limit": 293},
        )
        dispatch_ms.append(upstream_ms)
        dispatch_end_to_end_ms.append(end_to_end_ms)

    tenant_key = f"gate-b-utility:{run_id}"
    utility_key = f"gate-b-utility:{run_id}"
    utility_payload = {
        "p_request_kind": "ingest",
        "p_tenant_key": tenant_key,
        "p_continuation_key": utility_key,
        "p_operation": "scrape",
        "p_pipeline_stage": "gate_b_admission",
        "p_url": "https://example.test/utility",
        "p_options": {},
        "p_global_daily_limit": 100_000,
    }
    for index in range(20):
        client.rpc(
            "admit_and_enqueue_crawler_utility",
            {**utility_payload, "p_dedupe_key": f"{utility_key}:{index}"},
        )
    try:
        client.rpc(
            "admit_and_enqueue_crawler_utility",
            {**utility_payload, "p_dedupe_key": f"{utility_key}:20"},
        )
        tenant_bound_rejected = False
    except httpx.HTTPStatusError as exc:
        tenant_bound_rejected = exc.response.status_code == 400

    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    current_utility = client.exact_count(
        "crawler_jobs",
        {"request_kind": "neq.scout_run", "created_at": f"gte.{since}"},
    )
    if current_utility >= 99_999:
        raise RuntimeError("production utility count leaves no safe circuit probe")
    global_limit = current_utility + 1
    global_key = f"gate-b-global:{run_id}"
    global_payload = {
        **utility_payload,
        "p_tenant_key": global_key,
        "p_continuation_key": global_key,
        "p_global_daily_limit": global_limit,
    }
    client.rpc(
        "admit_and_enqueue_crawler_utility",
        {**global_payload, "p_dedupe_key": f"{global_key}:allowed"},
    )
    try:
        client.rpc(
            "admit_and_enqueue_crawler_utility",
            {
                **global_payload,
                "p_tenant_key": f"{global_key}:other",
                "p_dedupe_key": f"{global_key}:rejected",
            },
        )
        global_bound_rejected = False
    except httpx.HTTPStatusError as exc:
        global_bound_rejected = exc.response.status_code == 400

    scout_key = f"gate-b-scheduled-admission:{run_id}"
    client.insert_jobs(
        [
            {
                **benchmark_job(
                    scout_key,
                    "scheduled_survives_utility_circuit",
                    0,
                    "https://example.test/scout",
                ),
                "operation": "snapshot",
            }
        ]
    )
    scout_batches = client.rpc(
        "create_crawler_batches",
        {"p_operation": "snapshot", "p_batch_size": 1, "p_job_limit": 1},
    )
    batch_ids.update(
        batch["batch_id"] for batch in scout_batches if isinstance(batch, dict)
    )

    rpc_p95 = {
        "dispatch": round(percentile(dispatch_ms, 0.95), 3),
        "claim": round(percentile(claim_ms, 0.95), 3),
        "completion": round(percentile(completion_ms, 0.95), 3),
    }
    rpc_end_to_end_p95 = {
        "dispatch": round(percentile(dispatch_end_to_end_ms, 0.95), 3),
        "claim": round(percentile(claim_end_to_end_ms, 0.95), 3),
        "completion": round(percentile(completion_end_to_end_ms, 0.95), 3),
    }
    checks = {
        "two_dispatchers_one_winner": sorted(len(item) for item in responses)
        == [0, 15],
        "all_jobs_assigned_once": len(assigned) == 293 and len(set(assigned)) == 293,
        "small_tenants_before_heavy_second": first_cycle.count(
            "gate-b-fault:fairness_heavy"
        )
        == 1
        and sum(
            value.startswith("gate-b-fault:fairness_small_") for value in first_cycle
        )
        == 100,
        "batch_size_at_most_twenty": all(
            len(batch["job_ids"]) <= 20 for response in responses for batch in response
        ),
        "one_durable_completion_each": len(completion_changed) == 293
        and all(completion_changed),
        "rpc_p95_below_100_ms": all(value < 100 for value in rpc_p95.values()),
        "tenant_utility_bound": tenant_bound_rejected,
        "global_utility_circuit": global_bound_rejected,
        "scheduled_dispatch_survives_utility_circuit": len(scout_batches) == 1,
    }
    report = {
        "gate_b_boundaries_pass": all(checks.values()),
        "release": release_id(),
        "run_id": run_id,
        "checks": checks,
        "rpc_p95_ms": rpc_p95,
        "rpc_end_to_end_p95_ms": rpc_end_to_end_p95,
        "rpc_timing_source": "x-envoy-upstream-service-time",
        "jobs": 293,
        "render_reservations": 0,
    }
    args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    if args.cleanup:
        for continuation in (fairness_key, utility_key, global_key, scout_key):
            client.delete_gate_rows(continuation, set())
        client.delete_gate_rows(f"gate-b-cleanup:{run_id}", batch_ids)
    return report


def run_faults(args: argparse.Namespace) -> dict:
    expected_host = required_env("GATE_B_FIXTURE_HOST")
    if urlsplit(args.fixture_base).hostname != expected_host:
        raise SystemExit(f"fixture must use owned host {expected_host}")
    client = GateBClient()
    assert_preflight(client)
    run_id = str(uuid.uuid4())
    continuation = f"gate-b-faults:{run_id}"
    base = args.fixture_base.rstrip("/")
    enqueued_at = datetime.now(timezone.utc)
    reservations = 0
    batch_ids: set[str] = set()

    scenarios = [
        (
            "task_exit",
            [
                benchmark_job(
                    continuation,
                    "task_exit",
                    index,
                    f"{base}/stable",
                    {
                        "timeout_ms": 25_000,
                        "inject_task_exit_after": 5,
                    },
                )
                for index in range(20)
            ],
        ),
        (
            "callback_timeout",
            [
                benchmark_job(
                    continuation,
                    "callback_timeout",
                    0,
                    f"{base}/stable",
                    {
                        "timeout_ms": 25_000,
                        "inject_callback_timeout": True,
                    },
                )
            ],
        ),
        (
            "provider_502",
            [
                benchmark_job(
                    continuation,
                    "provider_502",
                    0,
                    f"{base}/flaky-502/{run_id}",
                )
            ],
        ),
        (
            "page_timeout",
            [
                benchmark_job(
                    continuation,
                    "page_timeout",
                    0,
                    f"{base}/flaky-timeout/{run_id}",
                    {"timeout_ms": 1_000},
                )
            ],
        ),
    ]
    for name, rows in scenarios:
        client.insert_jobs(rows)
        dispatch = client.dispatch("single")
        accepted = reservation_count(dispatch)
        if accepted != 1:
            raise RuntimeError(f"fault scenario {name} reserved {accepted} tasks")
        remember_batches(batch_ids, dispatch)
        reservations += accepted

    ambiguous = benchmark_job(
        continuation,
        "accept_response_lost",
        0,
        f"{base}/stable",
    )
    client.insert_jobs([ambiguous])
    batches = client.rpc(
        "create_crawler_batches",
        {
            "p_operation": "scrape",
            "p_batch_size": 20,
            "p_job_limit": 20,
        },
    )
    if len(batches) != 1:
        raise RuntimeError("ambiguous-start probe did not form one batch")
    batch_id = batches[0]["batch_id"]
    batch_ids.add(batch_id)
    token = client.rpc(
        "reserve_crawler_batch_submission",
        {
            "p_batch_id": batch_id,
            "p_limit": 28,
        },
    )
    if not isinstance(token, str):
        raise TypeError("ambiguous-start probe did not return a reservation token")
    client.start_task_without_acknowledgement(batch_id)
    reservations += 1

    expected_jobs = 24
    deadline = time.monotonic() + MAX_DRAIN_SECONDS
    while True:
        counts = {
            status: client.count_jobs(continuation, status) for status in ALL_STATUSES
        }
        if sum(counts[status] for status in TERMINAL) == expected_jobs:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError(f"fault recovery deadline exceeded: {counts}")
        dispatch = client.dispatch("single")
        remember_batches(batch_ids, dispatch)
        reservations += reservation_count(dispatch)
        if reservations > 10:
            raise RuntimeError("fault suite exceeded its ten-reservation allocation")
        time.sleep(10)

    jobs = client.rows(
        "crawler_jobs",
        params={
            "select": "id,batch_id,pipeline_stage,status,attempts,created_at,completed_at,result_manifest",
            "continuation_key": f"eq.{continuation}",
        },
    )
    batches = wait_render_metrics(client, batch_ids)
    measured_cost = (
        sum(
            float((row.get("render_metrics") or {}).get("attempt_seconds") or 0)
            for row in batches
        )
        * STANDARD_DOLLARS_PER_SECOND
    )
    render_retry_count = sum(
        int((row.get("render_metrics") or {}).get("retry_count") or 0)
        for row in batches
    )
    by_stage = defaultdict(list)
    for job in jobs:
        by_stage[job["pipeline_stage"]].append(job)
    drain_seconds = max(iso(job["completed_at"]) for job in jobs) - enqueued_at
    checks = {
        "all_jobs_succeeded": len(jobs) == expected_jobs
        and all(job["status"] == "succeeded" for job in jobs),
        "task_exit_recovered_suffix": sum(
            int(job["attempts"]) == 2 for job in by_stage["task_exit"]
        )
        == 15,
        "callback_committed_once": len(by_stage["callback_timeout"]) == 1
        and int(by_stage["callback_timeout"][0]["attempts"]) == 1,
        "provider_502_retried": int(by_stage["provider_502"][0]["attempts"]) == 2,
        "page_timeout_retried": int(by_stage["page_timeout"][0]["attempts"]) == 2,
        "accepted_response_loss_exactly_once": len(by_stage["accept_response_lost"])
        == 1
        and int(by_stage["accept_response_lost"][0]["attempts"]) == 1,
        "drain_below_25_minutes": drain_seconds.total_seconds() < MAX_DRAIN_SECONDS,
        "reservation_allocation": reservations <= 10,
        "render_task_retries_disabled": render_retry_count == 0,
    }
    report = {
        "gate_b_faults_pass": all(checks.values()),
        "release": release_id(),
        "run_id": run_id,
        "checks": checks,
        "jobs": len(jobs),
        "reservations": reservations,
        "drain_seconds": round(drain_seconds.total_seconds(), 3),
        "measured_compute_dollars": round(measured_cost, 4),
        "render_retry_count": render_retry_count,
    }
    args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    if args.cleanup:
        client.delete_gate_rows(continuation, batch_ids)
    return report


def create_and_claim_boundary_job(
    client: GateBClient,
    row: dict,
) -> tuple[str, dict]:
    client.insert_jobs([row])
    batches = client.rpc(
        "create_crawler_batches",
        {
            "p_operation": row["operation"],
            "p_batch_size": 1,
            "p_job_limit": 1,
        },
    )
    if len(batches) != 1:
        raise RuntimeError("security boundary did not form one batch")
    batch_id = batches[0]["batch_id"]
    response = client.worker(
        {
            "action": "claim",
            "batch_id": batch_id,
            "execution_id": str(uuid.uuid4()),
        }
    )
    response.raise_for_status()
    jobs = response.json().get("jobs")
    if not isinstance(jobs, list) or len(jobs) != 1:
        raise RuntimeError("security boundary did not claim one job")
    return batch_id, jobs[0]


def tampered_completion(
    client: GateBClient,
    batch_id: str,
    job: dict,
    decoded: bytes,
    *,
    wrong_hash: bool = False,
    declared_bytes_delta: int = 0,
) -> int:
    compressed = gzip.compress(decoded, 9)
    upload = client.http.put(
        job["uploads"]["result"]["url"],
        content=compressed,
        headers={"content-type": "application/gzip"},
        timeout=30,
    )
    upload.raise_for_status()
    response = client.worker(
        {
            "action": "complete",
            "batch_id": batch_id,
            "results": [
                {
                    "job_id": job["id"],
                    "attempt_id": job["attempt_id"],
                    "execution_id": job["execution_id"],
                    "ok": True,
                    "artifacts": [
                        {
                            "kind": "result",
                            "sha256": "0" * 64
                            if wrong_hash
                            else hashlib.sha256(compressed).hexdigest(),
                            "bytes": len(compressed) + declared_bytes_delta,
                        }
                    ],
                }
            ],
        }
    )
    return response.status_code


def failed_completion(job: dict) -> dict:
    return {
        "job_id": job["id"],
        "attempt_id": job["attempt_id"],
        "execution_id": job["execution_id"],
        "ok": False,
        "error_class": "terminal",
        "error": "Gate B boundary completion",
    }


def run_security(args: argparse.Namespace) -> dict:
    expected_host = required_env("GATE_B_FIXTURE_HOST")
    if urlsplit(args.fixture_base).hostname != expected_host:
        raise SystemExit(f"fixture must use owned host {expected_host}")
    client = GateBClient()
    assert_preflight(client)
    run_id = str(uuid.uuid4())
    continuation = f"gate-b-security:{run_id}"
    base = args.fixture_base.rstrip("/")
    reservations = 0
    task_batch_ids: set[str] = set()

    live_rows = [
        benchmark_job(continuation, "browser_network", 0, f"{base}/network"),
        {
            **benchmark_job(continuation, "snapshot_network", 0, f"{base}/network"),
            "operation": "snapshot",
        },
        benchmark_job(
            continuation,
            "browser_redirect_private",
            0,
            f"{base}/redirect-private",
        ),
        {
            **benchmark_job(
                continuation,
                "pdf_redirect_private",
                0,
                f"{base}/redirect-private",
            ),
            "operation": "parse_pdf",
        },
        benchmark_job(
            continuation,
            "direct_private",
            0,
            "http://169.254.169.254/latest/meta-data/",
        ),
    ]
    for row in live_rows:
        client.insert_jobs([row])
        result = client.dispatch("single", row["operation"])
        accepted = reservation_count(result)
        if accepted != 1:
            raise RuntimeError(
                f"security scenario {row['pipeline_stage']} reserved {accepted} tasks"
            )
        remember_batches(task_batch_ids, result)
        reservations += accepted

    deadline = time.monotonic() + MAX_DRAIN_SECONDS
    security_terminal = {"succeeded", "terminal_failed", "fallback_required"}
    while True:
        jobs = client.rows(
            "crawler_jobs",
            params={
                "select": "id,pipeline_stage,status,attempts,completed_at,result_manifest",
                "continuation_key": f"eq.{continuation}",
            },
        )
        live = [
            job
            for job in jobs
            if job["pipeline_stage"] in {row["pipeline_stage"] for row in live_rows}
        ]
        if len(live) == 5 and all(job["status"] in security_terminal for job in live):
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("security task runs did not reach expected states")
        time.sleep(5)

    batches = wait_render_metrics(client, task_batch_ids)
    metrics = [row.get("render_metrics") or {} for row in batches]
    measured_cost = (
        sum(float(metric.get("attempt_seconds") or 0) for metric in metrics)
        * STANDARD_DOLLARS_PER_SECOND
    )

    random_batch = str(uuid.uuid4())
    random_execution = str(uuid.uuid4())
    bad_token = client.worker(
        {"action": "claim", "batch_id": random_batch, "execution_id": random_execution},
        token="invalid-worker-token",
    ).status_code
    service_token = client.worker(
        {"action": "claim", "batch_id": random_batch, "execution_id": random_execution},
        token=client.key,
    ).status_code
    previous = os.environ.get("WORKFLOW_WORKER_TOKEN_PREVIOUS")
    previous_status = (
        client.worker(
            {
                "action": "claim",
                "batch_id": random_batch,
                "execution_id": random_execution,
            },
            token=previous,
        ).status_code
        if previous
        else None
    )

    boundary_rows = [
        benchmark_job(continuation, "hash_tamper", 0, f"{base}/stable"),
        benchmark_job(continuation, "size_tamper", 0, f"{base}/stable"),
        benchmark_job(continuation, "schema_tamper", 0, f"{base}/stable"),
        benchmark_job(continuation, "decompression_bomb", 0, f"{base}/stable"),
    ]
    boundary_status = {}
    cleanup_batch_ids = set(task_batch_ids)
    for row in boundary_rows:
        batch_id, job = create_and_claim_boundary_job(client, row)
        cleanup_batch_ids.add(batch_id)
        if row["pipeline_stage"] == "hash_tamper":
            signed_url = job["uploads"]["result"]["url"]
            substituted = signed_url.replace(job["id"], str(uuid.uuid4()))
            if substituted == signed_url:
                raise RuntimeError("signed upload path was not explicit")
            boundary_status["path_substitution"] = client.http.put(
                substituted,
                content=b"not-authorized",
                headers={"content-type": "application/gzip"},
            ).status_code
            boundary_status["hash_tamper"] = tampered_completion(
                client,
                batch_id,
                job,
                json.dumps(
                    {
                        "markdown": "fixture",
                        "source_url": f"{base}/stable",
                    }
                ).encode(),
                wrong_hash=True,
            )
        elif row["pipeline_stage"] == "size_tamper":
            boundary_status["size_tamper"] = tampered_completion(
                client,
                batch_id,
                job,
                json.dumps(
                    {
                        "markdown": "fixture",
                        "source_url": f"{base}/stable",
                    }
                ).encode(),
                declared_bytes_delta=1,
            )
        elif row["pipeline_stage"] == "schema_tamper":
            boundary_status["schema_tamper"] = tampered_completion(
                client,
                batch_id,
                job,
                json.dumps({"source_url": f"{base}/stable"}).encode(),
            )
        else:
            boundary_status["decompression_bomb"] = tampered_completion(
                client,
                batch_id,
                job,
                b"x" * (16 * 1024 * 1024 + 1),
            )

    duplicate_batch, duplicate_job = create_and_claim_boundary_job(
        client,
        benchmark_job(continuation, "duplicate_completion", 0, f"{base}/stable"),
    )
    cleanup_batch_ids.add(duplicate_batch)
    duplicate_payload = {
        "action": "complete",
        "batch_id": duplicate_batch,
        "results": [failed_completion(duplicate_job)],
    }
    duplicate_first = client.worker(duplicate_payload)
    duplicate_first.raise_for_status()
    duplicate_second = client.worker(duplicate_payload)
    duplicate_second.raise_for_status()
    boundary_status["duplicate_first"] = duplicate_first.json()
    boundary_status["duplicate_second"] = duplicate_second.json()

    stale_batch, stale_job = create_and_claim_boundary_job(
        client,
        benchmark_job(continuation, "stale_lease", 0, f"{base}/stable"),
    )
    cleanup_batch_ids.add(stale_batch)
    stale_started = time.monotonic()
    client.update_job(
        stale_job["id"],
        {
            "lease_expires_at": (
                datetime.now(timezone.utc) - timedelta(seconds=1)
            ).isoformat()
        },
    )
    client.rpc("reconcile_crawler_jobs")
    stale_completion = client.worker(
        {
            "action": "complete",
            "batch_id": stale_batch,
            "results": [failed_completion(stale_job)],
        }
    )
    stale_completion.raise_for_status()
    client.update_job(
        stale_job["id"],
        {
            "available_at": (
                datetime.now(timezone.utc) - timedelta(seconds=1)
            ).isoformat()
        },
    )
    retry_batches = client.rpc(
        "create_crawler_batches",
        {"p_operation": "scrape", "p_batch_size": 1, "p_job_limit": 1},
    )
    if len(retry_batches) != 1:
        raise RuntimeError("stale lease did not re-enter dispatch")
    retry_batch = retry_batches[0]["batch_id"]
    cleanup_batch_ids.add(retry_batch)
    retry_claim = client.worker(
        {
            "action": "claim",
            "batch_id": retry_batch,
            "execution_id": str(uuid.uuid4()),
        }
    )
    retry_claim.raise_for_status()
    retry_jobs = retry_claim.json().get("jobs")
    if not isinstance(retry_jobs, list) or len(retry_jobs) != 1:
        raise RuntimeError("stale lease retry did not claim one job")
    stale_retry = retry_jobs[0]
    stale_final = client.worker(
        {
            "action": "complete",
            "batch_id": retry_batch,
            "results": [failed_completion(stale_retry)],
        }
    )
    stale_final.raise_for_status()
    stale_state = client.rows(
        "crawler_jobs",
        params={
            "select": "id,attempts,status",
            "id": f"eq.{stale_job['id']}",
        },
    )[0]
    boundary_status["stale_completion"] = stale_completion.json()
    boundary_status["stale_final"] = stale_final.json()
    boundary_status["stale_reentry_seconds"] = round(
        time.monotonic() - stale_started, 3
    )
    boundary_status["stale_attempts"] = int(stale_state["attempts"])
    boundary_status["stale_status"] = stale_state["status"]

    by_stage = {job["pipeline_stage"]: job for job in live}
    checks = {
        "five_live_runs": reservations == 5,
        "browser_network_succeeded": by_stage["browser_network"]["status"]
        == "succeeded",
        "snapshot_network_succeeded": by_stage["snapshot_network"]["status"]
        == "succeeded",
        "private_targets_rejected": all(
            by_stage[name]["status"] in {"terminal_failed", "fallback_required"}
            for name in (
                "browser_redirect_private",
                "pdf_redirect_private",
                "direct_private",
            )
        ),
        "forbidden_connections_blocked": sum(
            int(metric.get("blocked_connections") or 0) for metric in metrics
        )
        > 0,
        "render_runs_terminal": sum(
            bool(row.get("render_task_run_id") and row.get("render_terminal"))
            for row in batches
        )
        == 5,
        "render_task_retries_disabled": all(
            int(metric.get("retry_count") or 0) == 0 for metric in metrics
        ),
        "invalid_token_rejected": bad_token == 401,
        "service_role_not_worker_token": service_token == 401,
        "previous_token_accepted": previous_status == 200,
        "signed_path_substitution_rejected": boundary_status["path_substitution"]
        not in {200, 201, 204},
        "hash_tamper_rejected": boundary_status["hash_tamper"] == 500,
        "size_tamper_rejected": boundary_status["size_tamper"] == 500,
        "schema_tamper_rejected": boundary_status["schema_tamper"] == 500,
        "decompression_bomb_rejected": boundary_status["decompression_bomb"] == 500,
        "duplicate_completion_rejected": boundary_status["duplicate_first"]
        == {"ok": True, "accepted": 1, "rejected": 0}
        and boundary_status["duplicate_second"]
        == {"ok": True, "accepted": 0, "rejected": 1},
        "stale_lease_recovered": boundary_status["stale_completion"]
        == {"ok": True, "accepted": 0, "rejected": 1}
        and boundary_status["stale_reentry_seconds"] < 60
        and boundary_status["stale_attempts"] == 2
        and boundary_status["stale_status"] == "terminal_failed",
        "stale_retry_completed_once": boundary_status["stale_final"]
        == {"ok": True, "accepted": 1, "rejected": 0},
    }
    report = {
        "gate_b_security_pass": all(checks.values()),
        "release": release_id(),
        "run_id": run_id,
        "checks": checks,
        "reservations": reservations,
        "boundary_status": boundary_status,
        "measured_compute_dollars": round(measured_cost, 4),
    }
    args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    if args.cleanup:
        client.delete_gate_rows(continuation, cleanup_batch_ids)
    return report


def summarize_full(
    run_id: str,
    continuation: str,
    enqueued_at: datetime,
    jobs: list[dict],
    batches: list[dict],
    reservations: int,
    expected_pages: int,
    resource_samples: list[dict],
) -> dict:
    statuses = Counter(row["status"] for row in jobs)
    ids = [row["id"] for row in jobs]
    queue_seconds = [
        (iso(row["started_at"]) - iso(row["available_at"])).total_seconds()
        for row in jobs
        if row.get("started_at") and row.get("available_at")
    ]
    completions = [iso(row["completed_at"]) for row in jobs if row.get("completed_at")]
    drain_seconds = (
        (max(completions) - enqueued_at).total_seconds() if completions else None
    )
    attempt_seconds = sum(
        float((row.get("render_metrics") or {}).get("attempt_seconds") or 0)
        for row in batches
    )
    outbound_bytes = sum(
        int((row.get("render_metrics") or {}).get("outbound_bytes") or 0)
        for row in batches
    )
    measured_cost = attempt_seconds * STANDARD_DOLLARS_PER_SECOND
    rendered = [row for row in batches if row.get("render_task_run_id")]
    resources = summarize_resources(resource_samples)
    checks = {
        "exact_jobs_once": len(ids) == expected_pages and len(ids) == len(set(ids)),
        "all_jobs_succeeded": statuses.get("succeeded", 0) == expected_pages,
        "queue_below_10_minutes": bool(queue_seconds) and max(queue_seconds) < 600,
        "drain_below_25_minutes": drain_seconds is not None and drain_seconds < 1_500,
        "no_firecrawl_fallback": statuses.get("fallback_required", 0) == 0,
        "no_terminal_failures": statuses.get("terminal_failed", 0) == 0,
        "reservation_budget": reservations <= MAX_RESERVATIONS,
        "measured_cost_below_12": measured_cost <= MAX_TEST_DOLLARS,
        "all_render_metrics_terminal": all(
            row.get("render_terminal") for row in rendered
        ),
        "render_task_retries_disabled": all(
            int((row.get("render_metrics") or {}).get("retry_count") or 0) == 0
            for row in rendered
        ),
        "outbound_measured": outbound_bytes > 0,
        "database_cpu_p95_below_70": resources["cpu_percent_p95"] < 70,
        "database_memory_p95_below_70": resources["memory_percent_p95"] < 70,
    }
    return {
        "gate_b_full_path_pass": all(checks.values()),
        "release": release_id(),
        "run_id": run_id,
        "continuation_key": continuation,
        "checks": checks,
        "counts": {
            "jobs": len(jobs),
            "statuses": dict(statuses),
            "task_runs": len(rendered),
            "reservations": reservations,
            "retried_jobs": sum(int(row.get("attempts", 0)) > 1 for row in jobs),
        },
        "timing_seconds": {
            "queue_max": round(max(queue_seconds), 3) if queue_seconds else None,
            "drain": round(drain_seconds, 3) if drain_seconds is not None else None,
            "task_attempt_total": round(attempt_seconds, 3),
        },
        "outbound_bytes": outbound_bytes,
        "supabase_resources": resources,
        "measured_compute_dollars": round(measured_cost, 4),
    }


def replay_arrivals(args: argparse.Namespace) -> dict:
    export = json.loads(args.arrivals.read_text())
    start = iso(str(export.get("window_start", "")))
    end = iso(str(export.get("window_end", "")))
    if (
        end - start != timedelta(days=7)
        or start.second
        or start.microsecond
        or end.second
        or end.microsecond
    ):
        raise SystemExit("arrival window must be exactly seven aligned UTC days")
    if int(export.get("complete_minutes", 0)) != 7 * 24 * 60:
        raise SystemExit("arrival export must prove 10,080 complete minutes")
    observed_scouts = int(export.get("observed_active_scouts", 0))
    observed_users = int(export.get("observed_users", 0))
    if observed_scouts <= 0 or observed_users <= 0:
        raise SystemExit("arrival export requires measured Scout and user bases")
    rows = export.get("rows")
    if not isinstance(rows, list):
        raise SystemExit("arrival export rows are required")
    minute_counts: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    busiest_utility_day: dict[str, float] = defaultdict(float)
    seen = set()
    for row in rows:
        if set(row) != {"minute", "operation", "workload_class", "count"}:
            raise SystemExit(
                "arrival rows must contain only the content-free counter fields"
            )
        minute = str(row["minute"])
        operation = str(row["operation"])
        workload = str(row["workload_class"])
        count = int(row["count"])
        minute_at = iso(minute)
        key = (minute, operation, workload)
        if (
            key in seen
            or minute_at < start
            or minute_at >= end
            or minute_at.second
            or minute_at.microsecond
            or operation not in {"scrape", "snapshot", "parse_pdf"}
            or workload not in {"scout", "utility", "system"}
            or count < 1
        ):
            raise SystemExit("arrival export contains an invalid or duplicate row")
        seen.add(key)
        scale = (
            10_000 / observed_scouts
            if workload == "scout"
            else 700 / observed_users
            if workload == "utility"
            else 1
        )
        projected = count * scale
        minute_counts[minute][operation] += projected
        if workload == "utility":
            busiest_utility_day[minute[:10]] += projected

    batch_sizes = {"scrape": 20, "parse_pdf": 5, "snapshot": 1}
    per_minute = {"scrape": 22, "parse_pdf": 4, "snapshot": 2}
    queued = defaultdict(float)
    tasks = 0
    projected_jobs = 0.0
    batch_fill = defaultdict(list)
    minute_at = start
    while minute_at < end:
        minute = minute_at.isoformat()
        for operation, count in minute_counts[minute].items():
            queued[operation] += count
            projected_jobs += count
        for operation, allocation in per_minute.items():
            starts = min(
                allocation, math.ceil(queued[operation] / batch_sizes[operation])
            )
            for _ in range(starts):
                fill = min(queued[operation], batch_sizes[operation])
                queued[operation] -= fill
                batch_fill[operation].append(fill)
                tasks += 1
        minute_at += timedelta(minutes=1)
    while any(value > 0 for value in queued.values()):
        for operation, allocation in per_minute.items():
            starts = min(
                allocation, math.ceil(queued[operation] / batch_sizes[operation])
            )
            for _ in range(starts):
                fill = min(queued[operation], batch_sizes[operation])
                queued[operation] -= fill
                batch_fill[operation].append(fill)
                tasks += 1

    full = json.loads(args.full_report.read_text())
    if not full.get("gate_b_full_path_pass"):
        raise SystemExit("Gate B full-path report must pass before cost replay")
    release = str(full.get("release", "")).strip()
    if not release:
        raise SystemExit("full-path report has no release identity")
    measured_pages = int((full.get("counts") or {}).get("jobs", 0))
    outbound_bytes = int(full.get("outbound_bytes", 0))
    if measured_pages <= 0 or outbound_bytes <= 0:
        raise SystemExit("full-path report lacks measured outbound bytes")

    monthly_jobs = projected_jobs * 30 / 7
    monthly_tasks = tasks * 30 / 7
    page_cost = monthly_jobs * GATE_A_SECONDS_PER_PAGE * STANDARD_DOLLARS_PER_SECOND
    startup_cost = (
        monthly_tasks * GATE_A_STARTUP_SECONDS_PER_TASK * STANDARD_DOLLARS_PER_SECOND
    )
    workflow_outbound_gb = (
        outbound_bytes / measured_pages * monthly_jobs / 1_000_000_000
    )
    gross_egress_cost = workflow_outbound_gb * OUTBOUND_OVERAGE_DOLLARS_PER_GB
    monthly_cost = page_cost + startup_cost + gross_egress_cost + 2.00
    report = {
        "arrival_replay_pass": monthly_cost <= 55,
        "release": release,
        "complete_minutes": 10_080,
        "observed_scale": {
            "active_queue_backed_scouts": observed_scouts,
            "registered_users": observed_users,
            "target_active_scouts": 10_000,
            "target_users": 700,
        },
        "projected_700_user_utility_daily_limit": max(
            1,
            math.ceil(max(busiest_utility_day.values(), default=0) * 1.25),
        ),
        "projected_weekly_jobs": round(projected_jobs),
        "projected_weekly_task_runs": tasks,
        "batch_fill": {
            operation: {
                "runs": len(values),
                "mean_jobs": round(sum(values) / len(values), 3) if values else 0,
                "full_runs": sum(value == batch_sizes[operation] for value in values),
            }
            for operation, values in batch_fill.items()
        },
        "projected_monthly_workflow_dollars": round(monthly_cost, 2),
        "monthly_cost_components": {
            "page_compute": round(page_cost, 4),
            "task_startup": round(startup_cost, 4),
            "added_concurrency": 2.00,
            "gross_egress_upper_bound": round(gross_egress_cost, 4),
        },
        "outbound": {
            "measured_bytes_per_job": round(outbound_bytes / measured_pages, 3),
            "projected_workflow_gb": round(workflow_outbound_gb, 6),
            "priced_dollars_per_gb": OUTBOUND_OVERAGE_DOLLARS_PER_GB,
            "included_bandwidth_credit_assumed": False,
        },
    }
    args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return report


def gate_b_verdict(args: argparse.Namespace) -> dict:
    reports = {
        "full": json.loads(args.full.read_text()),
        "faults": json.loads(args.faults.read_text()),
        "security": json.loads(args.security.read_text()),
        "boundaries": json.loads(args.boundaries.read_text()),
        "replay": json.loads(args.replay.read_text()),
    }
    releases = {str(report.get("release", "")).strip() for report in reports.values()}
    releases.discard("")
    reservations = (
        int((reports["full"].get("counts") or {}).get("reservations", 0))
        + int(reports["faults"].get("reservations", 0))
        + int(reports["security"].get("reservations", 0))
    )
    measured_cost = sum(
        float(reports[name].get("measured_compute_dollars", 0))
        for name in ("full", "faults", "security")
    )
    client = GateBClient()
    assert_preflight(client)
    checks = {
        "full_path": reports["full"].get("gate_b_full_path_pass") is True,
        "fault_recovery": reports["faults"].get("gate_b_faults_pass") is True,
        "security": reports["security"].get("gate_b_security_pass") is True,
        "boundaries": reports["boundaries"].get("gate_b_boundaries_pass") is True,
        "seven_day_arrival_replay": reports["replay"].get("arrival_replay_pass") is True
        and reports["replay"].get("complete_minutes") == 10_080,
        "one_release": len(releases) == 1,
        "reservation_budget": reservations <= MAX_RESERVATIONS,
        "measured_test_compute_below_12": measured_cost <= MAX_TEST_DOLLARS,
        "production_routing_still_zero": True,
    }
    report = {
        "gate_b_pass": all(checks.values()),
        "release": next(iter(releases)) if len(releases) == 1 else None,
        "checks": checks,
        "task_run_reservations": reservations,
        "measured_compute_dollars": round(measured_cost, 4),
        "projected_monthly_workflow_dollars": reports["replay"].get(
            "projected_monthly_workflow_dollars"
        ),
    }
    args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return report


def parse_args() -> argparse.Namespace:
    def render_log_limit(value: str) -> int:
        limit = int(value)
        if not 2 <= limit <= 1_000:
            raise argparse.ArgumentTypeError("must be between 2 and 1000")
        return limit

    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    collect = sub.add_parser("collect")
    collect.add_argument("--service-id", required=True)
    collect.add_argument("--start", required=True)
    collect.add_argument("--end", required=True)
    collect.add_argument(
        "--slice-limit",
        type=render_log_limit,
        default=1_000,
        help="Render log limit per request (2-1000; full slices split automatically)",
    )
    collect.add_argument(
        "--report", type=Path, default=Path("/tmp/scoutpost-gate-b-arrivals.json")
    )
    full = sub.add_parser("full")
    full.add_argument("--fixture-url", required=True)
    full.add_argument("--pages", type=int, default=PEAK_PAGES)
    full.add_argument("--fault-reservations", type=int, default=15)
    full.add_argument("--cleanup", action="store_true")
    full.add_argument(
        "--report", type=Path, default=Path("/tmp/scoutpost-gate-b-full.json")
    )
    faults = sub.add_parser("faults")
    faults.add_argument("--fixture-base", required=True)
    faults.add_argument("--cleanup", action="store_true")
    faults.add_argument(
        "--report", type=Path, default=Path("/tmp/scoutpost-gate-b-faults.json")
    )
    boundaries = sub.add_parser("boundaries")
    boundaries.add_argument("--cleanup", action="store_true")
    boundaries.add_argument(
        "--report", type=Path, default=Path("/tmp/scoutpost-gate-b-boundaries.json")
    )
    security = sub.add_parser("security")
    security.add_argument("--fixture-base", required=True)
    security.add_argument("--cleanup", action="store_true")
    security.add_argument(
        "--report", type=Path, default=Path("/tmp/scoutpost-gate-b-security.json")
    )
    replay = sub.add_parser("replay")
    replay.add_argument("--arrivals", type=Path, required=True)
    replay.add_argument("--full-report", type=Path, required=True)
    replay.add_argument(
        "--report", type=Path, default=Path("/tmp/scoutpost-gate-b-replay.json")
    )
    verdict = sub.add_parser("verdict")
    verdict.add_argument("--full", type=Path, required=True)
    verdict.add_argument("--faults", type=Path, required=True)
    verdict.add_argument("--security", type=Path, required=True)
    verdict.add_argument("--boundaries", type=Path, required=True)
    verdict.add_argument("--replay", type=Path, required=True)
    verdict.add_argument(
        "--report", type=Path, default=Path("/tmp/scoutpost-gate-b-verdict.json")
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.command == "collect":
        report = collect_arrivals(args)
    elif args.command == "full":
        if not 1 <= args.pages <= PEAK_PAGES:
            raise SystemExit(f"pages must be 1..{PEAK_PAGES}")
        report = run_full(args)
    elif args.command == "faults":
        report = run_faults(args)
    elif args.command == "boundaries":
        report = run_boundaries(args)
    elif args.command == "security":
        report = run_security(args)
    elif args.command == "verdict":
        report = gate_b_verdict(args)
    else:
        report = replay_arrivals(args)
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
