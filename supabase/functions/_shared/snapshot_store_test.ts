import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { SupabaseClient } from "./supabase.ts";
import {
  deleteScoutSnapshots,
  manifestObjectPath,
  sha256HexBytes,
  SNAPSHOT_BUCKET,
  SnapshotIntegrityError,
  snapshotDiagnostics,
  snapshotObjectPath,
  SnapshotPathError,
  SnapshotStorageError,
  storeSnapshot,
  type StoreSnapshotParams,
} from "./snapshot_store.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const SCOUT = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const SNAP = "44444444-4444-4444-8444-444444444444";

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

interface FakeOptions {
  uploadErrors?: Record<string, string | { message: string; statusCode?: string }>; // substring of path -> error
  listPages?: Array<Array<{ name: string }>>;
  listError?: string;
  removeError?: string;
  insertError?: string;
  insertNullData?: boolean;
  deleteError?: string;
}

function fakeSvc(opts: FakeOptions = {}) {
  const uploads: Array<{ path: string; contentType: string; bytes: Uint8Array }> = [];
  const removed: string[][] = [];
  const inserts: Array<Record<string, unknown>> = [];
  const deletes: Array<Record<string, unknown>> = [];
  const listPages = [...(opts.listPages ?? [])];

  const storageApi = {
    upload(path: string, bytes: Uint8Array, uploadOpts: { contentType: string }) {
      const errorKey = Object.keys(opts.uploadErrors ?? {}).find((k) => path.includes(k));
      if (errorKey) {
        const spec = opts.uploadErrors![errorKey];
        const error = typeof spec === "string" ? { message: spec } : spec;
        return Promise.resolve({ error });
      }
      uploads.push({ path, contentType: uploadOpts.contentType, bytes });
      return Promise.resolve({ error: null });
    },
    list(_prefix: string, _listOpts: { limit: number }) {
      if (opts.listError) {
        return Promise.resolve({ data: null, error: { message: opts.listError } });
      }
      return Promise.resolve({ data: listPages.shift() ?? [], error: null });
    },
    remove(names: string[]) {
      if (opts.removeError) {
        return Promise.resolve({ error: { message: opts.removeError } });
      }
      removed.push(names);
      return Promise.resolve({ error: null });
    },
  };

  const svc = {
    storage: { from: (_bucket: string) => storageApi },
    from(_table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push(row);
          return {
            select: (_cols: string) => ({
              single: () =>
                Promise.resolve(
                  opts.insertError
                    ? { data: null, error: { message: opts.insertError } }
                    : opts.insertNullData
                    ? { data: null, error: null }
                    : { data: { id: SNAP }, error: null },
                ),
            }),
          };
        },
        delete() {
          return {
            eq: (col1: string, val1: unknown) => ({
              eq: (col2: string, val2: unknown) => {
                deletes.push({ [col1]: val1, [col2]: val2 });
                return Promise.resolve(
                  opts.deleteError ? { error: { message: opts.deleteError } } : { error: null },
                );
              },
            }),
          };
        },
      };
    },
  };
  return { svc: svc as unknown as SupabaseClient, uploads, removed, inserts, deletes };
}

function fullParams(overrides: Partial<StoreSnapshotParams> = {}): StoreSnapshotParams {
  return {
    scoutId: SCOUT,
    userId: USER,
    scoutRunId: RUN,
    captureKind: "change",
    fidelity: "full",
    servedBy: "crawl4ai",
    capturedAt: "2026-07-07T10:00:00.000Z",
    requestedUrl: "https://example.com/page",
    finalUrl: "https://example.com/page",
    httpStatus: 200,
    responseHeaders: { "content-type": "text/html" },
    contentSha256: "a".repeat(64),
    canonicalContentSha256: "b".repeat(64),
    markdown: "# Heading\n\nBody text.",
    artifacts: [
      { kind: "mhtml", bytes: bytesOf("mhtml-bytes") },
      { kind: "screenshot", bytes: bytesOf("png-bytes") },
    ],
    ...overrides,
  };
}

