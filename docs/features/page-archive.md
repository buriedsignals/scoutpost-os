# Page Archive — evidence snapshots (retrieval + toggle)

> **Scope:** how a user or an **agent** turns evidence archiving on/off for a Page
> Scout and retrieves the archived snapshots. The capture/storage/trust internals
> (when a snapshot is written, fidelity tiers, hashing, RLS, deletion) live in
> [`web-scouts.md` → Evidence Archiving](web-scouts.md#evidence-archiving-page-archive).

Page Scouts (type `web`) can archive a **tamper-evident snapshot** of each capture:
the rendered page as **MHTML**, a full-page **screenshot**, **markdown**, a
**manifest** of per-artifact SHA-256 hashes, an **RFC 3161** trusted-timestamp
token (`tsr`), and — unless disabled — a public **Internet Archive / Wayback**
submission. This is how a newsroom proves what a page showed at capture time.

Archiving is **opt-in per scout** and **dark by default** (`archive_enabled`
defaults false). On hosted Scoutpost it is **Pro/Team-only**; self-hosted
deployments have no tier gate.

## Toggling archiving

`archive_enabled` (capture on/off) and `wayback_enabled` (also submit to the public
Wayback Machine; default **true**) are ordinary scout fields set on create or update.
Enabling `archive_enabled` on a free-tier hosted account returns **402**; disabling
is always allowed.

| Surface | Enable on create | Toggle on an existing scout |
|---|---|---|
| **UI** | "Capture evidence snapshots" toggle in the Page Scout schedule dialog (Pro/Team) | — (re-schedule) |
| **CLI** | `scout scouts add --type web --url <url> --archive-enabled true [--wayback-enabled false]` | `scout scouts update <id> --archive-enabled true` |
| **MCP** | `create_scout` with `archive_enabled: true` (+ optional `wayback_enabled`) | `update_scout` with `archive_enabled` / `wayback_enabled` |
| **REST** | `POST /scouts` body `{ "archive_enabled": true }` | `PATCH /scouts/:id` body `{ "archive_enabled": false }` |

## Retrieving snapshots

Two operations, served by the `snapshots` Edge Function (proxied like other EFs —
see [`fastapi-endpoints.md`](../architecture/fastapi-endpoints.md)).

**List** a scout's snapshots — newest first; each row carries `capture_kind`
(`baseline`/`change`), `fidelity` (`full`/`rendered_thirdparty`/`markdown_only`),
`sizes`, `trust` (`tsa_status`, `wayback_status`, `wayback_url`), and the
`artifacts` present:

| Surface | Command / call |
|---|---|
| **CLI** | `scout snapshots list --scout <scout_id>` (add `--json` for the raw envelope) |
| **MCP** | `list_snapshots` with `scout_id` |
| **REST** | `GET /snapshots?scout_id=<id>` (paginated: `offset`, `limit` ≤ 100) |

**Download** one artifact — kinds: `mhtml | screenshot | rawhtml | markdown |
manifest | tsr`. Every download is a content-disposition **attachment** (archived
hostile HTML never renders on the storage origin), via a **5-minute signed URL**:

| Surface | Command / call |
|---|---|
| **CLI** | `scout snapshots download <id> --artifact mhtml -o page.mhtml` (or `scout snapshots url <id> --artifact mhtml` to print the link) |
| **MCP** | `get_snapshot_url` with `id` + `artifact` → `{ url, content_type, expires_in }` |
| **REST** | `POST /snapshots/:id/url` body `{ "artifact": "mhtml" }` |

Requesting an artifact a snapshot doesn't hold (e.g. `mhtml` on a `markdown_only`
capture) returns **404** — list first to see each snapshot's `artifacts`. A
cross-user snapshot id is invisible (RLS) and also 404s.

## Capability map (UI ⇄ agent parity)

Action parity is a hard rule (the agent-native architecture discipline): every UI
action here has an equivalent agent tool, shipped in the same change.

| Capability | UI | CLI | MCP tool | REST |
|---|---|---|---|---|
| Turn archiving on/off | Schedule-dialog toggle (Pro/Team) | `scouts add/update --archive-enabled` | `create_scout`/`update_scout` `archive_enabled` | `POST`/`PATCH /scouts` |
| Toggle Wayback submission | disclosure beside the toggle | `--wayback-enabled` | same, `wayback_enabled` | same |
| List archive history | *(not in UI)* | `scout snapshots list` | `list_snapshots` | `GET /snapshots` |
| Download a snapshot artifact | *(not in UI)* | `scout snapshots download` / `url` | `get_snapshot_url` | `POST /snapshots/:id/url` |

