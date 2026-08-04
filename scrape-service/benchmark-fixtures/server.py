"""Disposable owned-origin fixture for the Gate B fault and SSRF suites."""

import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

_seen: dict[str, int] = {}
_lock = threading.Lock()
_stable = b"""<!doctype html><title>Scoutpost Gate B</title>
<main><h1>Owned crawler fixture</h1><p>stable fixture content v1</p></main>"""
_network = b"""<!doctype html><title>Scoutpost Gate B network</title>
<main><h1>Network isolation fixture</h1><p>public content remains readable</p></main>
<script>
for (const target of ['http://127.0.0.1:9/private',
                      'http://10.0.0.1/private',
                      'http://169.254.169.254/latest/meta-data/']) {
  const image = new Image(); image.src = target; document.body.append(image);
  fetch(target).catch(() => {});
}
try { new WebSocket('ws://127.0.0.1:9/socket'); } catch (_) {}
</script>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/health":
            self._send(200, b"ok", "text/plain")
            return
        if path.startswith("/flaky-502/") and self._first(path):
            self._send(502, b"temporary fixture failure", "text/plain")
            return
        if path.startswith("/flaky-timeout/") and self._first(path):
            time.sleep(3)
        if path == "/network":
            self._send(200, _network, "text/html; charset=utf-8")
            return
        if path == "/redirect-private":
            self.send_response(302)
            self.send_header("Location", "http://169.254.169.254/latest/meta-data/")
            self.end_headers()
            return
        self._send(200, _stable, "text/html; charset=utf-8")

    def _first(self, key: str) -> bool:
        with _lock:
            count = _seen.get(key, 0)
            _seen[key] = count + 1
            return count == 0

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def log_message(self, _format: str, *_args: object) -> None:
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(
        ("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler
    )
    server.serve_forever()
