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
