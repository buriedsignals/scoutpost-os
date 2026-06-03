# License Key Infrastructure

> **Status:** Product/ops design note. License keys gate deployment automation and update convenience, not Scoutpost application features.

The public OSS app remains usable without a license key. The supported newsroom install path is the Docker installer documented in `docs/oss/newsroom-docker-install.md`. A future or private license service may gate:

- managed setup scripts,
- hosted update automation,
- support workflows,
- convenience deploy assets.

It must not gate Page, Beat, Social, Civic, CLI, MCP, or editorial features.

## Current Data-Store Rule

Do not implement new license state in DynamoDB. The Scoutpost runtime is Supabase-first after the 2026-04-22 cutover. If license-key storage is implemented or refreshed, use a small Supabase-backed table or a separate operational service, and store only hashed keys.

Recommended minimal shape for any future implementation:

| Field | Purpose |
| --- | --- |
| `id` | UUID primary key. |
| `key_hash` | SHA-256 or stronger hash of the full license key. |
| `key_prefix` | Non-secret display prefix for support. |
| `customer_id` | Optional external customer link. |
| `subscription_id` | Optional external subscription link if a future license service needs one. Scoutpost SaaS subscriptions are resolved from MuckRock entitlements, not license records. |
| `status` | `active`, `past_due`, `cancelled`, `expired`. |
| `expires_at` | License validity limit. |
| `created_at`, `updated_at` | Audit timestamps. |

## Key Lifecycle

```
Manual ops action or external billing system
  -> license service creates random key
  -> store only hashed key + metadata
  -> deliver full key once to customer/operator

Installer / update automation
  -> POST validate request with key
  -> service hashes candidate key
  -> lookup active, unexpired license
  -> return allow/deny and non-secret metadata
```

## Security Requirements

- Store only hashes, never full license keys.
- Keep validation responses free of secrets.
- Rate-limit validation.
- Treat license validation as an automation entitlement check, not as application authorization.
- Do not embed license keys in public setup manifests, Docker images, frontend bundles, or GitHub Actions logs.

## Related Docs

- `docs/oss/newsroom-docker-install.md`
- `deploy/installer/README.md`
- `docs/oss/deployment-and-mirror.md` (historical implementation plan; do not treat stale DynamoDB references there as current architecture)
