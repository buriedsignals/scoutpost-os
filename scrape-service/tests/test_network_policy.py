import socket

import pytest
from app import network_policy


def test_resolve_global_pins_single_public_address(monkeypatch):
    monkeypatch.setattr(
        network_policy.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(socket.AF_INET, 0, 0, "", ("93.184.216.34", 0))],
    )
    assert network_policy.resolve_global("example.org", 443) == "93.184.216.34"


def test_resolve_global_prefers_public_ipv4_when_both_families_resolve(monkeypatch):
    monkeypatch.setattr(
        network_policy.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (socket.AF_INET6, 0, 0, "", ("2606:2800:220:1:248:1893:25c8:1946", 0)),
            (socket.AF_INET, 0, 0, "", ("93.184.216.34", 0)),
        ],
    )
    assert network_policy.resolve_global("example.org", 443) == "93.184.216.34"


def test_proxy_targets_allow_only_credential_free_http():
    assert network_policy.validate_http_target("https://example.org/path").hostname == (
        "example.org"
    )
    assert network_policy.validate_connect_target("example.org:443") == (
        "example.org",
        443,
    )
    for target in (
        "ws://example.org/socket",
        "https://user:secret@example.org/",
        "file:///etc/passwd",
    ):
        with pytest.raises(network_policy.UnsafeDestinationError):
            network_policy.validate_http_target(target)
    for target in ("example.org", "user@example.org:443", "example.org:99999"):
        with pytest.raises((network_policy.UnsafeDestinationError, ValueError)):
            network_policy.validate_connect_target(target)


def test_resolve_global_rejects_missing_unresolvable_and_empty(monkeypatch):
    with pytest.raises(network_policy.UnsafeDestinationError, match="missing"):
        network_policy.resolve_global("", 443)
    monkeypatch.setattr(
        network_policy.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("dns")),
    )
    with pytest.raises(network_policy.UnsafeDestinationError, match="unresolvable"):
        network_policy.resolve_global("example.org", 443)
    monkeypatch.setattr(
        network_policy.socket, "getaddrinfo", lambda *_args, **_kwargs: []
    )
    with pytest.raises(network_policy.UnsafeDestinationError, match="non-public"):
        network_policy.resolve_global("example.org", 443)


@pytest.mark.parametrize("address", ["127.0.0.1", "10.0.0.1", "169.254.169.254"])
def test_resolve_global_rejects_non_public_or_mixed_answers(monkeypatch, address):
    monkeypatch.setattr(
        network_policy.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (socket.AF_INET, 0, 0, "", ("93.184.216.34", 0)),
            (socket.AF_INET, 0, 0, "", (address, 0)),
        ],
    )
    with pytest.raises(network_policy.UnsafeDestinationError):
        network_policy.resolve_global("example.org", 443)


async def test_guarded_egress_blocks_loopback_connect(monkeypatch):
    monkeypatch.setattr(
        network_policy.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(socket.AF_INET, 0, 0, "", ("127.0.0.1", 0))],
    )
    async with network_policy.guarded_egress() as egress:
        port = int(egress.proxy_url.rsplit(":", 1)[1])
        reader, writer = await network_policy.asyncio.open_connection("127.0.0.1", port)
        writer.write(b"CONNECT 127.0.0.1:80 HTTP/1.1\r\n\r\n")
        await writer.drain()
        response = await reader.read()
        writer.close()
        await writer.wait_closed()

        assert response.startswith(b"HTTP/1.1 403")
        assert egress.stats.blocked == 1
        assert egress.stats.allowed == 0


