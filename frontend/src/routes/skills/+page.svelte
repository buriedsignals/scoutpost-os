<script lang="ts">
	import { ArrowLeft, Bot, FileText, Terminal, Wrench } from 'lucide-svelte';
	import SharpAction from '$lib/components/docs/SharpAction.svelte';
	import SharpPanel from '$lib/components/docs/SharpPanel.svelte';

	const skills = [
		{
			title: 'Product skill',
			href: '/skills/scoutpost.md',
			icon: Bot,
			description:
				'Use this when an AI assistant should operate Scoutpost through MCP, CLI, or REST: create scouts, run monitors, search units, and respect editorial verification.'
		},
		{
			title: 'Setup skill',
			href: '/skills/scoutpost-setup.md',
			icon: Wrench,
			description:
				'Use this when an AI assistant should deploy or self-host Scoutpost on newsroom infrastructure.'
		}
	];
</script>

<svelte:head>
	<title>Skills — Scoutpost</title>
	<meta
		name="description"
		content="Public Scoutpost skill files for AI agents: product operation, MCP and CLI usage, and self-hosted setup."
	/>
	<link rel="alternate" type="text/plain" title="skills.txt" href="/skills.txt" />
	<link rel="alternate" type="text/markdown" title="Scoutpost skill" href="/skills/scoutpost.md" />
	<link rel="alternate" type="text/markdown" title="Scoutpost setup skill" href="/skills/scoutpost-setup.md" />
</svelte:head>

<div class="skills-page">
	<div class="bg-pattern"></div>

	<main class="content">
		<SharpAction href="/login" variant="ghost" size="sm" className="back-link">
			<ArrowLeft size={14} />
			<span>Back</span>
		</SharpAction>

		<header class="hero">
			<span class="eyebrow">Agent resources</span>
			<h1>Scoutpost skills</h1>
			<p>
				Public, machine-readable instructions for AI assistants working with Scoutpost.
				Use the product skill for hosted accounts and the setup skill for self-hosted installs.
			</p>
		</header>

		<section class="skill-grid" aria-label="Skill files">
			{#each skills as skill}
				<SharpPanel className="skill-card">
					<svelte:component this={skill.icon} size={18} class="skill-icon" />
					<h2>{skill.title}</h2>
					<p>{skill.description}</p>
					<a href={skill.href}>{skill.href}</a>
				</SharpPanel>
			{/each}
		</section>

		<SharpPanel tone="soft" className="resource-panel">
			<div class="resource-head">
				<FileText size={16} />
				<h2>Supporting files</h2>
			</div>
			<ul>
				<li><a href="/skills.txt">/skills.txt</a> — plain-text skills index</li>
				<li><a href="/docs">/docs</a> — human-readable product docs</li>
				<li><a href="/docs.txt">/docs.txt</a> — compact text docs for agents</li>
				<li><a href="/llms.txt">/llms.txt</a> — curated AI-readable link index</li>
				<li><a href="/swagger">/swagger</a> — OpenAPI browser</li>
			</ul>
		</SharpPanel>

		<SharpPanel className="mcp-panel">
			<div class="resource-head">
				<Terminal size={16} />
				<h2>MCP endpoint</h2>
			</div>
			<p>
				Hosted agents can connect to <code>https://www.scoutpost.ai/mcp</code>. The skill
				files explain the available tools and the expected scout, unit, and verification workflow.
			</p>
		</SharpPanel>
	</main>
</div>

<style>
	.skills-page {
		min-height: 100vh;
		background: var(--color-bg);
		color: var(--color-ink);
		position: relative;
		overflow-x: hidden;
		font-family: var(--font-body);
	}

	.bg-pattern {
		position: absolute;
		inset: 0;
		background-image:
			linear-gradient(to right, var(--color-border) 1px, transparent 1px),
			linear-gradient(to bottom, var(--color-border) 1px, transparent 1px);
		background-size: 96px 96px;
		opacity: 0.28;
		pointer-events: none;
		mask-image: linear-gradient(to bottom, black 0%, black 42%, transparent 95%);
		-webkit-mask-image: linear-gradient(to bottom, black 0%, black 42%, transparent 95%);
	}

	.content {
		position: relative;
		z-index: 1;
		max-width: 920px;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}

	:global(.back-link) {
		margin-bottom: 3rem;
	}

	.hero {
		max-width: 760px;
		margin-bottom: 2rem;
	}

	.eyebrow {
		display: block;
		margin-bottom: 0.75rem;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--color-primary);
	}

	h1,
	h2,
	p {
		margin: 0;
	}

	h1 {
		font-family: var(--font-serif);
		font-size: clamp(2.5rem, 8vw, 5rem);
		line-height: 0.95;
		margin-bottom: 1rem;
	}

	.hero p {
		max-width: 680px;
		color: var(--color-ink-muted);
		font-size: 1.05rem;
		line-height: 1.7;
	}

	.skill-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
		margin: 2rem 0 1rem;
	}

	:global(.skill-card) {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		min-height: 230px;
		padding: 1.25rem;
	}

	:global(.skill-icon) {
		color: var(--color-primary);
	}

	:global(.skill-card h2),
	.resource-head h2 {
		font-family: var(--font-serif);
		font-size: 1.45rem;
		line-height: 1.15;
	}

	:global(.skill-card p),
	:global(.mcp-panel p) {
		color: var(--color-ink-muted);
		line-height: 1.65;
	}

	a {
		color: var(--color-primary);
		text-decoration: none;
		overflow-wrap: anywhere;
	}

	a:hover {
		color: var(--color-primary-deep);
		text-decoration: underline;
	}

	:global(.resource-panel),
	:global(.mcp-panel) {
		margin-top: 1rem;
		padding: 1.25rem;
	}

	.resource-head {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		margin-bottom: 1rem;
	}

	.resource-head :global(svg) {
		color: var(--color-primary);
	}

	ul {
		margin: 0;
		padding-left: 1.1rem;
		color: var(--color-ink-muted);
		line-height: 1.8;
	}

	code {
		font-family: var(--font-mono);
		font-size: 0.92em;
		color: var(--color-primary-deep);
	}

	@media (max-width: 720px) {
		.content {
			padding: 1.25rem 1rem 3rem;
		}

		:global(.back-link) {
			margin-bottom: 2.25rem;
		}

		.skill-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
