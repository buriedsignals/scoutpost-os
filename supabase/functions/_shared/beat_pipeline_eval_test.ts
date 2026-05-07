import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  beatCandidateRejectReason,
  type BeatHit,
  filterUsableBeatCandidates,
  isAiJournalismCompoundMatch,
  isLikelyTourismContent,
} from "./beat_pipeline.ts";

function hit(url: string, title = "Story", description = ""): BeatHit {
  return { url, title, description, date: "2026-05-01", _pass: "news" };
}

Deno.test("beat eval: rejects weak global topic retrieval URLs before scraping", () => {
  const cases: Array<[BeatHit, string | null]> = [
    [
      hit("https://sponsored.bloomberg.com/arm/ai", "Sponsored AI package"),
      "sponsored",
    ],
    [
      hit("https://techcrunch.com/tag/artificial-intelligence/"),
      "listing_page",
    ],
    [
      hit(
        "https://example.com/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1",
      ),
      "browser_challenge",
    ],
    [
      hit(
        "https://www.facebook.com/inma.newsmedia/posts/how-is-the-ai-era-impacting-news-media-companies",
      ),
      "social_platform",
    ],
    [
      hit(
        "https://www.youtube.com/watch?v=WR9VHZrBQYg",
      ),
      "social_platform",
    ],
    [
      hit(
        "https://www.reuters.com/technology/artificial-intelligence/openai-media-policy-2026-05-01/",
      ),
      null,
    ],
  ];

  for (const [candidate, expected] of cases) {
    assertEquals(beatCandidateRejectReason(candidate), expected);
  }
});

Deno.test("beat eval: AI journalism compound topic rejects generic AI-only candidates", () => {
  const cases: Array<[BeatHit, boolean]> = [
    [
      hit(
        "https://reutersinstitute.politics.ox.ac.uk/ai-adoption-uk-journalists-and-their-newsrooms-surveying-applications-approaches-and-attitudes",
        "AI adoption by UK journalists and their newsrooms",
      ),
      true,
    ],
    [
      hit(
        "https://www.journalism.cuny.edu/2026/01/meet-the-24-practitioners-selected-for-the-ai-journalism-lab-builders-cohort-in-partnership-with-nordic-ai/",
        "Meet the 24 Practitioners Selected for AI J Lab: Builders",
      ),
      true,
    ],
    [
      hit(
        "https://www.reuters.com/technology/two-fed-officials-dont-see-major-upheavel-artificial-intelligence-2026-02-24/",
        "Two Fed officials do not see major upheavel from artificial intelligence",
      ),
      false,
    ],
    [
      hit(
        "https://www.wsj.com/tech/ai",
        "Artificial Intelligence - Latest AI News and Analysis - WSJ.com",
      ),
      false,
    ],
  ];

  for (const [candidate, expected] of cases) {
    assertEquals(isAiJournalismCompoundMatch(candidate), expected);
  }
});

Deno.test("beat eval: Engadin priority domains prefer article and document URLs", () => {
  const candidates = [
    hit("https://www.engadinerpost.ch/"),
    hit("https://www.engadinerpost.ch/news"),
    hit("https://www.engadinerpost.ch/news/kategorie/lapunt"),
    hit("https://info.engadin.online/news/seite/2"),
    hit("https://www.suedostschweiz.ch/politik/2026-05-01/wohnraum-im-engadin"),
    hit(
      "https://www.gr.ch/DE/institutionen/verwaltung/dvs/awt/dokumente/bericht.pdf",
    ),
  ];

  const usable = filterUsableBeatCandidates(candidates).map((candidate) =>
    candidate.url
  );

  assertEquals(usable, [
    "https://www.suedostschweiz.ch/politik/2026-05-01/wohnraum-im-engadin",
    "https://www.gr.ch/DE/institutionen/verwaltung/dvs/awt/dokumente/bericht.pdf",
  ]);
});

Deno.test("beat eval: local niche anti-tourism keeps civic news but rejects travel pages", () => {
  assertEquals(
    isLikelyTourismContent(
      hit(
        "https://www.engadin.com/en/hotels",
        "Best places to stay in the Engadin",
      ),
    ),
    true,
  );
  assertEquals(
    isLikelyTourismContent(
      hit(
        "https://www.engadinerpost.ch/news/2026/05/01/gemeinde-prueft-wohnraum",
        "Gemeinde prueft neuen Wohnraum",
      ),
    ),
    false,
  );
});

Deno.test("beat eval: country topic can keep national/local-language and English sources", () => {
  const candidates = [
    hit(
      "https://www.reuters.com/business/energy/sweden-grid-investment-2026-05-01/",
      "Sweden announces new grid investment package",
    ),
    hit(
      "https://www.energinyheter.se/20260501/sverige-satsar-pa-vindkraft",
      "Sverige satsar pa ny vindkraft och elnat",
    ),
    hit(
      "https://energy.example.com/denmark-offshore-wind",
      "Denmark approves offshore wind expansion",
    ),
  ];

  const usable = filterUsableBeatCandidates(candidates).map((candidate) =>
    candidate.url
  );

  assertEquals(usable, [
    "https://www.reuters.com/business/energy/sweden-grid-investment-2026-05-01/",
    "https://www.energinyheter.se/20260501/sverige-satsar-pa-vindkraft",
    "https://energy.example.com/denmark-offshore-wind",
  ]);
});

Deno.test("beat eval: sparse village topic is allowed to produce an auditable zero", () => {
  const candidates = [
    hit(
      "https://www.gr.ch/DE/institutionen/verwaltung/djsg/kapo/aktuelles/medienmitteilungen/chur-unfall",
      "Kantonspolizei meldet Unfall in Chur",
    ),
    hit(
      "https://www.pontresina.ch/en/hotels",
      "Best hotels in Pontresina",
    ),
    hit(
      "https://www.engadinerpost.ch/2026/05/01/pontresina-gemeindeversammlung",
      "Pontresina Gemeindeversammlung genehmigt Budget",
    ),
  ];

  const hasPontresinaPoliceOverlap = candidates.some((candidate) => {
    const text = `${candidate.title ?? ""} ${
      candidate.description ?? ""
    } ${candidate.url}`.toLowerCase();
    return text.includes("pontresina") &&
      (text.includes("police") || text.includes("polizei") ||
        text.includes("polizia"));
  });

  assertEquals(hasPontresinaPoliceOverlap, false);
});
