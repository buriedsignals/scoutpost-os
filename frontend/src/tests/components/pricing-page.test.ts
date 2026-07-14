import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PricingPage from '../../routes/pricing/+page.svelte';

vi.mock('$lib/stores/auth', async () => {
	const { readable } = await import('svelte/store');
	const authState = readable({ authenticated: false, user: null });
	return {
		authStore: { subscribe: authState.subscribe },
		currentUser: authState,
		auth: {}
	};
});

vi.mock('$lib/paraglide/messages', () => ({
	common_back: () => 'Back',
	pricing_comingSoon: () => 'Coming soon',
	pricing_currentPlan: () => 'Current plan',
	pricing_getStarted: () => 'Get started',
	pricing_signUpToStart: () => 'Sign up to start',
	pricing_subtitle: () => 'Choose a plan',
	pricing_upgradeToPro: () => 'Upgrade to Pro'
}));

afterEach(() => {
	cleanup();
});

describe('pricing page', () => {
	it('describes the current hosted plans without promising removed features', () => {
		render(PricingPage);

		expect(screen.getByText('Fleet Scout for vessels, aircraft, and satellites')).toBeInTheDocument();
		expect(screen.getByText('Tamper-evident Page Archive snapshots')).toBeInTheDocument();
		expect(screen.getByText('Scraped source data stored in your workspace')).toBeInTheDocument();
		expect(screen.getByText('1,000 additional credits per seat')).toBeInTheDocument();
		expect(screen.queryByText(/CMS export/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/shared scouts/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/daily monitors/i)).not.toBeInTheDocument();
	});

	it('sends signed-out paid-plan CTAs to the MuckRock purchase flow', () => {
		render(PricingPage);

		expect(screen.getByRole('link', { name: 'Start with Pro' })).toHaveAttribute(
			'href',
			'https://accounts.muckrock.com/plans/70-scoutpost-pro/'
		);
		expect(screen.getByRole('link', { name: 'Start with Team' })).toHaveAttribute(
			'href',
			'https://accounts.muckrock.com/plans/71-scoutpost-team/'
		);
	});
});