Deno.test("sha256HexBytes matches known vectors", async () => {
  assertEquals(
    await sha256HexBytes(new Uint8Array(0)),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assertEquals(
    await sha256HexBytes(bytesOf("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("snapshotObjectPath builds content-addressed paths per kind", () => {
  const sha = "c".repeat(64);
  assertEquals(
    snapshotObjectPath(USER, SCOUT, sha, "mhtml"),
    `${USER}/${SCOUT}/${sha}.mhtml`,
  );
  assertEquals(snapshotObjectPath(USER, SCOUT, sha, "screenshot").endsWith(".png"), true);
  assertEquals(snapshotObjectPath(USER, SCOUT, sha, "rawhtml").endsWith(".html"), true);
  assertEquals(snapshotObjectPath(USER, SCOUT, sha, "markdown").endsWith(".md"), true);
  // Uppercase ids are valid UUIDs but must lowercase in the path: storage RLS
  // compares the first folder to auth.uid()::text, which is lowercase.
  assertEquals(
    snapshotObjectPath(USER.toUpperCase(), SCOUT.toUpperCase(), sha, "mhtml"),
    `${USER}/${SCOUT}/${sha}.mhtml`,
  );
  assertEquals(
    manifestObjectPath(USER.toUpperCase(), SCOUT, SNAP.toUpperCase()),
    `${USER}/${SCOUT}/manifest-${SNAP}.json`,
  );
});

Deno.test("snapshotObjectPath rejects traversal-shaped ids and hashes", () => {
  assertThrows(
    () => snapshotObjectPath("../evil", SCOUT, "c".repeat(64), "mhtml"),
    SnapshotPathError,
  );
  assertThrows(
    () => snapshotObjectPath(USER, "not-a-uuid", "c".repeat(64), "mhtml"),
    SnapshotPathError,
  );
  assertThrows(
    () => snapshotObjectPath(USER, SCOUT, "../../etc/passwd", "mhtml"),
    SnapshotPathError,
  );
});

Deno.test("manifestObjectPath validates and builds", () => {
  assertEquals(
    manifestObjectPath(USER, SCOUT, SNAP),
    `${USER}/${SCOUT}/manifest-${SNAP}.json`,
  );
  assertThrows(() => manifestObjectPath(USER, SCOUT, "nope"), SnapshotPathError);
});

Deno.test("storeSnapshot happy path: uploads artifacts + .md record, inserts row", async () => {
  const { svc, uploads, inserts } = fakeSvc();
  const stored = await storeSnapshot(svc, fullParams());

  assertEquals(stored.id, SNAP);
  assertEquals(uploads.length, 3); // mhtml + screenshot + markdown record
  const exts = uploads.map((u) => u.path.split(".").pop()).sort();
  assertEquals(exts, ["md", "mhtml", "png"]);
  for (const upload of uploads) {
    const sha = upload.path.split("/").pop()!.split(".")[0];
    assertEquals(sha, await sha256HexBytes(upload.bytes)); // filename == hash
  }
  assertEquals(inserts.length, 1);
  const row = inserts[0];
  assertEquals(row.fidelity, "full");
  assertEquals(row.capture_kind, "change");
  assertEquals(row.served_by, "crawl4ai");
  assertEquals(typeof row.markdown_sha256, "string");
  assertEquals(typeof row.mhtml_path, "string");
  assertEquals(row.rawhtml_path, null);
  assertEquals("expires_at" in row, false); // DB default NULL — no TTL (KTD7)
  assertEquals(stored.markdownPath.endsWith(".md"), true);
});

Deno.test("storeSnapshot verifies claimed hashes before storing anything", async () => {
  const { svc, uploads, inserts } = fakeSvc();
  await assertRejects(
    () =>
      storeSnapshot(
        svc,
        fullParams({
          artifacts: [
            { kind: "mhtml", bytes: bytesOf("mhtml-bytes"), claimedSha256: "f".repeat(64) },
            { kind: "screenshot", bytes: bytesOf("png-bytes") },
          ],
        }),
      ),
    SnapshotIntegrityError,
    "mismatch",
  );
  assertEquals(uploads.length, 0); // hash-before-store: zero bytes persisted
  assertEquals(inserts.length, 0);
});

Deno.test("storeSnapshot accepts matching claimed hashes", async () => {
  const { svc, inserts } = fakeSvc();
  const mhtml = bytesOf("mhtml-bytes");
  const png = bytesOf("png-bytes");
  await storeSnapshot(
    svc,
    fullParams({
      artifacts: [
        // Uppercase hex is the same digest — case is not integrity signal.
        {
          kind: "mhtml",
          bytes: mhtml,
          claimedSha256: (await sha256HexBytes(mhtml)).toUpperCase(),
        },
        { kind: "screenshot", bytes: png, claimedSha256: await sha256HexBytes(png) },
      ],
    }),
  );
  assertEquals(inserts.length, 1);
});

Deno.test("storeSnapshot enforces fidelity-artifact consistency", async () => {
  const { svc } = fakeSvc();
  // full missing screenshot
  await assertRejects(
    () =>
      storeSnapshot(
        svc,
        fullParams({ artifacts: [{ kind: "mhtml", bytes: bytesOf("x") }] }),
      ),
    SnapshotIntegrityError,
  );
  // rendered_thirdparty requires screenshot + rawhtml
  await assertRejects(
    () =>
      storeSnapshot(
        svc,
        fullParams({
          fidelity: "rendered_thirdparty",
          artifacts: [{ kind: "rawhtml", bytes: bytesOf("x") }],
        }),
      ),
    SnapshotIntegrityError,
  );
  // markdown_only must carry no artifacts
  await assertRejects(
    () =>
      storeSnapshot(
        svc,
        fullParams({
          fidelity: "markdown_only",
          artifacts: [{ kind: "rawhtml", bytes: bytesOf("x") }],
        }),
      ),
    SnapshotIntegrityError,
  );
});

Deno.test("storeSnapshot markdown_only stores just the .md record", async () => {
  const { svc, uploads, inserts } = fakeSvc();
  const stored = await storeSnapshot(
    svc,
    fullParams({ fidelity: "markdown_only", servedBy: "firecrawl", artifacts: [] }),
  );
  assertEquals(uploads.length, 1);
  assertEquals(uploads[0].path.endsWith(".md"), true);
  assertEquals(uploads[0].contentType, "text/markdown");
  assertEquals(inserts[0].mhtml_sha256, null);
  assertEquals(inserts[0].screenshot_sha256, null);
  assertEquals(stored.paths.mhtml, undefined);
});

Deno.test("storeSnapshot rejects empty markdown", async () => {
  const { svc } = fakeSvc();
  await assertRejects(
    () => storeSnapshot(svc, fullParams({ markdown: "   " })),
    SnapshotIntegrityError,
    "content record",
  );
});

Deno.test("storeSnapshot treats already-exists upload as idempotent success", async () => {
  const { svc, inserts } = fakeSvc({
    uploadErrors: { ".mhtml": "The resource already exists" },
  });
  const stored = await storeSnapshot(svc, fullParams());
  assertEquals(stored.id, SNAP);
  assertEquals(inserts.length, 1);
});

Deno.test("storeSnapshot surfaces non-duplicate upload errors", async () => {
  const { svc, inserts } = fakeSvc({
    uploadErrors: { ".png": "Payload too large" },
  });
  await assertRejects(() => storeSnapshot(svc, fullParams()), SnapshotStorageError, "upload failed");
  assertEquals(inserts.length, 0);
});

Deno.test("storeSnapshot surfaces insert errors", async () => {
  const { svc } = fakeSvc({ insertError: "permission denied" });
  await assertRejects(() => storeSnapshot(svc, fullParams()), SnapshotStorageError, "insert failed");
});

Deno.test("storeSnapshot surfaces insert returning no row", async () => {
  const { svc } = fakeSvc({ insertNullData: true });
  await assertRejects(
    () => storeSnapshot(svc, fullParams()),
    SnapshotStorageError,
    "no row returned",
  );
});

Deno.test("storeSnapshot minimal params default every optional field to null", async () => {
  const { svc, inserts } = fakeSvc();
  await storeSnapshot(svc, {
    scoutId: SCOUT,
    userId: USER,
    captureKind: "baseline",
    fidelity: "markdown_only",
    capturedAt: "2026-07-07T10:00:00.000Z",
    requestedUrl: "https://example.com/page",
    markdown: "content",
  });
  const row = inserts[0];
  assertEquals(row.scout_run_id, null);
  assertEquals(row.raw_capture_id, null);
  assertEquals(row.served_by, null);
  assertEquals(row.final_url, null);
  assertEquals(row.http_status, null);
  assertEquals(row.response_headers, null);
  assertEquals(row.content_sha256, null);
  assertEquals(row.canonical_content_sha256, null);
});

Deno.test("snapshotDiagnostics shapes run metadata", () => {
  assertEquals(snapshotDiagnostics({ status: "stored" , snapshotId: SNAP, fidelity: "full" }), {
    snapshot_status: "stored",
    snapshot_id: SNAP,
    snapshot_fidelity: "full",
  });
  assertEquals(snapshotDiagnostics({ status: "degraded:flap" }), {
    snapshot_status: "degraded:flap",
  });
});

Deno.test("deleteScoutSnapshots drains paginated objects then deletes rows", async () => {
  const { svc, removed, deletes } = fakeSvc({
    listPages: [
      [{ name: "aaa.mhtml" }, { name: "bbb.png" }],
      [{ name: "ccc.md" }],
      [],
    ],
  });
  const result = await deleteScoutSnapshots(svc, USER, SCOUT);
  assertEquals(result.objectsRemoved, 3);
  assertEquals(removed.length, 2);
  assertEquals(removed[0], [
    `${USER}/${SCOUT}/aaa.mhtml`,
    `${USER}/${SCOUT}/bbb.png`,
  ]);
  assertEquals(deletes, [{ scout_id: SCOUT, user_id: USER }]);
});

Deno.test("storeSnapshot treats statusCode 409 as idempotent success regardless of message", async () => {
  // Message matches no regex; the structured statusCode is the contract.
  const { svc, inserts } = fakeSvc({
    uploadErrors: { ".mhtml": { message: "Conflict", statusCode: "409" } },
  });
  const stored = await storeSnapshot(svc, fullParams());
  assertEquals(stored.id, SNAP);
  assertEquals(inserts.length, 1);
});

Deno.test("deleteScoutSnapshots throws on no progress (per-object remove failures)", async () => {
  // Same page listed twice with remove() reporting success: an un-removable
  // object must not spin the drain loop forever.
  const { svc } = fakeSvc({
    listPages: [[{ name: "stuck.md" }], [{ name: "stuck.md" }]],
  });
  await assertRejects(
    () => deleteScoutSnapshots(svc, USER, SCOUT),
    SnapshotStorageError,
    "no progress",
  );
});

Deno.test("deleteScoutSnapshots second sweep collects objects uploaded mid-delete", async () => {
  // Page queue: first drain sees one page then empty; after the row delete a
  // late upload appears and the second sweep collects it.
  const { svc, removed, deletes } = fakeSvc({
    listPages: [[{ name: "early.md" }], [], [{ name: "late.png" }], []],
  });
  const result = await deleteScoutSnapshots(svc, USER, SCOUT);
  assertEquals(result.objectsRemoved, 2);
  assertEquals(removed.length, 2);
  assertEquals(removed[1], [`${USER}/${SCOUT}/late.png`]);
  assertEquals(deletes.length, 1);
});

Deno.test("deleteScoutSnapshots surfaces storage and row errors", async () => {
  await assertRejects(
    () => deleteScoutSnapshots(fakeSvc({ listError: "boom" }).svc, USER, SCOUT),
    SnapshotStorageError,
    "list failed",
  );
  await assertRejects(
    () =>
      deleteScoutSnapshots(
        fakeSvc({ listPages: [[{ name: "a.md" }]], removeError: "boom" }).svc,
        USER,
        SCOUT,
      ),
    SnapshotStorageError,
    "remove failed",
  );
  await assertRejects(
    () => deleteScoutSnapshots(fakeSvc({ deleteError: "boom" }).svc, USER, SCOUT),
    SnapshotStorageError,
    "delete failed",
  );
  await assertRejects(
    () => deleteScoutSnapshots(fakeSvc().svc, "../evil", SCOUT),
    SnapshotPathError,
  );
});

Deno.test("updateSnapshotTrust returns false (never throws) on a row-update error", async () => {
  const { updateSnapshotTrust } = await import("./snapshot_store.ts");
  const okSvc = {
    from() {
      return { update() { return { eq() { return Promise.resolve({ error: null }); } }; } };
    },
  } as unknown as SupabaseClient;
  assertEquals(
    await updateSnapshotTrust(okSvc, "44444444-4444-4444-4444-444444444444", { tsa_status: "ok" }),
    true,
  );
  const errSvc = {
    from() {
      return {
        update() {
          return { eq() { return Promise.resolve({ error: { message: "db down" } }); } };
        },
      };
    },
  } as unknown as SupabaseClient;
  assertEquals(
    await updateSnapshotTrust(errSvc, "44444444-4444-4444-4444-444444444444", { tsa_status: "ok" }),
    false,
  );
});
