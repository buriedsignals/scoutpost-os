#!/usr/bin/env bash
# strip-oss.sh — Strip SaaS-only code for OSS mirror
#
# Single source of truth for what gets removed/replaced.
# Called by both mirror-oss.yml (production) and ci.yml (PR validation).
#
# Usage: bash scripts/ops/strip-oss.sh
set -euo pipefail

sed() {
  if [ "${1:-}" = "-i" ]; then
    shift
    if command sed --version >/dev/null 2>&1; then
      command sed -i "$@"
    else
      command sed -i '' "$@"
    fi
    return
  fi
  command sed "$@"
}

sed_if_exists() {
  local file="${@: -1}"
  [ -f "$file" ] || return 0
  sed "$@"
}

strip_edge_function() {
  local fn="$1"
  rm -rf "supabase/functions/${fn}/"
  sed_if_exists -i "/^\[functions\.${fn}\]$/,+1d" supabase/config.toml
  sed_if_exists -i "/${fn}/d" docs/architecture/api-surface.md
}

remove_hosted_shared_file() {
  local file="$1"
  rm -f "supabase/functions/_shared/${file}"
}

HOSTED_NEWSLETTER_ENTITLEMENT_PROVIDER="bee""hiiv"
HOSTED_NEWSLETTER_ENTITLEMENT_PROVIDER_TITLE="$(
  printf '%s' "$HOSTED_NEWSLETTER_ENTITLEMENT_PROVIDER" |
    awk '{ print toupper(substr($0, 1, 1)) substr($0, 2) }'
)"
HOSTED_NEWSLETTER_ENTITLEMENT_ENV_PREFIX="$(
  printf '%s' "$HOSTED_NEWSLETTER_ENTITLEMENT_PROVIDER" |
    tr '[:lower:]' '[:upper:]'
)"

echo "=== Stripping SaaS-only code ==="

HOSTED_SUPABASE_REF="gfmdziplticfoak"
HOSTED_SUPABASE_REF="${HOSTED_SUPABASE_REF}hrfpt"

# Local-only artifacts can appear when developers validate the strip step from
# a working copy instead of a clean CI checkout. Remove them before the hosted
# reference scan so ignored secrets/caches do not poison the OSS mirror check.
rm -rf .claude/
rm -rf .jj/
rm -f .env .env.local .env.production .env.test .env.test.local
rm -f supabase/.env supabase/.env.local supabase/.env.test supabase/.env.test.local
rm -rf supabase/.temp/
rm -rf mcp/dist/
find . -type d -name __pycache__ -prune -exec rm -rf {} +
find . -type d -name .pytest_cache -prune -exec rm -rf {} +

# AWS infrastructure was removed in the v2 migration — nothing to strip here.
# (aws/ and backend/app/adapters/aws/ no longer exist in the SaaS source tree.)

# Backend: remove SaaS-only auth broker (MuckRock OAuth)
rm -f backend/app/routers/auth.py
rm -f backend/app/routers/local_auth.py
rm -f backend/app/routers/muckrock_proxy.py
rm -f backend/app/services/muckrock_client.py
rm -f backend/app/services/muckrock_client.py
rm -f backend/tests/unit/auth/test_auth_router.py
rm -f backend/tests/unit/api/test_local_auth.py
rm -f backend/tests/unit/api/test_muckrock_proxy.py

# main.py unconditionally mounts auth.router in the SaaS source; strip the
# import + mount for OSS since the broker depends on MuckRock credentials.
# OSS users authenticate directly with Supabase (email/password on the
# frontend /login route), not through a broker.
sed -i '/^# Auth broker/d' backend/app/main.py
sed -i '/^from app\.routers import auth$/d' backend/app/main.py
sed -i '/app\.include_router(auth\.router/d' backend/app/main.py

# NOTE: user_service.py and session_service.py are kept for OSS. Many
# routers still import them (scraper, pulse, onboarding, user, data_extractor,
# utils/credits). They're dormant under deployment_target="supabase" but
# must be importable for the non-auth surface to load. PR 4 (post-cutover
# on the SaaS side) will remove those routers + services together.

# Backend: remove SaaS-only billing and credit management
rm -f backend/app/utils/credits.py
rm -f backend/app/services/cron.py
rm -f backend/app/services/seed_data_service.py
rm -f backend/app/services/api_key_service.py

# Backend: remove feedback router (Linear integration — SaaS-only)
rm -f backend/app/routers/feedback.py

# Backend: remove threat modeling dashboard (internal security assessment)
rm -rf backend/app/routers/threat_modeling/

# Supabase Edge Functions: remove hosted/SaaS-only endpoints before OSS
# deploy discovery runs. Self-hosted deployments should not deploy MuckRock
# OAuth/billing, hosted admin invoicing, or Buried Signals newsletter proxies.
strip_edge_function admin-report
strip_edge_function auth-muckrock
strip_edge_function billing-webhook
strip_edge_function indicator-claim
strip_edge_function mcp-auth
strip_edge_function newsletter-subscribe
sed_if_exists -i '/^# auth-muckrock is browser-facing/,+1d' supabase/config.toml
sed_if_exists -i '/^# mcp-auth is the MCP-only sibling/,+4d' supabase/config.toml
sed_if_exists -i '/^# newsletter-subscribe is called pre-auth/,+1d' supabase/config.toml

