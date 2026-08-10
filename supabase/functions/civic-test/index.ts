/**
 * civic-test Edge Function — synchronous preview of what a civic scout would
 * extract, used by the UI's Add Civic Scout flow. Nothing is persisted.
 *
 * Route:
 *   POST /civic-test
 *     body: { tracked_urls: string[] (1..2), criteria?: string }
 *     -> 200 { results: [{ url, title?, promises_count?, promises?, error? }] }
 *
 * For each tracked URL (max 2): scrape the listing page raw HTML, resolve
 * downstream meeting documents, then preview promises from those documents.
 * Per-URL failures are reported in the result entry rather than surfacing
 * as a 500.
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import { AuthedUser, requireUser } from "../_shared/auth.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { ValidationError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import { previewCivicTrackedUrls } from "../_shared/civic_preview.ts";
import type { CivicPreviewItem } from "../_shared/civic_preview.ts";

const InputSchema = z.object({
  tracked_urls: z.array(z.string().url()).min(1).max(2),
  criteria: z.string().max(4000).optional(),
});

interface ExtractedPromise {
  promise_text: string;
  context?: string;
  meeting_date?: string | null;
}

interface UrlResult {
  url: string;
  title?: string;
  promises_count?: number;
  promises?: ExtractedPromise[];
  items_count?: number;
  items?: CivicPreviewItem[];
  policy_version?: string;
  error?: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return jsonError("method not allowed", 405);
  }

  let user: AuthedUser;
  try {
    user = await requireUser(req);
  } catch (e) {
    return jsonFromError(e);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonFromError(new ValidationError("invalid JSON body"));
  }
  const parsed = InputSchema.safeParse(body);
  if (!parsed.success) {
    return jsonFromError(
      new ValidationError(
        parsed.error.issues.map((i) => i.message).join("; "),
      ),
    );
  }
  const { tracked_urls, criteria } = parsed.data;

  try {
    const results: UrlResult[] = [];
    for (const url of tracked_urls) {
      results.push(await previewUrl(url, criteria));
    }

    logEvent({
      level: "info",
      fn: "civic-test",
      event: "preview",
      user_id: user.id,
      urls: tracked_urls.length,
    });

    return jsonOk({ results });
  } catch (e) {
    logEvent({
      level: "error",
      fn: "civic-test",
      event: "unhandled",
      user_id: user.id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonFromError(e);
  }
});

// ---------------------------------------------------------------------------

async function previewUrl(
  url: string,
  criteria: string | undefined,
): Promise<UrlResult> {
  const preview = await previewCivicTrackedUrls([url], criteria, {
    maxDocs: 5,
    maxPromisesPerDocument: 10,
  });
  const promises: ExtractedPromise[] = preview.documents.flatMap((document) =>
    document.promises.map((promise) => ({
      promise_text: promise.promise_text,
      context: promise.context,
      meeting_date: promise.source_date || null,
    }))
  );
  const items = preview.documents.flatMap((document) => document.items);

  return {
    url,
    title: preview.documents[0]?.title,
    promises_count: promises.length,
    promises,
    items_count: items.length,
    items,
    policy_version: preview.policyVersion,
  };
}
