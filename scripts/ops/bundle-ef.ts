#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * bundle-ef.ts — inline an Edge Function's _shared/* deps into one self-
 * contained file at supabase/functions/<name>/_bundled.ts.
 *
 * Why: the Supabase MCP deploy tool's module resolver doesn't reach
 * across function dirs reliably for `../_shared/X.ts` imports. Rather
 * than upload each _shared module as a sibling file (which works but
 * is fragile across deploy-tool versions), we concat everything into
 * one entrypoint.
 *
 * Usage:
 *   deno run --allow-read --allow-write scripts/ops/bundle-ef.ts <ef-name>
 *
 * Strategy:
 *   1. BFS the EF entrypoint and all its _shared/*.ts deps.
 *   2. Topologically sort _shared/*.ts by intra-shared deps.
 *   3. For each file (shared topo order, then main): walk top-level
 *      import statements. Strip `from "./X.ts"` and `from "../_shared/X.ts"`
 *      imports (those modules are now inlined). Hoist + dedupe external
 *      imports (`https://...`, `npm:...`, `jsr:...`) to the top.
 *   4. Concatenate: [external imports] + [shared bodies in topo order] +
 *      [main body].
 */
// This script lives at scripts/ops/bundle-ef.ts, so the repo root is two
// levels up.
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const FUNCTIONS_DIR = `${ROOT}/supabase/functions`;
const SHARED_DIR = `${FUNCTIONS_DIR}/_shared`;

interface Statement {
  text: string;
  /** Source path, if this is an import; else null. */
  source: string | null;
}

/** Split a TypeScript file into top-level statements (for import lines)
 *  and trailing body. We only need to identify import statements at the
 *  top of the file — once we hit a non-import statement, the rest is
 *  body. This is sufficient for our codebase (all imports are at top). */