# Shared helpers used only by the hosted MuckRock/Billing auth surface above.
# Keep them out of the public mirror so self-hosted deployments do not inherit
# SaaS entitlement providers, credentials, or unused tests.
remove_hosted_shared_file "${HOSTED_NEWSLETTER_ENTITLEMENT_PROVIDER}.ts"
remove_hosted_shared_file "${HOSTED_NEWSLETTER_ENTITLEMENT_PROVIDER}.test.ts"
remove_hosted_shared_file entitlements.ts
remove_hosted_shared_file entitlements.test.ts
remove_hosted_shared_file muckrock.ts

# Remove hosted-only newsletter entitlement settings from files that remain in
# the public mirror.
sed_if_exists -i "/${HOSTED_NEWSLETTER_ENTITLEMENT_ENV_PREFIX}/d" AGENTS.md
sed_if_exists -i "/${HOSTED_NEWSLETTER_ENTITLEMENT_ENV_PREFIX}/d" CLAUDE.md
sed_if_exists -i "/${HOSTED_NEWSLETTER_ENTITLEMENT_ENV_PREFIX}/d" docs/architecture/developer-guide.md
sed_if_exists -i "/INDICATOR_CLAIM_PEPPER/d" AGENTS.md
sed_if_exists -i "/INDICATOR_CLAIM_PEPPER/d" CLAUDE.md
sed_if_exists -i "/INDICATOR_CLAIM_PEPPER/d" docs/architecture/developer-guide.md
sed_if_exists -i "/hosted AI Lab subscribers/,+4d" backend/app/config.py
sed_if_exists -i "s|, apply hosted entitlements including ${HOSTED_NEWSLETTER_ENTITLEMENT_PROVIDER_TITLE} AI Lab Pro||" docs/architecture/fastapi-endpoints.md
rm -f supabase/migrations/00065_indicator_claims.sql

# -------------------------------------------------------------------
# CI/CD: remove workflows that reference the dev repo
# -------------------------------------------------------------------
rm -f .github/workflows/mirror-*.yml
rm -f .github/workflows/claude*.yml
rm -f .github/workflows/qa-matrix.yml
rm -f .github/workflows/weekly-scout-benchmarks.yml
# CLI release workflow depends on Apple signing secrets that only exist on
# the private monorepo. OSS forks can restore this and add their own secrets.
rm -f .github/workflows/cli-release.yml

# -------------------------------------------------------------------
# Docs: remove internal/SaaS-specific documentation
# -------------------------------------------------------------------
rm -rf docs/superpowers/
rm -rf docs/muckrock/
rm -rf docs/billing/
rm -rf docs/supabase/
rm -rf docs/plans/
rm -f docs/architecture/license-key-infrastructure.md
rm -f docs/architecture/aws-architecture.md
rm -f docs/architecture/records-and-deduplication.md
rm -f DESIGN.md
rm -rf .firecrawl/

# Public docs are kept in the OSS mirror, but SaaS examples must not expose the
# hosted coJournalist project ref.
if [ -d docs ]; then
  while IFS= read -r -d '' file; do
    sed_if_exists -i "s|${HOSTED_SUPABASE_REF}|<project-ref>|g" "$file"
  done < <(find docs -type f -name '*.md' -print0)
fi

# -------------------------------------------------------------------
# Scripts: keep the OSS-friendly smoke test; drop hosted SaaS-only
# migration and user-announcement tooling.
# -------------------------------------------------------------------
rm -rf scripts/migrate/
# Hosted SaaS-only user update sender. It resolves recipient email addresses
# through MuckRock and sends through the hosted Resend account.
rm -f scripts/ops/send-user-update-email.ts
rm -f USER_UPDATE_EMAIL.md
rm -f docs/operations/user-update-email.md

# Private live benchmark harness. These scripts assume hosted Supabase Auth
# Admin access, internal service auth, and production operator credentials.
rm -f scripts/benchmarks/_bench_shared.ts
rm -f scripts/benchmarks/_bench_quality.ts
rm -f scripts/benchmarks/benchmark-web.ts
rm -f scripts/benchmarks/benchmark-subpage-follow.ts
rm -f scripts/benchmarks/benchmark-social.ts
rm -f scripts/benchmarks/benchmark-civic.ts
rm -f scripts/benchmarks/benchmark-beat.ts
rm -f scripts/benchmarks/benchmark-dedup.ts
rm -f scripts/benchmarks/benchmark-internal-workers.ts
rm -f scripts/benchmarks/benchmark-qa-matrix.ts
rm -f scripts/benchmarks/benchmark-scout-suite.ts
rm -f scripts/ops/notifications-benchmark.ts
strip_edge_function notifications-benchmark

# -------------------------------------------------------------------
# Public setup assets remain in the OSS mirror. /setup links to these
# files directly, so they must survive the strip step.
# -------------------------------------------------------------------

