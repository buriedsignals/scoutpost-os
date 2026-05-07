<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { auth } from '$lib/stores/auth';
	import { IS_LOCAL_DEMO_MODE } from '$lib/demo/state';
	import { onMount } from 'svelte';

	let mounted = false;
	let featureListEl: HTMLElement;
	const isSupabaseDeployment = import.meta.env.PUBLIC_DEPLOYMENT_TARGET === 'supabase';
	const selfHostLoginNote = (import.meta.env.PUBLIC_SELF_HOST_LOGIN_NOTE ?? '').trim();
	const showSupabaseAuth = () =>
		isSupabaseDeployment && !(false || false);

	// Supabase self-hosted auth state
	let isSignup = false;
	let email = '';
	let password = '';
	let authError = '';
	let authLoading = false;

	// Buried Signals newsletter signup (Pro Membership card)
	let subscribeEmail = '';
	let subscribing = false;
	let subscribed = false;
	let subscribeError = '';

	async function handleSubscribe() {
		const value = subscribeEmail.trim();
		if (!value) return;
		subscribing = true;
		subscribeError = '';
		try {
			const supabaseUrl = (import.meta.env.PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
			const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY ?? '';
			const res = await fetch(`${supabaseUrl}/functions/v1/newsletter-subscribe`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					apikey: supabaseAnonKey
				},
				body: JSON.stringify({ email: value, newsletters: ['buried_signals'] })
			});
			const data = await res.json().catch(() => ({}));
			if (res.ok) {
				subscribed = true;
			} else {
				subscribeError = data.error || data.detail || 'Something went wrong. Please try again.';
			}
		} catch {
			subscribeError = 'Something went wrong. Please try again.';
		} finally {
			subscribing = false;
		}
	}

	async function handleSupabaseAuth() {
		authLoading = true;
		authError = '';
		try {
			const { createClient } = await import('@supabase/supabase-js');
			const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
			const supabaseKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
			const supabase = createClient(supabaseUrl, supabaseKey);

			if (isSignup) {
				const { data, error } = await supabase.auth.signUp({ email, password });
				if (error) throw error;
				if (data?.session) {
					await goto('/');
				} else {
					authError = 'Check your email to confirm your account.';
				}
			} else {
				const { error } = await supabase.auth.signInWithPassword({ email, password });
				if (error) throw error;
				await goto('/');
			}
		} catch (e: any) {
			authError = e.message || 'Authentication failed';
		} finally {
			authLoading = false;
		}
	}

	$: notAvailable = $page.url.searchParams.get('error') === 'not_available';

	onMount(() => {
		mounted = true;

		const unsubscribe = auth.subscribe(async (state) => {
			if (state.authenticated) {
				await goto('/');
			}
		});

		let observer: IntersectionObserver | null = null;

		function setupScrollHover() {
			if (window.innerWidth >= 1024 || !featureListEl) return;

			observer = new IntersectionObserver(
				(entries) => {
					entries.forEach((entry) => {
						entry.target.classList.toggle('feature-active', entry.isIntersecting);
					});
				},
				{ rootMargin: '-35% 0px -35% 0px', threshold: [0, 0.2, 0.5, 0.8, 1] }
			);

			featureListEl.querySelectorAll('.feature-item').forEach((el) => {
				observer!.observe(el);
			});
		}

		setupScrollHover();

		return () => {
			unsubscribe();
			observer?.disconnect();
		};
	});
</script>

