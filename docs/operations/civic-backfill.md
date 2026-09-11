# Verify and backfill Civic documents

Use `scripts/civic-backfill.ts` for an operator-funded, bounded historical import
on an existing active Civic Scout. It uses service credentials from the environment;
it is not a public endpoint or a command that charges user credits. Provider usage
is still recorded. It preserves the Scout's live baselines, processed URLs and
editorial decisions. Existing missing trackers/revisions remain explicit repair
cases. It never resends historical email; ordinary future deadline reminders for
new qualifying promises retain their existing behavior.

Deploy the atomic persistence migration, this backfill migration and the matching
worker before applying a manifest. Follow the quiescent queue activation gate in
[the Civic pipeline](../supabase/civic-pipeline.md#atomic-worker-activation-and-rollback-gate).
Never enqueue the new mode while old workers can claim it.

Select one account/Scout and 1–10 exact documents. Supply their actual document
dates and a date range in a JSON file:

```json
{
  "user_id": "UUID",
  "scout_id": "UUID",
  "date_from": "2026-01-01",
  "date_to": "2026-09-11",
  "documents": [{
    "listing_url": "https://council.example/meetings",
    "source_url": "https://council.example/minutes.pdf",
    "document_date": "2026-06-08"
  }]
}
```

`listing_url` must be currently tracked. Planning resolves the selected URL through
the shared discovery path before parsing it. Dates are operator-reviewed source
metadata, not inferred from arbitrary URL numbers. Inspect the parsed source and
its scope before applying. Successful parsing does not imply qualifying findings.

```sh
deno run --allow-env --allow-net --allow-read --allow-write scripts/civic-backfill.ts \
  plan --targets selection.json --out manifest.json
```

Planning fetches/parses sources and may incur provider costs, but writes no account
rows. The private manifest includes parsed source text and a SHA256 digest; it
contains no credentials. Keep it outside Git. The apply step accepts only that exact
manifest digest, deployment and reviewed Scout configuration. A manifest expires
after seven days for application.

Documents over 40,000 characters require an explicit `selection` on the document:
`{"start_character":297744,"end_character":327744,"label":"Named sitting or decision section"}`.
These are zero-based JavaScript string offsets, end exclusive. Pick boundaries by
reading the source, not by copying these example offsets. The manifest retains the
full parsed source hash and length, selected text hash and labeled range. Findings
retain partial-coverage metadata. An excerpt never certifies the entire document;
complete archive coverage requires separately reviewed selections. There is no
silent leading-text truncation or automatic archive-wide replay.

```sh
deno run --allow-env --allow-net --allow-read scripts/civic-backfill.ts \
  apply --manifest manifest.json --confirm EXACT_MANIFEST_SHA256
deno run --allow-env --allow-net --allow-read scripts/civic-backfill.ts \
  status --manifest manifest.json
deno run --allow-env --allow-net --allow-read scripts/civic-backfill.ts \
  drain --manifest manifest.json
```

Apply atomically creates one run and pinned raw captures/queue rows. Captures expire
after 30 days. Workers extract from that exact text, avoiding a second OCR result
changing the source after review. Repeat `apply` with the same manifest safely;
`drain` invokes only one worker for that run and can be repeated. Cron also resumes
pending work. Failed rows remain bounded by the existing retry limit; inspect the
error before any explicit retry. A different batch cannot silently duplicate the
same Scout/source/content. Concurrent work on that Scout is rejected during the
backfill; finish or classify the batch before normal dispatch resumes.

`status` reconciles canonical units, run occurrences, promise revisions and absent
alert rows. It reports document diagnostics, semantic-zero outcomes and failures.
To verify the real user-facing APIs, authenticate Scout CLI as the manifest owner:

```sh
deno run --allow-env --allow-net --allow-read --allow-ffi scripts/civic-backfill.ts \
  verify --manifest manifest.json
```

This checks each saved unit through both the normal information-unit API and the
Civic item API. It does not claim rendered inbox verification; separately inspect
the signed-in inbox where required. No accepted findings means no positive
visibility proof. The current accountability policy still rejects procedural
content and past-due/undated promises; backfill does not loosen that policy.

Implementation uses the repository's Supabase RPC pattern. Current API contract:
[Supabase JavaScript RPC](https://supabase.com/docs/reference/javascript/rpc),
checked with Context7 `/supabase/supabase-js` on September 11, 2026.