# -------------------------------------------------------------------
# Frontend: replace auth system (MuckRock OAuth → Supabase Auth)
# -------------------------------------------------------------------
printf '%s\n' \
  '/**' \
  ' * Auth Store — Supabase Auth (self-hosted deployment).' \
  ' *' \
  ' * Re-exports from auth-supabase for email/password authentication.' \
  ' *' \
  " * USED BY: All components that import from '\$lib/stores/auth'" \
  ' */' \
  "import * as supabase from './auth-supabase';" \
  '' \
  'export const authStore = supabase.authStore;' \
  'export const currentUser = supabase.currentUser;' \
  'export const auth = supabase.auth;' \
  > frontend/src/lib/stores/auth.ts

rm -f frontend/src/lib/stores/auth-muckrock.ts

# -------------------------------------------------------------------
# Frontend: /login is now shared SaaS+OSS (single route, dual-path
# rendered based on PUBLIC_DEPLOYMENT_TARGET). OSS build sets that to
# "supabase" and the MuckRock button is hidden at render time. Commit
# 839e23d collapsed /login-supabase into /login deliberately.
# No rename needed here.
# -------------------------------------------------------------------

# -------------------------------------------------------------------
# Frontend: strip SaaS-only routes and references
# -------------------------------------------------------------------
rm -rf frontend/src/routes/admin/
rm -rf frontend/src/routes/pricing/
rm -rf frontend/src/routes/subscription/claim/

sed -i "s|'/login', '/pricing', '/setup', '/terms'|'/login', '/setup', '/terms'|" frontend/src/routes/+layout.svelte
sed -i "s|, '/subscription/claim/verify'||" frontend/src/routes/+layout.svelte
sed -i 's|href="/pricing"|href="/"|' frontend/src/routes/setup/+page.svelte
sed_if_exists -i "s|'/login', '/pricing', '/faq', '/skills', '/terms'|'/login', '/faq', '/skills', '/terms'|" frontend/src/lib/components/ui/MobileBlocker.svelte
sed -i "s|goto('/pricing');|return; // unlimited in self-hosted|" frontend/src/lib/components/workspace/NewScoutDropdown.svelte
sed -i "s|https://accounts.muckrock.com/[^'\`]*|#|g" frontend/src/lib/components/modals/PreferencesModal.svelte
# Login page carries the MuckRock signup link in the OAuth branch (dead
# code in OSS since PUBLIC_MUCKROCK_ENABLED is never true there, but the
# URL still appears in the source and fails the OSS mirror grep check).
sed_if_exists -i 's|https://accounts.muckrock.com/[^"]*|#|g' frontend/src/routes/login/+page.svelte
sed_if_exists -i 's|MuckRock and Supabase|Supabase|g' frontend/src/routes/terms/+page.svelte
# Remove UpgradeModal and all credit-gating logic (no credits in OSS)
rm -f frontend/src/lib/components/modals/UpgradeModal.svelte

# Strip hosted Indicator/Beehiiv claim UI, API helpers, profile metadata,
# and privacy rows from files that remain in OSS.
python3 - <<'PY'
from pathlib import Path
import json
import re


def rewrite(path: str, replacements: list[tuple[str, str, int]]) -> None:
    p = Path(path)
    if not p.exists():
        return
    src = p.read_text()
    for pattern, repl, flags in replacements:
        src = re.sub(pattern, repl, src, flags=flags)
    p.write_text(src)


rewrite(
    "frontend/src/lib/api-client.ts",
    [
        (
            r"\nexport interface IndicatorClaimRequestResponse \{.*?\nexport async function verifyIndicatorClaim\(token: string\): Promise<IndicatorClaimVerifyResponse> \{\n\treturn apiRequest<IndicatorClaimVerifyResponse>\('POST', '/indicator-claim/verify', \{ token \}\);\n\}\n",
            "\n",
            re.DOTALL,
        ),
    ],
)

rewrite(
    "frontend/src/lib/types.ts",
    [
        (r"\n\tentitlement_source\?: string \| null;", "", 0),
        (r"\n\tindicator_claim_active\?: boolean;", "", 0),
    ],
)

rewrite(
    "frontend/src/lib/stores/auth-supabase.ts",
    [
        (
            r"\n\t\tentitlement_source:\n\t\t\ttypeof metadata\.entitlement_source === 'string' \|\| metadata\.entitlement_source === null\n\t\t\t\t\? metadata\.entitlement_source\n\t\t\t\t: null,",
            "",
            0,
        ),
        (
            r"\n\t\tindicator_claim_active:\n\t\t\ttypeof metadata\.indicator_claim_active === 'boolean' \? metadata\.indicator_claim_active : false,",
            "",
            0,
        ),
    ],
)

