/**
 * Demo seed data for brand-new signups.
 *
 * Shown on the workspace when the user has zero real scouts and has not yet
 * dismissed the demo by creating their first scout. Everything here is pure
 * in-memory — nothing is written to Supabase, nothing is scheduled, nothing
 * consumes credits. Once the workspace has a real scout, the workspace page
 * retires the demo and sets a localStorage flag so it never re-seeds.
 */
import type { Scout, Unit } from '$lib/types/workspace';
import { IS_LOCAL_DEMO_MODE } from '$lib/demo/state';

export const DEMO_DISMISSED_KEY = 'cojournalist_demo_dismissed';

const DEMO_ID_PREFIX = 'demo-';

export function isDemoId(id: string | null | undefined): boolean {
	return typeof id === 'string' && id.startsWith(DEMO_ID_PREFIX);
}

export function demoDismissed(): boolean {
	if (IS_LOCAL_DEMO_MODE) return false;
	if (typeof localStorage === 'undefined') return false;
	try {
		return localStorage.getItem(DEMO_DISMISSED_KEY) === '1';
	} catch {
		return false;
	}
}

export function markDemoDismissed(): void {
	if (IS_LOCAL_DEMO_MODE) return;
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(DEMO_DISMISSED_KEY, '1');
	} catch {
		// Private mode / quota — cleanup just runs again next session, harmless.
	}
}

type DemoScoutLike =
	| (Pick<Scout, 'id' | 'name'> & { is_demo?: boolean | null })
	| { id?: string | null; name?: string | null; is_demo?: boolean | null };

type DemoUnitLike =
	| (Pick<Unit, 'id'> & {
			scout_id?: string | null;
			scout_name?: string | null;
			is_demo?: boolean | null;
	  })
	| null
	| undefined;

// Stable "now" per bundle load so relative times in the UI don't flicker.
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (offsetMs: number): string => new Date(NOW - offsetMs).toISOString();

export const DEMO_SCOUT_IDS = {
	web: 'demo-web',
	pulse: 'demo-pulse',
	social: 'demo-social',
	civic: 'demo-civic'
} as const;

const BACKEND_DEMO_SCOUT_ID = 'onboarding-demo';

// Demo data spans exactly two topics so a brand-new user sees the workspace
// concept (multiple scouts, multiple sources, one editorial focus) without
// being overwhelmed: Climate & mobility, and Housing affordability.
// Every scout carries either a location or a topic (criteria) — usually both —
// and every unit is anchored to one of those two topics.

export const DEMO_SCOUTS: Scout[] = [
	{
		id: DEMO_SCOUT_IDS.web,
		name: 'Oakland City Hall · climate & transit',
		type: 'web',
		is_demo: true,
		url: 'https://www.oaklandca.gov/news',
		topic: 'Climate & mobility',
		criteria: 'climate action',
		location: null,
		is_active: true,
		regularity: 'daily',
		last_run: {
			started_at: iso(4 * HOUR),
			status: 'ok',
			articles_count: 3
		},
		created_at: iso(2 * DAY)
	},
	{
		id: DEMO_SCOUT_IDS.pulse,
		name: 'Housing affordability · São Paulo',
		type: 'pulse',
		is_demo: true,
		topic: 'Housing affordability',
		criteria: null,
		url: null,
		location: {
			displayName: 'São Paulo, Brazil',
			display_name: 'São Paulo, Brazil'
		},
		is_active: true,
		regularity: 'daily',
		last_run: {
			started_at: iso(6 * HOUR),
			status: 'ok',
			articles_count: 3
		},
		created_at: iso(2 * DAY)
	},
	{
		id: DEMO_SCOUT_IDS.social,
		name: '@SadiqKhan · ULEZ & transport',
		type: 'social',
		is_demo: true,
		platform: 'twitter',
		profile_handle: 'SadiqKhan',
		url: 'https://x.com/SadiqKhan',
		topic: 'Climate & mobility',
		criteria: 'low-emission zones',
		location: null,
		is_active: true,
		regularity: 'daily',
		last_run: {
			started_at: iso(2 * HOUR),
			status: 'ok',
			articles_count: 3
		},
		created_at: iso(2 * DAY)
	},
	{
		id: DEMO_SCOUT_IDS.civic,
		name: 'Nairobi County Assembly',
		type: 'civic',
		is_demo: true,
		topic: 'Housing affordability',
		criteria: null,
		root_domain: 'nairobiassembly.go.ke',
		tracked_urls: ['https://nairobiassembly.go.ke/assembly-business/house-business/'],
		url: 'https://nairobiassembly.go.ke/',
		location: {
			displayName: 'Nairobi, Kenya',
			display_name: 'Nairobi, Kenya'
		},
		is_active: true,
		regularity: 'weekly',
		last_run: {
			started_at: iso(12 * HOUR),
			status: 'ok',
			articles_count: 3
		},
		created_at: iso(2 * DAY)
	}
];

