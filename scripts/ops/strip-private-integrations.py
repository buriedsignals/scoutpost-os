#!/usr/bin/env python3
"""Remove private integration material and fail closed on unmarked references.

Called from strip-oss.sh in a disposable export, never from a working checkout.
The two strip tools are the only reference-scan exceptions: they describe the
exclusion policy, not the private product. Dependency stores and VCS internals
are not exported source. Build outputs are removed rather than exempted.
"""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import sys
import zipfile


ROOT = Path.cwd()
CONTROL_FILES = {
    "scripts/ops/strip-oss.sh",
    "scripts/ops/strip-private-integrations.py",
}
SKIP_DIRECTORIES = {".git", ".jj", "node_modules", ".venv", "venv"}
PRIVATE_ROOTS = (
    "integrations",
    "supabase/functions/page-integrations",
    "frontend/src/routes/integrations",
    "frontend/src/lib/integrations",
    "frontend/src/lib/components/integrations",
    "frontend/src/tests/integrations",
    "backend/app/routers/page_integrations_proxy.py",
    "backend/tests/unit/api/test_page_integrations_proxy.py",
    "docs/integrations",
)
GENERATED_ROOTS = (
    "frontend/.svelte-kit",
    "frontend/build",
    "frontend/src/lib/paraglide",
)
# These shared hooks are mandatory, not best-effort regex replacements. Other
# retained files (for example agent guidance) can carry the same bounded blocks.
REQUIRED_HOOK_COUNTS = {
    "backend/app/main.py": 4,
    "frontend/src/lib/utils/auth-return.ts": 2,
    "frontend/src/routes/+layout.svelte": 1,
    "frontend/src/lib/components/modals/PreferencesModal.svelte": 2,
    "frontend/vite.config.ts": 2,
    "supabase/config.toml": 1,
    ".github/workflows/ci.yml": 1,
}
PUBLIC_FILES = (
    "supabase/functions/scouts/index.ts",
    "supabase/functions/scouts/handlers.ts",
    "supabase/functions/_shared/auth.ts",
    "supabase/functions/mcp-server/index.ts",
    "supabase/functions/cli-auth/index.ts",
    "backend/app/routers/public_edge_proxy.py",
    "frontend/src/lib/utils/auth-return.ts",
    "frontend/src/routes/cli/authorize/+page.svelte",
    "cli/scout.ts",
    "mcp/scout-mcp.ts",
)
PRIVATE_NAME = re.compile(
    r"page[-_](?:scout[-_])?integrations|scoutpost[-_](?:chrome|chatgpt)|ConnectedIntegrations",
    re.IGNORECASE,
)
PRIVATE_REFERENCE = re.compile(
    rb"page[-_ ]?(?:scout[-_ ]?)?integrations|scoutpost[-_](?:chrome|chatgpt)|"
    rb"SAAS_PAGE_INTEGRATIONS_|ConnectedIntegrations|(?:^|[\"'$`])/?integrations/|"
    rb"\$lib/integrations/|/integrations/authorize\b|"
    rb"page:(?:probe|create|creation-status)|"
    rb"(?:test_page_scout|create_page_scout|get_page_scout_creation)",
    re.IGNORECASE,
)
MARKER_TOKEN = "SAAS_PAGE_INTEGRATIONS_"
MARKER = re.compile(
    r"\s*(?://\s*SAAS_PAGE_INTEGRATIONS_(BEGIN|END)|"
    r"\#\s*SAAS_PAGE_INTEGRATIONS_(BEGIN|END)|"
    r"/\*\s*SAAS_PAGE_INTEGRATIONS_(BEGIN|END)\s*\*/|"
    r"<!--\s*SAAS_PAGE_INTEGRATIONS_(BEGIN|END)\s*-->)\s*"
)


def entries():
    """Walk ignored build/artifact paths too, without following any symlinks."""
    for directory, directories, files in os.walk(ROOT, followlinks=False):
        directories[:] = sorted(name for name in directories if name not in SKIP_DIRECTORIES)
        for name in directories + sorted(files):
            yield Path(directory) / name


def relative(path):
    return path.relative_to(ROOT).as_posix()


def private_path(path):
    name = relative(path)
    return any(name == root or name.startswith(root + "/") for root in PRIVATE_ROOTS) or bool(
        PRIVATE_NAME.search(name)
    )


def remove(path):
    # unlink removes the link itself; never traverse a private symlink target.
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def has_private_bytes(stream):
    overlap = b""
    while chunk := stream.read(64 * 1024):
        if PRIVATE_REFERENCE.search(overlap + chunk):
            return True
        overlap = chunk[-256:]
    return False


