import importlib.util
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import pytest


SCRIPT = Path(__file__).parents[2] / "scripts/benchmarks/benchmark-crawler-gate-b.py"
SPEC = importlib.util.spec_from_file_location("gate_b_driver", SCRIPT)
assert SPEC and SPEC.loader
gate_b = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate_b)


def stamp(minute: int) -> str:
    return (
        '{"id":"%s","message":"{\\"minute\\":\\"2026-08-04T00:%02d:00Z\\"}"}'
        % (minute, minute)
    )


def fake_result(records: list[str]) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(
        args=[], returncode=0, stdout="\n".join(records), stderr=""
    )


def test_render_logs_split_at_provider_limit(monkeypatch):
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        start = datetime.fromisoformat(command[command.index("--start") + 1])
        end = datetime.fromisoformat(command[command.index("--end") + 1])
        if end - start > gate_b.timedelta(minutes=1):
            return fake_result([stamp(index) for index in range(2)])
        return fake_result([stamp(start.minute)])

    monkeypatch.setattr(gate_b.subprocess, "run", run)
    records = gate_b.fetch_render_logs(
        "srv-test",
        datetime(2026, 8, 4, tzinfo=timezone.utc),
        datetime(2026, 8, 4, 0, 4, tzinfo=timezone.utc),
        2,
    )

    assert len(records) == 4
    assert len(calls) == 7
    assert all(command[command.index("--limit") + 1] == "2" for command in calls)


def test_render_logs_fail_when_one_minute_is_saturated(monkeypatch):
    monkeypatch.setattr(
        gate_b.subprocess,
        "run",
        lambda *args, **kwargs: fake_result([stamp(0), stamp(1)]),
    )

    with pytest.raises(RuntimeError, match="one-minute slice"):
        gate_b.fetch_render_logs(
            "srv-test",
            datetime(2026, 8, 4, tzinfo=timezone.utc),
            datetime(2026, 8, 4, 0, 1, tzinfo=timezone.utc),
            2,
        )