There is deliberately **no snapshot-history UI** yet; retrieval is agent- and
API-first. The email alert for an archiving-enabled scout carries a "View archived
snapshot" link to the scout (see U5).

## What a snapshot does and does not prove

Honest limits — carry this language into any user-facing summary:

- **Proves:** integrity since capture (the manifest's hashes cover the exact stored
  bytes), existence at time **T** (the RFC 3161 token and any Wayback capture bind
  the content hash to a timestamp), and independent third-party corroboration when
  Wayback succeeded.
- **Does not prove:** that a specific person saw this content, nor that every visitor
  saw it (personalization, geo-variance, and bot-served variants are all possible).
  A `rendered_thirdparty` snapshot was captured by an anti-bot fallback renderer, not
  a local render; a `markdown_only` snapshot has no visual artifact at all.

## Verifying a snapshot

A snapshot is self-verifying evidence. The `manifest` records a SHA-256 for every
stored artifact, and the `tsr` is an RFC 3161 timestamp token whose message imprint
is `SHA-256(manifest bytes)`. Two independent checks establish (1) the artifacts are
unchanged since capture and (2) they existed no later than a trusted timestamp T.

Download the artifacts to check plus the `manifest` and `tsr` (UI, `scout snapshots
download`, or `POST /snapshots/:id/url`). Treat `manifest.json` and `snapshot.tsr` as
**raw bytes** — do not reformat the manifest; its hash depends on exact bytes (it is
canonical JSON: sorted keys, no whitespace).

### 1. Artifact integrity — recompute hashes against the manifest

The manifest has a `*_sha256` field per stored artifact. Recompute and compare:

```bash
# hash each artifact you downloaded (cross-platform):
openssl dgst -sha256 page.mhtml screenshot.png content.md
# read the recorded hashes:
python3 -m json.tool < manifest.json      # markdown_sha256, mhtml_sha256, screenshot_sha256, rawhtml_sha256
```

A match proves the artifact's bytes are identical to what was captured. Which fields
are present depends on fidelity: `full` binds `mhtml_sha256` + `screenshot_sha256`;
`rendered_thirdparty` binds `rawhtml_sha256` + `screenshot_sha256`; `markdown_only`
binds `markdown_sha256` alone. `markdown_sha256` is always present.

### 2. Timestamp — verify the token against the manifest

```bash
# what time did the TSA attest?
openssl ts -reply -in snapshot.tsr -text | grep -A1 "Time stamp"

# verify the token binds THIS manifest (needs the TSA's CA chain):
openssl ts -verify -data manifest.json -in snapshot.tsr -CAfile tsa-ca-bundle.pem
#   → "Verification: OK"
```

`openssl ts -verify` hashes `manifest.json` with SHA-256, checks it equals the token's
imprint, then validates the TSA's signature up to `-CAfile`. The signing certificate
chain is embedded in the token (`certReq=true`), so only the trust anchor is external —
fetch the timestamping root+intermediate for the configured TSA (defaults: DigiCert and
Sectigo, both published by the CA). The `.tsr` is stored as a full RFC 3161
`TimeStampResp` (`application/timestamp-reply`), which is what `openssl ts` expects.

A pass means the manifest — and therefore every artifact hash it records — existed at
time T. Combined with step 1, the artifacts themselves existed, unaltered, at T.

### 3. Third-party corroboration (optional)

If the snapshot's `wayback_status` is `success`, open its `wayback_url` (from
`scout snapshots list --json`, or the row's `trust`): an independent public archive (the
Internet Archive) holds its own capture near `captured_at`. This is corroboration by a
party you do not control — not a hash check.

### What a successful verification demonstrates — and what it does not

- **Demonstrates:** the stored artifacts are byte-for-byte unchanged since capture
  (step 1) and existed no later than the TSA's timestamp T (step 2); if Wayback
  succeeded, an independent archive corroborates a capture near that time (step 3).
  Together: *this content existed in this exact form at this time and has not been
  altered since.*
- **Does not demonstrate:** that the captured page is what a human visitor saw
  (personalization, geographic variance, A/B tests, and bot-served variants all diverge
  from a scraper's view); that the source was authentic or unmanipulated upstream; that
  content the scout did not capture did not exist; or anything about a `markdown_only`
  snapshot's visual appearance (no rendered artifact exists). A re-stamp after the fact
  proves only a *later* T — a snapshot never stamped in its capture window cannot be
  retroactively given an earlier one.

The `scout snapshots download` CLI is itself a verification tool: it writes the exact
signed bytes to disk, so the hashes above recompute against the same object the server
stored.
