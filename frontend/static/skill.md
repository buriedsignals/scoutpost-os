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

Each run extracts **information units**: atomic, source-linked facts. Units are deduplicated across repeated coverage and land in an editorial inbox.

The journalist stays responsible for verification. Your job is to help monitor, search, organize, summarize, and draft safely.

## The main public concepts

| Concept | Meaning |
|---|---|
| **Page Scout** | Watch one URL for meaningful changes |
| **Beat Scout** | Monitor a beat by topic or geography |
| **Social Scout** | Track social posts and deletions |
| **Civic Scout** | Track council materials, including PDFs and promises |
| **Information unit** | One atomic fact with source and timestamps |
| **Verification** | Human editorial approval before a fact is treated as publishable |
| **Page Archive** | Opt-in tamper-evident evidence snapshots of a Page Scout's captures (MHTML, screenshot, markdown, RFC 3161 timestamp, optional Wayback) |

## How you're connected

Scoutpost is usually exposed to agents through one of these paths:

- **CLI**: the `scout` binary on `$PATH`
- **MCP**: remote MCP at `https://www.scoutpost.ai/mcp`
- **REST API**: public HTTP surface documented at `https://www.scoutpost.ai/swagger`

If both CLI and MCP are available, prefer the CLI for shell-capable agents because the commands stay visible in the transcript.

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

## Useful URLs

- App: https://www.scoutpost.ai/login
- Docs: https://www.scoutpost.ai/docs
- Docs text: https://www.scoutpost.ai/docs.txt
- Pricing: https://www.scoutpost.ai/pricing
- FAQ: https://www.scoutpost.ai/faq
- Setup skill: https://www.scoutpost.ai/skills/scoutpost-setup.md

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
- On hosted Scoutpost archiving is Pro/Team-only (a free-tier enable returns 403 archive_forbidden). Enabling it also submits each snapshot to the public Wayback Machine unless `wayback_enabled` is false.

**List a scout's snapshots** (newest first):

- CLI: `scout snapshots list --scout <scout_id>`
- MCP: `list_snapshots` with `scout_id`
- REST: `GET /snapshots?scout_id=<id>`

**Download one artifact** (`mhtml | screenshot | rawhtml | markdown | manifest | tsr`):

- CLI: `scout snapshots download <snapshot_id> --artifact mhtml -o page.mhtml` (or `scout snapshots url <id> --artifact mhtml` to just print the link)
- MCP: `get_snapshot_url` with `id` + `artifact` → a 5-minute signed download URL
- REST: `POST /snapshots/:id/url` with `{ "artifact": "mhtml" }`

More detail: `docs/features/page-archive.md`.

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