<div class="login-container">
	<!-- Subtle grid pattern (editorial baseline) -->
	<div class="grid-pattern"></div>

	<div class="content-wrapper">
		<!-- Auth panel - Fixed centered on left -->
		<div class="auth-panel-container">
			<div class="auth-panel" class:mounted>
				<div class="auth-shell">
					<div class="auth-card">
						{#if notAvailable}
							<img src="/logo-scoutpost.svg" alt="Scoutpost" class="auth-logo" />
							<p class="coming-soon-title">Access not available</p>
							<p class="coming-soon-text">
								Scoutpost hosted accounts are in limited access. This hosted account is not enabled yet; if you expected access, contact the Scoutpost team.
							</p>
						{:else}
							{#if showSupabaseAuth()}
								<span class="brand-dot"></span>
								<p class="auth-title">{isSignup ? 'Create Account' : 'Welcome Back'}</p>
								<p class="auth-subtitle">
									{#if IS_LOCAL_DEMO_MODE}
										{isSignup ? 'Create a local demo account' : 'Sign in to the local demo workspace'}
									{:else}
										{isSignup ? 'Set up your admin account' : 'Sign in to your account'}
									{/if}
								</p>
								{#if selfHostLoginNote}
									<p class="auth-mode-note">{selfHostLoginNote}</p>
								{:else if IS_LOCAL_DEMO_MODE}
									<p class="auth-mode-note">Local demo workspace. Example scouts stay local and never hit hosted auth.</p>
								{/if}

								{#if authError}
									<p class="auth-error">{authError}</p>
								{/if}

								<form onsubmit={(e) => { e.preventDefault(); handleSupabaseAuth(); }}>
									<input type="email" bind:value={email} placeholder="Email" required class="auth-input" />
									<input type="password" bind:value={password} placeholder="Password" required minlength="6" class="auth-input" />
									<button type="submit" class="sign-in-button" disabled={authLoading}>
										{authLoading ? 'Please wait...' : isSignup ? 'Create Account' : 'Sign In'}
									</button>
								</form>

								<button class="auth-toggle" onclick={() => { isSignup = !isSignup; authError = ''; }}>
									{isSignup ? 'Already have an account? Sign in' : 'Create a new account'}
								</button>

								<div class="auth-cta-row">
									
									<span class="auth-cta-sep">·</span>
									<a href="/docs" class="auth-cta-link">See docs</a>
									<span class="auth-cta-sep">·</span>
									<a href="/skills" class="auth-cta-link">See skills</a>
								</div>
							{:else}
								<span class="brand-dot"></span>
								<p class="auth-prompt">Sign in</p>
								<button class="sign-in-button" onclick={() => auth.login()}>
									Sign in
								</button>
								
								<div class="auth-cta-row">
									
									<span class="auth-cta-sep">·</span>
									<a href="/docs" class="auth-cta-link">See docs</a>
									<span class="auth-cta-sep">·</span>
									<a href="/skills" class="auth-cta-link">See skills</a>
								</div>
							{/if}


							<div class="auth-oss-badge">
								<p class="auth-oss-text">
									Open source under the
									<a href="/faq" class="auth-oss-link">Sustainable Use License</a>
								</p>
								<a href="https://github.com/buriedsignals/scoutpost-os" target="_blank" rel="noopener noreferrer" class="auth-github-link">
									<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align: -2px; margin-right: 4px;"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
									View on GitHub
								</a>
							</div>
							<div class="terms-footer">
								<a href="/terms">Terms & Privacy</a>
							</div>
						{/if}
					</div>
				</div>
			</div>
		</div>

		<!-- Story / marketing panel -->
		<div class="story-panel" class:mounted>
			<div class="badge">
				<span class="badge-dot"></span>
				PUBLIC BETA
			</div>

			<img src="/logo-scoutpost.svg" alt="Scoutpost" class="headline-logo" />

			<p class="tagline">
				Let your AI monitor the
				<span class="highlight-muted">noise</span>
				and
				<span class="highlight-accent">surface leads</span>.
			</p>

			<div class="description-block">
				<h2 class="subheadline">
					Connect your agent to scouts that monitor pages, social profiles, city councils, and your beat — while you <span class="highlight-accent">focus on reporting</span>.
				</h2>

				<a
					href="https://buriedsignals.com"
					target="_blank"
					rel="noopener noreferrer"
					class="built-by-link"
				>
					Built by <strong>Buried Signals</strong> ↗
				</a>

				<hr class="works-with-divider" />
				<div class="works-with">
					<span class="works-with-label">Works with</span>
					<span class="agent-pill">
						<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
						Claude Code
					</span>
					<span class="agent-pill">
						<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .962L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>
						Claude Cowork
					</span>
					<span class="agent-pill">
						<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
						Codex
					</span>
					<span class="agent-pill">
						<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3L9.5 9.5 3 12l6.5 2.5L12 21l2.5-6.5L21 12l-6.5-2.5z"/></svg>
						Gemini
					</span>
					<span class="agent-pill">
						<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 7h.01"/><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/><path d="m20 7 2 .5-2 .5"/><path d="M10 18v3"/><path d="M14 17.75V21"/><path d="M7 18a6 6 0 0 0 3.84-10.61"/></svg>
						Goose
					</span>
					<span class="agent-pill">
						<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18h8"/><path d="M3 22h18"/><path d="M14 22a7 7 0 1 0 0-14h-1"/><path d="M9 14h2"/><path d="M9 12a2 2 0 0 1 2-2V6l-4-4h3l1 2"/><path d="M4 4h3l1 2"/></svg>
						OpenClaw
					</span>
					<span class="agent-pill">
						<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="20" x="4" y="2" rx="2"/><line x1="8" x2="16" y1="6" y2="6"/><line x1="8" x2="16" y1="14" y2="14"/><line x1="10" x2="10" y1="18" y2="18"/><line x1="14" x2="14" y1="18" y2="18"/></svg>
						Hermes
					</span>
					<span class="agent-pill">
						<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/><path d="M7 12h10"/></svg>
						API
					</span>
				</div>

				<div class="section-eyebrow section-eyebrow-first">How it works</div>
				<div class="feature-list">
					<div class="feature-item">
						<div class="feature-icon">
							<svg class="feature-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
								<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
								<line x1="9" y1="10" x2="15" y2="10"/>
								<line x1="9" y1="14" x2="13" y2="14"/>
							</svg>
						</div>
						<div>
							<p class="feature-title">Schedule from a chat</p>
							<p class="feature-desc">Tell your AI what to watch — a URL, a council, a social profile, a beat. It sets up the scout.</p>
						</div>
					</div>

					<div class="feature-item">
						<div class="feature-icon">
							<svg class="feature-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
								<polyline points="20 6 9 17 4 12"/>
								<path d="M22 12a10 10 0 1 1-5.93-9.14"/>
							</svg>
						</div>
						<div>
							<p class="feature-title">Every story, once</p>
							<p class="feature-desc">When the same news moves across outlets and social, we distill it to the underlying facts and surface each one a single time.</p>
						</div>
					</div>

					<div class="feature-item">
						<div class="feature-icon">
							<svg class="feature-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
								<ellipse cx="12" cy="5" rx="9" ry="3"/>
								<path d="M3 5v14a9 3 0 0 0 18 0V5"/>
								<path d="M3 12a9 3 0 0 0 18 0"/>
							</svg>
						</div>
						<div>
							<p class="feature-title">A newsroom database, not a chat log</p>
							<p class="feature-desc">Your AI queries Scoutpost by place, person, topic, or date — and hands you clean, cite-able units ready to use.</p>
						</div>
					</div>

					<div class="feature-item">
						<div class="feature-icon">
							<svg class="feature-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
								<polyline points="16 3 21 3 21 8"/>
								<line x1="4" y1="20" x2="21" y2="3"/>
								<polyline points="21 16 21 21 16 21"/>
								<line x1="15" y1="15" x2="21" y2="21"/>
								<line x1="4" y1="4" x2="9" y2="9"/>
							</svg>
						</div>
						<div>
							<p class="feature-title">Works with your existing workflow</p>
							<p class="feature-desc">Structured output your AI can turn into a briefing note, a script, or a draft — in whatever format your editor expects.</p>
						</div>
					</div>

					<div class="feature-item">
						<div class="feature-icon">
							<svg class="feature-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
								<circle cx="7.5" cy="15.5" r="5.5"/>
								<path d="M21 2l-9.6 9.6"/>
								<path d="M15.5 7.5l3 3L22 7l-3-3"/>
							</svg>
						</div>
						<div>
							<p class="feature-title">Your data, your keys</p>
							<p class="feature-desc">Open source under the <a href="/faq" class="inline-link">Sustainable Use License</a>. Self-host anywhere. No vendor lock-in. Export anytime.</p>
						</div>
					</div>

					<div class="feature-item">
						<div class="feature-icon">
							<svg class="feature-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
								<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
								<circle cx="9" cy="7" r="4"/>
								<polyline points="17 11 19 13 23 9"/>
							</svg>
						</div>
						<div>
							<p class="feature-title">You're still the editor</p>
							<p class="feature-desc">Your AI flags what it's unsure about. You verify or reject. Nothing reaches print without a human stamp.</p>
						</div>
					</div>
				</div>

				<div class="section-eyebrow section-eyebrow-spaced">What can you track?</div>
				<div class="feature-list" bind:this={featureListEl}>
					<div class="feature-item">
						<div class="feature-icon">
							<svg class="feature-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
								<circle cx="12" cy="12" r="10"/>
								<line x1="22" y1="12" x2="18" y2="12"/>
								<line x1="6" y1="12" x2="2" y2="12"/>
								<line x1="12" y1="6" x2="12" y2="2"/>
								<line x1="12" y1="22" x2="12" y2="18"/>
							</svg>
						</div>
						<div>
							<p class="feature-title">Pages</p>
							<p class="feature-desc">Watch any URL for changes — meeting agendas, press rooms, FOIA portals, filings. Get pinged only when updates match your criteria.</p>
						</div>
					</div>
					<div class="feature-item">
						<div class="feature-icon">
							<svg class="feature-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
								<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
								<circle cx="9" cy="7" r="4"/>
								<path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
								<path d="M16 3.13a4 4 0 0 1 0 7.75"/>
							</svg>
						</div>
						<div>
							<p class="feature-title">Social profiles</p>
							<p class="feature-desc">Track Instagram, X, and Facebook — text and images. Catch deleted posts, flag newsworthy changes, sidestep the algorithmic feed.</p>
						</div>
					</div>
					<div class="feature-item">
						<div class="feature-icon">
							<svg class="feature-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
								<path d="M3 21h18"/>
								<path d="M5 21V7l8-4v18"/>
								<path d="M19 21V11l-6-4"/>
								<path d="M9 9v.01"/>
								<path d="M9 12v.01"/>
								<path d="M9 15v.01"/>
								<path d="M9 18v.01"/>
							</svg>
						</div>
						<div>
							<p class="feature-title">City councils</p>
							<p class="feature-desc">Parse meeting minutes as they drop, extract promises with meeting-date context, and keep a running ledger of what officials said they'd do.</p>
						</div>
					</div>
					<div class="feature-item">
						<div class="feature-icon">
							<svg class="feature-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
								<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/>
								<path d="M4 6h.01"/>
								<path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/>
								<path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/>
								<path d="M12 18h.01"/>
								<path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/>
								<circle cx="12" cy="12" r="2"/>
								<path d="m13.41 10.59 5.66-5.66"/>
							</svg>
						</div>
						<div>
							<p class="feature-title">Your beat</p>
							<p class="feature-desc">Scouts monitor locations, topics, or both — pulling from niche and reliable sources on your schedule. Surface under-reported stories and leads.</p>
						</div>
					</div>
				</div>

				<div class="section-eyebrow section-eyebrow-spaced">More from Buried Signals</div>
				<div class="promo-grid">
					<div class="promo-card">
						<span class="promo-section-label promo-section-label--top">Launching May 2026</span>
						<h3 class="promo-title">Membership</h3>
						<p class="promo-subtitle">Investigations with AI. The tools to run your own.</p>
						<ul class="promo-features">
							<li>Collaborative investigations — shared leads, data, and methodology</li>
							<li>Live bootcamps, workshops, and events</li>
							<li>Hosted Pro tier of the agent extensions — Scoutpost, Navigator, Spotlight, DataHound</li>
							<li>Investigation methodologies and AI techniques, in depth</li>
						</ul>
						<div class="promo-action promo-action--stack">
							{#if !subscribed}
								<form class="promo-signup-form" onsubmit={(e) => { e.preventDefault(); handleSubscribe(); }}>
									<input
										type="email"
										bind:value={subscribeEmail}
										placeholder="you@example.com"
										required
										autocomplete="email"
										disabled={subscribing}
									/>
									<button type="submit" class="promo-btn-primary" disabled={subscribing}>
										{subscribing ? 'Subscribing…' : 'Subscribe'}
									</button>
								</form>
								{#if subscribeError}
									<p class="promo-signup-error">{subscribeError}</p>
								{/if}
								<p class="promo-disclaimer">700+ journalists already reading</p>
							{:else}
								<p class="promo-signup-success">
									<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
										<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" fill="currentColor"/>
									</svg>
									<span>You're in. I'll ping you at launch.</span>
								</p>
								<p class="promo-disclaimer">Joining 700+ journalists already reading.</p>
							{/if}
						</div>
					</div>

					<div class="promo-card">
						<h3 class="promo-title">Consulting</h3>
						<p class="promo-subtitle">I train newsrooms to investigate with AI — workshops, custom tooling, and investigation collaborations.</p>
						<div class="promo-section-label-wrap">
							<span class="promo-section-label">Past clients</span>
						</div>
						<ul class="promo-features">
							<li>Le Temps</li>
							<li>MAZ Journalistenschule</li>
							<li>Republik</li>
							<li>20 Minuten</li>
							<li>MediaStorm</li>
							<li>The New Humanitarian</li>
						</ul>
						<div class="promo-action promo-action--inline">
							<a
								href="mailto:tom@buriedsignals.com?subject=Consulting%20inquiry"
								class="promo-btn-primary"
							>
								Get in touch →
							</a>
							<a
								href="https://buriedsignals.com/consulting"
								target="_blank"
								rel="noopener noreferrer"
								class="promo-link"
							>
								See case studies →
							</a>
						</div>
					</div>
				</div>
			</div>

			<div class="footer-badges-container">
				<div class="footer-group">
					<p class="footer-label">Supported by</p>
					<a href="https://www.imj.ch" target="_blank" rel="noopener noreferrer">
						<img src="/logos/logo_imj_schwarz.svg" alt="IMJ" class="footer-logo footer-logo-imj footer-logo-desaturated" />
					</a>
				</div>
			</div>
		</div>
	</div>
</div>

<style>
	/* ──────────────────────────────────────────────────────────
	   Landing page — plum + ochre on cream (see DESIGN.md)
	   ────────────────────────────────────────────────────────── */

	.login-container {
		min-height: 100vh;
		background: var(--color-bg);
		color: var(--color-ink);
		position: relative;
		overflow-x: hidden;
		font-family: var(--font-body);
	}

	/* Editorial baseline grid — very subtle hairline lattice */
	.grid-pattern {
		position: absolute;
		inset: 0;
		background-image:
			linear-gradient(to right, var(--color-border) 1px, transparent 1px),
			linear-gradient(to bottom, var(--color-border) 1px, transparent 1px);
		background-size: 96px 96px;
		opacity: 0.35;
		z-index: 1;
		pointer-events: none;
		mask-image: linear-gradient(to bottom, black 0%, black 40%, transparent 95%);
		-webkit-mask-image: linear-gradient(to bottom, black 0%, black 40%, transparent 95%);
	}

	.content-wrapper {
		position: relative;
		z-index: 3;
		max-width: 1440px;
		margin: 0 auto;
		padding: 2rem 1.25rem;
		min-height: 100vh;
		display: flex;
		flex-direction: column-reverse;
		gap: 3rem;
		align-items: flex-start;
	}

	@media (min-width: 768px) {
		.content-wrapper {
			padding: 3rem 2rem;
			gap: 4rem;
		}
	}

	@media (min-width: 1024px) {
		.content-wrapper {
			flex-direction: row;
			padding: 4rem 3rem;
			gap: 3rem;
			align-items: flex-start;
			justify-content: center;
		}
	}

	@media (min-width: 1280px) {
		.content-wrapper {
			padding: 5rem 4rem;
			gap: 5rem;
		}
	}

	/* ──────────────────────────────────────────────────────────
	   Auth panel — gradient border shell (hero-tier surface)
	   ────────────────────────────────────────────────────────── */
	.auth-panel-container {
		width: 100%;
		max-width: 420px;
		flex-shrink: 0;
	}

	@media (min-width: 1024px) {
		.auth-panel-container {
			position: fixed;
			left: 5rem;
			top: 50%;
			transform: translateY(-50%);
			width: 420px;
			max-width: calc(50vw - 6rem);
			z-index: 10;
		}
	}

	.auth-panel {
		width: 100%;
		opacity: 0;
		transform: translateY(12px);
		transition: opacity 600ms cubic-bezier(0.4, 0, 0.2, 1), transform 600ms cubic-bezier(0.4, 0, 0.2, 1);
	}

	.auth-panel.mounted {
		opacity: 1;
		transform: translateY(0);
		transition-delay: 150ms;
	}

	/* Gradient border shell — the one "hero edge" treatment on the page */
	.auth-shell {
		display: block;
		padding: 1px;
		background: linear-gradient(
			to bottom right,
			rgba(107, 63, 160, 0.55),
			var(--color-border) 45%,
			transparent 100%
		);
	}

	.auth-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 2.5rem 2rem;
		background: var(--color-surface-alt);
		gap: 1.25rem;
	}

	.auth-logo {
		height: 2rem;
		width: auto;
	}

	.brand-dot {
		width: 10px;
		height: 10px;
		background: var(--color-primary);
	}

	.auth-title {
		font-family: var(--font-display);
		font-size: 1.75rem;
		font-weight: 600;
		color: var(--color-ink);
		margin: 0;
		letter-spacing: -0.01em;
	}

	
	.auth-prompt {
		font-family: var(--font-body);
		font-size: 1rem;
		font-weight: 500;
		color: var(--color-ink);
		margin: 0;
		text-align: center;
		line-height: 1.4;
	}

	

	

	.auth-subtitle {
		color: var(--color-ink-muted);
		font-size: 0.9375rem;
		font-weight: 400;
		margin: 0;
		text-align: center;
	}

	.coming-soon-title {
		font-family: var(--font-display);
		font-size: 1.5rem;
		font-weight: 600;
		color: var(--color-ink);
		margin: 0;
	}

	.coming-soon-text {
		color: var(--color-ink-muted);
		font-size: 0.9375rem;
		line-height: 1.6;
		text-align: center;
		margin: 0;
	}

	.auth-cta-row {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		width: 100%;
		padding-top: 0.25rem;
	}

	.auth-cta-link {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-ink-muted);
		text-decoration: none;
		padding: 0.25rem 0.5rem;
		transition: color 150ms ease;
	}

	.auth-cta-link:hover {
		color: var(--color-primary);
	}

	.auth-cta-sep {
		color: var(--color-border-strong);
		font-size: 0.75rem;
	}

	.auth-oss-badge {
		margin-top: 0.75rem;
		padding-top: 1rem;
		border-top: 1px solid var(--color-border);
		text-align: center;
		width: 100%;
	}

	.auth-oss-text {
		font-size: 0.75rem;
		color: var(--color-ink-subtle);
		margin: 0 0 0.625rem;
		line-height: 1.5;
	}

	.auth-oss-link {
		color: var(--color-ink-muted);
		text-decoration: none;
		font-weight: 500;
	}

	.auth-oss-link:hover {
		color: var(--color-primary);
		text-decoration: underline;
	}

	.auth-github-link {
		display: inline-flex;
		align-items: center;
		padding: 0.375rem 0.75rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-ink-muted);
		text-decoration: none;
		border: 1px solid var(--color-border);
		transition: border-color 150ms ease, color 150ms ease;
	}

	.auth-github-link:hover {
		border-color: var(--color-primary);
		color: var(--color-primary);
	}

	.auth-mode-note {
		margin: 0 0 0.75rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--color-primary-deep);
	}

	.sign-in-button {
		width: 100%;
		background: var(--color-ink);
		color: var(--color-bg);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		padding: 0.875rem 1.5rem;
		border: 1px solid var(--color-ink);
		cursor: pointer;
		transition: background 150ms ease, border-color 150ms ease;
	}

	.sign-in-button:hover:not(:disabled) {
		background: var(--color-primary-deep);
		border-color: var(--color-primary-deep);
	}

	.sign-in-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	

	

	

	.auth-card form {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.auth-input {
		width: 100%;
		padding: 0.75rem 1rem;
		border: 1px solid var(--color-border);
		background: var(--color-bg);
		color: var(--color-ink);
		font-size: 0.9375rem;
		font-family: var(--font-body);
		outline: none;
		transition: border-color 150ms ease, box-shadow 150ms ease;
	}

	.auth-input:focus {
		border-color: var(--color-primary);
		box-shadow: 0 0 0 3px var(--color-primary-soft);
	}

	.auth-input::placeholder {
		color: var(--color-ink-subtle);
	}

	.auth-error {
		width: 100%;
		padding: 0.625rem 0.875rem;
		background: var(--color-surface);
		border: 1px solid var(--color-error);
		border-left-width: 3px;
		color: var(--color-error);
		font-size: 0.8125rem;
		text-align: left;
		margin: 0;
	}

	.auth-toggle {
		background: none;
		border: none;
		color: var(--color-ink-muted);
		font-size: 0.8125rem;
		font-family: var(--font-body);
		cursor: pointer;
		margin-top: 0.25rem;
		padding: 0.25rem 0.5rem;
		transition: color 150ms ease;
	}

	.auth-toggle:hover {
		color: var(--color-primary);
	}

	.terms-footer {
		margin-top: 0.75rem;
		text-align: center;
	}

	.terms-footer a {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 400;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-ink-subtle);
		text-decoration: none;
		transition: color 150ms ease;
	}

	.terms-footer a:hover {
		color: var(--color-primary);
	}

	/* ──────────────────────────────────────────────────────────
	   Story panel
	   ────────────────────────────────────────────────────────── */
	.story-panel {
		flex: 1;
		max-width: 800px;
		color: var(--color-ink);
		opacity: 0;
		transform: translateY(12px);
		transition: opacity 600ms cubic-bezier(0.4, 0, 0.2, 1), transform 600ms cubic-bezier(0.4, 0, 0.2, 1);
	}

	.story-panel.mounted {
		opacity: 1;
		transform: translateY(0);
		transition-delay: 300ms;
	}

	@media (min-width: 1024px) {
		.story-panel {
			margin-left: calc(420px + 3rem);
			padding: 0;
		}
	}

	@media (min-width: 1280px) {
		.story-panel {
			margin-left: calc(420px + 5rem);
		}
	}

	/* Public Beta badge — uppercase mono + plum dot */
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.875rem;
		border: 1px solid var(--color-primary);
		border-radius: 0;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--color-ink);
		margin-bottom: 2rem;
		transition: background 150ms ease;
	}

	.badge:hover {
		background: var(--color-primary-soft);
	}

	.badge-dot {
		width: 6px;
		height: 6px;
		background: var(--color-primary);
		animation: pulse-dot 2s ease-in-out infinite;
	}

	@keyframes pulse-dot {
		0%, 100% { opacity: 1; transform: scale(1); }
		50%      { opacity: 0.5; transform: scale(0.85); }
	}

	.headline-logo {
		display: block;
		height: clamp(2.5rem, 6vw, 4rem);
		width: auto;
		margin-bottom: 1.5rem;
	}

	.tagline {
		font-family: var(--font-display);
		font-size: clamp(1.5rem, 3.4vw, 2.25rem);
		line-height: 1.2;
		font-weight: 600;
		color: var(--color-ink);
		letter-spacing: -0.02em;
		margin-bottom: 1.5rem;
	}

	.highlight-muted {
		position: relative;
		color: var(--color-ink);
		font-style: italic;
		font-weight: 400;
	}
	.highlight-muted::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		top: 58%;
		height: 2px;
		background: var(--color-secondary);
		transform: rotate(-1.5deg);
	}

	.highlight-accent {
		color: var(--color-primary);
		font-weight: 600;
	}

	/* Section eyebrow — the single most repeated structural marker */
	.section-eyebrow {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-secondary);
		margin: 0 0 0.5rem 0;
	}

	.section-eyebrow-spaced { margin-top: 0.75rem; }
	.section-eyebrow-first  { margin-top: 0; }

	.works-with-divider {
		border: 0;
		border-top: 1px solid var(--color-border);
		margin: 0.5rem 0 1rem 0;
		width: 100%;
	}

	.works-with {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-bottom: 2rem;
	}

	.works-with-label {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-ink-muted);
		margin-right: 0.25rem;
	}

	.inline-link {
		color: var(--color-primary);
		text-decoration: none;
		font-weight: 500;
		border-bottom: 1px solid var(--color-primary-soft);
		transition: border-color 150ms ease;
	}

	.inline-link:hover {
		border-bottom-color: var(--color-primary);
	}

	.agent-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.3125rem 0.75rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.06em;
		color: var(--color-ink);
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-pill);
	}

	.agent-pill svg {
		color: var(--color-primary);
		flex-shrink: 0;
	}

	.description-block {
		margin-bottom: 3rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.subheadline {
		font-family: var(--font-body);
		font-size: clamp(1.125rem, 2vw, 1.375rem);
		font-weight: 300;
		line-height: 1.55;
		color: var(--color-ink-muted);
		letter-spacing: 0;
		margin: 0;
	}

	.subheadline .highlight-accent {
		color: var(--color-primary);
		font-weight: 500;
	}

	.built-by-link {
		align-self: flex-start;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		margin-top: 1rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-ink-muted);
		text-decoration: none;
		transition: color 150ms ease;
	}

	.built-by-link strong {
		color: var(--color-ink);
		font-weight: 500;
	}

	.built-by-link:hover,
	.built-by-link:hover strong {
		color: var(--color-primary);
	}

	/* ──────────────────────────────────────────────────────────
	   Feature cards — hairline + cream-alt, ochre icon tile
	   ────────────────────────────────────────────────────────── */
	.feature-list {
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.feature-item {
		display: flex;
		gap: 1rem;
		align-items: flex-start;
		padding: 1.25rem 1.25rem;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-top-width: 0;
		transition: background 150ms ease, border-color 150ms ease;
	}

	.feature-list > .feature-item:first-child {
		border-top-width: 1px;
	}

	.feature-item:hover,
	.feature-item:global(.feature-active) {
		background: var(--color-bg);
		border-color: var(--color-border-strong);
	}

	.feature-icon {
		flex-shrink: 0;
		width: 2.25rem;
		height: 2.25rem;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--color-secondary-soft);
		color: var(--color-secondary);
		border: 1px solid var(--color-secondary);
	}

	.feature-icon-svg {
		width: 1.125rem;
		height: 1.125rem;
	}

	.feature-title {
		font-family: var(--font-body);
		font-weight: 600;
		font-size: 0.9375rem;
		color: var(--color-ink);
		margin: 0 0 0.25rem 0;
		line-height: 1.4;
	}

	.feature-desc {
		color: var(--color-ink-muted);
		line-height: 1.55;
		font-size: 0.875rem;
		font-weight: 300;
		margin: 0;
	}

	/* Mobile scroll reveal (GPU-only) */
	@media (max-width: 1023px) {
		.feature-item {
			transform: scale(0.99);
			opacity: 0.75;
			will-change: transform, opacity;
			transition: transform 300ms cubic-bezier(0.4, 0, 0.2, 1),
						opacity 300ms cubic-bezier(0.4, 0, 0.2, 1),
						background 150ms ease,
						border-color 150ms ease;
		}

		.feature-item:global(.feature-active) {
			transform: scale(1);
			opacity: 1;
		}
	}

	@supports (animation-timeline: view()) and (animation-range: entry 0% cover 50%) {
		@media (max-width: 1023px) {
			.feature-item {
				animation: feature-reveal linear both;
				animation-timeline: view();
				animation-range: entry 10% cover 40%;
			}

			@keyframes feature-reveal {
				from { opacity: 0.75; transform: scale(0.99); }
				to   { opacity: 1; transform: scale(1); }
			}
		}
	}

	/* ──────────────────────────────────────────────────────────
	   Promo cards — Pro Membership + Consulting
	   ────────────────────────────────────────────────────────── */
	.promo-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 1rem;
		margin-top: 0;
	}

	.promo-card {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1.75rem;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		transition: border-color 150ms ease, background 150ms ease;
	}

	.promo-card:hover {
		background: var(--color-bg);
		border-color: var(--color-border-strong);
	}

	/* Shared "eyebrow-within-card" label — used for both "Launching May 2026"
	   (top of Pro card) and "Past clients" (mid-card on Consulting) so the
	   two promo cards read structurally parallel. */
	.promo-section-label-wrap {
		margin-top: 0.25rem;
	}

	.promo-section-label {
		display: inline-block;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-secondary);
	}

	.promo-section-label--top {
		margin-bottom: 0.125rem;
	}

	.promo-title {
		font-family: var(--font-display);
		font-size: 1.5rem;
		font-weight: 600;
		line-height: 1.15;
		color: var(--color-ink);
		letter-spacing: -0.01em;
		margin: 0;
	}

	.promo-subtitle {
		font-size: 0.9375rem;
		font-weight: 400;
		line-height: 1.5;
		color: var(--color-ink-muted);
		margin: 0;
	}

	.promo-features {
		list-style: none;
		padding: 0;
		margin: 0.25rem 0 0 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.promo-features li {
		font-size: 0.875rem;
		font-weight: 300;
		line-height: 1.5;
		color: var(--color-ink-muted);
		padding-left: 1rem;
		position: relative;
	}

	.promo-features li::before {
		content: '';
		position: absolute;
		left: 0;
		top: 0.625rem;
		width: 6px;
		height: 1px;
		background: var(--color-primary);
	}

	/* Shared action row anchor — pins the CTA to the card bottom so the
	   purple buttons align across both cards regardless of content length. */
	.promo-action {
		margin-top: auto;
		padding-top: 1rem;
		display: flex;
	}
	/* Pro Membership card: email input forces a vertical stack. */
	.promo-action--stack {
		flex-direction: column;
		gap: 0.625rem;
		align-items: flex-start;
	}
	/* Consulting card: both CTAs sit on the same row. */
	.promo-action--inline {
		flex-direction: row;
		align-items: center;
		gap: 1.25rem;
		flex-wrap: wrap;
	}

	.promo-signup-form {
		display: flex;
		gap: 0.5rem;
		width: 100%;
	}

	.promo-signup-form input[type='email'] {
		flex: 1;
		height: 2.5rem;
		box-sizing: border-box;
		padding: 0 0.75rem;
		border: 1px solid var(--color-border);
		font-family: var(--font-body);
		font-size: 0.875rem;
		color: var(--color-ink);
		background: var(--color-bg);
		transition: border-color 150ms ease, box-shadow 150ms ease;
	}

	.promo-signup-form input[type='email']:focus {
		outline: none;
		border-color: var(--color-primary);
		box-shadow: 0 0 0 3px var(--color-primary-soft);
	}

	.promo-signup-form input[type='email']:disabled {
		opacity: 0.6;
	}

	.promo-signup-error {
		font-size: 0.8125rem;
		color: var(--color-error);
		margin: 0;
	}

	.promo-signup-success {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-primary);
	}

	.promo-signup-success svg {
		flex-shrink: 0;
	}

	.promo-disclaimer {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.05em;
		color: var(--color-ink-subtle);
		margin: 0;
	}

	/* Shared sharp ink/plum CTA — same height across promo cards (aligns buttons) */
	.promo-btn-primary {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 2.5rem;
		box-sizing: border-box;
		background: var(--color-primary);
		color: var(--color-bg);
		text-decoration: none;
		padding: 0 1.125rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		border: 1px solid var(--color-primary);
		cursor: pointer;
		transition: background 150ms ease, border-color 150ms ease;
		white-space: nowrap;
	}

	.promo-btn-primary:hover:not(:disabled) {
		background: var(--color-primary-deep);
		border-color: var(--color-primary-deep);
	}

	.promo-btn-primary:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.promo-link {
		color: var(--color-ink-muted);
		text-decoration: none;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		border-bottom: 1px solid var(--color-border);
		padding-bottom: 2px;
		transition: color 150ms ease, border-color 150ms ease;
	}

	.promo-link:hover {
		color: var(--color-ink);
		border-bottom-color: var(--color-ink);
	}

	/* ──────────────────────────────────────────────────────────
	   Footer badges
	   ────────────────────────────────────────────────────────── */
	.footer-badges-container {
		display: flex;
		flex-direction: row;
		flex-wrap: wrap;
		justify-content: flex-start;
		gap: 2rem;
		padding-top: 2rem;
		border-top: 1px solid var(--color-border);
	}

	.footer-group {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		align-items: flex-start;
	}

	.footer-label {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-ink-subtle);
		margin: 0;
	}

	.footer-logo {
		height: 2.25rem;
		opacity: 0.55;
		transition: opacity 150ms ease;
	}

	.footer-logo:hover {
		opacity: 0.9;
	}

	.footer-logo-imj {
		height: 2rem;
		margin-top: 2px;
	}

	.footer-logo-desaturated {
		filter: grayscale(1);
	}

	/* ──────────────────────────────────────────────────────────
	   Responsive adjustments
	   ────────────────────────────────────────────────────────── */
	@media (max-width: 640px) {
		.footer-badges-container {
			flex-direction: column;
			align-items: flex-start;
			gap: 1.25rem;
		}

		.headline-logo {
			height: 2.25rem;
		}

		.tagline {
			font-size: 1.5rem;
		}

		.subheadline {
			font-size: 1.0625rem;
		}

		.feature-item {
			padding: 1rem;
		}

		.promo-card {
			padding: 1.25rem;
		}
	}

	@media (max-width: 375px) {
		.content-wrapper {
			padding: 2rem 1rem;
		}

		.badge {
			font-size: 0.625rem;
			padding: 0.375rem 0.75rem;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.badge-dot {
			animation: none;
		}
		.feature-item {
			transition: none;
			will-change: auto;
			opacity: 1;
			transform: none;
		}
		.auth-panel, .story-panel {
			opacity: 1;
			transform: none;
			transition: none;
		}
	}
</style>
