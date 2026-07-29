import type { RequestHandler } from './$types';

export const prerender = true;

export const GET: RequestHandler = () => {
	const supabaseOrigin = (import.meta.env.PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
	const apiBase = `${supabaseOrigin}/functions/v1`;

	return new Response(
		JSON.stringify({
			version: 1,
			issuer: 'requested-site',
			api_origin: supabaseOrigin,
			api_base_url: apiBase,
			device_authorization_endpoint: `${apiBase}/cli-auth/v1/device/authorize`,
			token_endpoint: `${apiBase}/cli-auth/v1/device/token`,
			verification_uri: '/cli/authorize',
			api_key_management_url: '/?connect=api',
			public_gateway_key: import.meta.env.PUBLIC_SUPABASE_ANON_KEY
		}),
		{
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				'Cache-Control': 'public, max-age=300'
			}
		}
	);
};