const DEMO_SCOUT_NAME: Record<string, string> = {
	[DEMO_SCOUT_IDS.web]: DEMO_SCOUTS[0].name,
	[DEMO_SCOUT_IDS.pulse]: DEMO_SCOUTS[1].name,
	[DEMO_SCOUT_IDS.social]: DEMO_SCOUTS[2].name,
	[DEMO_SCOUT_IDS.civic]: DEMO_SCOUTS[3].name
};

const DEMO_SCOUT_NAMES = new Set(Object.values(DEMO_SCOUT_NAME));

export function isDemoScout(
	scout: DemoScoutLike | null | undefined
): boolean {
	if (!scout) return false;
	if (scout.is_demo === true) return true;
	if (scout.id === BACKEND_DEMO_SCOUT_ID) return true;
	if (isDemoId(scout.id)) return true;
	return typeof scout.name === 'string' && DEMO_SCOUT_NAMES.has(scout.name);
}

export function isDemoUnit(
	unit: DemoUnitLike
): boolean {
	if (!unit) return false;
	if (unit.is_demo === true) return true;
	if (isDemoId(unit.id)) return true;
	if (unit.scout_id === BACKEND_DEMO_SCOUT_ID) return true;
	return typeof unit.scout_name === 'string' && DEMO_SCOUT_NAMES.has(unit.scout_name);
}

export function isDemoWorkspace(scouts: DemoScoutLike[]): boolean {
	return !demoDismissed() && scouts.length > 0 && scouts.every((scout) => isDemoScout(scout));
}

export function shouldSeedDemoWorkspace(
	scouts: DemoScoutLike[],
	loadError: string | null | undefined = null
): boolean {
	return !loadError && !demoDismissed() && scouts.length === 0;
}

export function shouldRetireDemoWorkspace(scouts: DemoScoutLike[]): boolean {
	return !demoDismissed() && scouts.some((scout) => !isDemoScout(scout));
}

export function shouldUseLocalDemoUnits(params: {
	scopeScoutId: string | null;
	units: DemoUnitLike[];
}): boolean {
	const { scopeScoutId, units } = params;
	return (
		!demoDismissed() &&
		((scopeScoutId !== null && isDemoId(scopeScoutId)) ||
			(units.length > 0 && units.every((unit) => isDemoUnit(unit))))
	);
}

interface DemoUnitSeed {
	id: string;
	scoutId: string;
	statement: string;
	sourceUrl: string;
	sourceTitle: string;
	sourceDomain: string;
	entities?: Array<{ canonical_name: string; type: string }>;
	// Mirrors the parent scout: location-scoped scouts produce location-tagged
	// units; topic-scoped scouts produce topic-tagged units.
	location?: string;
	tags?: string[];
	ageMs: number;
	verified?: boolean;
}

