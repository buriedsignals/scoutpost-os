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

Action parity is a hard rule ([`ce-agent-native-architecture`](../../../kit/compound-engineering/skills/ce-agent-native-architecture/SKILL.md)):
every UI action here has an equivalent agent tool, shipped in the same change.

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

The `tsr` + `manifest` artifacts make the timestamp externally verifiable
(`openssl ts -verify` against the manifest hash); the full verification procedure
lives in this doc's companion section once the trust layer is user-exposed.
