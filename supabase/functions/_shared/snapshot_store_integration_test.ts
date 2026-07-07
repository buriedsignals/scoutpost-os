/**
 * Integration probes for the page_snapshots migration, bucket, and RLS
 * (PAGE-ARCHIVE-PRD U2). Explicitly opt-in per the repo's test discipline
 * (CLAUDE.md: runtime smoke tests are gated on a dedicated flag and guarded
 * against accidental production targets — env-var *presence* is not consent):
 *
 *   supabase start
 *   PAGE_ARCHIVE_INTEGRATION_TEST=1 deno test --allow-env --allow-net \
 *     --allow-read=. --allow-import _shared/snapshot_store_integration_test.ts
 *
 * with SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY (or the
 * API_URL / PUBLISHABLE_KEY / SECRET_KEY forms from `supabase status -o env`)
 * exported. The test refuses non-local targets unless
 * PAGE_ARCHIVE_INTEGRATION_ALLOW_REMOTE=1 is also set: it creates auth users
 * and fixture scouts, which must never land in production by accident.
 * Without the opt-in flag the test self-skips (ignore), so the network-
 * isolated unit tier and the coverage gate never attempt it.
 */

const OPT_IN = Deno.env.get("PAGE_ARCHIVE_INTEGRATION_TEST") === "1";
const TARGET_URL = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("API_URL") ?? "";
const LOCAL_TARGET = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])([:/]|$)/
  .test(TARGET_URL);
const ALLOW_REMOTE = Deno.env.get("PAGE_ARCHIVE_INTEGRATION_ALLOW_REMOTE") === "1";
const RUN_INTEGRATION = OPT_IN && TARGET_URL !== "" && (LOCAL_TARGET || ALLOW_REMOTE);

if (OPT_IN && TARGET_URL !== "" && !LOCAL_TARGET && !ALLOW_REMOTE) {
  console.warn(
    "snapshot_store integration: refusing non-local target " + TARGET_URL +
      " (set PAGE_ARCHIVE_INTEGRATION_ALLOW_REMOTE=1 to override)",
  );
}

Deno.test({
  name: "page_snapshots: storage upload + owner RLS + deletion contract (integration)",
  ignore: !RUN_INTEGRATION,
  fn: async () => {
    const { assertEquals } = await import(
      "https://deno.land/std@0.208.0/assert/mod.ts"
    );
    const testing = await import("./_testing.ts");
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    const { deleteScoutSnapshots, SNAPSHOT_BUCKET, storeSnapshot } = await import(
      "./snapshot_store.ts"
    );

    const url = testing.getTestingSupabaseUrl();
    const service = createClient(url, testing.getTestingServiceRoleKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const owner = await testing.createTestUser();
    const stranger = await testing.createTestUser();
    try {
      // Fixture scout (inactive: chk_active_has_schedule requires a cron on
      // active scouts, and this scout never runs).
      const { data: scout, error: scoutError } = await service
        .from("scouts")
        .insert({
          user_id: owner.id,
          name: `u2-integration-${crypto.randomUUID().slice(0, 8)}`,
          type: "web",
          url: "https://example.com/",
          is_active: false,
        })
        .select("id")
        .single();
      if (scoutError || !scout) {
        throw new Error(`fixture scout insert failed: ${scoutError?.message}`);
      }

      // Service-role write path: markdown_only row + .md object.
      const stored = await storeSnapshot(service, {
        scoutId: scout.id,
        userId: owner.id,
        captureKind: "baseline",
        fidelity: "markdown_only",
        capturedAt: new Date().toISOString(),
        requestedUrl: "https://example.com/",
        markdown: "# integration probe\n\ncontent record",
      });

      // Owner (user JWT, RLS enforced) reads the row and signs the object.
      const ownerClient = createClient(url, testing.getTestingAnonKey(), {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${owner.token}` } },
      });
      const ownerRows = await ownerClient
        .from("page_snapshots")
        .select("id, fidelity, expires_at")
        .eq("scout_id", scout.id);
      assertEquals(ownerRows.error, null);
      assertEquals(ownerRows.data?.length, 1);
      assertEquals(ownerRows.data?.[0].fidelity, "markdown_only");
      assertEquals(ownerRows.data?.[0].expires_at, null); // no TTL (KTD7)

      const ownerSigned = await ownerClient.storage
        .from(SNAPSHOT_BUCKET)
        .createSignedUrl(stored.markdownPath, 60);
      assertEquals(ownerSigned.error, null);
      assertEquals(typeof ownerSigned.data?.signedUrl, "string");

      // Stranger sees nothing: no rows, no signed URLs for the owner's object.
      const strangerClient = createClient(url, testing.getTestingAnonKey(), {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${stranger.token}` } },
      });
      const strangerRows = await strangerClient
        .from("page_snapshots")
        .select("id")
        .eq("scout_id", scout.id);
      assertEquals(strangerRows.error, null);
      assertEquals(strangerRows.data?.length, 0);
      const strangerSigned = await strangerClient.storage
        .from(SNAPSHOT_BUCKET)
        .createSignedUrl(stored.markdownPath, 60);
      assertEquals(strangerSigned.data, null); // storage RLS denies by path prefix

      // Deletion contract (R3): objects AND rows gone.
      const { objectsRemoved } = await deleteScoutSnapshots(
        service,
        owner.id,
        scout.id,
      );
      assertEquals(objectsRemoved >= 1, true);
      const afterList = await service.storage
        .from(SNAPSHOT_BUCKET)
        .list(`${owner.id}/${scout.id}`, { limit: 10 });
      assertEquals(afterList.data?.length ?? 0, 0);
      const afterRows = await service
        .from("page_snapshots")
        .select("id")
        .eq("scout_id", scout.id);
      assertEquals(afterRows.data?.length, 0);
    } finally {
      await owner.cleanup();
      await stranger.cleanup();
    }
  },
});
