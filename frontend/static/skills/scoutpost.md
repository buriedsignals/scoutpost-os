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

Use whichever surface is connected to your agent. Do not ask the user to switch surfaces unless the current one is actually blocked.

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
