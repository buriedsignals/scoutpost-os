"""Per-task outbound proxy with DNS pinning for untrusted crawl targets."""

import asyncio
import ipaddress
import socket
from contextlib import asynccontextmanager
from dataclasses import dataclass
from urllib.parse import urlsplit


class UnsafeDestinationError(RuntimeError):
    pass


def validate_http_target(target: str):
    parsed = urlsplit(target)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise UnsafeDestinationError("unsafe proxy target")
    return parsed


def validate_connect_target(target: str) -> tuple[str, int]:
    host, separator, raw_port = target.rpartition(":")
    if not separator or not host or "@" in host:
        raise UnsafeDestinationError("unsafe CONNECT target")
    port = int(raw_port)
    if not 1 <= port <= 65_535:
        raise UnsafeDestinationError("unsafe CONNECT port")
    return host.strip("[]"), port


def resolve_addresses(host: str, port: int | None = None) -> set[str]:
    return {
        info[4][0]
        for info in socket.getaddrinfo(host, port)
    }


def is_public_address(address: str) -> bool:
    return ipaddress.ip_address(address).is_global


def resolve_global(host: str, port: int) -> str:
    """Resolve once and reject the destination if any answer is non-global."""
    if not host:
        raise UnsafeDestinationError("missing host")
    try:
        addresses = resolve_addresses(host, port)
    except OSError as exc:
        raise UnsafeDestinationError("unresolvable host") from exc
    if not addresses or any(not is_public_address(address) for address in addresses):
        raise UnsafeDestinationError("non-public destination")
    return min(addresses)


async def _relay(  # pragma: no cover - exercised by live Gate B network probes
    source: asyncio.StreamReader,
    target: asyncio.StreamWriter,
    stats: "EgressStats | None" = None,
) -> None:
    try:
        while data := await source.read(65_536):
            if stats is not None:
                stats.outbound_bytes += len(data)
            target.write(data)
            await target.drain()
    finally:
        target.close()


async def _proxy_client(
    client: asyncio.StreamReader,
    reply: asyncio.StreamWriter,
    stats: "EgressStats | None" = None,
) -> None:  # pragma: no cover - exercised by live Gate B network probes
    upstream = None
    try:
        request = await asyncio.wait_for(client.readline(), timeout=10)
        method, target, _version = request.decode("iso-8859-1").strip().split(" ", 2)
        headers: list[bytes] = []
        while line := await asyncio.wait_for(client.readline(), timeout=10):
            headers.append(line)
            if line in (b"\r\n", b"\n"):
                break
        if method.upper() == "CONNECT":
            host, port = validate_connect_target(target)
            address = await asyncio.to_thread(resolve_global, host, port)
            if stats is not None:
                stats.allowed += 1
            upstream_reader, upstream = await asyncio.open_connection(address, port)
            reply.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await reply.drain()
            await asyncio.gather(
                _relay(client, upstream, stats),
                _relay(upstream_reader, reply),
            )
            return
        parsed = validate_http_target(target)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        address = await asyncio.to_thread(resolve_global, parsed.hostname or "", port)
        if stats is not None:
            stats.allowed += 1
        upstream_reader, upstream = await asyncio.open_connection(address, port)
        path = (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else "")
        request_line = f"{method} {path} HTTP/1.1\r\n".encode("iso-8859-1")
        upstream.write(request_line)
        if stats is not None:
            stats.outbound_bytes += len(request_line)
        for line in headers:
            upstream.write(line)
            if stats is not None:
                stats.outbound_bytes += len(line)
        await upstream.drain()
        await asyncio.gather(
            _relay(client, upstream, stats),
            _relay(upstream_reader, reply),
        )
    except (
        UnsafeDestinationError,
        ValueError,
        asyncio.TimeoutError,
        UnicodeDecodeError,
    ):
        if stats is not None:
            stats.blocked += 1
        reply.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
        await reply.drain()
    finally:
        if upstream is not None:
            upstream.close()
        reply.close()


@dataclass
class EgressStats:
    allowed: int = 0
    blocked: int = 0
    outbound_bytes: int = 0


@dataclass(frozen=True)
class GuardedEgress:
    proxy_url: str
    stats: EgressStats


@asynccontextmanager
async def guarded_egress():  # pragma: no cover - live proxy lifecycle
    stats = EgressStats()
    server = await asyncio.start_server(
        lambda reader, writer: _proxy_client(reader, writer, stats),
        host="127.0.0.1",
        port=0,
    )
    port = server.sockets[0].getsockname()[1]
    try:
        yield GuardedEgress(proxy_url=f"http://127.0.0.1:{port}", stats=stats)
    finally:
        server.close()
        await server.wait_closed()