def private_archive(path):
    if path.suffix.lower() not in {".zip", ".crx"}:
        return False
    try:
        # zipfile also understands the ZIP payload following a CRX header.
        with zipfile.ZipFile(path) as archive:
            for member in archive.infolist():
                if PRIVATE_REFERENCE.search(member.filename.encode()):
                    return True
                if not member.is_dir():
                    with archive.open(member) as source:
                        if has_private_bytes(source):
                            return True
    except (OSError, RuntimeError, zipfile.BadZipFile) as error:
        raise ValueError(f"Cannot inspect release archive {relative(path)}: {error}") from error
    return False


def strip_blocks(path):
    original = path.read_bytes()
    if MARKER_TOKEN.encode() not in original:
        return 0
    source = original.decode("utf-8")
    kept = []
    block = None
    seen = set()
    for number, line in enumerate(source.splitlines(keepends=True), 1):
        marker = MARKER.fullmatch(line)
        if MARKER_TOKEN in line and marker is None:
            raise ValueError(f"{relative(path)}:{number}: marker must be a standalone comment")
        if marker:
            kind = next(group for group in marker.groups() if group is not None)
            if kind == "BEGIN":
                if block is not None:
                    raise ValueError(f"{relative(path)}:{number}: nested or duplicate BEGIN")
                block = []
            else:
                if block is None:
                    raise ValueError(f"{relative(path)}:{number}: END without BEGIN")
                body = "".join(block).strip()
                if not body or body in seen:
                    raise ValueError(f"{relative(path)}:{number}: empty or duplicate private block")
                seen.add(body)
                block = None
        elif block is None:
            kept.append(line)
        else:
            block.append(line)
    if block is not None:
        raise ValueError(f"{relative(path)}: unterminated private block")
    path.write_bytes("".join(kept).encode("utf-8"))
    return len(seen)


def strip():
    for name in (*PRIVATE_ROOTS, *GENERATED_ROOTS):
        remove(ROOT / name)
    # Delete named migrations, dedicated tests/docs/workflows, and copied
    # release archives even when they are outside the normal package roots.
    for path in sorted(entries(), key=lambda entry: len(entry.parts), reverse=True):
        if private_path(path):
            remove(path)
        elif not path.is_symlink() and path.is_file() and private_archive(path):
            remove(path)

    marked = {}
    for path in entries():
        if path.is_symlink() or not path.is_file() or relative(path) in CONTROL_FILES:
            continue
        marked[relative(path)] = strip_blocks(path)
    for name, expected in REQUIRED_HOOK_COUNTS.items():
        actual = marked.get(name, 0)
        if actual != expected:
            raise ValueError(f"{name}: expected {expected} private blocks, found {actual}")

    for path in (ROOT / "frontend/messages").glob("*.json"):
        if path.is_symlink():
            raise ValueError(f"Refusing to rewrite translation symlink: {relative(path)}")
        messages = json.loads(path.read_text())
        public = {key: value for key, value in messages.items() if not key.startswith("pageIntegrations_")}
        if public != messages:
            path.write_text(json.dumps(public, ensure_ascii=False, indent=2) + "\n")
    print("Private packages, shared hooks, translations, and generated outputs removed")


def check():
    failures = []
    for path in entries():
        name = relative(path)
        if name in CONTROL_FILES:
            continue
        if private_path(path):
            failures.append(f"private path remains: {name}")
        if path.is_symlink():
            target = os.readlink(path)
            if PRIVATE_REFERENCE.search(target.encode()):
                failures.append(f"private symlink target remains: {name}")
            # A retained import or guidance link must not point into removed
            # material (or out of the export into the private checkout).
            if not path.exists() or not path.resolve().is_relative_to(ROOT):
                failures.append(f"dangling or external symlink: {name}")
        elif path.is_file():
            with path.open("rb") as source:
                if has_private_bytes(source):
                    failures.append(f"private reference remains: {name}")
            if private_archive(path):
                failures.append(f"private release archive remains: {name}")
    for name in PUBLIC_FILES:
        if not (ROOT / name).is_file():
            failures.append(f"public Page/MCP/CLI seam was removed: {name}")
    config = (ROOT / "supabase/config.toml").read_text()
    for function in ("scouts", "mcp-server", "cli-auth"):
        if f"[functions.{function}]" not in config:
            failures.append(f"public function configuration was removed: {function}")
    if failures:
        raise ValueError("\n".join(failures))
    print("Private integration exclusion and retained Page/MCP/CLI boundary validated")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("strip", "check"))
    operation = parser.parse_args().operation
    try:
        strip() if operation == "strip" else check()
    except (OSError, UnicodeError, ValueError) as error:
        print(f"OSS integration boundary failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
