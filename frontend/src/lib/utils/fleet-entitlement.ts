export type FleetTier = 'free' | 'pro' | 'team' | undefined;

/**
 * UI-only Fleet gate. The server is authoritative; this keeps hosted Free
 * users from opening a form that the create endpoint will deny. An unresolved
 * auth state is deliberately not rendered as a Free-tier upsell.
 */
export function isFleetScoutLocked(args: {
	isHosted: boolean;
	authenticated: boolean;
	tier: FleetTier;
}): boolean {
	if (!args.isHosted || !args.authenticated) return false;
	return args.tier !== 'pro' && args.tier !== 'team';
}
