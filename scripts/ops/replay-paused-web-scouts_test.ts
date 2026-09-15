import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  applyReplayPreview,
  createReplayPreview,
  parseReplayArgs,
} from "./replay-paused-web-scouts.ts";

const PROJECT = "https://replay.invalid";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SCOUTS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
type Row = Record<string, unknown>;

function database() {
  const requests: Row[] = [];
  const runs = new Map<string, { scoutId: string; snapshot: unknown }>();
  const snapshots = new Map(SCOUTS.map((id) => [id, {
    scout: {
      id,
      user_id: USER,
      name: "Private Scout",
      url: `https://example.org/${id}`,
      type: "web",
      is_active: false,
      schedule: "0 8 * * *",
      config: { private_keyword: "customer query" },
    },
    baseline_captures: [{
      id: "capture",
      canonical_content_sha256: "baseline",
    }],
  }]));
  const state = { loseResponseFor: "", rejectScout: "", creations: 0 };
  const client = createClient(PROJECT, "test-service-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (_input, init) => {
        const request = init as RequestInit | undefined;
        const url = new URL(String(_input));
        assertEquals(url.pathname, "/rest/v1/rpc/prepare_page_scout_replay");
        assertEquals(request?.method, "POST");
        const body = JSON.parse(String(request?.body)) as Row;
        requests.push(body);
        const scoutId = String(body.p_scout_id);
        const runId = String(body.p_run_id);
        const snapshot = snapshots.get(scoutId)!;
        const response = (data: unknown, status = 200) =>
          Promise.resolve(
            new Response(JSON.stringify(data), {
              status,
              headers: { "content-type": "application/json" },
            }),
          );
        if (body.p_apply === false) {
          return response({
            run_id: runId,
            scout_id: scoutId,
            user_id: USER,
            name: snapshot.scout.name,
            url: snapshot.scout.url,
            snapshot,
            maximum_credit_cost: 1,
            notification_mode: "disabled",
            crawler_backend: "workflow",
            schedule_changed: false,
            writes: [
              "scout run and dispatch job",
              "normal workflow and credit accounting",
            ],
          });
        }
        assertEquals(body.p_apply, true);
        const existing = runs.get(runId);
        if (existing) {
          if (
            existing.scoutId !== scoutId ||
            JSON.stringify(existing.snapshot) !==
              JSON.stringify(body.p_expected_snapshot)
          ) {
            return response({
              message: "replay ID is already used by a different operation",
            }, 409);
          }
        } else {
          if (
            state.rejectScout === scoutId ||
            JSON.stringify(snapshot) !==
              JSON.stringify(body.p_expected_snapshot)
          ) {
            return response({
              message: "Scout or baseline changed since preview; preview again",
            }, 409);
          }
          if (body.p_approved_credit_cost !== 1) {
            return response({
              message: "explicit one-credit approval required",
            }, 400);
          }
          runs.set(runId, {
            scoutId,
            snapshot: structuredClone(body.p_expected_snapshot),
          });
          state.creations++;
        }
        if (state.loseResponseFor === scoutId) {
          state.loseResponseFor = "";
          return Promise.reject(new TypeError("Connection lost after commit"));
        }
        return response({
          run_id: runId,
          scout_id: scoutId,
          created: !existing,
          status: "running",
          approved_credit_cost: 1,
        });
      },
    },
  });
  return { client, requests, runs, snapshots, state };
}

