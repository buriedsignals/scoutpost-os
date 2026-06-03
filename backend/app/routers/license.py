"""License key validation and setup-guide delivery.

PURPOSE: Two endpoints for license key lifecycle:
- POST /license/validate — validates a license key (public, rate limited)
- POST /license/setup-guide — returns gated setup files for valid keys

DEPENDS ON: services/license_key_service.py
USED BY: legacy/private automation checks

No authentication required on /license/validate — the key IS the credential.
"""
import functools
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.services.license_key_service import LicenseKeyService

router = APIRouter()

# Rate limiter for validation endpoint — prevents brute force
limiter = Limiter(key_func=get_remote_address)


def _validate_license_key(key: str) -> tuple[dict | None, JSONResponse | None]:
    """Validate a license key. Returns (record, None) on success or (None, error_response) on failure."""
    service = LicenseKeyService()
    record = service.validate_key(key)

    if not record:
        return None, JSONResponse(
            status_code=403,
            content={"valid": False, "error": "Invalid license key"},
        )

    expires_at = datetime.fromisoformat(record["expires_at"])
    if datetime.now(timezone.utc) > expires_at:
        return None, JSONResponse(
            status_code=403,
            content={"valid": False, "error": "License expired", "expired_at": record["expires_at"]},
        )

    status = record.get("status", "active")
    if status == "revoked":
        return None, JSONResponse(
            status_code=403,
            content={"valid": False, "error": "License revoked"},
        )

    return record, None


@router.post("/license/validate")
@limiter.limit("10/minute")
async def validate_license(request: Request):
    """Validate a license key.

    Accepts JSON body: {"key": "cjl_..."}

    Returns:
        200 with metadata if valid and not expired.
        403 if invalid, expired, or revoked.

    No authentication required — the key IS the credential.
    Rate limited to 10/minute per IP to prevent brute force.
    """
    body = await request.json()
    key = body.get("key", "")
    record, error = _validate_license_key(key)
    if error:
        return error

    status = record.get("status", "active")
    return {
        "valid": True,
        "status": status,
        "expires_at": record["expires_at"],
        "customer_email": record.get("customer_email"),
    }


def _resolve_gated_file(name: str) -> str:
    """Resolve a gated file from automation/ or deploy/ directories.

    Checks three locations in order:
    1. Production Dockerfile: files copied to backend/app/{name} (same dir as this code)
    2. Docker Compose dev: directories mounted at /app/automation and /app/deploy
    3. Local dev (no Docker): repo root automation/ and deploy/ directories
    """
    # 1. Production: Dockerfile COPYs files directly alongside app code
    app_dir = Path(__file__).resolve().parent.parent
    direct_path = app_dir / name
    if direct_path.exists() and direct_path.stat().st_size > 0:
        return direct_path.read_text()

    # 2 & 3: Map filenames to canonical paths under automation/ or deploy/
    file_map = {
        "SETUP_AGENT.md": "automation/SETUP_AGENT.md",
        "setup.sh": "automation/setup.sh",
        "sync-upstream.yml": "automation/sync-upstream.yml",
        "render.yaml": "deploy/render/render.yaml",
        "SETUP.md": "deploy/SETUP.md",
    }
    rel_path = file_map.get(name)
    if not rel_path:
        return ""

    # Docker Compose dev: directories mounted at /app/
    docker_base = Path("/app")
    if (docker_base / rel_path).exists():
        return (docker_base / rel_path).read_text()

    # Local dev: repo root (4 levels up from this file)
    repo_root = Path(__file__).resolve().parent.parent.parent.parent
    if (repo_root / rel_path).exists():
        return (repo_root / rel_path).read_text()

    return ""


@functools.lru_cache(maxsize=1)
def _load_gated_files() -> dict[str, str]:
    """Load all license-gated files (cached for process lifetime)."""
    names = ["SETUP_AGENT.md", "render.yaml", "setup.sh", "sync-upstream.yml", "SETUP.md"]
    return {name: _resolve_gated_file(name) for name in names}


@router.post("/license/setup-guide")
@limiter.limit("5/minute")
async def download_setup_guide(request: Request):
    """Download license-gated deployment files after license key validation.

    Accepts JSON body: {"key": "cjl_..."}

    Query params:
        ?file=SETUP_AGENT.md  — return single file as raw text
        (no param)            — return all files as JSON bundle

    Rate limited to 5/minute per IP.
    """
    body = await request.json()
    key = body.get("key", "")
    record, error = _validate_license_key(key)
    if error:
        return error

    # Single file mode: return raw content (no jq needed)
    requested_file = request.query_params.get("file")
    if requested_file:
        files = _load_gated_files()
        if requested_file not in files or not files[requested_file]:
            return JSONResponse(
                status_code=404,
                content={"error": f"File not found: {requested_file}"},
            )
        return Response(content=files[requested_file], media_type="text/plain")

    # Bundle mode: return all files as JSON (for frontend download button)
    files = _load_gated_files()
    if not any(files.values()):
        return JSONResponse(
            status_code=503,
            content={"error": "Setup files not available"},
        )

    return {"files": files}
