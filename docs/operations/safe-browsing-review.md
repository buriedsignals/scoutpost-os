# Safe Browsing Review Packet

BUG-019 is an operational provider-reputation gate, not a deterministic code
regression. Use this packet when checking or requesting review for
`scoutpost.ai`.

## Provider state to verify

- Google Search Console: `Security Issues`
- Google Search Console: `Manual Actions`
- Google Safe Browsing Site Status: `https://scoutpost.ai`
- Google Safe Browsing Site Status: `https://www.scoutpost.ai`
- Chrome browser interstitial state for apex and `www`

Record the exact check time, hostname, provider UI state, and any sample URLs.

## Evidence now supplied by the app

- `https://scoutpost.ai/robots.txt`
- `https://scoutpost.ai/sitemap.xml`
- `https://scoutpost.ai/.well-known/security.txt`
- HTTPS with HSTS
- Content Security Policy on HTML responses
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- canonical redirect from `www.scoutpost.ai` to `scoutpost.ai`

## Setup-page mitigation

The public `/setup` page is Docker-only and no longer collects API keys,
service-role keys, JWT secrets, deploy hooks, or provider credentials in the
browser. Operators create `scoutpost-setup.json` locally from the committed
example manifest, keep it out of Git, and mount it read-only into the installer
container.

## Review criteria

BUG-019 can be marked clear when:

- Search Console reports no active security issue.
- Google Safe Browsing is clean for apex and `www`.
- Chrome does not show an interstitial for public pages.
- Any provider review request includes the setup-page mitigation and public
  trust-file evidence above.