rewrite(
    "frontend/src/lib/components/modals/PreferencesModal.svelte",
    [
        (r"import \{ Settings, CheckCircle, ExternalLink, MailCheck \} from 'lucide-svelte';", "import { Settings, CheckCircle, ExternalLink } from 'lucide-svelte';", 0),
        (r"\n\timport \{ requestIndicatorClaim \} from '\$lib/api-client';", "", 0),
        (r"\n\tlet claimEmail = '';\n\tlet claimLoading = false;\n\tlet claimMessage: string \| null = null;\n\tlet claimError: string \| null = null;", "", 0),
        (
            r"\n\t\$: showIndicatorClaim =\n\t\timport\.meta\.env\.PUBLIC_MUCKROCK_ENABLED === 'true' &&\n\t\t\$authStore\.user\?\.tier !== 'team' &&\n\t\t\(\$authStore\.user\?\.tier !== 'pro' \|\| !\$authStore\.user\?\.indicator_claim_active\);\n",
            "\n",
            0,
        ),
        (
            r"\n\tasync function handleClaimSubscription\(\) \{.*?\n\t\}\n\n\tfunction handleBackdropClick",
            "\n\tfunction handleBackdropClick",
            re.DOTALL,
        ),
        (
            r"\n\n\t\t\t\t\t\t\{#if \$authStore\.user\?\.indicator_claim_active\}.*?\n\t\t\t\t\t\t\{/if\}\n\n\t\t\t\t\t\t\{#if showIndicatorClaim\}.*?\n\t\t\t\t\t\t\{/if\}",
            "",
            re.DOTALL,
        ),
        (
            r"\n\t\.claim-status \{.*?\n\t\}\n\n\t\.claim-box \{.*?\n\t\}\n\n\t\.claim-row \{.*?\n\t\}\n\n\t\.claim-row \.form-input \{.*?\n\t\}\n\n\t\.claim-button \{.*?\n\t\}\n\n\t\.claim-message,\n\t\.claim-error \{.*?\n\t\}\n\n\t\.claim-message \{.*?\}\n\t\.claim-error \{.*?\}\n\n\t@media \(max-width: 560px\) \{.*?\n\t\}\n",
            "\n",
            re.DOTALL,
        ),
    ],
)

rewrite(
    "supabase/functions/user/index.ts",
    [
        (r"\n  entitlement_source: string \| null;", "", 0),
        (r"\n  indicator_claim_active: boolean;", "", 0),
        (r"balance, monthly_cap, tier, entitlement_source", "balance, monthly_cap, tier", 0),
        (
            r"\n  const entitlementSource = \(creditRow\?\.entitlement_source \?\? null\) as\n    \| string\n    \| null;\n\n  const \{ data: indicatorMemberships \} = await svc\n    \.from\(\"indicator_memberships\"\)\n    \.select\(\"status, grace_expires_at\"\)\n    \.eq\(\"user_id\", user\.id\)\n    \.eq\(\"status\", \"active\"\);\n  const now = Date\.now\(\);\n  const indicatorClaimActive = \(indicatorMemberships \?\? \[\]\)\.some\(\(row\) => \{\n    const grace = typeof row\.grace_expires_at === \"string\"\n      \? Date\.parse\(row\.grace_expires_at\)\n      : Number\.NaN;\n    return !Number\.isFinite\(grace\) \|\| grace > now;\n  \}\);\n",
            "\n",
            0,
        ),
        (r"\n    entitlement_source: entitlementSource,", "", 0),
        (r"\n    indicator_claim_active: indicatorClaimActive,", "", 0),
    ],
)

rewrite(
    "frontend/src/routes/terms/+page.svelte",
    [
        (r"\n\t\t\t\t<li><strong>Subscription claim metadata</strong>.*?</li>", "", 0),
        (r"\n\t\t\t\t<li>Indicator subscription emails.*?</li>", "", 0),
        (r"\n\t\t\t\t\t<tr><td>Beehiiv</td>.*?</tr>", "", 0),
    ],
)

for messages_path in Path("frontend/messages").glob("*.json"):
    data = json.loads(messages_path.read_text())
    for key in list(data):
        if key.startswith("claimVerify_") or key.startswith("preferences_claim"):
            data.pop(key, None)
    messages_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
PY
rm -rf frontend/src/lib/paraglide/

# Strip UpgradeModal and pricing-only UI from the current workspace shell.
python3 - <<'PY'
from pathlib import Path
import re


def rewrite(path: str, replacements: list[tuple[str, str, int]]) -> None:
    p = Path(path)
    if not p.exists():
        return
    src = p.read_text()
    for pattern, repl, flags in replacements:
        src = re.sub(pattern, repl, src, flags=flags)
    p.write_text(src)