Deno.test("preview is read-only and preserves the customer state needed for approval", async () => {
  const db = database();
  const before = structuredClone([...db.snapshots]);
  const preview = await createReplayPreview(
    db.client,
    PROJECT + "/",
    SCOUTS.slice(0, 2),
    "a".repeat(40),
  );
  assertEquals(db.runs.size, 0);
  assertEquals(db.state.creations, 0);
  assertEquals([...db.snapshots], before);
  assertEquals(db.requests.map((request) => request.p_apply), [false, false]);
  assertEquals(preview.project_url, PROJECT);
  assertEquals(preview.source_version, "a".repeat(40));
  assertEquals(preview.total_maximum_credit_cost, 2);
  assertEquals(preview.scouts.map((scout) => scout.maximum_credit_cost), [
    1,
    1,
  ]);
  assertEquals(
    preview.scouts.map((scout) => scout.snapshot),
    before.slice(0, 2).map(([, snapshot]) => snapshot),
  );
  assertEquals(preview.writes, [
    "scout run and dispatch job",
    "normal workflow and credit accounting",
  ]);
  assertNotEquals(preview.scouts[0].run_id, preview.scouts[1].run_id);
});

Deno.test("CLI requires explicit UUID selection, output path and numeric apply approval", () => {
  assertEquals(parseReplayArgs(["--help"]), { action: "help" });
  assertEquals(
    parseReplayArgs([
      "preview",
      "--scout-id",
      SCOUTS[0],
      "--scout-id",
      SCOUTS[1],
      "--output",
      "private.json",
    ]),
    { action: "preview", scoutIds: SCOUTS.slice(0, 2), output: "private.json" },
  );
  assertEquals(
    parseReplayArgs([
      "apply",
      "--preview",
      "private.json",
      "--approve-maximum-credits",
      "2",
    ]),
    { action: "apply", preview: "private.json", approval: 2 },
  );
  for (
    const args of [
      [],
      ["preview", "--output", "private.json"],
      ["preview", "--scout-id", SCOUTS[0]],
      ["preview", "--scout-id", "all", "--output", "private.json"],
      [
        "preview",
        "--scout-id",
        SCOUTS[0],
        "--scout-id",
        SCOUTS[0],
        "--output",
        "private.json",
      ],
      ["apply", "--preview", "private.json"],
      [
        "apply",
        "--preview",
        "private.json",
        "--approve-maximum-credits",
        "1.5",
      ],
      ["apply", "--preview", "private.json", "--approve-maximum-credits", "-1"],
      [
        "apply",
        "--preview",
        "private.json",
        "--approve-maximum-credits",
        "9007199254740992",
      ],
      [
        "apply",
        "--preview",
        "private.json",
        "--approve-maximum-credits",
        "2",
        "--apply",
        "true",
      ],
    ]
  ) assertThrows(() => parseReplayArgs(args));
});

Deno.test("apply binds the complete preview to project and exact explicit credit approval before RPC", async () => {
  const db = database();
  const preview = await createReplayPreview(
    db.client,
    PROJECT,
    SCOUTS.slice(0, 2),
  );
  db.requests.length = 0;
  await assertRejects(() =>
    applyReplayPreview(db.client, "https://other.invalid", preview, 2)
  );
  for (const approval of [undefined, NaN, 0, 1, 3, 2.5]) {
    await assertRejects(() =>
      applyReplayPreview(db.client, PROJECT, preview, approval as number)
    );
  }
  assertEquals(db.requests, []);
  assertEquals(db.runs.size, 0);
  const results = await applyReplayPreview(db.client, PROJECT, preview, 2);
  assertEquals(results.map((result) => result.created), [true, true]);
  assertEquals(db.state.creations, 2);
});

