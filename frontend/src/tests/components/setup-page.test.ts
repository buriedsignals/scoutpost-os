import { render, fireEvent, screen, waitFor, cleanup } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SetupPage from '../../routes/setup/+page.svelte';

beforeEach(() => {
	Object.defineProperty(URL, 'createObjectURL', {
		value: vi.fn(() => 'blob:setup-download'),
		configurable: true
	});
	Object.defineProperty(URL, 'revokeObjectURL', {
		value: vi.fn(),
		configurable: true
	});
	HTMLAnchorElement.prototype.click = vi.fn();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

async function fillField(label: RegExp, value: string) {
	const field = screen
		.getAllByLabelText(label)
		.find((element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement);
	if (!field) throw new Error(`Could not find editable field for ${label}`);
	await userEvent.clear(field);
	await userEvent.type(field, value);
}

describe('setup page validation', () => {
	it('updates Docker installer validation as required fields are filled', async () => {
		render(SetupPage);

		await fireEvent.click(screen.getByRole('button', { name: /download docker installer/i }));

		expect(screen.getByRole('alert')).toHaveTextContent('Gemini API key is required.');
		expect(screen.getByRole('alert')).toHaveTextContent('Supabase access token is required.');

		await fillField(/gemini api key/i, 'gemini-key');

		await waitFor(() => {
			expect(screen.getByRole('alert')).not.toHaveTextContent('Gemini API key is required.');
		});
		expect(screen.getByRole('alert')).toHaveTextContent('Firecrawl API key is required.');

		await fillField(/firecrawl api key/i, 'firecrawl-key');
		await fillField(/apify api token/i, 'apify-token');
		await fillField(/resend api key/i, 'resend-key');
		await fillField(/resend sender email/i, 'scouts@example.com');
		await fillField(/maptiler api key/i, 'maptiler-key');
		await fillField(/admin email/i, 'admin@example.com');
		await fillField(/allowed signup domains/i, 'example.com');
		await fillField(/organization id/i, 'org_123');
		await fillField(/database password/i, 'long-db-password');
		await fillField(/supabase access token/i, 'sbp_test_token');

		await fireEvent.click(screen.getByRole('button', { name: /download docker installer/i }));

		await waitFor(() => {
			expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		});
		expect(URL.createObjectURL).toHaveBeenCalled();
	});
});
