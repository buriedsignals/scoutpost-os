/** Authenticated HTTP dispatcher for the canonical Scout operations. */
import { handleCors } from "../_shared/cors.ts";
import { type AuthedUser, requireUserOrApiKey } from "../_shared/auth.ts";
import { jsonError, jsonFromError } from "../_shared/responses.ts";
import { logEvent } from "../_shared/log.ts";
import {
  createScout,
  createScoutFromTemplate,
  deleteScout,
  getScout,
  listScouts,
  pauseScout,
  resumeScout,
  runScout,
  testScout,
  updateScout,
} from "./handlers.ts";
Deno.serve(async (req): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;
  let user: AuthedUser;
  try {
    user = await requireUserOrApiKey(req);
  } catch (e) {
    return jsonFromError(e);
  }
  const url = new URL(req.url);
  // Trim the "/scouts" prefix Kong leaves on the path. "/scouts" -> "",
  // "/scouts/<id>" -> "/<id>", "/scouts/<id>/run" -> "/<id>/run".
  const path = url.pathname.replace(/^.*\/scouts/, "") || "/";
  const idMatch = path.match(/^\/([0-9a-f-]{36})$/i);
  const idActionMatch = path.match(/^\/([0-9a-f-]{36})\/(run|pause|resume)$/i);
  const isRead = req.method === "GET" || req.method === "HEAD";
  try {
    if (path === "/" && isRead) {
      return await listScouts(req, user);
    }
    if (path === "/" && req.method === "POST") {
      return await createScout(req, user);
    }
    if (path === "/from-template" && req.method === "POST") {
      return await createScoutFromTemplate(req, user);
    }
    if (path === "/test" && req.method === "POST") {
      return await testScout(req, user);
    }
    if (idMatch && isRead) {
      return await getScout(user, idMatch[1]);
    }
    if (idMatch && req.method === "PATCH") {
      return await updateScout(req, user, idMatch[1]);
    }
    if (idMatch && req.method === "DELETE") {
      return await deleteScout(user, idMatch[1]);
    }
    if (idActionMatch && req.method === "POST") {
      const [, id, action] = idActionMatch;
      if (action === "run") return await runScout(user, id);
      if (action === "pause") return await pauseScout(user, id);
      if (action === "resume") return await resumeScout(user, id);
    }
    return jsonError("method not allowed", 405);
  } catch (e) {
    logEvent({
      level: "error",
      fn: "scouts",
      event: "unhandled",
      user_id: user.id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonFromError(e);
  }
});