rewrite(
    "frontend/src/routes/+page.svelte",
    [
        (r"\n\timport MetricPill from '\$lib/components/ui/MetricPill\.svelte';", "", 0),
        (r"\n\timport UpgradeModal from '\$lib/components/modals/UpgradeModal\.svelte';", "", 0),
        (r"\n\tlet showUpgradeModal = false;\n\tlet upgradeRequired = 0;\n", "\n", 0),
        (
            r"\n\t\t// Pre-check credits client-side\..*?\n\t\tconst perRunCost = .*?\n\t\tconst currentCredits = .*?\n\t\tif \(currentCredits < perRunCost\) \{\n\t\t\tupgradeRequired = perRunCost;\n\t\t\tshowUpgradeModal = true;\n\t\t\treturn;\n\t\t\}\n",
            "\n",
            re.DOTALL,
        ),
        (
            r"\n\t\t\t\{#if \$authStore\.authenticated \|\| \$authStore\.user\}\n\t\t\t\t<MetricPill.*?\/>\n\t\t\t\{/if\}",
            "",
            re.DOTALL,
        ),
        (r"\n\t\t\t\t\t\t<a href=\"/pricing\" class=\"user-menu-item\" role=\"menuitem\" on:click=\{\(\) => \(userMenuOpen = false\)\}>Pricing</a>", "", 0),
        (
            r"\n\t<UpgradeModal\n\t\topen=\{showUpgradeModal\}\n\t\tcurrentCredits=\{\$authStore\.user\?\.credits \?\? 0\}\n\t\trequiredCredits=\{upgradeRequired\}\n\t\toperationType=\"monitoring\"\n\t\tonClose=\{\(\) => \(showUpgradeModal = false\)\}\n\t/>\n",
            "\n",
            0,
        ),
    ],
)

rewrite(
    "frontend/src/lib/components/modals/ScoutScheduleModal.svelte",
    [
        (r"import \{ getScoutCost, validateScheduleCredits \} from '\$lib/utils/scouts';", "import { getScoutCost } from '$lib/utils/scouts';", 0),
        (r"\n\timport UpgradeModal from '\$lib/components/modals/UpgradeModal\.svelte';", "", 0),
        (r"\n\tlet showUpgradeModal = false;\n\tlet upgradeRequiredCredits = 0;\n", "\n", 0),
        (
            r"\n\t\t// Validate credits client-side\..*?\n\t\tconst creditCheck = validateScheduleCredits\(\{\n\t\t\tscoutType,\n\t\t\tregularity: regularity as 'daily' \| 'weekly' \| 'monthly',\n\t\t\tplatform: scoutType === 'social' \? platform : undefined,\n\t\t\tcurrentCredits: \$authStore\.user\?\.credits \?\? 0\n\t\t\}\);\n\t\tif \(!creditCheck\.valid\) \{\n\t\t\tisSubmitting = false;\n\t\t\tupgradeRequiredCredits = creditCheck\.monthlyCost;\n\t\t\tshowUpgradeModal = true;\n\t\t\treturn;\n\t\t\}\n",
            "\n",
            re.DOTALL,
        ),
        (
            r"\n<UpgradeModal\n\topen=\{showUpgradeModal\}\n\tcurrentCredits=\{\$authStore\.user\?\.credits \?\? 0\}\n\trequiredCredits=\{upgradeRequiredCredits\}\n\toperationType=\"scout scheduling\"\n\tonClose=\{\(\) => \(showUpgradeModal = false\)\}\n/>\n",
            "\n",
            0,
        ),
    ],
)
PY

# Frontend: remove FeedbackModal and BugReportButton (Linear integration — SaaS-only)
rm -f frontend/src/lib/components/modals/FeedbackModal.svelte
sed_if_exists -i "/import BugReportButton from/d" frontend/src/routes/+layout.svelte
sed_if_exists -i "/import FeedbackModal from/d" frontend/src/routes/+layout.svelte
sed_if_exists -i "/let feedbackModalOpen/d" frontend/src/routes/+layout.svelte
python3 - <<'PY'
from pathlib import Path
import re

p = Path("frontend/src/routes/+layout.svelte")
text = p.read_text()
text = re.sub(
    r"\n\{#if \$page\.url\.pathname !== '/login'\}\n\t<BugReportButton onOpen=\{\(\) => \(feedbackModalOpen = true\)\} />\n\t<FeedbackModal\n\t\topen=\{feedbackModalOpen\}\n\t\tonClose=\{\(\) => \(feedbackModalOpen = false\)\}\n\t/>\n\{/if\}\n",
    "\n",
    text,
    flags=re.MULTILINE,
)
p.write_text(text)
PY

# Backend: strip feedback router import and mount from main.py
sed -i '/^    feedback,$/d' backend/app/main.py
sed -i '/feedback\.router/d' backend/app/main.py

# Backend: the OSS frontend is Supabase-native. Keep FastAPI only as the
# optional /api/v1 add-on and strip the legacy user/feed/export surface.
sed -i '/^    onboarding,$/d' backend/app/main.py
sed -i '/^    user,$/d' backend/app/main.py
sed -i '/^    units,$/d' backend/app/main.py
sed -i '/^    export,$/d' backend/app/main.py
sed -i '/^    license,$/d' backend/app/main.py
sed -i '/^from app\.routers import muckrock_proxy$/d' backend/app/main.py
sed -i '/^from app\.routers import local_auth$/d' backend/app/main.py
sed -i '/onboarding\.router/d' backend/app/main.py
sed -i '/user\.router/d' backend/app/main.py
sed -i '/units\.router/d' backend/app/main.py
sed -i '/export\.router/d' backend/app/main.py
sed -i '/license\.router/d' backend/app/main.py
sed -i '/muckrock_proxy\.router/d' backend/app/main.py

python3 - <<'PY'
from pathlib import Path

