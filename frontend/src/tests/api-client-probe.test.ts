/**
 * Probe envelope contract tests — POST /civic/discover, POST /civic/test and
 * the POST /scouts create gate (HTTP 422). The envelope is defined server-side
 * in supabase/functions/_shared/scout_probe.ts; these tests prove the client
 * passes it through untouched and surfaces the server's `error` sentence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/config/api', () => ({
	API_BASE_URL: '/api',
	buildApiUrl: (path: string) => `/api${path.startsWith('/') ? path : '/' + path}`,
	buildFastApiUrl: (path: string) => `/api${path.startsWith('/') ? path : '/' + path}`
}));

import { apiClient, ProbeGateError, isProbeOutcome } from '$lib/api-client';

function mockFetchResponse(body: unknown, status = 200) {
	return vi.fn().mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		json: vi.fn().mockResolvedValue(body),
		text: vi.fn().mockResolvedValue(JSON.stringify(body))
	});
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
	fetchSpy = mockFetchResponse({});
	vi.stubGlobal('fetch', fetchSpy);
});

describe('isProbeOutcome', () => {
	it('classifies no_meetings_detected as an outcome and everything else as a failure', () => {
		expect(isProbeOutcome('no_meetings_detected')).toBe(true);
		for (const code of ['unreachable', 'blocked', 'empty_content', 'no_documents', 'parse_failed', 'model_failed']) {
			expect(isProbeOutcome(code)).toBe(false);
		}
		expect(isProbeOutcome(undefined)).toBe(false);
	});
});

describe('discoverCivic', () => {
	it('POSTs root_domain and passes the ok envelope with verified candidates through', async () => {
		const body = {
			ok: true,
			stage: 'detect',
			system: 'moderngov',
			candidates: [
				{
					url: 'https://democracy.bristol.gov.uk/ieListMeetings.aspx?CId=1',
					description: 'Full Council meetings',
					confidence: 0.9,
					system: 'moderngov',
					documents_visible: 12,
					recommended: true
				}
			]
		};
		fetchSpy = mockFetchResponse(body);
		vi.stubGlobal('fetch', fetchSpy);

		const result = await apiClient.discoverCivic('bristol.gov.uk');

		expect(fetchSpy).toHaveBeenCalledWith(
			'/api/civic/discover',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ root_domain: 'bristol.gov.uk' })
			})
		);
		expect(result.ok).toBe(true);
		expect(result.stage).toBe('detect');
		expect(result.system).toBe('moderngov');
		expect(result.candidates[0].documents_visible).toBe(12);
		expect(result.candidates[0].recommended).toBe(true);
		expect(result.error_code).toBeUndefined();
	});

	it('passes the no_meetings_detected outcome through with error, error_code and unverified pages', async () => {
		const body = {
			ok: false,
			stage: 'detect',
			error_code: 'no_meetings_detected',
			error: 'No council meetings were detected on this website. Choose one of the suggested pages, or enter the page that lists individual meetings (agendas, minutes or protocols).',
			system: 'generic',
			candidates: [],
			unverified: [{ url: 'https://www.bristol.gov.uk/council', description: 'Council section', confidence: 0.4 }]
		};
		fetchSpy = mockFetchResponse(body);
		vi.stubGlobal('fetch', fetchSpy);

		const result = await apiClient.discoverCivic('https://www.bristol.gov.uk/');

		expect(result.ok).toBe(false);
		expect(result.error_code).toBe('no_meetings_detected');
		expect(isProbeOutcome(result.error_code)).toBe(true);
		expect(result.error).toBe(body.error);
		expect(result.candidates).toEqual([]);
		expect(result.unverified).toEqual(body.unverified);
	});

	it('passes a reach-stage failure (blocked) through as ok:false with the server sentence', async () => {
		const body = {
			ok: false,
			stage: 'reach',
			error_code: 'blocked',
			error: 'The website blocks automated access, so it cannot be monitored from here.',
			system: 'generic',
			candidates: []
		};
		fetchSpy = mockFetchResponse(body);
		vi.stubGlobal('fetch', fetchSpy);

		const result = await apiClient.discoverCivic('blocked.example');

		expect(result.ok).toBe(false);
		expect(result.stage).toBe('reach');
		expect(result.error_code).toBe('blocked');
		expect(isProbeOutcome(result.error_code)).toBe(false);
		expect(result.error).toBe(body.error);
	});
});

describe('testCivic', () => {
	it('POSTs tracked_urls (+criteria) and passes error/error_code through on a sample failure', async () => {
		const body = {
			ok: false,
			stage: 'sample',
			error_code: 'no_documents',
			error: 'No meeting documents were found on the selected page. Pick the page that lists individual meetings rather than a section landing page, then test again.',
			api_version: '2',
			valid: false,
			documents_found: 0,
			documents_resolved: 0,
			documents_evaluated: 0,
			policy_version: 'v2',
			preview_snapshot_token: null,
			sample_items: [],
			sample_promises: []
		};
		fetchSpy = mockFetchResponse(body);
		vi.stubGlobal('fetch', fetchSpy);

		const result = await apiClient.testCivic(['https://example.gov/meetings'], 'housing');

		expect(fetchSpy).toHaveBeenCalledWith(
			'/api/civic/test',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ tracked_urls: ['https://example.gov/meetings'], criteria: 'housing' })
			})
		);
		expect(result.ok).toBe(false);
		expect(result.valid).toBe(false);
		expect(result.error_code).toBe('no_documents');
		expect(result.error).toBe(body.error);
	});

	it('keeps the existing success fields alongside the ok envelope', async () => {
		const body = {
			ok: true,
			stage: 'sample',
			api_version: '2',
			valid: true,
			documents_found: 2,
			documents_resolved: 2,
			documents_evaluated: 2,
			policy_version: 'v2',
			preview_snapshot_token: 'tok-1',
			sample_items: [],
			sample_promises: []
		};
		fetchSpy = mockFetchResponse(body);
		vi.stubGlobal('fetch', fetchSpy);

		const result = await apiClient.testCivic(['https://example.gov/meetings']);

		expect(result.ok).toBe(true);
		expect(result.valid).toBe(true);
		expect(result.preview_snapshot_token).toBe('tok-1');
		expect(result.error).toBeUndefined();
	});
});

describe('POST /scouts create gate (422)', () => {
	const civicGate = {
		ok: false,
		stage: 'detect',
		error_code: 'no_meetings_detected',
		error: 'No council meetings were detected on this website. Choose one of the suggested pages, or enter the page that lists individual meetings (agendas, minutes or protocols).',
		system: 'generic',
		validated: [],
		invalid: ['https://www.bristol.gov.uk/'],
		candidates: [
			{ url: 'https://democracy.bristol.gov.uk/ieListMeetings.aspx?CId=1', description: 'Full Council', confidence: 0.9, documents_visible: 3, recommended: true }
		]
	};

	it('scheduleLocalScout surfaces the server error sentence as the thrown message', async () => {
		fetchSpy = mockFetchResponse(civicGate, 422);
		vi.stubGlobal('fetch', fetchSpy);

		await expect(
			apiClient.scheduleLocalScout({
				name: 'bristol',
				scout_type: 'civic',
				regularity: 'daily',
				day_number: 1,
				time: '09:00',
				monitoring: 'EMAIL',
				root_domain: 'https://www.bristol.gov.uk/',
				tracked_urls: ['https://www.bristol.gov.uk/']
			})
		).rejects.toThrow(civicGate.error);
	});

	it('scheduleLocalScout throws a ProbeGateError carrying error_code, stage, status and candidates', async () => {
		fetchSpy = mockFetchResponse(civicGate, 422);
		vi.stubGlobal('fetch', fetchSpy);

		let caught: unknown;
		try {
			await apiClient.scheduleLocalScout({
				name: 'bristol',
				scout_type: 'civic',
				regularity: 'daily',
				day_number: 1,
				time: '09:00',
				monitoring: 'EMAIL',
				tracked_urls: ['https://www.bristol.gov.uk/']
			});
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ProbeGateError);
		const err = caught as ProbeGateError;
		expect(err.message).toBe(civicGate.error);
		expect(err.error_code).toBe('no_meetings_detected');
		expect(err.stage).toBe('detect');
		expect(err.status).toBe(422);
		expect(err.candidates).toEqual(civicGate.candidates);
	});

	it('scheduleMonitoring (web) surfaces a blocked gate with error_code and no candidates', async () => {
		const webGate = {
			ok: false,
			stage: 'reach',
			error_code: 'blocked',
			error: 'The website blocks automated access, so it cannot be monitored from here.'
		};
		fetchSpy = mockFetchResponse(webGate, 422);
		vi.stubGlobal('fetch', fetchSpy);

		let caught: unknown;
		try {
			await apiClient.scheduleMonitoring({
				name: 'blocked',
				url: 'https://blocked.example',
				criteria: 'anything',
				regularity: 'daily',
				day_number: 1,
				time: '09:00',
				channel: 'website',
				monitoring: 'EMAIL'
			});
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ProbeGateError);
		const err = caught as ProbeGateError;
		expect(err.message).toBe(webGate.error);
		expect(err.error_code).toBe('blocked');
		expect(err.candidates).toEqual([]);
	});

	it('non-envelope errors keep the existing plain Error behaviour', async () => {
		fetchSpy = mockFetchResponse({ error: 'name already exists' }, 409);
		vi.stubGlobal('fetch', fetchSpy);

		let caught: unknown;
		try {
			await apiClient.scheduleLocalScout({
				name: 'dup',
				scout_type: 'civic',
				regularity: 'daily',
				day_number: 1,
				time: '09:00',
				monitoring: 'EMAIL'
			});
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(Error);
		expect(caught).not.toBeInstanceOf(ProbeGateError);
		expect((caught as Error).message).toBe('name already exists');
	});
});
