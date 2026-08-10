/**
 * Webhook Client -- Page Scout test execution via backend API.
 *
 * USED BY: PageScoutView.svelte
 * DEPENDS ON: $lib/config/api (buildApiUrl)
 *
 * Sends test scraper requests to POST /scouts/test with abort timeout
 * (10 min default). Returns scraper_status, criteria_status, and summary.
 * Exported as singleton: webhookClient.
 */

import { buildApiUrl } from '$lib/config/api';

interface ScraperTestRequest {
	url: string;
	criteria?: string;
	scraperName?: string;
}

interface ScraperTestResponse {
	summary: string;
	scraper_status: boolean;
	criteria_status: boolean;
	content_hash?: string;
}

class WebhookClient {
	private timeout: number;

	constructor(timeout: number = 600000) {  // 10 minutes for async polling
		this.timeout = timeout;
	}

	/**
	 * Test scraper with URL and criteria
	 * Uses FastAPI backend endpoint instead of N8N webhook
	 */
	async testScraper(request: ScraperTestRequest): Promise<ScraperTestResponse> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout);

		try {
			const { authStore } = await import('$lib/stores/auth');
			const token = await authStore.getToken();
			const response = await fetch(buildApiUrl('/scouts/test'), {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(token ? { Authorization: `Bearer ${token}` } : {})
				},
				body: JSON.stringify({
					url: request.url,
					criteria: request.criteria,
					scraperName: request.scraperName
				}),
				signal: controller.signal
			});

			clearTimeout(timeoutId);

			if (!response.ok) {
				throw new Error(`Scout test failed: ${response.status} ${response.statusText}`);
			}

			const data = await response.json();

			return {
				summary: data.summary || '',
				scraper_status: data.scraper_status ?? true,
				criteria_status: data.criteria_status ?? false,
				content_hash: data.content_hash
			};
		} catch (error) {
			clearTimeout(timeoutId);

			if (error instanceof Error) {
				if (error.name === 'AbortError') {
					throw new Error(`Scout test timed out after ${this.timeout}ms`);
				}
				throw new Error(`Scout test failed: ${error.message}`);
			}
			throw error;
		}
	}

}

// Export singleton instance for convenience
export const webhookClient = new WebhookClient();