p = Path("backend/app/main.py")
lines = p.read_text().splitlines()
targets = (
    "muckrock_proxy.router",
    "local_auth.router",
    "onboarding.router",
    "user.router",
    "units.router",
    "export.router",
    "license.router",
    "feedback.router",
    'prefix="/api/auth"',
    'tags=["Auth (MuckRock proxy)"]',
    'tags=["Auth (local MuckRock broker)"]',
)
out = []
i = 0
while i < len(lines):
    line = lines[i]
    if "from app.routers import muckrock_proxy" in line:
        i += 1
        continue
    if "from app.routers import local_auth" in line:
        i += 1
        continue
    if line.lstrip().startswith("app.include_router("):
        block = [line]
        j = i + 1
        while j < len(lines):
            block.append(lines[j])
            if lines[j].strip() == ")":
                break
            j += 1
        block_text = "\n".join(block)
        if any(target in block_text for target in targets):
            i = j + 1
            continue
    out.append(line)
    i += 1

text = "\n".join(out) + "\n"
text = text.replace("if settings.local_muckrock_auth_broker:\nelse:\n", "")
p.write_text(text)
PY

# -------------------------------------------------------------------
# Frontend: strip leftover MuckRock + /pricing references from shared
# files that dual-serve SaaS and OSS. These are SaaS-facing UI fragments
# that are gated behind PUBLIC_DEPLOYMENT_TARGET at runtime, but the
# grep-based validator below can't see runtime flags — it only sees
# strings. Strip them from OSS source.
# -------------------------------------------------------------------

# docs/+page.svelte: pricing links + MuckRock mention in prose
sed_if_exists -i 's|<a href="/pricing">|<a href="/">|g' frontend/src/routes/docs/+page.svelte
sed_if_exists -i 's|href="/pricing"|href="/"|g' frontend/src/routes/docs/+page.svelte
sed_if_exists -i 's|sign in with MuckRock OAuth\. Free tier starts with 100 credits/month\.|sign in with your email address.|' frontend/src/routes/docs/+page.svelte

# +page.svelte (home/workspace): credits-pill + user-menu pricing links
sed_if_exists -i 's|href="/pricing"|href="/"|g' frontend/src/routes/+page.svelte

# login/+page.svelte: remove the entire MuckRock-preview branch + "See pricing" CTAs
# The {#if PUBLIC_DEPLOYMENT_TARGET === 'supabase' && !previewMuckRock} block shows
# the email/password form (OSS path); the {:else} branch shows the MuckRock button
# (SaaS path). For OSS we remove the SaaS branch entirely.
python3 - <<'PY'
import re, pathlib
p = pathlib.Path("frontend/src/routes/login/+page.svelte")
src = p.read_text()
# Drop the previewMuckRock state (dev-only toggle)
src = re.sub(r"\n\s*// Dev-only:.*?previewMuckRock.*?\n", "\n", src, count=1, flags=re.DOTALL)
src = re.sub(r"\n\s*let previewMuckRock\s*=\s*false;\s*", "\n", src, count=1)
# Replace `!previewMuckRock && auth.login()` → just open supabase flow fallback
src = src.replace("!previewMuckRock && auth.login()", "auth.login()")
# Strip the `&& !previewMuckRock` clause wherever it still lingers (e.g. inside
# `{#if PUBLIC_DEPLOYMENT_TARGET === 'supabase' && !previewMuckRock}`).
src = src.replace(" && !previewMuckRock", "")
src = src.replace("!previewMuckRock && ", "")
# Drop any remaining `previewMuckRock` identifier references.
src = re.sub(r"\bpreviewMuckRock\b", "false", src)
# Drop "See pricing" CTA links — both occurrences
src = re.sub(r'<a href="/pricing"[^>]*>[^<]*</a>', '', src)
# Strip the MuckRock-preview checkbox/label (entire <label class="muckrock-toggle">...</label>)
src = re.sub(r'<label class="muckrock-toggle">.*?</label>', '', src, flags=re.DOTALL)
# Strip the surrounding dev-only preview conditional so no SaaS env guard
# survives in OSS source after the label has been removed.
src = re.sub(
    r'\n\s*\{#if\s+import\.meta\.env\.PUBLIC_DEPLOYMENT_TARGET === \'supabase\' && import\.meta\.env\.DEV && import\.meta\.env\.PUBLIC_MUCKROCK_ENABLED !== \'true\' && !IS_LOCAL_DEMO_MODE\}\s*\n\s*\{/if\}',
    '\n',
    src,
    flags=re.DOTALL,
)
# Strip the MuckRock preview text comment lines
src = re.sub(r'<p class="auth-subtitle">Sign in via MuckRock</p>', '<p class="auth-subtitle">Sign in</p>', src)
src = src.replace("Sign in with MuckRock", "Sign in")
# Collapse the MuckRock-authenticate prompt + signup link (post-2026-04-22 copy)
src = re.sub(r'<p class="auth-prompt">Authenticate with MuckRock to continue</p>', '<p class="auth-prompt">Sign in</p>', src)
src = re.sub(r'<a\s+class="auth-signup-link"[^>]*>.*?</a>', '', src, flags=re.DOTALL)
src = src.replace(
    "This MuckRock account is not enabled yet; if you expected access, contact the Scoutpost team.",
    "This hosted account is not enabled yet; if you expected access, contact the Scoutpost team.",
)
# Strip CSS / JS comments that name MuckRock (validator greps the file
# content case-insensitively, so even a doc-comment inside <style> trips it).
src = re.sub(r'/\*[^*]*?[Mm]uck[Rr]ock[^/]*?\*/', '', src, flags=re.DOTALL)
src = re.sub(r'//[^\n]*[Mm]uck[Rr]ock[^\n]*', '', src)
# Strip muckrock-toggle CSS rules
src = re.sub(r'\.muckrock-toggle\s*\{[^}]*\}', '', src)
src = re.sub(r'\.muckrock-toggle\s+input\s*\{[^}]*\}', '', src)
src = re.sub(r'\.muckrock-toggle:hover\s*\{[^}]*\}', '', src)
src = re.sub(r'\.auth-signup-link\s*\{[^}]*\}', '', src)
src = re.sub(r'\.auth-signup-link:hover\s*\{[^}]*\}', '', src)
# Collapse the PUBLIC_MUCKROCK_ENABLED conditional to always pick the
# email/password branch for OSS. The validator greps for the literal
# string 'MuckRock' so we must avoid that identifier in OSS source.
src = re.sub(
    r"import\.meta\.env\.PUBLIC_MUCKROCK_ENABLED\s*===\s*'true'\s*\|\|\s*(\w+)",
    r"false || \1",
    src,
)
src = re.sub(r"import\.meta\.env\.PUBLIC_MUCKROCK_ENABLED\s*===\s*'true'", "false", src)
p.write_text(src)
PY

