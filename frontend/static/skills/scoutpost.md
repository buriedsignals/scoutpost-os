---
name: scoutpost
description: >
  Operate Scoutpost through MCP, CLI, or REST: create scouts, search
  information units, export findings, and preserve editorial verification.
---

# Scoutpost skill

You have been connected to **Scoutpost**, a monitoring platform for journalists and newsrooms. A human journalist is using you to create scouts, search findings, and turn emerging developments into organized leads. This document tells you how to use Scoutpost correctly and how to behave around editorial verification.

Read this once. Apply it for every Scoutpost task in this session.

---

## What Scoutpost does

Scoutpost runs scheduled scouts that watch:

- public pages
- local news and beats
- social profiles
- councils, agendas, minutes, and PDFs
- transport: vessels (AIS), aircraft (ADS-B), and satellites

Each run extracts **information units**: atomic, source-linked facts. Units are deduplicated across repeated coverage and land in an editorial inbox.

The journalist stays responsible for verification. Your job is to help monitor, search, organize, summarize, and draft safely.

## The main public concepts

| Concept | Meaning |
|---|---|
| **Page Scout** | Watch one URL for meaningful changes |
| **Beat Scout** | Monitor a beat by topic or geography |
| **Social Scout** | Track social posts and deletions |
| **Civic Scout** | Track council materials, including PDFs and promises |
| **Fleet Scout** | Alert when specific tracked vessels, aircraft, or satellites (an ID watch list, up to 20) enter a watched area |
| **Information unit** | One atomic fact with source and timestamps |
| **Verification** | Human editorial approval before a fact is treated as publishable |
| **Page Archive** | Opt-in tamper-evident evidence snapshots of a Page Scout's captures (MHTML, screenshot, markdown, RFC 3161 timestamp, optional Wayback) |

## How you're connected

Scoutpost is usually exposed to agents through one of these paths:

- **CLI**: the `scout` binary on `$PATH`
- **MCP**: the remote MCP URL shown in the app's Agents modal
- **REST API**: the API base shown in the app's Agents -> API panel

If both CLI and MCP are available, prefer the CLI for shell-capable agents because the commands stay visible in the transcript.

Do not assume a hosted scoutpost.ai endpoint. In self-hosted deployments,
use the newsroom's own Supabase/API/MCP targets from the Agents modal or the
local `scout` config.

## Core workflow

1. Understand what the journalist wants to monitor.
2. Pick the right scout type.
3. Confirm before creating or running anything that spends credits.
4. Use scouts and units to find leads.
5. Treat unverified units as leads, not publishable facts.
6. Surface source URLs and verification state in every summary.

## Operational rules

- Do not auto-run expensive operations without confirmation.
- Always disclose credit spend before running a Civic Scout or a large batch of scouts.
- Never present an unverified unit as confirmed fact.
- Always include source URLs when summarizing findings.
- If units contradict each other, surface the contradiction instead of choosing a side.
- Evidence archiving is opt-in per page scout and Pro/Team-only on hosted Scoutpost; enabling it also submits each snapshot to the public Internet Archive unless the newsroom turns Wayback off. Disclose that before enabling it for someone.

## Useful URLs

- App: open the newsroom Scoutpost URL
- Docs: `/docs` on the deployed app
- Docs text: `/docs.txt` on the deployed app
- FAQ: `/faq` on the deployed app
- Setup skill: `/skills/scoutpost-setup.md` on the deployed app

## CLI and MCP parity

The exact command names vary by surface, but the public contract is:

- list scouts
- create scouts
- inspect a scout
- run, pause, resume, and delete scouts
- list units
- search units
- verify or reject units
- mark units used in an article
- export project material for drafting
- list a page scout's archived evidence snapshots
- download a snapshot artifact (MHTML, screenshot, markdown, manifest, timestamp)
- turn evidence archiving on or off for a page scout

Use whichever surface is connected to your agent. Do not ask the user to switch surfaces unless the current one is actually blocked.

## Page Archive (evidence snapshots)

Page Scouts can archive a tamper-evident snapshot of each capture (the rendered page as MHTML, a screenshot, markdown, an RFC 3161 trusted timestamp, and — unless disabled — a public Internet Archive/Wayback submission). This is how a journalist proves what a page showed at capture time.

**Turn archiving on/off** when creating or updating a page scout:

- CLI: `scout scouts add --type web --url <url> --archive-enabled true [--wayback-enabled false]`, or `scout scouts update <id> --archive-enabled true`
- MCP: `create_scout` / `update_scout` with `archive_enabled: true` (and optional `wayback_enabled`)
- REST: include `"archive_enabled": true` in the `POST /scouts` or `PATCH /scouts/:id` body
- On hosted Scoutpost archiving is Pro/Team-only (a free-tier enable returns 402). Enabling it also submits each snapshot to the public Wayback Machine unless `wayback_enabled` is false.

**List a scout's snapshots** (newest first — capture kind baseline/change, fidelity, trust status, and the artifacts available):

- CLI: `scout snapshots list --scout <scout_id>`
- MCP: `list_snapshots` with `scout_id`
- REST: `GET /snapshots?scout_id=<id>`

**Download one artifact** (`mhtml | screenshot | rawhtml | markdown | manifest | tsr`):

- CLI: `scout snapshots download <snapshot_id> --artifact mhtml -o page.mhtml` (or `scout snapshots url <id> --artifact mhtml` to just print the link)
- MCP: `get_snapshot_url` with `id` + `artifact` → a 5-minute signed download URL
- REST: `POST /snapshots/:id/url` with `{ "artifact": "mhtml" }`

Snapshots exist only for scouts with archiving enabled. Treat an archived snapshot as evidence of what a page showed at the captured time — not proof that a specific person saw it.

## Verification policy

Scoutpost has a deliberate human verification boundary:

- **verified** units are safe to treat as editor-approved facts
- **unverified** units are leads that still need review

When in doubt, say that a claim is unverified and cite the source.

## Setup vs product use

This file is the **product-use** skill. If the user wants to deploy, self-host, or provision Scoutpost, use the setup skill instead:

- https://www.scoutpost.ai/skills/scoutpost-setup.md

## Canonical location

Canonical URL: `https://www.scoutpost.ai/skills/scoutpost.md`

Legacy compatibility URL: `https://www.scoutpost.ai/skill.md`
