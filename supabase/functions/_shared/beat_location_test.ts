import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildBeatLocationMatcher,
  buildBeatLocationSearchLabel,
  parseBeatLocation,
} from "./beat_location.ts";

Deno.test("parseBeatLocation keeps country-only selections as country scope", () => {
  const parsed = parseBeatLocation({
    displayName: "United Kingdom",
    country: "GB",
    locationType: "country",
  });

  assertEquals(parsed.city, null);
  assertEquals(parsed.state, null);
  assertEquals(parsed.country, "United Kingdom");
  assertEquals(parsed.countryCode, "GB");
});

Deno.test("parseBeatLocation keeps city selections intact", () => {
  const parsed = parseBeatLocation({
    displayName: "Bozeman, Montana, United States",
    city: "Bozeman",
    state: "MT",
    country: "US",
    locationType: "city",
  });

  assertEquals(parsed.city, "Bozeman");
  assertEquals(parsed.state, "MT");
  assertEquals(parsed.country, "Montana, United States");
  assertEquals(parsed.countryCode, "US");
});

Deno.test("parseBeatLocation preserves MapTiler region selections from the UI", () => {
  const parsed = parseBeatLocation({
    displayName: "Ontario, Canada",
    country: "CA",
    locationType: "state",
  });

  assertEquals(parsed.city, "Ontario");
  assertEquals(parsed.state, null);
  assertEquals(parsed.country, "Canada");
  assertEquals(parsed.countryCode, "CA");
});

Deno.test("buildBeatLocationSearchLabel uses selected place hierarchy for ambiguous cities", () => {
  assertEquals(
    buildBeatLocationSearchLabel(
      parseBeatLocation({
        displayName: "London, United Kingdom",
        city: "London",
        country: "GB",
        locationType: "city",
      }),
    ),
    "London United Kingdom",
  );
  assertEquals(
    buildBeatLocationSearchLabel(
      parseBeatLocation({
        displayName: "London, Ontario, Canada",
        city: "London",
        state: "ON",
        country: "CA",
        locationType: "city",
      }),
    ),
    "London Ontario",
  );
  assertEquals(
    buildBeatLocationSearchLabel(
      parseBeatLocation({
        displayName: "Zurich, Switzerland",
        city: "Zurich",
        country: "CH",
        locationType: "city",
      }),
    ),
    "Zurich Switzerland",
  );
  assertEquals(
    buildBeatLocationSearchLabel(
      parseBeatLocation({
        displayName: "United Kingdom",
        country: "GB",
        locationType: "country",
      }),
    ),
    "United Kingdom",
  );
});

Deno.test("buildBeatLocationMatcher accepts UK coverage and rejects Montreal drift", () => {
  const matcher = buildBeatLocationMatcher({
    city: null,
    state: null,
    country: "United Kingdom",
    countryCode: "GB",
  });

  assert(matcher);
  assert(
    matcher(
      "Government’s Local Power Plan will support renewable energy projects across England, Scotland and Wales.",
    ),
  );
  assert(
    !matcher(
      "Montreal is expanding social housing supply across Quebec as Canada revises affordability policy.",
    ),
  );
});

Deno.test("buildBeatLocationMatcher requires subdivision context for ambiguous state-scoped cities", () => {
  const matcher = buildBeatLocationMatcher(
    parseBeatLocation({
      displayName: "London, Ontario, Canada",
      city: "London",
      state: "ON",
      country: "CA",
      locationType: "city",
    }),
  );

  assert(matcher);
  assert(
    matcher(
      "London city council in Ontario approved a new housing affordability plan for local tenants.",
    ),
  );
  assert(
    matcher(
      "London is seeking Canadian infrastructure grants for new housing near Western University.",
    ),
  );
  assert(
    !matcher(
      "London borough councils in England are debating housing targets after a UK planning review.",
    ),
  );
});
