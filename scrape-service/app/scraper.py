"""Crawl4AI wrapper: one shared browser, a small semaphore-capped pool.

crawl4ai (and its Playwright runtime) is imported lazily so the unit-test tier
and the CI job never need the browser stack installed — the wrapper body is
exercised by the `live`-marked tests and the container healthcheck instead.
"""

import asyncio
from typing import Any


class Scraper:
    def __init__(self, pool_size: int) -> None:
        self._semaphore = asyncio.Semaphore(pool_size)
        # Snapshot fetches hold a browser slot far longer than ordinary
        # scrapes (scan + MHTML + compositor). Serializing them keeps at most
        # ONE pool slot on long-hold duty, so concurrent captures cannot
        # starve ordinary scrapes into queue-wait 504s.
        self._snapshot_semaphore = asyncio.Semaphore(1)
        self._crawler: Any = None
        self._lock = asyncio.Lock()

    async def _ensure_crawler(self) -> Any:  # pragma: no cover - live path
        async with self._lock:
            if self._crawler is None:
                from crawl4ai import AsyncWebCrawler, BrowserConfig, UndetectedAdapter
                from crawl4ai.async_crawler_strategy import (
                    AsyncPlaywrightCrawlerStrategy,
                )

                # Stealth by default: production Firecrawl cleared Cloudflare
                # JS challenges that vanilla Playwright on a datacenter IP does
                # not (2026-07-06 flip: galeria.de, mardigras.org.au,
                # npcc.police.uk, pappers.fr all 307→challenge). The undetected
                # adapter + stealth flag patch the browser fingerprint at the
                # driver level; content output is unchanged for unprotected
                # sites, so canonical hashing/dedup is unaffected.
                #
                # headless=False: verified 2026-07-06 that headless stealth
                # alone still trips the CF JS challenge on all 6 probe hosts —
                # headless itself is the detection vector. The container runs
                # the process under xvfb-run (see Dockerfile CMD) so the headed
                # browser has a display.
                browser_config = BrowserConfig(
                    headless=False, verbose=False, enable_stealth=True
                )
                crawler = AsyncWebCrawler(
                    crawler_strategy=AsyncPlaywrightCrawlerStrategy(
                        browser_config=browser_config,
                        browser_adapter=UndetectedAdapter(),
                    ),
                    config=browser_config,
                )
                await crawler.start()
                self._crawler = crawler
        return self._crawler

    @property
    def warm(self) -> bool:
        return self._crawler is not None

    async def run(
        self,
        url: str,
        timeout_ms: int,
        snapshot: bool = False,
    ) -> Any:  # pragma: no cover - live path
        from crawl4ai import CacheMode, CrawlerRunConfig

        crawler = await self._ensure_crawler()
        # magic/simulate_user/override_navigator: crawl4ai's page-level
        # anti-detection (human-like interaction timing, navigator patches) —
        # layered with the undetected adapter for CF-challenged scout hosts.
        #
        # snapshot=True (PAGE-ARCHIVE-PRD U1/KTD1): capture MHTML + full-page
        # screenshot on the SAME arun that produces the markdown — same-render
        # provenance is the point. Both flags ride crawl4ai's native capture
        # (CDP Page.captureSnapshot under the hood); the live test suite must
        # prove them under this exact stealth/undetected/headed config, not
        # vanilla Playwright.
        # scan_full_page is load-bearing for the screenshot: crawl4ai's
        # screenshot path degrades to viewport-only when it is False (its
        # default) — verified against 0.8.9's take_screenshot kwargs. It also
        # scrolls the page pre-capture, which pulls lazy-loaded content into
        # the MHTML. max_scroll_steps bounds infinite-scroll pages.
        run_config = CrawlerRunConfig(
            cache_mode=CacheMode.BYPASS,
            page_timeout=timeout_ms,
            magic=True,
            simulate_user=True,
            override_navigator=True,
            capture_mhtml=snapshot,
            screenshot=snapshot,
            scan_full_page=snapshot,
            max_scroll_steps=30 if snapshot else None,
        )
        if snapshot:
            async with self._snapshot_semaphore:
                async with self._semaphore:
                    return await crawler.arun(url=url, config=run_config)
        async with self._semaphore:
            return await crawler.arun(url=url, config=run_config)

    async def close(self) -> None:  # pragma: no cover - live path
        if self._crawler is not None:
            await self._crawler.close()
            self._crawler = None