function splitImports(src: string): { imports: Statement[]; body: string } {
  const imports: Statement[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    // Skip whitespace + line/block comments.
    while (i < n) {
      const c = src[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i++;
        continue;
      }
      if (c === "/" && src[i + 1] === "/") {
        const eol = src.indexOf("\n", i);
        i = eol < 0 ? n : eol + 1;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        i = end < 0 ? n : end + 2;
        continue;
      }
      break;
    }
    if (i >= n) break;

    // Is this an `import ...` statement? Only consume top-level imports.
    if (src.startsWith("import", i) && /\s|['"({]/.test(src[i + 6] ?? "")) {
      const start = i;
      // Walk forward to the terminating `;` or newline-after-source.
      // Need to skip inside string literals.
      let end = i + 6;
      let inStr: string | null = null;
      while (end < n) {
        const c = src[end];
        if (inStr) {
          if (c === "\\" && end + 1 < n) {
            end += 2;
            continue;
          }
          if (c === inStr) inStr = null;
          end++;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") {
          inStr = c;
          end++;
          continue;
        }
        if (c === ";") {
          end++;
          break;
        }
        end++;
      }
      const text = src.slice(start, end);
      // Extract source: the quoted string after `from` (tolerates trailing
      // `with { type: "json" }` import attributes), or the bare-string source
      // for side-effect `import "x"` imports.
      const m = text.match(/from\s+(['"])([^'"]+)\1/) ??
        text.match(/^\s*import\s+(['"])([^'"]+)\1/);
      const source = m ? m[2] : null;
      imports.push({ text, source });
      i = end;
      continue;
    }

    // First non-import top-level token — the rest is body.
    return { imports, body: src.slice(i) };
  }
  return { imports, body: "" };
}

function isSharedImport(source: string): boolean {
  return source.startsWith("./") || source.startsWith("../_shared/") ||
    source === "../_shared/";
}

/** Resolve a `_shared/X.ts` import path (or a `./X.ts` path inside _shared)
 *  to an absolute filesystem path. */
function resolveSharedPath(source: string, fromFile: string): string {
  if (source.startsWith("./")) {
    // Inside _shared: ./X.ts → SHARED_DIR/X.ts (we only call this on
    // _shared files, so fromFile is in SHARED_DIR).
    const dir = fromFile.substring(0, fromFile.lastIndexOf("/"));
    return `${dir}/${source.slice(2)}`;
  }
  if (source.startsWith("../_shared/")) {
    return `${SHARED_DIR}/${source.slice("../_shared/".length)}`;
  }
  throw new Error(`Not a _shared import: ${source}`);
}

interface SharedFile {
  path: string;
  body: string;
  externalImports: Statement[];
  inlinedJson: string[];
  /** Other _shared paths this file depends on. */
  deps: Set<string>;
}

/** Inline a relative JSON import as `const X = <json>;` so the bundle is
 *  self-contained. Triggered by either `import X from "./foo.json"` or the
 *  newer `import X from "./foo.json" with { type: "json" }` form. */
function inlineJsonImport(stmt: Statement, fromFile: string): string {
  const localName = stmt.text.match(/import\s+(\w+)\s+from/)?.[1];
  if (!localName) {
    throw new Error(`Cannot inline JSON import (no default name): ${stmt.text}`);
  }
  const dir = fromFile.substring(0, fromFile.lastIndexOf("/"));
  const jsonPath = stmt.source!.startsWith("/")
    ? stmt.source!
    : `${dir}/${stmt.source}`.replace(/\/\.\//g, "/").replace(
        /\/[^/]+\/\.\.\//g,
        "/",
      );
  const json = Deno.readTextFileSync(jsonPath);
  return `const ${localName} = ${json.trimEnd()};`;
}

function loadFile(path: string): {
  externalImports: Statement[];
  inlinedJson: string[];
  body: string;
  sharedDeps: string[];
} {
  const src = Deno.readTextFileSync(path);
  const { imports, body } = splitImports(src);
  const externalImports: Statement[] = [];
  const inlinedJson: string[] = [];
  const sharedDeps: string[] = [];

  for (const stmt of imports) {
    if (stmt.source && isSharedImport(stmt.source)) {
      sharedDeps.push(resolveSharedPath(stmt.source, path));
    } else if (stmt.source && /\.json$/i.test(stmt.source) && !/^https?:/i.test(stmt.source)) {
      inlinedJson.push(inlineJsonImport(stmt, path));
    } else {
      externalImports.push(stmt);
    }
  }
  return { externalImports, inlinedJson, body, sharedDeps };
}

function buildSharedGraph(entryDeps: string[]): Map<string, SharedFile> {
  const files = new Map<string, SharedFile>();
  const queue = [...entryDeps];

  while (queue.length) {
    const path = queue.shift()!;
    if (files.has(path)) continue;
    const { externalImports, inlinedJson, body, sharedDeps } = loadFile(path);
    files.set(path, {
      path,
      body,
      externalImports,
      inlinedJson,
      deps: new Set(sharedDeps),
    });
    for (const dep of sharedDeps) {
      if (!files.has(dep)) queue.push(dep);
    }
  }
  return files;
}

function toposort(files: Map<string, SharedFile>): SharedFile[] {
  const sorted: SharedFile[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(path: string) {
    if (visited.has(path)) return;
    if (visiting.has(path)) {
      throw new Error(`Cyclic _shared dep involving: ${path}`);
    }
    visiting.add(path);
    const file = files.get(path)!;
    for (const dep of file.deps) visit(dep);
    visiting.delete(path);
    visited.add(path);
    sorted.push(file);
  }

  // Visit in stable order (sorted paths) so output is deterministic.
  for (const path of [...files.keys()].sort()) visit(path);
  return sorted;
}

function dedupeImports(stmts: Statement[]): Statement[] {
  // Normalize internal whitespace so that two semantically-identical
  // multi-line imports (e.g. `import {\n  X,\n} from "y"` vs.
  // `import { X } from "y"`) collapse to one — otherwise both end up in
  // the bundled output and Deno errors with "Identifier already declared".
  const seen = new Set<string>();
  const out: Statement[] = [];
  for (const s of stmts) {
    const key = s.text.replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function main() {
  const efName = Deno.args[0];
  if (!efName) {
    console.error("Usage: bundle-ef.ts <ef-name>");
    Deno.exit(2);
  }
  const entryPath = `${FUNCTIONS_DIR}/${efName}/index.ts`;
  try {
    Deno.statSync(entryPath);
  } catch {
    console.error(`Not found: ${entryPath}`);
    Deno.exit(2);
  }

  const main = loadFile(entryPath);
  const sharedFiles = buildSharedGraph(main.sharedDeps);
  const sortedShared = toposort(sharedFiles);

  // Collect all externals (shared + main), dedupe.
  const allExternals = dedupeImports([
    ...sortedShared.flatMap((f) => f.externalImports),
    ...main.externalImports,
  ]);
  // Inlined JSON consts (from `import X from "./foo.json"`) — emit once.
  const allInlinedJson = [
    ...sortedShared.flatMap((f) => f.inlinedJson),
    ...main.inlinedJson,
  ];

  const banner =
    `// AUTO-GENERATED by scripts/ops/bundle-ef.ts — do not edit by hand.\n` +
    `// Source: supabase/functions/${efName}/index.ts + _shared/* deps.\n` +
    `// Regenerate: deno run --allow-read --allow-write scripts/ops/bundle-ef.ts ${efName}\n`;

  const sections: string[] = [banner];
  if (allExternals.length) {
    sections.push(allExternals.map((s) => s.text).join("\n"));
  }
  if (allInlinedJson.length) {
    sections.push(`// --- inlined JSON imports ---\n${allInlinedJson.join("\n")}`);
  }
  for (const f of sortedShared) {
    const rel = f.path.substring(SHARED_DIR.length + 1);
    sections.push(`// --- _shared/${rel} ---\n${f.body.trimEnd()}`);
  }
  sections.push(`// --- ${efName}/index.ts ---\n${main.body.trimEnd()}`);

  const output = sections.join("\n\n") + "\n";
  const outPath = `${FUNCTIONS_DIR}/${efName}/_bundled.ts`;
  Deno.writeTextFileSync(outPath, output);

  console.log(`bundled → ${outPath}`);
  console.log(`  shared deps: ${sortedShared.length}`);
  for (const f of sortedShared) {
    console.log(`    - ${f.path.substring(SHARED_DIR.length + 1)}`);
  }
  console.log(`  external imports: ${allExternals.length}`);
}

main();