Deno.test("all malformed input is rejected before any RPC including a bad later Scout", async () => {
  const db = database();
  for (const ids of [[], [SCOUTS[0], "bad"], [SCOUTS[0], SCOUTS[0]]]) {
    await assertRejects(() => createReplayPreview(db.client, PROJECT, ids));
  }
  assertEquals(db.requests, []);
  const preview = await createReplayPreview(
    db.client,
    PROJECT,
    SCOUTS.slice(0, 2),
  );
  db.requests.length = 0;
  const mutations: ((value: Row) => void)[] = [
    (value) => {
      value.format_version = 99;
    },
    (value) => {
      value.created_at = "not a date";
    },
    (value) => {
      value.project_url = "https://user:password@replay.invalid";
    },
    (value) => {
      value.total_maximum_credit_cost = 1;
    },
    (value) => {
      value.writes = [];
    },
    (value) => {
      (value.scouts as Row[])[1].snapshot = {};
    },
    (value) => {
      (value.scouts as Row[])[1].maximum_credit_cost = 0;
    },
    (value) => {
      (value.scouts as Row[])[1].notification_mode = "enabled";
    },
    (value) => {
      (value.scouts as Row[])[1].schedule_changed = true;
    },
    (value) => {
      (value.scouts as Row[])[1].run_id = (value.scouts as Row[])[0].run_id;
    },
    (value) => {
      (value.scouts as Row[])[1].scout_id = "bad";
    },
  ];
  for (const mutate of mutations) {
    const malformed: Row = structuredClone(preview);
    mutate(malformed);
    await assertRejects(() =>
      applyReplayPreview(db.client, PROJECT, malformed, 2)
    );
  }
  for (const malformed of [null, [], "not JSON", {}]) {
    await assertRejects(() =>
      applyReplayPreview(db.client, PROJECT, malformed, 2)
    );
  }
  assertEquals(db.requests, []);
  assertEquals(db.runs.size, 0);
});

Deno.test("rerunning the same file recovers partial and uncertain commits without duplicate runs", async () => {
  const db = database();
  const preview = await createReplayPreview(db.client, PROJECT, SCOUTS);
  const file = JSON.stringify(preview);
  db.state.loseResponseFor = SCOUTS[1];
  await assertRejects(() =>
    applyReplayPreview(db.client, PROJECT, JSON.parse(file), 3)
  );
  assertEquals(db.state.creations, 2);
  assertEquals(
    [...db.runs.keys()],
    preview.scouts.slice(0, 2).map((scout) => scout.run_id),
  );
  // A completed run can change the baseline before the operator retries the file.
  db.snapshots.get(SCOUTS[0])!.baseline_captures[0].canonical_content_sha256 =
    "new baseline";
  const resumed = await applyReplayPreview(
    db.client,
    PROJECT,
    JSON.parse(file),
    3,
  );
  assertEquals(resumed.map((result) => result.created), [false, false, true]);
  assertEquals(db.state.creations, 3);
  assertEquals(
    [...db.runs.keys()],
    preview.scouts.map((scout) => scout.run_id),
  );
  const repeated = await applyReplayPreview(
    db.client,
    PROJECT,
    JSON.parse(file),
    3,
  );
  assertEquals(repeated.map((result) => result.created), [false, false, false]);
  assertEquals(db.state.creations, 3);
  assertEquals(JSON.stringify(preview), file);
});

Deno.test("RPC drift stops later submissions and retry preserves earlier fixed IDs", async () => {
  const db = database();
  const preview = await createReplayPreview(db.client, PROJECT, SCOUTS);
  db.state.rejectScout = SCOUTS[1];
  await assertRejects(
    () => applyReplayPreview(db.client, PROJECT, preview, 3),
    Error,
    "Scout or baseline changed since preview",
  );
  assertEquals(db.state.creations, 1);
  assertEquals([...db.runs.keys()], [preview.scouts[0].run_id]);
  db.state.rejectScout = "";
  const resumed = await applyReplayPreview(db.client, PROJECT, preview, 3);
  assertEquals(resumed.map((result) => result.created), [false, true, true]);
  assertEquals(db.state.creations, 3);
  const conflicting = structuredClone(preview);
  (conflicting.scouts[0].snapshot.scout as Row).config = {
    private_keyword: "different operation",
  };
  await assertRejects(
    () => applyReplayPreview(db.client, PROJECT, conflicting, 3),
    Error,
    "replay ID is already used by a different operation",
  );
  assertEquals(db.state.creations, 3);
});