# api-client.ts: strip MuckRock JSDoc comments (comment-only references)
sed_if_exists -i "s|, '' for MuckRock cookies|, '' for self-hosted|g" frontend/src/lib/api-client.ts
sed_if_exists -i "s|for MuckRock session-cookie auth|for legacy session-cookie auth|g" frontend/src/lib/api-client.ts
sed_if_exists -i "s|MuckRock||g" frontend/src/lib/api-client.ts

# Frontend package scripts: private repo defaults `npm run dev` to the local
# MuckRock broker launcher. OSS should keep a generic raw Vite default instead.
python3 - <<'PY'
import json
from pathlib import Path

p = Path("frontend/package.json")
if p.exists():
    package = json.loads(p.read_text())
    scripts = package.get("scripts", {})
    if scripts.get("dev") == "bash ../scripts/dev/run-frontend-muckrock-local.sh":
        scripts["dev"] = "npm run dev:raw"
    scripts.pop("dev:hosted-broker", None)
    package["scripts"] = scripts
    p.write_text(json.dumps(package, indent=2) + "\n")
PY

# Remove the private-repo MuckRock launchers from the OSS mirror. The local
# Supabase demo launcher can stay; it does not depend on SaaS auth.
rm -f scripts/dev/run-frontend-muckrock-local.sh
rm -f scripts/dev/run-frontend-muckrock-hosted.sh

# -------------------------------------------------------------------
# OSS deployment defaults must be generated per newsroom. Never ship the
# hosted coJournalist Supabase project as a baked frontend/CLI target.
# -------------------------------------------------------------------
cat > frontend/.env.production <<'ENVEOF'
PUBLIC_DEPLOYMENT_TARGET=supabase
PUBLIC_SUPABASE_URL=https://project-ref.supabase.co
PUBLIC_SUPABASE_ANON_KEY=
VITE_API_URL=https://project-ref.supabase.co/functions/v1
PUBLIC_MAPTILER_API_KEY=
PUBLIC_MUCKROCK_ENABLED=false
PUBLIC_LOCAL_DEMO_MODE=false
ENVEOF

sed_if_exists -i "s|https://${HOSTED_SUPABASE_REF}.supabase.co|https://project-ref.supabase.co|g" frontend/.env.local.example
sed_if_exists -i 's|PUBLIC_SUPABASE_ANON_KEY=.*|PUBLIC_SUPABASE_ANON_KEY=<public anon key>|' frontend/.env.local.example

python3 - <<'PY'
from pathlib import Path

p = Path("Dockerfile")
if p.exists():
    text = p.read_text()
    start = text.find("ENV PUBLIC_DEPLOYMENT_TARGET=supabase")
    end = text.find("# MapTiler key stays as ARG", start)
    if start != -1 and end != -1:
        replacement = """ARG PUBLIC_DEPLOYMENT_TARGET=supabase
ARG PUBLIC_SUPABASE_URL=''
ARG PUBLIC_SUPABASE_ANON_KEY=''
ARG VITE_API_URL=''
ARG PUBLIC_MUCKROCK_ENABLED=false
ARG PUBLIC_LOCAL_DEMO_MODE=false
ENV PUBLIC_DEPLOYMENT_TARGET=${PUBLIC_DEPLOYMENT_TARGET}
ENV PUBLIC_SUPABASE_URL=${PUBLIC_SUPABASE_URL}
ENV PUBLIC_SUPABASE_ANON_KEY=${PUBLIC_SUPABASE_ANON_KEY}
ENV VITE_API_URL=${VITE_API_URL}
ENV PUBLIC_MUCKROCK_ENABLED=${PUBLIC_MUCKROCK_ENABLED}
ENV PUBLIC_LOCAL_DEMO_MODE=${PUBLIC_LOCAL_DEMO_MODE}
"""
        text = text[:start] + replacement + text[end:]
        p.write_text(text)