async def test_guarded_egress_contains_public_upstream_socket_failure(monkeypatch):
    monkeypatch.setattr(
        network_policy.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(socket.AF_INET, 0, 0, "", ("93.184.216.34", 0))],
    )

    async def fail_connect(*_args, **_kwargs):
        raise OSError("network unreachable")

    monkeypatch.setattr(network_policy.asyncio, "open_connection", fail_connect)
    replies = []

    class FakeReader:
        def __init__(self):
            self.lines = iter(
                [
                    b"CONNECT example.org:443 HTTP/1.1\r\n",
                    b"\r\n",
                ]
            )

        async def readline(self):
            return next(self.lines, b"")

    class FakeWriter:
        def write(self, data):
            replies.append(data)

        async def drain(self):
            pass

        def close(self):
            pass

    stats = network_policy.EgressStats()
    await network_policy._proxy_client(FakeReader(), FakeWriter(), stats)

    assert b"502 Bad Gateway" in b"".join(replies)
    assert stats.blocked == 0
    assert stats.allowed == 1


async def _pinned_upstream(monkeypatch, handler):
    """Resolve every host to one public address and route the proxy's upstream
    connection to a loopback server, recording the address the proxy dialled.
    Returns (dialled, real_open_connection, server)."""
    monkeypatch.setattr(
        network_policy.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(socket.AF_INET, 0, 0, "", ("93.184.216.34", 0))],
    )
    real_open_connection = network_policy.asyncio.open_connection
    server = await network_policy.asyncio.start_server(handler, host="127.0.0.1", port=0)
    upstream_port = server.sockets[0].getsockname()[1]
    dialled = []

    async def open_pinned(host, port, **kwargs):
        dialled.append((host, port))
        return await real_open_connection("127.0.0.1", upstream_port, **kwargs)

    monkeypatch.setattr(network_policy.asyncio, "open_connection", open_pinned)
    return dialled, real_open_connection, server


async def test_guarded_egress_tunnels_connect_only_to_the_pinned_address(monkeypatch):
    received = []

    async def upstream(reader, writer):
        received.append(await reader.readexactly(4))
        writer.write(b"pong")
        await writer.drain()
        writer.close()

    dialled, real_open_connection, server = await _pinned_upstream(monkeypatch, upstream)
    async with server, network_policy.guarded_egress() as egress:
        port = int(egress.proxy_url.rsplit(":", 1)[1])
        reader, writer = await real_open_connection("127.0.0.1", port)
        writer.write(b"CONNECT rebinding.example:443 HTTP/1.1\r\nHost: x\r\n\r\n")
        await writer.drain()
        established = await reader.readuntil(b"\r\n\r\n")
        writer.write(b"ping")
        await writer.drain()
        tunnelled = await reader.read()
        writer.close()
        await writer.wait_closed()

    # The tunnel dials the address validated at resolve time, never the
    # hostname, so a second (rebinding) DNS answer cannot redirect it.
    assert dialled == [("93.184.216.34", 443)]
    assert established == b"HTTP/1.1 200 Connection Established\r\n\r\n"
    assert received == [b"ping"]
    assert tunnelled == b"pong"
    assert egress.stats.allowed == 1
    assert egress.stats.blocked == 0
    assert egress.stats.outbound_bytes == len(b"ping")


async def test_guarded_egress_forwards_plain_http_in_origin_form_to_the_pinned_address(
    monkeypatch,
):
    received = []

    async def upstream(reader, writer):
        received.append(await reader.readuntil(b"\r\n\r\n"))
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
        await writer.drain()
        writer.close()

    dialled, real_open_connection, server = await _pinned_upstream(monkeypatch, upstream)
    headers = b"Host: rebinding.example:8080\r\nAccept: */*\r\n\r\n"
    async with server, network_policy.guarded_egress() as egress:
        port = int(egress.proxy_url.rsplit(":", 1)[1])
        reader, writer = await real_open_connection("127.0.0.1", port)
        writer.write(b"GET http://rebinding.example:8080/a/b?q=1 HTTP/1.1\r\n" + headers)
        await writer.drain()
        response = await reader.read()
        writer.close()
        await writer.wait_closed()

    request_line = b"GET /a/b?q=1 HTTP/1.1\r\n"
    assert dialled == [("93.184.216.34", 8080)]
    assert received == [request_line + headers]
    assert response == b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"
    assert egress.stats.allowed == 1
    assert egress.stats.outbound_bytes == len(request_line) + len(headers)
