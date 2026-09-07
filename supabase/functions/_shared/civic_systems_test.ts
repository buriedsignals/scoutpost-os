import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  countVisibleMeetingDocuments,
  detectCivicSystem,
  isModernGovEntryUrl,
  isModernGovListingUrl,
  isModernGovMeetingUrl,
  modernGovListingForCommittee,
  resolveCivicListings,
  validateCivicTrackedUrls,
} from "./civic_systems.ts";
import { extractCivicLinksFromHtml } from "./civic_links.ts";

// Fixture shapes are copied from democracy.leeds.gov.uk (2026-09-07);
// identifiers are synthetic. democracy.bristol.gov.uk was unavailable that day
// but runs the same modern.gov product, and www.bristol.gov.uk links to it.
const FIXTURES: Record<string, string> = {
  // www.bristol.gov.uk section page — what discovery ranked as a candidate.
  "https://www.bristol.gov.uk/council/how-council-decisions-are-made/council-meetings":
    `
    <a href="/council/how-council-decisions-are-made/full-council">Full Council</a>
    <p><a href="https://democracy.bristol.gov.uk/mgCalendarMonthView.aspx?GL=1&amp;bcr=1">Find council meeting</a></p>
    <p><a href="https://democracy.bristol.gov.uk/mgListCommittees.aspx?bcr=1">View all committees, meeting agendas, public forum dates and deadlines</a></p>
    <a href="https://www.facebook.com/bristolcouncil">Facebook</a>
  `,
  // modern.gov entry page: as on Leeds, the committee index links committee
  // RECORD pages, not listings; only the constitution has a direct listing.
  "https://democracy.bristol.gov.uk/mgListCommittees.aspx?bcr=1": `
    <a href="mgCommitteeDetails.aspx?ID=900">Audit Committee</a>
    <a href="mgCommitteeDetails.aspx?ID=111">Full Council</a>
    <a href="mgCommitteeDetails.aspx?ID=142">Cabinet</a>
    <a href="ieListMeetings.aspx?CId=1072&amp;MD=Constitution&amp;info=1&amp;bcr=1">Constitution</a>
    <a href="mgMemberIndex.aspx?bcr=1">Councillors</a>
  `,
  "https://democracy.bristol.gov.uk/ieListMeetings.aspx?CommitteeId=900": `
    <a href="mgCommitteeDetails.aspx?ID=900">Audit Committee</a>
  `,
  "https://democracy.bristol.gov.uk/ieListMeetings.aspx?CId=1072&MD=Constitution&info=1&bcr=1":
    `
    <a href="ieListDocuments.aspx?CId=1072&amp;MId=1&amp;Ver=4">Constitution part 1</a>
  `,
  // Committee listings — dated meeting pages behind each.
  "https://democracy.bristol.gov.uk/ieListMeetings.aspx?CommitteeId=111": `
    <a href="ieListDocuments.aspx?CId=111&amp;MId=14369&amp;Ver=4">9 Sep 2026 1.00 pm</a>
    <a href="ieListDocuments.aspx?CId=111&amp;MId=14368&amp;Ver=4">15 Jul 2026 1.00 pm</a>
    <a href="ieListMeetings.aspx?Act=Prev&amp;CId=111&amp;D=2025&amp;MD=ielistmeetings">Previous</a>
  `,
  "https://democracy.bristol.gov.uk/ieListMeetings.aspx?CommitteeId=142": `
    <a href="ieListDocuments.aspx?CId=142&amp;MId=15001&amp;Ver=4">2 Sep 2026 4.00 pm</a>
  `,
  // Zermatt-style generic listing with PDFs one hop down.
  "https://gemeinde.zermatt.ch/urversammlung/protokoll": `
    <a href="/pdf/protokoll/2025/vollprotokoll_2025-03-19.pdf">Vollprotokoll 19.03.2025</a>
    <a href="/pdf/protokoll/2024/vollprotokoll_2024-12-04.pdf">Vollprotokoll 04.12.2024</a>
  `,
  "https://www.example-town.org/about": `
    <a href="/about/history">History</a>
    <a href="/contact">Contact</a>
  `,
};

function fetcher(log: string[] = []) {
  return (url: string): Promise<string> => {
    log.push(url);
    const html = FIXTURES[url];
    if (html === undefined) return Promise.reject(new Error(`404 ${url}`));
    return Promise.resolve(html);
  };
}