const SEEDS: DemoUnitSeed[] = [
	// --- Page Monitor: Oakland City Hall (topic-scoped: Climate & mobility) ---
	{
		id: 'demo-unit-web-1',
		scoutId: DEMO_SCOUT_IDS.web,
		statement:
			'Oakland City Council approves $38M expansion of the Lake Merritt bike path, adding 12 miles of protected lanes by 2028.',
		sourceUrl: 'https://www.oaklandca.gov/news/2026/bike-network-expansion',
		sourceTitle: 'Oakland expands Lake Merritt bike network',
		sourceDomain: 'oaklandca.gov',
		entities: [
			{ canonical_name: 'Oakland City Council', type: 'org' },
			{ canonical_name: 'Lake Merritt', type: 'place' }
		],
		tags: ['public transit'],
		ageMs: 4 * HOUR
	},
	{
		id: 'demo-unit-web-2',
		scoutId: DEMO_SCOUT_IDS.web,
		statement:
			'New page added: "Climate Action Plan — 2030 Update" (48 pages). Public comment open until 2026-05-30.',
		sourceUrl: 'https://www.oaklandca.gov/projects/climate-action-plan-2030',
		sourceTitle: 'Climate Action Plan — 2030 Update',
		sourceDomain: 'oaklandca.gov',
		entities: [{ canonical_name: 'City of Oakland', type: 'org' }],
		tags: ['climate action'],
		ageMs: 28 * HOUR,
		verified: true
	},
	{
		id: 'demo-unit-web-3',
		scoutId: DEMO_SCOUT_IDS.web,
		statement:
			'AC Transit announces fare-free pilot for K-12 students starting fall 2026, funded by the Climate Action Plan reserve.',
		sourceUrl: 'https://www.oaklandca.gov/news/2026/ac-transit-fare-free',
		sourceTitle: 'Free transit for K-12 students from fall 2026',
		sourceDomain: 'oaklandca.gov',
		entities: [
			{ canonical_name: 'AC Transit', type: 'org' },
			{ canonical_name: 'Oakland Unified School District', type: 'org' }
		],
		tags: ['public transit', 'climate action'],
		ageMs: 44 * HOUR
	},

	// --- Beat Scout: São Paulo (location-scoped) ---
	{
		id: 'demo-unit-pulse-1',
		scoutId: DEMO_SCOUT_IDS.pulse,
		statement:
			'São Paulo city legislators approve R$ 480M fund to build 4,200 affordable housing units in central zones by 2029.',
		sourceUrl: 'https://www1.folha.uol.com.br/cotidiano/2026/04/habitacao-centro-sp.shtml',
		sourceTitle: 'Câmara aprova fundo para habitação no centro de SP',
		sourceDomain: 'folha.uol.com.br',
		entities: [
			{ canonical_name: 'Câmara Municipal de São Paulo', type: 'org' },
			{ canonical_name: 'São Paulo', type: 'place' }
		],
		location: 'São Paulo, Brazil',
		ageMs: 6 * HOUR
	},
	{
		id: 'demo-unit-pulse-2',
		scoutId: DEMO_SCOUT_IDS.pulse,
		statement:
			'Rent in Vila Madalena district rose 11.4% year-over-year, outpacing wage growth by 7 points, per FIPE-ZAP index.',
		sourceUrl: 'https://valor.globo.com/brasil/noticia/2026/04/vila-madalena-rent.ghtml',
		sourceTitle: 'Aluguel em Vila Madalena sobe 11%, mostra FIPE-ZAP',
		sourceDomain: 'valor.globo.com',
		entities: [
			{ canonical_name: 'Vila Madalena', type: 'place' },
			{ canonical_name: 'FIPE-ZAP', type: 'org' }
		],
		location: 'São Paulo, Brazil',
		ageMs: 20 * HOUR
	},
	{
		id: 'demo-unit-pulse-3',
		scoutId: DEMO_SCOUT_IDS.pulse,
		statement:
			'Instituto Pólis study: São Paulo short-term rental listings grew 38% since 2024, correlating with displacement in 14 districts.',
		sourceUrl: 'https://www.polis.org.br/publicacoes/airbnb-sp-2026',
		sourceTitle: 'Estudo Pólis: Airbnb e deslocamento em São Paulo',
		sourceDomain: 'polis.org.br',
		entities: [{ canonical_name: 'Instituto Pólis', type: 'org' }],
		location: 'São Paulo, Brazil',
		ageMs: 38 * HOUR,
		verified: true
	},

	// --- Social Monitor: @SadiqKhan (topic-scoped: Climate & mobility) ---
	{
		id: 'demo-unit-social-1',
		scoutId: DEMO_SCOUT_IDS.social,
		statement:
			'New post: "Today we expand the ULEZ scrappage scheme to all London boroughs. Up to £2,000 for eligible drivers."',
		sourceUrl: 'https://x.com/SadiqKhan/status/1781234567890',
		sourceTitle: '@SadiqKhan on X',
		sourceDomain: 'x.com',
		entities: [
			{ canonical_name: 'Sadiq Khan', type: 'person' },
			{ canonical_name: 'ULEZ', type: 'policy' }
		],
		tags: ['low-emission zones'],
		ageMs: 2 * HOUR
	},
	{
		id: 'demo-unit-social-2',
		scoutId: DEMO_SCOUT_IDS.social,
		statement:
			'Reply thread: Mayor responds to Elizabeth Line overcrowding complaints, blaming DfT delay on additional 9-car trainsets.',
		sourceUrl: 'https://x.com/SadiqKhan/status/1780987654321',
		sourceTitle: '@SadiqKhan on X',
		sourceDomain: 'x.com',
		entities: [
			{ canonical_name: 'Transport for London', type: 'org' },
			{ canonical_name: 'Department for Transport', type: 'org' }
		],
		tags: ['public transit'],
		ageMs: 14 * HOUR
	},
	{
		id: 'demo-unit-social-3',
		scoutId: DEMO_SCOUT_IDS.social,
		statement:
			'Announces £25M e-bike loan scheme for outer-London boroughs, citing 2030 net-zero transport target.',
		sourceUrl: 'https://x.com/SadiqKhan/status/1780111222333',
		sourceTitle: '@SadiqKhan on X',
		sourceDomain: 'x.com',
		entities: [
			{ canonical_name: 'Greater London Authority', type: 'org' },
			{ canonical_name: 'e-bike loan scheme', type: 'policy' }
		],
		tags: ['low-emission zones', 'public transit'],
		ageMs: 30 * HOUR
	},

	// --- Civic Monitor: Nairobi County Assembly (location-scoped) ---
	{
		id: 'demo-unit-civic-1',
		scoutId: DEMO_SCOUT_IDS.civic,
		statement:
			'Promise extracted: "We will construct 10,000 low-cost housing units across Eastlands by end of 2028." — Motion 42/2026, passed 56–29.',
		sourceUrl: 'https://nairobiassembly.go.ke/sittings/2026-04-17/motion-42',
		sourceTitle: 'Motion 42/2026 — Eastlands Affordable Housing',
		sourceDomain: 'nairobiassembly.go.ke',
		entities: [
			{ canonical_name: 'Nairobi County Assembly', type: 'org' },
			{ canonical_name: 'Eastlands', type: 'place' }
		],
		location: 'Nairobi, Kenya',
		ageMs: 12 * HOUR,
		verified: true
	},
	{
		id: 'demo-unit-civic-2',
		scoutId: DEMO_SCOUT_IDS.civic,
		statement:
			'Commitment: "Kibera in-situ upgrade will deliver 3,200 social housing units and on-site sanitation by 2027." — Motion 51/2026, passed 49–18.',
		sourceUrl: 'https://nairobiassembly.go.ke/sittings/2026-04-10/kibera-upgrade',
		sourceTitle: 'Motion 51/2026 — Kibera In-Situ Upgrade',
		sourceDomain: 'nairobiassembly.go.ke',
		entities: [
			{ canonical_name: 'Nairobi County Assembly', type: 'org' },
			{ canonical_name: 'Kibera', type: 'place' }
		],
		location: 'Nairobi, Kenya',
		ageMs: 36 * HOUR
	},
	{
		id: 'demo-unit-civic-3',
		scoutId: DEMO_SCOUT_IDS.civic,
		statement:
			'Land allocation passed: 42 hectares in Mukuru kwa Njenga zoned for affordable-housing partnership with the State Department for Housing.',
		sourceUrl: 'https://nairobiassembly.go.ke/sittings/2026-04-03/mukuru-land',
		sourceTitle: 'Mukuru kwa Njenga Land Allocation',
		sourceDomain: 'nairobiassembly.go.ke',
		entities: [
			{ canonical_name: 'Nairobi County Government', type: 'org' },
			{ canonical_name: 'Mukuru kwa Njenga', type: 'place' },
			{ canonical_name: 'State Department for Housing', type: 'org' }
		],
		location: 'Nairobi, Kenya',
		ageMs: 46 * HOUR
	}
];

export const DEMO_UNITS: Unit[] = SEEDS.map((s) => ({
	id: s.id,
	is_demo: true,
	statement: s.statement,
	unit_type: 'event',
	entities: (s.entities ?? []).map((e) => ({
		entity_id: null,
		canonical_name: e.canonical_name,
		type: e.type,
		mention_text: e.canonical_name
	})),
	location: s.location ? { displayName: s.location, display_name: s.location } : null,
	tags: s.tags,
	extracted_at: iso(s.ageMs),
	source: {
		url: s.sourceUrl,
		title: s.sourceTitle,
		domain: s.sourceDomain
	},
	verification: s.verified
		? {
				verified: true,
				verified_at: iso(s.ageMs - HOUR),
				verified_by: 'demo',
				notes: null
			}
		: undefined,
	scout_id: s.scoutId,
	scout_name: DEMO_SCOUT_NAME[s.scoutId]
}));
