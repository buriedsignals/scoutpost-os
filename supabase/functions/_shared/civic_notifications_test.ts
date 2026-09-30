import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sendCivicAlert, sendCivicPromiseDigest } from "./notifications.ts";
import { SUPPORTED_LANGUAGES } from "./email_translations.ts";

function recipient(language = "de", emailEnabled = true) {
  let sent = false;
  return {
    from(table: string) {
      const query = {
        select() { return query; },
        eq() { return query; },
        update(value: { notification_sent?: boolean }) {
          if (value.notification_sent) sent = true;
          return query;
        },
        maybeSingle() {
          return Promise.resolve({
            data: table === "scout_runs" ? { notification_sent: sent } : {
              preferred_language: language,
              preferences: { email_notifications: emailEnabled },
            },
            error: null,
          });
        },
      };
      return query;
    },
    auth: { admin: { getUserById() {
      return Promise.resolve({ data: { user: { email: "offline@example.invalid" } }, error: null });
    } } },
  };
}

async function captureEmail(run: (messages: Array<{ subject: string; html: string; key: string | null }>) => Promise<void>) {
  const fetchBefore = globalThis.fetch;
  const keyBefore = Deno.env.get("RESEND_API_KEY");
  const messages: Array<{ subject: string; html: string; key: string | null }> = [];
  try {
    Deno.env.set("RESEND_API_KEY", "offline-only");
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      assertEquals(String(input), "https://api.resend.com/emails");
      const payload = JSON.parse(String(init?.body));
      assertEquals(payload.to, ["offline@example.invalid"]);
      messages.push({ ...payload, key: new Headers(init?.headers).get("Idempotency-Key") });
      return Response.json({ id: "offline-provider-id" });
    }) as typeof fetch;
    await run(messages);
  } finally {
    globalThis.fetch = fetchBefore;
    if (keyBefore === undefined) Deno.env.delete("RESEND_API_KEY");
    else Deno.env.set("RESEND_API_KEY", keyBefore);
  }
}

const saved = {
  userId: "reader", scoutId: "council", runId: "run", scoutName: "Stadtrat",
  // The old API accepted arbitrary extraction prose. The new path must render
  // the persisted rows and their dates, never this discarded candidate.
  summary: "Unstored extraction candidate",
  items: [{ promiseText: "Brücke fertigstellen", dueDate: "2030-06-01", sourceTitle: "Beschluss", sourceUrl: "https://example.test/minutes_(2030).pdf" }],
  providerIdempotencyKey: "civic/run/new-items",
};

Deno.test("Civic saved notification includes stored deadlines and links, suppressing run replay", async () => {
  await captureEmail(async (messages) => {
    const svc = recipient();
    assertEquals((await sendCivicAlert(svc as never, saved)).ok, true);
    assertEquals((await sendCivicAlert(svc as never, saved)).reason, "already_sent");
    assertEquals(messages.length, 1);
    assertStringIncludes(messages[0].html, "Brücke fertigstellen");
    assertStringIncludes(messages[0].html, "2030-06-01");
    assertStringIncludes(messages[0].html, 'href="https://example.test/minutes_(2030).pdf"');
    assert(!messages[0].html.includes("Unstored extraction candidate"));
    assert(!messages[0].html.includes("These promises were saved"));
    assertEquals(messages[0].key, "civic/run/new-items");
  });
});

Deno.test("Civic email opt-out and empty runs never reach the provider", async () => {
  await captureEmail(async (messages) => {
    assertEquals((await sendCivicAlert(recipient("de", false) as never, saved)).reason, "email_disabled");
    assertEquals((await sendCivicPromiseDigest(recipient("de", false) as never, saved)).reason, "email_disabled");
    const emptyRun = { ...saved, items: [] };
    assertEquals((await sendCivicAlert(recipient() as never, emptyRun)).reason, "no_new_promises");
    assertEquals((await sendCivicPromiseDigest(recipient() as never, { userId: "reader", items: [] })).reason, "no_due_promises");
    assertEquals(messages, []);
  });
});

Deno.test("deadline emails include every delivered promise and do not label overdue dates as today", async () => {
  await captureEmail(async (messages) => {
    const items = Array.from({ length: 21 }, (_, index) => ({
      promiseText: `Audit ${index + 1}`, dueDate: "2020-01-01",
    }));
    assertEquals((await sendCivicPromiseDigest(recipient() as never, {
      userId: "reader", items, providerIdempotencyKey: "civic/reminder/reader/promise/2020-01-01",
    })).ok, true);
    assertStringIncludes(messages[0].html, "Audit 21");
    assertStringIncludes(messages[0].html, "2020-01-01");
    assert(!messages[0].subject.includes("heute"));
    assertEquals(messages[0].key, "civic/reminder/reader/promise/2020-01-01");
  });
});

Deno.test("saved Civic email copy is localized in every supported locale", async () => {
  await captureEmail(async (messages) => {
    for (const language of SUPPORTED_LANGUAGES) {
      await sendCivicAlert(recipient(language) as never, saved);
      const email = messages.at(-1)!;
      assertStringIncludes(email.html, "2030-06-01");
      if (language !== "en") {
        assert(!email.subject.includes("New promises saved"), language);
        assert(!email.html.includes("These promises were saved"), language);
      }
    }
  });
});
