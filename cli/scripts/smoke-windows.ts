// Native-Windows release smoke. This script intentionally refuses to run on
// another OS: cross-compilation is build evidence, not lifecycle evidence.
if (Deno.build.os !== "windows") {
  throw new Error("smoke-windows must run on a native Windows release runner");
}

import { WindowsCredentialStore } from "../lib/windows_credentials.ts";

const binary = new URL("../dist/scout-windows-x86_64.exe", import.meta.url);
const appData = await Deno.makeTempDir({ prefix: "scout-windows-smoke-" });
const env = { APPDATA: appData, USERPROFILE: appData };
const decoder = new TextDecoder();
const requests: Array<{ method: string; path: string; body: unknown }> = [];
const server = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen() {} },
  async (request) => {
    const url = new URL(request.url);
    let body: unknown = null;
    if (request.body) body = JSON.parse(await request.text());
    requests.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      body,
    });
    if (
      request.headers.get("Authorization") !==
        "Bearer cj_windows_smoke_not_a_real_key"
    ) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (request.method === "GET" && url.pathname === "/scouts") {
      return Response.json({
        items: [{
          id: "prior-scout",
          name: "Prior",
          type: "web",
          is_active: true,
        }],
        pagination: { has_more: false, offset: 0, limit: 50 },
      });
    }
    if (request.method === "PATCH" && url.pathname === "/scouts/prior-scout") {
      return Response.json({
        id: "prior-scout",
        name: "Updated",
        type: "web",
        is_active: true,
      });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
);
const port = (server.addr as Deno.NetAddr).port;

async function run(
  args: string[],
  stdin?: string,
): Promise<Deno.CommandOutput> {
  const command = new Deno.Command(binary, {
    args,
    env,
    clearEnv: false,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (stdin !== undefined) {
    const writer = command.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  return await command.output();
}

try {
  const version = await run(["--version"]);
  if (!version.success || !decoder.decode(version.stdout).trim()) {
    throw new Error("Windows scout binary did not report a version");
  }
  const help = await run(["--help"]);
  if (
    !help.success ||
    !decoder.decode(help.stdout).includes("scout — Scoutpost CLI")
  ) {
    throw new Error("Windows scout binary did not render its command contract");
  }
  if (
    !(await run(["config", "set", `api_url=http://127.0.0.1:${port}`])).success
  ) {
    throw new Error(
      "Windows scout binary could not write public configuration",
    );
  }
  const secret = "cj_windows_smoke_not_a_real_key";
  if (
    !(await run(["config", "set", "api_key", "--stdin"], `${secret}\n`)).success
  ) {
    throw new Error(
      "Windows scout binary could not store a credential through stdin",
    );
  }
  const shown = await run(["config", "show"]);
  const output = decoder.decode(shown.stdout);
  if (!shown.success || output.includes(secret) || !output.includes("cj_w")) {
    throw new Error("Windows scout config output did not preserve redaction");
  }
  const config = await Deno.readTextFile(`${appData}\\Scoutpost\\config.json`);
  if (config.includes(secret) || config.includes("api_key")) {
    throw new Error("Windows scout wrote protected credentials to config.json");
  }
  const listed = await run(["scouts", "list"]);
  if (
    !listed.success || !decoder.decode(listed.stdout).includes("prior-scout")
  ) {
    throw new Error(
      "Windows scout could not list through its authenticated API client",
    );
  }
  const updated = await run([
    "scouts",
    "update",
    "prior-scout",
    "--name",
    "Updated",
  ]);
  if (!updated.success || !decoder.decode(updated.stdout).includes("Updated")) {
    throw new Error("Windows scout could not update a prior-version object");
  }
  if (
    !requests.some((request) =>
      request.method === "GET" && request.path.startsWith("/scouts?")
    ) ||
    !requests.some((request) =>
      request.method === "PATCH" &&
      request.path === "/scouts/prior-scout" &&
      JSON.stringify(request.body) === JSON.stringify({ name: "Updated" })
    )
  ) {
    throw new Error(
      "Windows scout did not preserve the list/update wire contract",
    );
  }
} finally {
  await server.shutdown();
  const credentials = new WindowsCredentialStore();
  credentials.delete("api_key");
  credentials.delete("auth_token");
  await Deno.remove(appData, { recursive: true });
}
