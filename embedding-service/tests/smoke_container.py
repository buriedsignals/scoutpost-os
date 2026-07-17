#!/usr/bin/env python3
"""Verify the built container serves the pinned real EmbeddingGemma artifact."""

from __future__ import annotations

import json
import math
import os
import urllib.request


url = os.environ.get("EMBEDDING_SMOKE_URL", "http://127.0.0.1:8080")
token = os.environ.get("EMBEDDING_SERVICE_TOKEN", "ci-token")
request = urllib.request.Request(
    f"{url}/embed",
    data=json.dumps(
        {
            "inputs": [
                {
                    "text": "Zurich council approved the housing budget.",
                    "task_type": "RETRIEVAL_DOCUMENT",
                    "title": "Council minutes",
                }
            ]
        }
    ).encode(),
    headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    },
    method="POST",
)
with urllib.request.urlopen(request, timeout=120) as response:
    body = json.load(response)

assert body["model"] == "embeddinggemma-300m-768-int8-onnx-task-prefix-v1"
assert body["dimensions"] == 768
assert len(body["data"]) == 1
vector = body["data"][0]["embedding"]
assert len(vector) == 768
assert all(math.isfinite(value) for value in vector)
norm = math.sqrt(sum(value * value for value in vector))
assert abs(norm - 1.0) < 1e-4, norm
print(f"real-model smoke passed: dimensions={len(vector)} norm={norm:.6f}")
