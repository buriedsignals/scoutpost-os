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
        self._crawler: Any = None
        self._lock = asyncio.Lock()

    async def _ensure_crawler(self) -> Any:  # pragma: no cover - live path
        async with self._lock:
            if self._crawler is None:
                from crawl4ai import AsyncWebCrawler, BrowserConfig

                crawler = AsyncWebCrawler(
                    config=BrowserConfig(headless=True, verbose=False)
                )
                await crawler.start()
                self._crawler = crawler
        return self._crawler

    @property
    def warm(self) -> bool:
        return self._crawler is not None

    async def run(self, url: str, timeout_ms: int) -> Any:  # pragma: no cover - live path
        from crawl4ai import CacheMode, CrawlerRunConfig

        crawler = await self._ensure_crawler()
        run_config = CrawlerRunConfig(
            cache_mode=CacheMode.BYPASS,
            page_timeout=timeout_ms,
        )
        async with self._semaphore:
            return await crawler.arun(url=url, config=run_config)

    async def close(self) -> None:  # pragma: no cover - live path
        if self._crawler is not None:
            await self._crawler.close()
            self._crawler = None
