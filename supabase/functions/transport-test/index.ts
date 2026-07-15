/**
 * Authenticated, non-credit Fleet transport configuration live test.
 * Fetches the current matching watched objects/pass windows and returns the
 * stable state ids the create call can hand back as transport_baseline_ids.
 */

import { z } from "https://esm.sh/zod@3";
import { requireUserOrApiKey } from "../_shared/auth.ts";
import { handleCors } from "../_shared/cors.ts";
import { ValidationError } from "../_shared/errors.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { assertTransportEntitled } from "../_shared/transport_entitlement.ts";
import { runTransportTest, transportTestDependencies } from "./lib.ts";

const InputSchema = z.object({ config: z.unknown() });

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return jsonError("method not allowed", 405);

  let serviceClient: ReturnType<typeof getServiceClient>;
  try {
    const user = await requireUserOrApiKey(req);
    serviceClient = getServiceClient();
    await assertTransportEntitled(serviceClient, user.id, "transport-test");
  } catch (error) {
    return jsonFromError(error);
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
        parsed.error.issues.map((issue) =>
          `${issue.path.join(".")}: ${issue.message}`
        ).join("; "),
      ),
    );
  }

  try {
    return jsonOk(
      await runTransportTest(
        parsed.data.config,
        transportTestDependencies(serviceClient),
      ),
    );
  } catch (error) {
    return jsonFromError(error);
  }
});
