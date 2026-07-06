import { assertEquals } from "jsr:@std/assert";
import {
  criteriaScoreFromUnit,
  socialCriteriaThreshold,
} from "./social_criteria.ts";

Deno.test("socialCriteriaThreshold uses platform defaults", () => {
  assertEquals(socialCriteriaThreshold("tiktok"), 0.7);
  assertEquals(socialCriteriaThreshold("instagram"), 0.65);
  assertEquals(socialCriteriaThreshold("x"), 0.55);
  assertEquals(socialCriteriaThreshold("facebook"), 0.55);
  assertEquals(socialCriteriaThreshold("linkedin"), 0.55);
  assertEquals(socialCriteriaThreshold("unknown"), 0.55);
});

Deno.test("socialCriteriaThreshold honors metadata override", () => {
  assertEquals(
    socialCriteriaThreshold("tiktok", { criteria_threshold: 0.8 }),
    0.8,
  );
  assertEquals(
    socialCriteriaThreshold("tiktok", { criteria_threshold: "0.4" }),
    0.4,
  );
  assertEquals(socialCriteriaThreshold("tiktok", { criteria_threshold: 2 }), 1);
});

Deno.test("criteriaScoreFromUnit falls back to criteria_match boolean", () => {
  assertEquals(criteriaScoreFromUnit({ criteria_score: 0.62 }), 0.62);
  assertEquals(criteriaScoreFromUnit({ criteria_match: false }), 0);
  assertEquals(criteriaScoreFromUnit({ criteria_match: true }), 1);
});
