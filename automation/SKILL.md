---
name: scoutpost-setup
description: >
  Deploy a fresh Scoutpost instance on the user's own infrastructure. Use
  whenever the user says "set up Scoutpost", "deploy Scoutpost", "install
  Scoutpost", "self-host Scoutpost", or drops this repo into an agent
  asking to be provisioned. Walks end-to-end: fork the repo, collect API keys,
  provision Supabase, deploy Edge Functions, build the frontend, and install
  the sync-upstream GitHub Action.
trigger: >
  Activates on user requests for deployment / setup / self-hosting of
  Scoutpost, or when the agent first enters this repo with a provisioning
  task.
agent_agnostic: true
---

# Scoutpost self-hosted setup

Agent-agnostic skill. This file is the entry point whichever AI coding agent
(Claude Code, Cursor, Codex, Windsurf, Gemini CLI, etc.) the user drops into
the repo. It is intentionally tracked (lives under `automation/`, not
`.claude/`) so every agent sees the same instructions.

This skill orchestrates the full deployment of Scoutpost on the user's own
Supabase project. The canonical, step-by-step reference lives in
`automation/SETUP_AGENT.md` — **read that file in full before you start**. It
contains the exact commands for each step, including API-key collection,
Supabase linking, Edge Function deployment, and the frontend build.

## How agents activate this skill

- **Claude Code**: `automation/SKILL.md` is surfaced via the project's
  `CLAUDE.md` ("Self-hosting setup lives in `automation/`"). When the user
  asks to set up / deploy / self-host, read this file first.
- **Cursor / Windsurf**: `AGENTS.md` at the repo root points at this file;
  rules-file users can add a rule that says "for setup/deploy tasks, follow
  `automation/SKILL.md`".
- **Generic (any MCP/CLI agent)**: the user can paste:
  > Read `automation/SKILL.md` and follow it to set up Scoutpost.

## Preconditions

No license key is required. The repository is public and self-hosting is free
under the Sustainable Use License.

The user needs:

- **Supabase account** — managed cloud at supabase.com, or self-hosted via
  Docker.
- **API keys** for Gemini, Firecrawl, Resend, Apify, and MapTiler (all
  required).
- **Signup controls** — one admin email and the newsroom email domains allowed
  to create accounts. Setup seeds a Supabase before-user-created Auth hook.
- **Verified Resend sender domain** — scouts can't send notifications without
  it.
- **Hosting target** for the frontend — Render, Cloudflare Pages, Vercel, or
  any static host that serves a SvelteKit static build.
- **Node 22 LTS** on the local machine running this skill — Node 25+ generates
  lockfiles that break the Docker build.

## Flow

1. **Read `automation/SETUP_AGENT.md`.** It is the source of truth.
2. **Pre-flight checks** — run the environment check from Step 1 of
   `SETUP_AGENT.md`. Help the user install anything missing before
   continuing.
3. **Clone / fork** — the repo is public, clone via
   `gh repo fork buriedsignals/scoutpost-os --clone` or plain `git clone`.
4. **Collect setup values** — prefer the `/setup` generator or
   `scoutpost-setup.json` manifest so secrets stay out of chat. Explain what
   each service does. Do not skip MapTiler or the Resend domain verification
   step.
5. **Provision Supabase** — managed or self-hosted Docker. Run migrations
   (`supabase db push`) and deploy all Edge Functions
   (`supabase functions deploy --all`).
6. **Write `.env`** — use `.env.example` as the template; fill in every
   variable the user provided.
7. **Build and deploy the frontend** — `cd frontend && nvm use && npm ci &&
   npm run build`, then push the static build to the chosen host.
8. **Install the sync workflow** — copy `automation/sync-upstream.yml` into
   `.github/workflows/` in the user's fork so upstream releases land as PRs.
   The workflow reports migrations and configured secrets; operators apply
   migrations and deploy Edge Functions after reviewing the PR.
9. **Verify** — hit the Supabase functions health endpoint, then the frontend
   URL. Create the first user account.

## Important behaviours

- **Ask before spending money.** Supabase Pro, Render paid tiers, and the
  scout pipelines (Civic = 20 credits/run in hosted mode; real API cost
  self-hosted) all incur charges. Surface this before provisioning.
- **Don't put secrets in chat.** Use the generated manifest or local shell
  prompts. Agents should read `scoutpost-setup.json` from disk and run
  `automation/setup-from-manifest.sh`.
- **Don't assume defaults.** Prompt the user for every decision and secret —
  regions, tier selection, signup domains, sender address. No silent choices.
- **One step at a time.** Complete each step, summarise what was done, then
  ask the user to confirm before the next step. The user must be able to
  audit the work as it happens.
- **Use the existing automation when sensible.** `automation/setup.sh` runs
  the whole flow non-interactively if the user prefers a bash script over a
  chat-driven walkthrough. Offer it as an alternative at the start.
- **Node 22 LTS is a hard requirement.** If the user has a different major
  version active, stop and walk them through `nvm install 22 && nvm use 22`
  before the frontend build. Lockfile drift will otherwise break the Docker
  build on Render.

## Files you will touch

| Path | Purpose |
|---|---|
| `automation/SETUP_AGENT.md` | Full step-by-step reference — read first |
| `automation/setup-from-manifest.sh` | Manifest-driven bootstrap script |
| `automation/setup.sh` | Legacy interactive bootstrap script |
| `automation/sync-upstream.yml` | GitHub Action for upstream sync |
| `automation/selfhost-doctor.sh` | Existing-install preflight |
| `automation/adopt-signup-allowlist.sh` | Moves local signup policy into the upstream allowlist |
| `deploy/SETUP.md` | Deployment-specific reference |
| `supabase/` | Migrations + Edge Functions the skill will deploy |
| `frontend/` | SvelteKit app — requires Node 22 for `npm ci` + `npm run build` |
| `.env.example` | Template for the environment file the skill writes |
