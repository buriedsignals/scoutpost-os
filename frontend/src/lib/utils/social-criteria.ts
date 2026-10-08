// Criteria mode keeps only posts whose content matches the criteria
// (apify-callback extracts matching statements), so criteria that describe a
// posting event rather than a topic match nothing. Detect that phrasing so the
// form can point the user to Summarize or the removals checkbox instead.
const POST_EVENT_PATTERNS = [
	/\b(?:new|any)\s+posts?\b/i,
	/\bposts?\s+(?:(?:is|are|was|were|gets?|got|has\s+been|have\s+been)\s+)?(?:added|published|posted|created|uploaded|removed|deleted|taken\s+down)\b/i,
	/\b(?:when|whenever|if)\s+(?:he|she|they|it|someone|the\s+(?:user|profile|account|page))\s+posts?\b/i
];

export function describesPostEvents(criteria: string): boolean {
	return POST_EVENT_PATTERNS.some((pattern) => pattern.test(criteria));
}
