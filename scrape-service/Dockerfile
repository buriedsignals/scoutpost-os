# Scoutpost scrape-service — Crawl4AI (Playwright) + poppler pdftotext behind
# a bearer-authed FastAPI app. See SCRAPING-MIGRATION-PRD.md (U1/KTD5).
#
# Version bumps: monthly per docs/architecture/scrape-service.md runbook.
# Python deps install from the hash-locked requirements.lock. The browser is
# Debian's security-maintained Chromium, not Patchright's bundled build: no
# Playwright/Patchright release bundles a Chromium patched for CVE-2026-118306
# (fixed in 156.0.8078.73). Patchright's driver launches it through a symlink
# at the path it expects. Rebuild without cache to pick up Debian security
# updates; the build fails below CHROMIUM_MIN_VERSION.

FROM python:3.12-slim-bookworm

# Browsers in a world-readable path so the runtime (non-root) user finds them.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

ARG CHROMIUM_MIN_VERSION=156.0.8078.73

# xvfb + xauth: the browser runs HEADED under a virtual display — headless
# mode itself is what Cloudflare's JS challenge keys on (verified 2026-07-06:
# headless + undetected adapter + stealth still blocked on all 6 probe hosts).
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils xvfb xauth chromium \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.lock ./
# install-deps adds Patchright's system libraries and fonts only (no browser
# download). The symlink puts Debian's binary where the driver looks for it,
# and the version check runs the binary through that same path.
RUN pip install --require-hashes -r requirements.lock \
    && patchright install-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chrome="$(python -c 'from patchright.sync_api import sync_playwright as s; p = s().start(); print(p.chromium.executable_path); p.stop()')" \
    && mkdir -p "$(dirname "$chrome")" \
    && ln -s /usr/lib/chromium/chromium "$chrome" \
    && version="$("$chrome" --version | grep -oE '[0-9]+(\.[0-9]+){3}')" \
    && echo "Patchright launches Chromium $version" \
    && dpkg --compare-versions "$version" ge "$CHROMIUM_MIN_VERSION"

COPY app ./app

RUN mkdir -p /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix \
    && useradd --create-home scraper \
    && chown -R scraper:scraper /srv
USER scraper

EXPOSE 8080

# Local-compose healthcheck; Render uses healthCheckPath: /health instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import os,urllib.request;urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('PORT','8080')}/health\")" || exit 1

# xvfb-run gives the headed Chromium a virtual display (-a: auto display num).
CMD ["sh", "-c", "xvfb-run -a --server-args='-screen 0 1920x1080x24' uvicorn app.main:create_app --factory --host 0.0.0.0 --port ${PORT:-8080}"]