Deno.test("modern.gov URL classifiers follow the verified hierarchy", () => {
  assertEquals(
    isModernGovEntryUrl(
      "https://democracy.leeds.gov.uk/mgListCommittees.aspx?bcr=1",
    ),
    true,
  );
  assertEquals(
    isModernGovListingUrl(
      "https://democracy.leeds.gov.uk/ieListMeetings.aspx?CommitteeId=111",
    ),
    true,
  );
  assertEquals(
    isModernGovListingUrl(
      "https://democracy.leeds.gov.uk/ieListMeetings.aspx?CId=111&Year=0",
    ),
    true,
  );
  // Unpopulated committee id is a template, not a listing.
  assertEquals(
    isModernGovListingUrl(
      "https://democracy.leeds.gov.uk/ieListMeetings.aspx?CId=",
    ),
    false,
  );
  assertEquals(
    isModernGovMeetingUrl(
      "https://democracy.leeds.gov.uk/ieListDocuments.aspx?CId=111&MId=14369&Ver=4",
    ),
    true,
  );
  assertEquals(
    isModernGovMeetingUrl(
      "https://democracy.leeds.gov.uk/ieListMeetings.aspx?CId=111",
    ),
    false,
  );
  assertEquals(
    detectCivicSystem(["https://www.bristol.gov.uk/council"]),
    "generic",
  );
  assertEquals(
    detectCivicSystem([
      "https://democracy.bristol.gov.uk/mgListCommittees.aspx?bcr=1",
    ]),
    "moderngov",
  );
});

Deno.test("countVisibleMeetingDocuments counts dated modern.gov meetings or generic leaf documents", () => {
  const listing =
    "https://democracy.bristol.gov.uk/ieListMeetings.aspx?CommitteeId=111";
  assertEquals(
    countVisibleMeetingDocuments(
      extractCivicLinksFromHtml(FIXTURES[listing], listing),
    ),
    2,
  );
  const zermatt = "https://gemeinde.zermatt.ch/urversammlung/protokoll";
  assertEquals(
    countVisibleMeetingDocuments(
      extractCivicLinksFromHtml(FIXTURES[zermatt], zermatt),
    ),
    2,
  );
  const section =
    "https://www.bristol.gov.uk/council/how-council-decisions-are-made/council-meetings";
  assertEquals(
    countVisibleMeetingDocuments(
      extractCivicLinksFromHtml(FIXTURES[section], section),
    ),
    0,
  );
});

// Regression for the 2026-09-07 acceptance failure: the Council UI probe on
// https://www.bristol.gov.uk/ ended in "Extraction test failed" because the
// resolver never reached the modern.gov listing.
Deno.test("resolveCivicListings surfaces modern.gov committee listings behind a bristol.gov.uk section page", async () => {
  const log: string[] = [];
  const result = await resolveCivicListings(
    ["https://www.bristol.gov.uk/council/how-council-decisions-are-made/council-meetings"],
    { fetchHtml: fetcher(log) },
  );
  assertEquals(result.system, "moderngov");
  assertEquals(result.candidates.map((c) => c.url), [
    "https://democracy.bristol.gov.uk/ieListMeetings.aspx?CommitteeId=111",
    "https://democracy.bristol.gov.uk/ieListMeetings.aspx?CommitteeId=142",
    "https://democracy.bristol.gov.uk/ieListMeetings.aspx?CId=1072&MD=Constitution&info=1&bcr=1",
  ]);
  assertEquals(result.candidates[0].recommended, true);
  assertEquals(result.candidates[0].documents_visible, 2);
  assertEquals(result.candidates[0].description, "Full Council");
  assertEquals(result.candidates[1].recommended, false);
  // Budget: 1 seed + 1 entry + up to 5 listings (Council, Cabinet, Audit,
  // Constitution — derived from committee records, priority bodies first);
  // the calendar entry is never fetched because the committee index sufficed.
  assertEquals(result.scraped, 6);
  assert(
    !log.includes(
      "https://democracy.bristol.gov.uk/mgCalendarMonthView.aspx?GL=1&bcr=1",
    ),
  );
});

Deno.test("resolveCivicListings validates a listing given directly as the seed (tracked-url gate)", async () => {
  const listing =
    "https://democracy.bristol.gov.uk/ieListMeetings.aspx?CommitteeId=111";
  const result = await resolveCivicListings([listing], {
    fetchHtml: fetcher(),
  });
  assertEquals(result.candidates.length, 1);
  assertEquals(result.candidates[0].url, listing);
  assertEquals(result.candidates[0].system, "moderngov");
  assertEquals(result.scraped, 1);
});