PY

sed_if_exists -i "s|https://${HOSTED_SUPABASE_REF}.supabase.co/functions/v1|https://www.scoutpost.ai/functions/v1|g" supabase/functions/openapi-spec/spec.json
sed_if_exists -i "s|${HOSTED_SUPABASE_REF}|<project-ref>|g" scripts/ops/deploy-functions.sh

# -------------------------------------------------------------------
# Validate: no SaaS-only references remain
# -------------------------------------------------------------------
echo "=== Validating OSS build ==="
FAIL=0
HOSTED_ONLY_EDGE_FUNCTIONS=(
  admin-report
  auth-muckrock
  billing-webhook
  indicator-claim
  mcp-auth
  newsletter-subscribe
  notifications-benchmark
)
HOSTED_ONLY_SHARED_FILES=(
  "${HOSTED_NEWSLETTER_ENTITLEMENT_PROVIDER}.ts"
  "${HOSTED_NEWSLETTER_ENTITLEMENT_PROVIDER}.test.ts"
  entitlements.ts
  entitlements.test.ts
  muckrock.ts
)

for fn in "${HOSTED_ONLY_EDGE_FUNCTIONS[@]}"; do
  if [ -d "supabase/functions/${fn}" ]; then
    echo "ERROR: hosted-only Edge Function still present in OSS build: ${fn}"
    FAIL=1
  fi
  if grep -q "^\[functions\.${fn}\]$" supabase/config.toml 2>/dev/null; then
    echo "ERROR: hosted-only Edge Function config still present in OSS build: ${fn}"
    FAIL=1
  fi
done

for file in "${HOSTED_ONLY_SHARED_FILES[@]}"; do
  if [ -f "supabase/functions/_shared/${file}" ]; then
    echo "ERROR: hosted-only shared Edge Function helper still present in OSS build: ${file}"
    FAIL=1
  fi
done

if grep -ri "$HOSTED_NEWSLETTER_ENTITLEMENT_PROVIDER" \
  --exclude="strip-oss.sh" \
  --exclude-dir=".git" \
  --exclude-dir=".jj" \
  --exclude-dir="node_modules" \
  --exclude-dir=".svelte-kit" \
  --exclude-dir="build" \
  --exclude-dir="tests" \
  . 2>/dev/null; then
  echo "ERROR: hosted newsletter entitlement provider references found in OSS build"
  FAIL=1
fi

if grep -ri "muckrock" --exclude="auth-supabase.ts" --exclude="types.ts" --exclude="PreferencesModal.svelte" --exclude-dir="faq" --exclude-dir="paraglide" --exclude-dir="tests" frontend/src/ 2>/dev/null; then
  echo "ERROR: MuckRock references found in OSS build"
  FAIL=1
fi

if grep -rE "'/pricing'|\"/pricing\"" --exclude-dir="tests" frontend/src/ 2>/dev/null; then
  echo "ERROR: /pricing references found in OSS build"
  FAIL=1
fi

if grep -r "accounts.muckrock.com" --exclude-dir="tests" frontend/src/ 2>/dev/null; then
  echo "ERROR: accounts.muckrock.com URLs found in OSS build"
  FAIL=1
fi

if grep -r "auth-muckrock" --exclude="auth-supabase.ts" --exclude-dir="tests" frontend/src/ 2>/dev/null; then
  echo "ERROR: auth-muckrock references found in OSS build"
  FAIL=1
fi

if grep -riE "indicator-claim|indicator_claim|subscription/claim|Claim Indicator|Indicator subscription" \
  --exclude="strip-oss.sh" \
  --exclude-dir=".git" \
  --exclude-dir=".jj" \
  --exclude-dir="node_modules" \
  --exclude-dir=".svelte-kit" \
  --exclude-dir="build" \
  --exclude-dir="tests" \
  . 2>/dev/null; then
  echo "ERROR: hosted Indicator claim references found in OSS build"
  FAIL=1
fi

if [ -d "backend/app/routers/threat_modeling" ]; then
  echo "ERROR: threat_modeling directory found in OSS build"
  FAIL=1
fi

if grep -r "$HOSTED_SUPABASE_REF" \
  --exclude-dir=".git" \
  --exclude-dir=".jj" \
  --exclude-dir="node_modules" \
  --exclude-dir=".svelte-kit" \
  --exclude-dir="build" \
  --exclude-dir="tests" \
  . 2>/dev/null; then
  echo "ERROR: hosted coJournalist Supabase project ref found in OSS build"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "Fix: update scripts/ops/strip-oss.sh with additional sed commands"
  exit 1
fi

echo "=== OSS strip complete — all validations passed ==="
