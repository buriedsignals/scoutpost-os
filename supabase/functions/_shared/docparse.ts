/**
 * Document-parse port (SCRAPING-MIGRATION-PRD U3).
 *
 * `parseDocument(url)` returns markdown/text for a civic document (PDF today,
 * occasionally an HTML agenda). It is the switch point for PDF parsing at the
 * U7 flip:
 *
 *   - SCRAPE_PROVIDER=firecrawl (default, dark): `firecrawlScrape(url)` — the
 *     legacy path, which parses PDFs server-side (pdfMode:"fast", embedded
 *     text, no OCR) and HTML transparently. Behavior is byte-identical to the
 *     former civic call sites.
 *   - SCRAPE_PROVIDER=crawl4ai: dispatch by content. Try the self-hosted
 *     scrape-service `POST /parse` (poppler `pdftotext -layout`, deterministic
 *     — civic dedup keys on content_sha256); if the service reports the URL is
 *     not a PDF (415), fall back to the browser scrape port for HTML. A
 *     bitmap-only PDF surfaces as `NeedsOcrError` (the service's 422), which
 *     mirrors today's silent-empty behavior — production has never OCR'd.
 *
 * Consumers read `.markdown` only; `pages` is advisory (scanned-share metrics).
 */

import { ApiError } from "./errors.ts";
import { firecrawlScrape } from "./scrape_firecrawl.ts";
import { scrape, scrapeProvider } from "./scrape.ts";

export interface DocParseResult {
  markdown: string;
  source_url: string;
  /** Document title where available (Firecrawl/HTML scrape); a PDF parsed by
   * pdftotext has no reliable title, so callers fall back to the URL. */
  title?: string;
  /** Page count from the parser; undefined on the Firecrawl/HTML paths. */
  pages?: number;
}

export interface DocParseOptions {
  /** Server-side timeout in ms (default 120_000 for large civic PDFs). */
  timeoutMs?: number;
  /** Client-side abort fuse in ms; defaults to timeoutMs + 5000. */
  abortAfterMs?: number;
}

/** A bitmap-only PDF: the density guard tripped, no extractable text. Distinct,
 * non-transient — the caller treats it like an empty document (no OCR today). */
export class NeedsOcrError extends Error {
  constructor(public readonly pages: number, public readonly chars: number) {
    super(`needs_ocr: ${chars} chars over ${pages} pages`);
    this.name = "NeedsOcrError";
  }
}

function serviceConfig(): { url: string; token: string } {
  const url = Deno.env.get("SCRAPE_SERVICE_URL");
  if (!url) throw new ApiError("SCRAPE_SERVICE_URL not configured", 500);
  const token = Deno.env.get("SCRAPE_SERVICE_TOKEN");
  if (!token) throw new ApiError("SCRAPE_SERVICE_TOKEN not configured", 500);
  return { url: url.replace(/\/+$/, ""), token };
}

/** Sentinel: the scrape-service reported the URL is not a PDF (HTTP 415). */
const NOT_A_PDF = Symbol("not_a_pdf");

async function parseViaService(
  url: string,
  opts: DocParseOptions,
): Promise<DocParseResult | typeof NOT_A_PDF> {
  const { url: base, token } = serviceConfig();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  // The /parse path can run download → pdftotext → native Google PDF fallback
  // through OpenRouter server-side (up to ~135s on a large scanned doc). The
  // client fuse must outlast that, or the service fallback gets abandoned just
  // before it returns. pg_cron civic parsing is not latency-sensitive.
  const abortAfterMs = opts.abortAfterMs ?? 210_000;

  const ac = new AbortController();
  const fuse = setTimeout(() => ac.abort(), abortAfterMs);
  let res: Response;
  try {
    res = await fetch(`${base}/parse`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url }),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(fuse);
    if ((e as { name?: string }).name === "AbortError") {
      throw new ApiError(`crawl4ai parse aborted after ${abortAfterMs}ms`, 504);
    }
    throw e;
  }
  clearTimeout(fuse);

  if (res.status === 415) {
    await res.body?.cancel();
    return NOT_A_PDF;
  }
  if (res.status === 422) {
    const body = await res.json().catch(() => ({}));
    const detail = body?.detail ?? {};
    if (detail?.error === "needs_ocr") {
      throw new NeedsOcrError(Number(detail.pages ?? 0), Number(detail.chars ?? 0));
    }
    throw new ApiError(`crawl4ai parse failed: 422 ${JSON.stringify(body)}`, 502);
  }
  if (!res.ok) {
    // Parity with the scrape provider: non-OK → 502 (transient classifier
    // still catches upstream 5xx/429 via the "failed: <status>" shape).
    throw new ApiError(`crawl4ai parse failed: ${res.status} ${await res.text()}`, 502);
  }
  const d = await res.json();
  return {
    markdown: typeof d.markdown === "string" ? d.markdown : "",
    source_url: typeof d.source_url === "string" ? d.source_url : url,
    pages: typeof d.pages === "number" ? d.pages : undefined,
  };
}

export async function parseDocument(
  url: string,
  opts: DocParseOptions = {},
): Promise<DocParseResult> {
  if (scrapeProvider() === "firecrawl") {
    const r = await firecrawlScrape(url, {
      timeoutMs: opts.timeoutMs,
      abortAfterMs: opts.abortAfterMs,
    });
    return { markdown: r.markdown, source_url: r.source_url, title: r.title };
  }

  const parsed = await parseViaService(url, opts);
  if (parsed !== NOT_A_PDF) return parsed;

  // Not a PDF → the document is an HTML page (e.g. an agenda). Render it.
  const r = await scrape(url, {
    formats: ["markdown"],
    timeoutMs: opts.timeoutMs,
    abortAfterMs: opts.abortAfterMs,
  });
  return { markdown: r.markdown, source_url: r.source_url, title: r.title };
}
