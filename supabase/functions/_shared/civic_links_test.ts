import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  classifyCivicMeetingUrls,
  extractCivicLinksFromHtml,
  extractCivicLinksFromPages,
  filterCivicDiscoveryCandidates,
  isCivicScrapableUrl,
} from "./civic_links.ts";

Deno.test("extractCivicLinksFromHtml extracts same-domain document links and strips fragments", () => {
  const html = `
    <html>
      <body>
        <a href="/urversammlung/protokoll">Protokolle</a>
        <a href="/pdf/protokoll/2025/vollprotokoll_2025-03-19.pdf#page=1">Vollprotokoll</a>
        <a href="mailto:info@example.org">Mail</a>
        <a href="https://external.example.org/minutes">External</a>
      </body>
    </html>
  `;

  const links = extractCivicLinksFromHtml(
    html,
    "https://gemeinde.zermatt.ch",
  );

  assertEquals(links, [
    {
      url: "https://gemeinde.zermatt.ch/urversammlung/protokoll",
      anchorText: "Protokolle",
    },
    {
      url:
        "https://gemeinde.zermatt.ch/pdf/protokoll/2025/vollprotokoll_2025-03-19.pdf",
      anchorText: "Vollprotokoll",
    },
  ]);
});

Deno.test("extractCivicLinksFromHtml rejects asset links with query strings", () => {
  const html = `
    <a href="/calendar/agenda.gif?download=1">Agenda image</a>
    <a href="/media/meeting.mp4">Meeting video</a>
    <a href="/meetings/minutes.pdf?download=1">Minutes PDF</a>
    <a href="/council/minutes">Minutes page</a>
  `;

  const links = extractCivicLinksFromHtml(html, "https://city.example.org");

  assertEquals(links, [
    {
      url: "https://city.example.org/meetings/minutes.pdf?download=1",
      anchorText: "Minutes PDF",
    },
    {
      url: "https://city.example.org/council/minutes",
      anchorText: "Minutes page",
    },
  ]);
});

Deno.test("extractCivicLinksFromPages de-duplicates links across tracked pages", () => {
  const pages = [
    {
      pageUrl: "https://gemeinde.zermatt.ch/urversammlung/protokoll",
      rawHtml:
        '<a href="/pdf/protokoll/2025/vollprotokoll_2025-03-19.pdf">Vollprotokoll</a>',
    },
    {
      pageUrl: "https://gemeinde.zermatt.ch/urversammlung/protokoll?page=2",
      rawHtml:
        '<a href="/pdf/protokoll/2025/vollprotokoll_2025-03-19.pdf">Duplicate</a>',
    },
  ];

  const links = extractCivicLinksFromPages(pages);

  assertEquals(links.length, 1);
  assertEquals(
    links[0].url,
    "https://gemeinde.zermatt.ch/pdf/protokoll/2025/vollprotokoll_2025-03-19.pdf",
  );
});

Deno.test("filterCivicDiscoveryCandidates rejects dead /pdf listing paths but keeps listing pages", () => {
  const filtered = filterCivicDiscoveryCandidates([
    { url: "https://gemeinde.zermatt.ch/pdf/protokoll", confidence: 0.95 },
    {
      url: "https://gemeinde.zermatt.ch/urversammlung/protokoll",
      confidence: 0.9,
    },
  ]);

  assertEquals(filtered, [
    {
      url: "https://gemeinde.zermatt.ch/urversammlung/protokoll",
      confidence: 0.9,
    },
  ]);
});

Deno.test("classifyCivicMeetingUrls uses keyword stage for pdf minutes links", async () => {
  const urls = await classifyCivicMeetingUrls([
    {
      url:
        "https://gemeinde.zermatt.ch/pdf/protokoll/2025/vollprotokoll_2025-03-19.pdf",
      anchorText: "Vollprotokoll 19.03.2025",
    },
    {
      url:
        "https://gemeinde.zermatt.ch/pdf/protokoll/2024/beschlussprotokoll_2024-12-11.pdf",
      anchorText: "Beschlussprotokoll 11.12.2024",
    },
  ]);

  assertEquals(urls.length, 2);
  assertExists(urls[0].match(/2025-03-19/));
  assertExists(urls[1].match(/2024-12-11/));
});

Deno.test("classifyCivicMeetingUrls prioritizes full records before newer agendas", async () => {
  const urls = await classifyCivicMeetingUrls([
    {
      url:
        "https://grosserrat.example/media/files/ratsprotokolle/tagesordnung_2026-05-06.pdf",
      anchorText: "Tagesordnung 06.05.2026",
    },
    {
      url:
        "https://grosserrat.example/media/files/ratsprotokolle/vollprotokoll_2026-01-07.pdf",
      anchorText: "Vollprotokoll 07.01.2026",
    },
    {
      url:
        "https://grosserrat.example/media/files/ratsprotokolle/geschaeftsverzeichnis_2026-05-06.pdf",
      anchorText: "Geschäftsverzeichnis 06.05.2026",
    },
  ]);

  assertEquals(urls, [
    "https://grosserrat.example/media/files/ratsprotokolle/vollprotokoll_2026-01-07.pdf",
    "https://grosserrat.example/media/files/ratsprotokolle/geschaeftsverzeichnis_2026-05-06.pdf",
    "https://grosserrat.example/media/files/ratsprotokolle/tagesordnung_2026-05-06.pdf",
  ]);
});

Deno.test("classifyCivicMeetingUrls uses PDF as a tie-breaker within document class and date", async () => {
  const urls = await classifyCivicMeetingUrls([
    {
      url: "https://city.example.org/council/minutes/2026-05-04",
      anchorText: "Minutes 04.05.2026",
    },
    {
      url: "https://city.example.org/council/minutes_2026-05-04.pdf",
      anchorText: "Minutes PDF",
    },
  ]);

  assertEquals(urls, [
    "https://city.example.org/council/minutes_2026-05-04.pdf",
    "https://city.example.org/council/minutes/2026-05-04",
  ]);
});

Deno.test("classifyCivicMeetingUrls excludes unsupported asset URLs before keyword matching", async () => {
  const urls = await classifyCivicMeetingUrls([
    {
      url: "https://city.example.org/calendar/agenda.gif?download=1",
      anchorText: "Council agenda",
    },
    {
      url: "https://city.example.org/council/agenda/2026-05-01",
      anchorText: "Council agenda",
    },
  ]);

  assertEquals(urls, [
    "https://city.example.org/council/agenda/2026-05-01",
  ]);
});

Deno.test("isCivicScrapableUrl rejects image, video, and archive assets", () => {
  assertEquals(
    isCivicScrapableUrl("https://city.example.org/minutes.pdf?download=1"),
    true,
  );
  assertEquals(
    isCivicScrapableUrl("https://city.example.org/agenda.gif?download=1"),
    false,
  );
  assertEquals(
    isCivicScrapableUrl("https://city.example.org/council/meeting.mp4"),
    false,
  );
  assertEquals(
    isCivicScrapableUrl("https://city.example.org/archive/minutes.zip"),
    false,
  );
});
