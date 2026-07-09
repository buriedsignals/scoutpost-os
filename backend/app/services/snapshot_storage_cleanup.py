"""Best-effort cleanup of Page Archive snapshot objects in Supabase Storage.

The `page-snapshots` bucket has no TTL (KTD7) and FK cascades on `scouts`/
`page_snapshots` remove only the DB rows — never the stored objects, which live
outside the Postgres FK graph. The Deno `deleteScoutSnapshots` (called from the
`scouts` Edge Function DELETE route) owns the object side of that contract, but
the FastAPI deletion paths (`/api/v1/scouts/{name}` and the GDPR
`/api/user/delete-account` flow) delete scouts via raw SQL and never invoke it —
so without this sweep every scout/account deleted through FastAPI permanently
orphans its evidence bytes (markdown/mhtml/screenshot/rawhtml/manifest/tsr).

This module reproduces the object sweep over the Supabase Storage REST API using
the service-role key. Objects are content-addressed under
`page-snapshots/{user_id}/{scout_id}/…` (lowercased ids), so a per-scout prefix
sweep collects everything a scout owns.

DEPENDS ON: config.get_settings (Supabase URL + service key)
USED BY: routers/user.py (account deletion), routers/v1.py (scout deletion)
"""
from __future__ import annotations

import logging

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

_BUCKET = "page-snapshots"
_PAGE_LIMIT = 1000
# Backstop against a non-shrinking list (an object the API repeatedly fails to
# remove) spinning forever — mirrors the Deno drain's no-progress guard.
_MAX_PAGES = 100
_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=15.0, pool=5.0)


def _storage_available() -> bool:
    settings = get_settings()
    return bool(settings.supabase_url and settings.supabase_service_key)


async def sweep_scout_snapshots(user_id: str, scout_id: str) -> int:
    """Remove every object under `page-snapshots/{user_id}/{scout_id}/`.

    Best-effort: returns the count of objects removed and never raises. A failure
    here must not abort the surrounding scout/account deletion — the DB rows are
    already gone; a stray object is an orphan to reconcile, not a blocker.
    """
    if not user_id or not scout_id:
        return 0
    if not _storage_available():
        logger.warning(
            "page-snapshots sweep skipped for scout %s: Supabase storage not configured",
            scout_id,
        )
        return 0

    settings = get_settings()
    base = settings.supabase_url.rstrip("/")
    # Object paths are lowercased at write time (snapshotObjectPath) so storage
    # RLS can compare the first folder to auth.uid()::text.
    prefix = f"{user_id.lower()}/{scout_id.lower()}"
    headers = {
        "Authorization": f"Bearer {settings.supabase_service_key}",
        "apikey": settings.supabase_service_key,
        "Content-Type": "application/json",
    }

    removed = 0
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            previous_signature = ""
            for _ in range(_MAX_PAGES):
                list_resp = await client.post(
                    f"{base}/storage/v1/object/list/{_BUCKET}",
                    headers=headers,
                    json={"prefix": prefix, "limit": _PAGE_LIMIT, "offset": 0},
                )
                list_resp.raise_for_status()
                entries = list_resp.json()
                # Only real files (id != null) — folder placeholders have id null.
                names = [
                    e["name"]
                    for e in entries
                    if isinstance(e, dict) and e.get("name") and e.get("id") is not None
                ]
                if not names:
                    break
                signature = "\n".join(sorted(names))
                if signature == previous_signature:
                    logger.error(
                        "page-snapshots sweep made no progress under %s: %d object(s) survive delete",
                        prefix,
                        len(names),
                    )
                    break
                previous_signature = signature
                paths = [f"{prefix}/{name}" for name in names]
                del_resp = await client.request(
                    "DELETE",
                    f"{base}/storage/v1/object/{_BUCKET}",
                    headers=headers,
                    json={"prefixes": paths},
                )
                del_resp.raise_for_status()
                removed += len(paths)
                if len(names) < _PAGE_LIMIT:
                    break
    except Exception as exc:  # noqa: BLE001 - best-effort; never abort deletion
        logger.error(
            "page-snapshots sweep failed for scout %s (user %s) after removing %d object(s): %s",
            scout_id,
            user_id,
            removed,
            exc,
        )
        return removed

    if removed:
        logger.info(
            "page-snapshots sweep removed %d object(s) for scout %s (user %s)",
            removed,
            scout_id,
            user_id,
        )
    return removed
