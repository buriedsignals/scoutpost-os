import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import SetupPage from '../../routes/setup/+page.svelte';

afterEach(() => {
	cleanup();
});

describe('setup page', () => {
	it('is Docker-only and does not collect deployment secrets in the browser', () => {
		render(SetupPage);

		expect(screen.getByRole('heading', { name: /install scoutpost with docker/i })).toBeInTheDocument();
		expect(screen.getByText(/no browser secret collection/i)).toBeInTheDocument();
		expect(screen.getAllByText(/ghcr\.io\/buriedsignals\/scoutpost-installer:latest/i).length).toBeGreaterThan(0);
		expect(screen.getByRole('link', { name: /download example manifest/i })).toHaveAttribute(
			'href',
			expect.stringContaining('scoutpost-setup.example.json')
		);
		expect(screen.queryByLabelText(/gemini api key/i)).not.toBeInTheDocument();
		expect(screen.queryByLabelText(/supabase access token/i)).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /download docker installer/i })).not.toBeInTheDocument();
		expect(screen.queryByText(/shell fallback/i)).not.toBeInTheDocument();
	});
});
