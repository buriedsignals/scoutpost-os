<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { auth } from '$lib/stores/auth';
	import { IS_LOCAL_DEMO_MODE } from '$lib/demo/state';
	import { onMount } from 'svelte';
	import { consumeAuthReturn } from '$lib/utils/auth-return';
	import NightWatchScene, { type SceneRect } from '$lib/components/login/NightWatchScene.svelte';
	import * as m from '$lib/paraglide/messages';

	let mounted = false;
	let featureListEl: HTMLElement;
	let heroCopyEl: HTMLElement;
	let authPanelEl: HTMLElement;
	let signal = 0;
	let postLoginNavigationStarted = false;
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
	let showIndicatorLoginHelp = false;

	async function navigateAfterLogin() {
		if (postLoginNavigationStarted) return;
		postLoginNavigationStarted = true;
		await goto(consumeAuthReturn());
	}

	type NewsletterId = 'buried_signals' | 'indicator_media';

	const newsletterLabels: Record<NewsletterId, string> = {
		buried_signals: 'Buried Signals',
		indicator_media: 'Indicator Briefing'
	};

	// Shared Buried Signals + Indicator newsletter signup (Indicator Lab card)
	let subscribeEmail = '';
	let selectedNewsletters: NewsletterId[] = ['buried_signals', 'indicator_media'];
	let subscribing = false;
	let subscribed = false;
	let subscribedMessage = m.login_subscribed();
	let subscribeError = '';

	function toggleNewsletter(newsletter: NewsletterId) {
		const selected = selectedNewsletters.includes(newsletter);
		if (selected && selectedNewsletters.length === 1) return;

		selectedNewsletters = selected
			? selectedNewsletters.filter((item) => item !== newsletter)
			: [...selectedNewsletters, newsletter];
	}

	async function handleSubscribe() {
		const value = subscribeEmail.trim();
		const newsletters = [...selectedNewsletters];
		if (!value || newsletters.length === 0) return;
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
				body: JSON.stringify({ email: value, newsletters })
			});
			const data = await res.json().catch(() => ({}));
			if (res.ok) {
				const completed: NewsletterId[] = Array.isArray(data.subscribed)
					? (data.subscribed as unknown[]).filter((item: unknown): item is NewsletterId =>
						item === 'buried_signals' || item === 'indicator_media'
					)
					: newsletters;
				const firstCompleted = completed[0] ?? newsletters[0] ?? 'buried_signals';
				subscribedMessage = completed.length === 2
					? m.login_subscribedBoth()
					: m.login_subscribedTo({ newsletter: newsletterLabels[firstCompleted] });
				subscribed = true;
			} else {
				subscribeError = data.error || data.detail || m.login_retryError();
			}
		} catch {
			subscribeError = m.login_retryError();
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
					await navigateAfterLogin();
				} else {
					authError = m.login_confirmEmail();
				}
			} else {
				const { error } = await supabase.auth.signInWithPassword({ email, password });
				if (error) throw error;
				await navigateAfterLogin();
			}
		} catch (e: any) {
			authError = e.message || m.auth_loginFailed();
		} finally {
			authLoading = false;
		}
	}

	// The scope may roam above the hero caption and left of a side-docked auth card.
	function sceneFreeRect(): SceneRect | null {
		if (!heroCopyEl) return null;
		const vw = window.innerWidth;
		const heroTop = heroCopyEl.getBoundingClientRect().top + window.scrollY;
		const auth = authPanelEl?.getBoundingClientRect();
		const authBeside = vw >= 1024 && auth && auth.left > vw / 2;
		return {
			left: 0,
			top: 0,
			right: authBeside ? auth.left - 24 : vw,
			bottom: Math.min(heroTop - 24, window.innerHeight)
		};
	}

	$: notAvailable = $page.url.searchParams.get('error') === 'not_available';

	onMount(() => {
		mounted = true;

		const unsubscribe = auth.subscribe(async (state) => {
			if (state.authenticated) {
				await navigateAfterLogin();
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

{#snippet authMark()}
	<svg class="auth-mark" viewBox="0 0 100 100" aria-hidden="true">
		{#key signal}
			{#if signal > 0}<circle class="auth-mark-ping" cx="74" cy="26" r="5" />{/if}
		{/key}
		<circle class="auth-mark-ring" cx="42" cy="58" r="30" pathLength="100" />
		<line class="auth-mark-line" x1="42" y1="58" x2="74" y2="26" />
		<circle class="auth-mark-hub" cx="42" cy="58" r="3.5" />
		<circle class="auth-mark-point" cx="74" cy="26" r="5" />
	</svg>
{/snippet}

<div class="login-container">
	<NightWatchScene freeRect={sceneFreeRect} onsignal={() => (signal += 1)} />

	<div class="content-wrapper">
		<!-- Hero caption, anchored to the bottom of the first screen like the teaser's captions -->
		<header class="hero" class:mounted>
			<div class="hero-copy" bind:this={heroCopyEl}>
				<img src="/logo-scoutpost.svg" alt="Scoutpost" class="headline-logo" />

				<p class="tagline">
					{m.login_monitor()} <span class="highlight-muted">{m.login_sourcesMatter()}</span>
					{m.common_and()} <span class="highlight-accent">{m.login_surfaceLeads()}</span>.
				</p>

				<h2 class="subheadline">
					{m.login_connectDescription()} <span class="highlight-accent">{m.login_focusReporting()}</span>.
				</h2>
			</div>
		</header>

		<!-- Auth panel - docked right on desktop, after the hero on mobile -->
		<div class="auth-panel-container" bind:this={authPanelEl}>
			<div class="auth-panel" class:mounted>
				<div class="auth-shell">
					<div class="auth-card">
						{#if notAvailable}
							<img src="/logo-scoutpost.svg" alt="Scoutpost" class="auth-logo" />
							<p class="coming-soon-title">{m.login_accessUnavailable()}</p>
							<p class="coming-soon-text">
								{m.login_limitedAccess()}
							</p>
						{:else}
							{#if showSupabaseAuth()}
								{@render authMark()}
								<p class="auth-title">{isSignup ? m.login_createAccount() : m.login_welcomeBack()}</p>
								<p class="auth-subtitle">
									{#if IS_LOCAL_DEMO_MODE}
										{isSignup ? m.login_createDemo() : m.login_signInDemo()}
									{:else}
										{isSignup ? m.login_setupAdmin() : m.login_signInAccount()}
									{/if}
								</p>
								{#if selfHostLoginNote}
									<p class="auth-mode-note">{selfHostLoginNote}</p>
								{:else if IS_LOCAL_DEMO_MODE}
									<p class="auth-mode-note">{m.login_demoNote()}</p>
								{/if}

								{#if authError}
									<p class="auth-error">{authError}</p>
								{/if}

								<form onsubmit={(e) => { e.preventDefault(); handleSupabaseAuth(); }}>
									<input type="email" bind:value={email} placeholder={m.login_email()} required class="auth-input" />
									<input type="password" bind:value={password} placeholder={m.login_password()} required minlength="6" class="auth-input" />
									<button type="submit" class="sign-in-button" disabled={authLoading}>
										{authLoading ? m.login_pleaseWait() : isSignup ? m.login_createAccount() : m.login_signIn()}
									</button>
								</form>

								<button class="auth-toggle" onclick={() => { isSignup = !isSignup; authError = ''; }}>
									{isSignup ? m.login_existingAccount() : m.login_newAccount()}
								</button>

								<div class="auth-cta-row">
									
									<span class="auth-cta-sep">·</span>
									<a href="/docs" class="auth-cta-link">{m.login_seeDocs()}</a>
									<span class="auth-cta-sep">·</span>
									<a href="/skills" class="auth-cta-link">{m.login_seeSkills()}</a>
								</div>
							{:else}
								{@render authMark()}
								<p class="auth-prompt">{m.login_signIn()}</p>
								<button class="sign-in-button" onclick={() => auth.login()}>
									{m.login_signIn()}
								</button>
								<div class="auth-account-options">
								</div>
								<div class="auth-cta-row">
									
									<span class="auth-cta-sep">·</span>
									<a href="/docs" class="auth-cta-link">{m.login_seeDocs()}</a>
									<span class="auth-cta-sep">·</span>
									<a href="/skills" class="auth-cta-link">{m.login_seeSkills()}</a>
								</div>
							{/if}


							<div class="auth-oss-badge">
								<p class="auth-oss-text">
									{m.login_openSource()}
									<a href="/faq" class="auth-oss-link">AGPL-3.0</a>
								</p>
								<a href="https://github.com/buriedsignals/scoutpost-os" target="_blank" rel="noopener noreferrer" class="auth-github-link">
									<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align: -2px; margin-right: 4px;"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
									{m.pricing_viewGithub()}
								</a>
							</div>
							<div class="terms-footer">
								<a href="/terms">{m.login_termsPrivacy()}</a>
							</div>
						{/if}
					</div>
				</div>
			</div>
		</div>

		<!-- Story / marketing panel -->
		<div class="story-panel" class:mounted>
			<div class="description-block">
				<div class="credits-row">
					<a
						href="https://buriedsignals.com"
						target="_blank"
						rel="noopener noreferrer"
						class="built-by-link"
					>
						{m.login_builtBy()} <strong>Buried Signals</strong> ↗
					</a>
					<a
						href="https://www.imj.ch"
						target="_blank"
						rel="noopener noreferrer"
						class="supported-by-link"
					>
						<span>{m.login_supportedBy()}</span>
						<img src="/logos/logo_imj_schwarz.svg" alt="IMJ" class="supported-by-logo" />
					</a>
				</div>

				<hr class="works-with-divider" />
				<div class="works-with">
					<span class="works-with-label">{m.login_worksWith()}</span>
					<!-- Marketing surface names; setup recipes retain client-specific labels. -->
					<span class="agent-pill">
						<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
						Claude Code
					</span>
					<span class="agent-pill">
						<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .962L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>
						Claude Desktop
					</span>
					<span class="agent-pill">
						<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
						ChatGPT Desktop
					</span>
					<span class="agent-pill">
						<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/><circle cx="18" cy="7" r="3"/></svg>
						OpenCode
					</span>
					<span class="agent-pill">
						<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3L9.5 9.5 3 12l6.5 2.5L12 21l2.5-6.5L21 12l-6.5-2.5z"/></svg>
						Antigravity
					</span>
					<span class="agent-pill">
						<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 7h.01"/><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/><path d="m20 7 2 .5-2 .5"/><path d="M10 18v3"/><path d="M14 17.75V21"/><path d="M7 18a6 6 0 0 0 3.84-10.61"/></svg>
						Goose
					</span>
					<span class="agent-pill">
						<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/><path d="M7 12h10"/></svg>
						API
					</span>
				</div>

				<section class="demo-section" aria-labelledby="product-demo-heading">
					<p id="product-demo-heading" class="section-eyebrow">{m.login_seeAction()}</p>
					<!-- YouTube requires a 200px-tall player; 16:9 falls below that on common iPhone widths. -->
					<div class="demo-video-frame" style="min-height: 200px">
						<iframe
							src="https://www.youtube-nocookie.com/embed/SzRd9R4_fs8?rel=0"
							title={m.login_productDemo()}
							loading="lazy"
							referrerpolicy="strict-origin-when-cross-origin"
							allow="encrypted-media; picture-in-picture"
							allowfullscreen
						></iframe>
					</div>
				</section>

				<div class="section-eyebrow section-eyebrow-first">{m.login_howWorks()}</div>
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
							<p class="feature-title">{m.login_createScouts()}</p>
							<p class="feature-desc">{m.login_createScoutsDescription()}</p>
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
							<p class="feature-title">{m.login_linkedFindings()}</p>
							<p class="feature-desc">{m.login_linkedFindingsDescription()}</p>
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
							<p class="feature-title">{m.login_editorialInbox()}</p>
							<p class="feature-desc">{m.login_editorialInboxDescription()}</p>
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
							<p class="feature-title">{m.login_workflow()}</p>
							<p class="feature-desc">{m.login_workflowDescription()}</p>
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
							<p class="feature-title">{m.login_preserveEvidence()}</p>
							<p class="feature-desc">{m.login_preserveEvidenceDescription()}</p>
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
							<p class="feature-title">{m.login_humanVerification()}</p>
							<p class="feature-desc">{m.login_humanVerificationDescription()}</p>
						</div>
					</div>
				</div>

				<div class="section-eyebrow section-eyebrow-spaced">{m.login_whatTrack()}</div>
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
							<p class="feature-title">{m.login_pages()}</p>
							<p class="feature-desc">{m.login_pagesDescription()}</p>
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
							<p class="feature-title">{m.login_socialProfiles()}</p>
							<p class="feature-desc">{m.login_socialProfilesDescription()}</p>
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
							<p class="feature-title">{m.login_councils()}</p>
							<p class="feature-desc">{m.login_councilsDescription()}</p>
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
							<p class="feature-title">{m.login_yourBeat()}</p>
							<p class="feature-desc">{m.login_yourBeatDescription()}</p>
						</div>
					</div>
					<div class="feature-item">
						<div class="feature-icon">
							<svg class="feature-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
								<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>
							</svg>
						</div>
						<div>
							<p class="feature-title">{m.login_fleets()}</p>
							<p class="feature-desc">{m.login_fleetsDescription()}</p>
						</div>
					</div>
				</div>

				<div class="section-eyebrow section-eyebrow-spaced">{m.login_moreTools()}</div>
				<div class="promo-grid">
					<div class="promo-card">
						<div class="promo-kicker">
							<span>Indicator Lab</span>
							<span class="promo-launch">{m.login_launchDate()}</span>
						</div>
						<h3 class="promo-title">{m.login_labTitle()}</h3>
						<p class="promo-subtitle">{m.login_labDescription()}</p>
						<a class="indicator-lab-link" href="https://buriedsignals.com/join">{m.login_exploreLab()} <span aria-hidden="true">→</span></a>

						<div class="promo-newsletter-block">
							{#if subscribeError}
								<p class="promo-signup-error" role="alert">{subscribeError}</p>
							{/if}
							{#if !subscribed}
								<p class="promo-newsletter-heading">{m.login_newsletters()}</p>
								<div class="promo-newsletter-options" aria-label={m.login_newsletterChoices()}>
									<button
										type="button"
										class="promo-newsletter-toggle"
										class:promo-newsletter-toggle--selected={selectedNewsletters.includes('buried_signals')}
										aria-pressed={selectedNewsletters.includes('buried_signals')}
										onclick={() => toggleNewsletter('buried_signals')}
									>
										<span class="promo-newsletter-check" aria-hidden="true">{selectedNewsletters.includes('buried_signals') ? '✓' : ''}</span>
										<span class="promo-newsletter-copy">
											<span class="promo-newsletter-title">Buried Signals</span>
											<span class="promo-newsletter-description">{m.login_buriedNewsletter()}</span>
										</span>
									</button>
									<button
										type="button"
										class="promo-newsletter-toggle"
										class:promo-newsletter-toggle--selected={selectedNewsletters.includes('indicator_media')}
										aria-pressed={selectedNewsletters.includes('indicator_media')}
										onclick={() => toggleNewsletter('indicator_media')}
									>
										<span class="promo-newsletter-check" aria-hidden="true">{selectedNewsletters.includes('indicator_media') ? '✓' : ''}</span>
										<span class="promo-newsletter-copy">
											<span class="promo-newsletter-title">Indicator Briefing</span>
											<span class="promo-newsletter-description">{m.login_indicatorNewsletter()}</span>
										</span>
									</button>
								</div>
								<p class="promo-disclaimer">{m.login_readers()}</p>
								<form class="promo-signup-form" onsubmit={(e) => { e.preventDefault(); handleSubscribe(); }}>
									<input
										type="email"
										bind:value={subscribeEmail}
										placeholder={m.login_emailExample()}
										required
										autocomplete="email"
										disabled={subscribing}
									/>
									<button type="submit" class="promo-btn-primary" disabled={subscribing}>
										{subscribing ? m.login_subscribing() : m.login_subscribe()}
									</button>
								</form>
							{:else}
								<p class="promo-signup-success">
									<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
										<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" fill="currentColor"/>
									</svg>
									<span>{subscribedMessage}</span>
								</p>
							{/if}
						</div>
					</div>

					<div class="promo-card">
						<div class="promo-kicker">
							<span>{m.login_hireMe()}</span>
						</div>
						<h3 class="promo-title">{m.login_trainingTitle()}</h3>
						<p class="promo-subtitle">{m.login_trainingDescription()}</p>
						<div class="promo-section-label-wrap">
							<span class="promo-section-label">{m.login_pastClients()}</span>
						</div>
						<ul class="promo-features">
							<li>Le Temps</li>
							<li>Al Jazeera</li>
							<li>MAZ Journalistenschule</li>
							<li>Republik</li>
							<li>20 Minuten</li>
							<li>SRF</li>
							<li>MediaStorm</li>
							<li>The New Humanitarian</li>
						</ul>
						<div class="promo-action promo-action--inline">
							<a
								href="mailto:tom@buriedsignals.com?subject=Consulting%20inquiry"
								class="promo-btn-primary"
							>
								{m.login_contact()}
							</a>
							<a
								href="https://buriedsignals.com/consulting"
								target="_blank"
								rel="noopener noreferrer"
								class="promo-link"
							>
								{m.login_caseStudies()}
							</a>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</div>

<style>
	/* Night Watch landing surface: a surveillance scene behind a caption-style hero,
	   with the auth card docked as dark glass. Copy is unchanged. */

	.login-container {
		--edge: clamp(1.25rem, 5vw, 5rem);
		--auth-w: 400px;
		--glass: oklch(0.2 0.009 215 / 0.68);
		--glass-line: oklch(0.84 0.03 205 / 0.16);
		--scope-teal: oklch(0.71 0.045 200);
		--caption-muted: oklch(0.94 0.008 200 / 0.58);

		min-height: 100vh;
		background: oklch(0.17 0.008 220);
		color: var(--color-ink);
		position: relative;
		overflow-x: hidden;
		font-family: var(--font-body);
	}

	.content-wrapper {
		position: relative;
		z-index: 3;
		padding: 0 var(--edge) 2.5rem;
		display: flex;
		flex-direction: column;
		gap: 2.5rem;
	}

	.hero {
		min-height: 78svh;
		display: flex;
		align-items: flex-end;
		padding-top: 2rem;
	}

	.hero-copy {
		max-width: 46rem;
	}

	@media (min-width: 1024px) {
		.content-wrapper {
			padding: 0 calc(var(--auth-w) + var(--edge) * 2) 5rem var(--edge);
			gap: 0;
		}

		.hero {
			/* Ends well above the fold so the credits and Works With row sit on the
			   first screen; the subtracted height keeps the logo where it was. */
			min-height: calc(100svh - 7rem - clamp(2.5rem, 6vh, 4.5rem));
			padding-bottom: 1.5rem;
		}
	}

	/* Auth panel */
	.auth-panel-container {
		width: 100%;
		max-width: 420px;
		flex-shrink: 0;
	}

	@media (min-width: 1024px) {
		.auth-panel-container {
			position: fixed;
			right: var(--edge);
			top: 50%;
			transform: translateY(-50%);
			width: var(--auth-w);
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

	.auth-shell {
		position: relative;
		display: block;
		border-radius: var(--radius-xl);
		box-shadow: 0 40px 90px -30px oklch(0.05 0.01 220 / 0.85);
	}

	/* Viewfinder brackets around the card. */
	.auth-shell::before {
		content: '';
		position: absolute;
		inset: -9px;
		pointer-events: none;
		--c: var(--scope-teal);
		background:
			linear-gradient(var(--c), var(--c)) top left / 16px 1px,
			linear-gradient(var(--c), var(--c)) top left / 1px 16px,
			linear-gradient(var(--c), var(--c)) top right / 16px 1px,
			linear-gradient(var(--c), var(--c)) top right / 1px 16px,
			linear-gradient(var(--c), var(--c)) bottom left / 16px 1px,
			linear-gradient(var(--c), var(--c)) bottom left / 1px 16px,
			linear-gradient(var(--c), var(--c)) bottom right / 16px 1px,
			linear-gradient(var(--c), var(--c)) bottom right / 1px 16px;
		background-repeat: no-repeat;
		opacity: 0;
		transform: scale(1.04);
		transition: opacity 700ms ease, transform 900ms cubic-bezier(0.2, 0.7, 0.2, 1);
	}

	.auth-panel.mounted .auth-shell::before {
		opacity: 0.75;
		transform: scale(1);
		transition-delay: 500ms;
	}

	.auth-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 2.5rem 2rem;
		background: var(--glass);
		-webkit-backdrop-filter: blur(20px) saturate(1.15);
		backdrop-filter: blur(20px) saturate(1.15);
		border: 1px solid var(--glass-line);
		gap: 1.25rem;
		border-radius: var(--radius-xl);
	}

	.auth-logo {
		height: 2rem;
		width: auto;
	}

	/* The Scoutpost mark; its point pings whenever the scene's scope finds a signal. */
	.auth-mark {
		width: 2.75rem;
		height: 2.75rem;
		overflow: visible;
	}

	.auth-mark-ring {
		fill: none;
		stroke: var(--scope-teal);
		stroke-width: 6.5;
		stroke-dasharray: 100;
		stroke-dashoffset: 100;
		transform: rotate(-45deg);
		transform-origin: 42px 58px;
	}

	.auth-mark-line {
		stroke: var(--color-primary);
		stroke-width: 3.5;
		stroke-linecap: round;
		stroke-dasharray: 46;
		stroke-dashoffset: 46;
	}

	.auth-mark-hub {
		fill: var(--scope-teal);
	}

	.auth-mark-point {
		fill: var(--color-primary);
		opacity: 0;
	}

	.auth-panel.mounted .auth-mark-ring {
		animation: mark-draw 900ms cubic-bezier(0.3, 0.7, 0.2, 1) 350ms forwards;
	}

	.auth-panel.mounted .auth-mark-line {
		animation: mark-draw 380ms ease-out 1150ms forwards;
	}

	.auth-panel.mounted .auth-mark-point {
		animation: mark-point 200ms ease-out 1500ms forwards;
	}

	.auth-mark-ping {
		fill: none;
		stroke: var(--color-primary);
		stroke-width: 2.5;
		transform-box: fill-box;
		transform-origin: center;
		animation: mark-ping 900ms cubic-bezier(0.2, 0.7, 0.3, 1) forwards;
	}

	@keyframes mark-draw {
		to { stroke-dashoffset: 0; }
	}

	@keyframes mark-point {
		to { opacity: 1; }
	}

	@keyframes mark-ping {
		from { transform: scale(1); opacity: 0.9; }
		to { transform: scale(5); opacity: 0; }
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

	

	.auth-account-options {
		margin-top: 0.875rem;
		text-align: center;
	}

	.auth-account-options .auth-signup-link,
	.indicator-login-help-toggle {
		white-space: nowrap;
	}

	.auth-account-options 

	.indicator-login-help-toggle {
		height: auto;
		min-height: 0;
		border: 1px dashed var(--color-ink-muted);
		padding: 0.25rem 0.375rem;
		background: var(--color-paper);
		color: var(--color-ink);
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		line-height: 1;
		text-transform: uppercase;
		cursor: pointer;
	}

	.indicator-login-help-toggle:hover,
	.indicator-login-help-toggle:focus-visible {
		border-color: var(--color-primary);
		color: var(--color-primary);
		outline-offset: 0.25rem;
	}

	.indicator-login-help-copy {
		max-width: 21rem;
		margin: 0.5rem auto 0;
		color: var(--color-ink-muted);
		font-size: 0.75rem;
		line-height: 1.45;
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
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: 0.25rem 0.5rem;
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
		white-space: nowrap;
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
		border-radius: var(--radius-md);
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

	.hero .hero-copy > * {
		opacity: 0;
		transform: translateY(18px);
		transition: opacity 900ms cubic-bezier(0.2, 0.7, 0.2, 1), transform 900ms cubic-bezier(0.2, 0.7, 0.2, 1);
	}

	.hero.mounted .hero-copy > * {
		opacity: 1;
		transform: none;
	}

	.hero.mounted .hero-copy > :nth-child(1) { transition-delay: 250ms; }
	.hero.mounted .hero-copy > :nth-child(2) { transition-delay: 420ms; }
	.hero.mounted .hero-copy > :nth-child(3) { transition-delay: 600ms; }

	.headline-logo {
		display: block;
		height: clamp(2.25rem, 4.5vw, 3.25rem);
		width: auto;
		margin: 0 0 1.75rem -0.35rem;
	}

	/* Caption treatment from the teaser: muted frost with bright key phrases. */
	.tagline {
		font-family: var(--font-display);
		font-size: clamp(2rem, 4.4vw, 3.6rem);
		line-height: 1.06;
		font-weight: 700;
		color: var(--caption-muted);
		letter-spacing: -0.03em;
		margin: 0 0 1.5rem;
		text-wrap: balance;
	}

	.highlight-muted {
		color: var(--color-ink);
	}

	.highlight-accent {
		color: var(--color-primary);
		font-weight: 700;
	}

	/* Section eyebrow — the single most repeated structural marker */
	.section-eyebrow {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-primary);
		margin: 0 0 0.5rem 0;
	}

	.section-eyebrow-spaced { margin-top: 0.75rem; }
	.section-eyebrow-first  { margin-top: 0; }

	.works-with-divider {
		border: 0;
		border-top: 1px solid var(--color-border);
		margin: 0;
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

	.demo-section {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.demo-section .section-eyebrow {
		margin-bottom: 0;
	}

	.demo-video-frame {
		aspect-ratio: 16 / 9;
		width: 100%;
		overflow: hidden;
		background: var(--color-ink);
		border: 1px solid var(--color-border-strong);
	}

	.demo-video-frame iframe {
		display: block;
		width: 100%;
		height: 100%;
		border: 0;
	}

	.description-block {
		margin-bottom: 3rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.subheadline {
		font-family: var(--font-body);
		font-size: clamp(1.0625rem, 1.6vw, 1.25rem);
		font-weight: 500;
		line-height: 1.55;
		color: var(--caption-muted);
		letter-spacing: 0;
		margin: 0;
		max-width: 38rem;
		text-wrap: pretty;
	}

	.subheadline .highlight-accent {
		color: var(--color-primary);
		font-weight: 500;
	}

	.credits-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem 2rem;
	}

	.supported-by-link {
		display: inline-flex;
		align-items: center;
		gap: 0.625rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-ink-muted);
		text-decoration: none;
		transition: color 150ms ease;
	}

	.supported-by-logo {
		height: 1.5rem;
		width: auto;
		filter: grayscale(1) invert(1);
		opacity: 0.8;
		transition: opacity 150ms ease;
	}

	.supported-by-link:hover {
		color: var(--color-primary);
	}

	.supported-by-link:hover .supported-by-logo {
		opacity: 1;
	}

	.built-by-link {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		margin-top: 0;
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

	/* Feature cards */
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
		background: oklch(0.24 0.011 215 / 0.82);
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
		background: oklch(0.37 0.026 205);
		color: oklch(0.88 0.028 202);
		border: 1px solid oklch(0.68 0.05 202 / 48%);
		transition:
			background-color 150ms ease,
			border-color 150ms ease,
			color 150ms ease;
	}

	.feature-item:hover .feature-icon,
	.feature-item:global(.feature-active) .feature-icon {
		background: oklch(0.41 0.032 203);
		color: oklch(0.95 0.015 202);
		border-color: oklch(0.74 0.05 202 / 60%);
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
		font-weight: 500;
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
	   Promo cards — Indicator Lab + Consulting
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
		background: oklch(0.24 0.011 215 / 0.82);
		border: 1px solid var(--color-border);
	}

	.promo-kicker {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-primary);
	}

	.promo-launch {
		font-weight: 500;
		color: var(--color-ink-subtle);
		text-align: right;
	}

	/* Supporting eyebrow label within the Consulting card. */
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
		color: var(--color-primary);
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

	.indicator-lab-link {
		display: inline-flex;
		align-items: center;
		align-self: flex-start;
		gap: 0.5rem;
		padding-bottom: 2px;
		border-bottom: 1px solid var(--color-border);
		color: var(--color-ink-muted);
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-decoration: none;
		text-transform: uppercase;
		transition: border-color 150ms ease, color 150ms ease;
	}

	.indicator-lab-link:hover {
		border-color: var(--color-secondary);
		color: var(--color-secondary);
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
		font-weight: 500;
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

	.promo-newsletter-block {
		display: grid;
		gap: 0.75rem;
		margin-top: auto;
		padding-top: 1.25rem;
		border-top: 1px solid var(--color-border);
	}

	.promo-newsletter-heading {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-ink-subtle);
	}

	.promo-newsletter-options {
		display: grid;
		gap: 0.5rem;
	}

	.promo-newsletter-toggle {
		display: grid;
		grid-template-columns: 16px minmax(0, 1fr);
		align-items: start;
		gap: 0.625rem;
		width: 100%;
		padding: 0.75rem;
		border: 1px solid var(--color-border);
		background: transparent;
		color: var(--color-ink-muted);
		cursor: pointer;
		text-align: left;
		transition: border-color 150ms ease, background 150ms ease, color 150ms ease;
	}

	.promo-newsletter-toggle--selected {
		border-color: color-mix(in oklab, var(--color-primary) 58%, var(--color-border));
		background: color-mix(in srgb, var(--color-primary) 7%, transparent);
		color: var(--color-primary);
	}

	.promo-newsletter-toggle:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}

	.promo-newsletter-check {
		display: inline-grid;
		width: 13px;
		height: 13px;
		place-items: center;
		border: 1px solid currentColor;
		font-size: 9px;
		line-height: 1;
	}

	.promo-newsletter-toggle--selected .promo-newsletter-check {
		border-color: var(--color-primary);
		background: var(--color-primary);
		color: var(--color-bg);
	}

	.promo-newsletter-copy {
		display: grid;
		gap: 0.25rem;
	}

	.promo-newsletter-title {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-ink);
	}

	.promo-newsletter-description {
		font-size: 0.8125rem;
		font-weight: 300;
		line-height: 1.45;
		color: var(--color-ink-muted);
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

	/* Shared CTA — same height across promo cards (aligns buttons) */
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
		transition: background 150ms ease, border-color 150ms ease, color 150ms ease,
			transform 150ms ease, box-shadow 150ms ease;
		white-space: nowrap;
	}

	.promo-btn-primary:hover:not(:disabled) {
		background: var(--color-primary-deep);
		border-color: var(--color-primary-deep);
		transform: translateY(-1px);
		box-shadow: 0 6px 18px color-mix(in oklab, var(--color-primary) 24%, transparent);
	}

	.promo-btn-primary:focus-visible {
		outline: 2px solid var(--color-primary-deep);
		outline-offset: 3px;
	}

	.promo-btn-primary:active:not(:disabled) {
		transform: translateY(0);
		box-shadow: none;
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
		transition: color 150ms ease;
	}

	.promo-link:hover {
		color: var(--color-primary);
	}

	.feature-icon,
	.auth-input,
	.auth-cta-link,
	.promo-signup-form input[type='email'],
	.promo-btn-primary {
		border-radius: var(--radius-md);
	}

	.feature-list > .feature-item:first-child {
		border-radius: var(--radius-lg) var(--radius-lg) 0 0;
	}

	.feature-list > .feature-item:last-child {
		border-radius: 0 0 var(--radius-lg) var(--radius-lg);
	}

	.promo-card {
		border-radius: var(--radius-lg);
	}

	/* ──────────────────────────────────────────────────────────
	   Responsive adjustments
	   ────────────────────────────────────────────────────────── */
	@media (max-width: 640px) {
		.headline-logo {
			height: 2.25rem;
		}

		.tagline {
			font-size: 2rem;
		}

		.feature-item {
			padding: 1rem;
		}

		.promo-card {
			padding: 1.25rem;
		}

		.auth-card {
			padding: 2rem 1.25rem;
		}

		.auth-cta-link {
			padding: 0.25rem 0.25rem;
			letter-spacing: 0.07em;
		}
	}

	@media (max-width: 375px) {
		.content-wrapper {
			padding: 0 1rem 2rem;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.feature-item {
			transition: none;
			will-change: auto;
			opacity: 1;
			transform: none;
		}
		.auth-panel, .story-panel, .hero .hero-copy > * {
			opacity: 1;
			transform: none;
			transition: none;
		}
		.auth-mark-ring, .auth-mark-line {
			stroke-dashoffset: 0;
			animation: none !important;
		}
		.auth-mark-point {
			opacity: 1;
			animation: none !important;
		}
		.auth-mark-ping {
			display: none;
		}
	}
</style>