Deno.test("resolveCivicListings keeps the generic one-hop rule for Swiss councils", async () => {
  const listing = "https://gemeinde.zermatt.ch/urversammlung/protokoll";
  const result = await resolveCivicListings([listing], {
    fetchHtml: fetcher(),
  });
  assertEquals(result.system, "generic");
  assertEquals(result.candidates.map((c) => [c.url, c.documents_visible]), [[
    listing,
    2,
  ]]);
});

Deno.test("resolveCivicListings returns no candidates when nothing exposes meetings", async () => {
  const result = await resolveCivicListings(
    [
      "https://www.example-town.org/about",
      "https://www.example-town.org/missing",
    ],
    { fetchHtml: fetcher() },
  );
  assertEquals(result.system, "generic");
  assertEquals(result.candidates, []);
});

Deno.test("resolveCivicListings uses listings already present in the site map without extra fetches", async () => {
  const log: string[] = [];
  const result = await resolveCivicListings(
    ["https://www.example-town.org/about"],
    { fetchHtml: fetcher(log) },
    ["https://democracy.bristol.gov.uk/ieListMeetings.aspx?CommitteeId=142"],
  );
  assertEquals(result.system, "moderngov");
  assertEquals(result.candidates.map((c) => c.url), [
    "https://democracy.bristol.gov.uk/ieListMeetings.aspx?CommitteeId=142",
  ]);
  assertEquals(result.scraped, 2);
});

Deno.test("validateCivicTrackedUrls accepts a verified listing and rejects a section page with alternatives", async () => {
  const listing =
    "https://democracy.bristol.gov.uk/ieListMeetings.aspx?CommitteeId=111";
  const good = await validateCivicTrackedUrls([listing], {
    fetchHtml: fetcher(),
  });
  assertEquals(good.ok, true);
  assertEquals(good.validated, [listing]);
  assertEquals(good.candidates, []);

  const section =
    "https://www.bristol.gov.uk/council/how-council-decisions-are-made/council-meetings";
  const bad = await validateCivicTrackedUrls([section], {
    fetchHtml: fetcher(),
  });
  assertEquals(bad.ok, false);
  assertEquals(bad.invalid, [section]);
  assertEquals(bad.candidates.map((c) => c.url), [
    "https://democracy.bristol.gov.uk/ieListMeetings.aspx?CommitteeId=111",
    "https://democracy.bristol.gov.uk/ieListMeetings.aspx?CommitteeId=142",
    "https://democracy.bristol.gov.uk/ieListMeetings.aspx?CId=1072&MD=Constitution&info=1&bcr=1",
  ]);

  const mixed = await validateCivicTrackedUrls([listing, section], {
    fetchHtml: fetcher(),
  });
  assertEquals(mixed.ok, false);
  assertEquals(mixed.validated, [listing]);
  assertEquals(mixed.invalid, [section]);
});

Deno.test("modernGovListingForCommittee derives the listing from a committee record", () => {
  assertEquals(
    modernGovListingForCommittee(
      "https://democracy.leeds.gov.uk/mgCommitteeDetails.aspx?ID=111",
    ),
    "https://democracy.leeds.gov.uk/ieListMeetings.aspx?CommitteeId=111",
  );
  assertEquals(
    modernGovListingForCommittee(
      "https://democracy.leeds.gov.uk/mgMemberIndex.aspx?bcr=1",
    ),
    null,
  );
});

// Live finding 2026-09-07: the Leeds committee index (38 mgCommitteeDetails
// record links) was "validated" as a tracked page because record ids were
// counted as documents. A modern.gov page without meeting pages exposes none.
Deno.test("a modern.gov committee index is not a valid tracked page and its committees are offered instead", async () => {
  const entry = "https://democracy.bristol.gov.uk/mgListCommittees.aspx?bcr=1";
  const result = await validateCivicTrackedUrls([entry], {
    fetchHtml: fetcher(),
  });
  assertEquals(result.ok, false);
  assertEquals(result.invalid, [entry]);
  assertEquals(result.candidates.map((c) => c.description), [
    "Full Council",
    "Cabinet",
    "Constitution",
  ]);
  assertEquals(
    countVisibleMeetingDocuments(
      extractCivicLinksFromHtml(FIXTURES[entry], entry),
    ),
    0,
  );
});
