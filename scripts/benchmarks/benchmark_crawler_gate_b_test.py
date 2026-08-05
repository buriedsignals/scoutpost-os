import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("benchmark-crawler-gate-b.py")
SPEC = importlib.util.spec_from_file_location("benchmark_crawler_gate_b", SCRIPT)
gate_b = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate_b)


def sample(cpu_seconds: float) -> dict:
    return {
        "memory_percent": 10.0,
        "cpu_seconds": {"user": cpu_seconds, "idle": cpu_seconds},
    }


class GateBReportTest(unittest.TestCase):
    def test_cached_samples_do_not_count_as_intervals(self) -> None:
        samples = [sample(0), sample(0), sample(1), sample(2)]

        self.assertEqual(len(gate_b.cpu_percent_intervals(samples)), 2)

    def test_full_report_can_be_rebuilt_without_network_calls(self) -> None:
        inputs = {
            "run_id": "run-one",
            "release": "test-release",
            "continuation_key": "gate-b:run-one",
            "enqueued_at": "2026-08-05T10:00:00+00:00",
            "jobs": [{
                "id": "job-one",
                "batch_id": "batch-one",
                "status": "succeeded",
                "attempts": 1,
                "available_at": "2026-08-05T10:00:00+00:00",
                "started_at": "2026-08-05T10:00:01+00:00",
                "completed_at": "2026-08-05T10:00:02+00:00",
                "error_class": None,
            }],
            "batches": [{
                "id": "batch-one",
                "render_task_run_id": "trn-one",
                "render_terminal": True,
                "render_metrics": {
                    "attempt_seconds": 1,
                    "outbound_bytes": 1,
                    "retry_count": 0,
                },
            }],
            "reservations": 1,
            "expected_pages": 1,
            "resource_samples": [sample(0), sample(1), sample(2)],
        }
        with tempfile.TemporaryDirectory() as directory:
            inputs_path = Path(directory) / "inputs.json"
            report_path = Path(directory) / "report.json"
            inputs_path.write_text(json.dumps(inputs))
            args = SimpleNamespace(inputs=inputs_path, report=report_path)

            with patch.dict("os.environ", {"GATE_B_RELEASE": "test-release"}):
                report = gate_b.run_full_report(args)

            self.assertTrue(report["gate_b_full_path_pass"])
            self.assertEqual(json.loads(report_path.read_text()), report)

    def test_full_report_refresh_only_reads_evidence(self) -> None:
        inputs = {
            "run_id": "run-one",
            "release": "test-release",
            "continuation_key": "gate-b:run-one",
            "enqueued_at": "2026-08-05T10:00:00+00:00",
            "jobs": None,
            "batches": None,
            "batch_ids": [],
            "reservations": 1,
            "expected_pages": 1,
            "resource_samples": [sample(0), sample(1), sample(2)],
        }
        jobs = [{
            "id": "job-one",
            "batch_id": "batch-one",
            "status": "succeeded",
            "attempts": 1,
            "available_at": "2026-08-05T10:00:00+00:00",
            "started_at": "2026-08-05T10:00:01+00:00",
            "completed_at": "2026-08-05T10:00:02+00:00",
            "error_class": None,
        }]
        batches = [{
            "id": "batch-one",
            "render_task_run_id": "trn-one",
            "render_terminal": True,
            "render_metrics": {
                "attempt_seconds": 1,
                "outbound_bytes": 1,
                "retry_count": 0,
            },
        }]

        class ReadOnlyClient:
            def rpc(self, _name):
                return [{
                    "recurring_cron_exists": False,
                    "workflow_scout_runs": 0,
                    "unpinned_scout_runs": 0,
                }]

            def rows(self, _table, *, params):
                return jobs

            def batch_rows(self, batch_ids):
                self.batch_ids = batch_ids
                return batches

            def dispatch(self, _mode):
                raise AssertionError("refresh must not dispatch")

        client = ReadOnlyClient()
        with tempfile.TemporaryDirectory() as directory:
            inputs_path = Path(directory) / "inputs.json"
            report_path = Path(directory) / "report.json"
            inputs_path.write_text(json.dumps(inputs))
            args = SimpleNamespace(
                inputs=inputs_path,
                report=report_path,
                refresh=True,
            )

            with (
                patch.object(gate_b, "GateBClient", return_value=client),
                patch.dict("os.environ", {"GATE_B_RELEASE": "test-release"}),
            ):
                report = gate_b.run_full_report(args)

            self.assertTrue(report["gate_b_full_path_pass"])
            self.assertEqual(client.batch_ids, {"batch-one"})

    def test_all_task_start_outcomes_count_toward_liability(self) -> None:
        self.assertEqual(
            gate_b.reservation_count(
                {"submitted": 2, "released": 3, "ambiguous": 4}
            ),
            9,
        )


if __name__ == "__main__":
    unittest.main()
