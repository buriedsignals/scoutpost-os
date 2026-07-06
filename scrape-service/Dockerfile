# Scoutpost scrape-service — Crawl4AI (Playwright) + poppler pdftotext behind
# a bearer-authed FastAPI app. See SCRAPING-MIGRATION-PRD.md (U1/KTD5).
#
# Version bumps: monthly per docs/architecture/scrape-service.md runbook.
# crawl4ai is pinned in requirements.txt; Playwright/Chromium version rides
# with crawl4ai's pinned playwright dependency.

FROM python:3.12-slim-bookworm

# Browsers in a world-readable path so the runtime (non-root) user finds them.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt ./
RUN pip install -r requirements.txt \
    && playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY app ./app

RUN useradd --create-home scraper \
    && chown -R scraper:scraper /srv
USER scraper

EXPOSE 8080

# Local-compose healthcheck; Render uses healthCheckPath: /health instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import os,urllib.request;urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('PORT','8080')}/health\")" || exit 1

CMD ["sh", "-c", "uvicorn app.main:create_app --factory --host 0.0.0.0 --port ${PORT:-8080}"]
