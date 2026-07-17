<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { ArrowLeft, ExternalLink, FileCode, Terminal, Plug, Bot } from 'lucide-svelte';
	import { authStore } from '$lib/stores/auth';
	import SharpAction from '$lib/components/docs/SharpAction.svelte';
	import SharpCodeBlock from '$lib/components/docs/SharpCodeBlock.svelte';
	import SharpPanel from '$lib/components/docs/SharpPanel.svelte';

	$: backHref = $authStore.authenticated ? '/' : '/login';

	type Section = { id: string; title: string; children?: { id: string; title: string }[] };

	const toc: Section[] = [
		{ id: 'intro', title: 'Introduction' },
		{ id: 'quickstart', title: 'Quickstart' },
		{
			id: 'scouts',
			title: 'Scouts',
			children: [
				{ id: 'scout-page', title: 'Page Scout' },
				{ id: 'scout-beat', title: 'Beat Scout' },
				{ id: 'scout-social', title: 'Social Scout' },
				{ id: 'scout-civic', title: 'Civic Scout' }
			]
		},
		{
			id: 'concepts',
			title: 'Core concepts',
			children: [
				{ id: 'units', title: 'Information units' },
				{ id: 'entities', title: 'Entities' },
				{ id: 'dedup', title: 'Deduplication' },
				{ id: 'verification', title: 'Verification' },
				{ id: 'credits', title: 'Credits' }
			]
		},
		{
			id: 'integrations',
			title: 'Integrations',
			children: [
				{ id: 'mcp', title: 'MCP server' },
				{ id: 'rest', title: 'REST API' },
				{ id: 'cli', title: 'CLI' }
			]
		},
		{
			id: 'cookbook',
			title: 'Cookbook',
			children: [
				{ id: 'recipe-triage', title: 'Daily triage' },
				{ id: 'recipe-extract', title: 'Structured extraction' },
				{ id: 'recipe-lifecycle', title: 'Manage unit lifecycle' }
			]
		},
		{
			id: 'reference',
			title: 'Reference',
			children: [
				{ id: 'ref-urls', title: 'Base URLs' },
				{ id: 'ref-auth', title: 'Authentication' },
				{ id: 'ref-endpoints', title: 'Endpoints' },
				{ id: 'ref-errors', title: 'Errors' },
				{ id: 'ref-costs', title: 'Credit costs' }
			]
		},
		{ id: 'selfhost', title: 'Self-hosting' },
		{ id: 'help', title: 'Getting help' }
	];

	let activeId = 'intro';
	let observer: IntersectionObserver | null = null;

	onMount(() => {
		const ids: string[] = [];
		for (const s of toc) {
			ids.push(s.id);
			if (s.children) for (const c of s.children) ids.push(c.id);
		}
		const elements = ids
			.map((id) => document.getElementById(id))
			.filter((el): el is HTMLElement => el !== null);

		observer = new IntersectionObserver(
			(entries) => {
				const visible = entries
					.filter((e) => e.isIntersecting)
					.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
				if (visible.length > 0) activeId = visible[0].target.id;
			},
			{ rootMargin: '-24px 0px -60% 0px', threshold: [0, 0.25, 1] }
		);
		for (const el of elements) observer.observe(el);
	});

	onDestroy(() => {
		observer?.disconnect();
	});

	const mcpOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://scoutpost.ai';
	$: mcpConfig = JSON.stringify(
		{
			mcpServers: {
				scoutpost: {
					url: `${mcpOrigin}/mcp`,
					transport: 'http'
				}
			}
		},
		null,
		2
	);
</script>

<svelte:head>
	<title>Docs — Scoutpost</title>
	<meta
		name="description"
		content="Reference for the Scoutpost scouts API — MCP, REST, and CLI integrations for connecting your AI agent to monitoring jobs."
	/>
	<link rel="alternate" type="text/plain" title="docs.txt" href="/docs.txt" />
	<link rel="alternate" type="text/plain" title="llms.txt" href="/llms.txt" />
	<link rel="alternate" type="text/plain" title="llms-full.txt" href="/llms-full.txt" />
	<link rel="alternate" type="text/markdown" title="Scoutpost skill" href="/skills/scoutpost.md" />
	<link rel="alternate" type="text/markdown" title="Scoutpost setup skill" href="/skills/scoutpost-setup.md" />
</svelte:head>

<div class="docs">
	<div class="mobile-back-wrap">
		<SharpAction href={backHref} ariaLabel="Back">
			<ArrowLeft size={14} />
			<span>Back</span>
		</SharpAction>
	</div>

	<div class="layout">
		<aside class="sidebar" aria-label="Documentation table of contents">
			<div class="sidebar-inner">
				<SharpAction href={backHref} variant="ghost" size="sm" className="sidebar-back">
					<ArrowLeft size={13} />
					<span>Back</span>
				</SharpAction>
				<div class="sidebar-head">
					<span class="eyebrow">Docs · v2</span>
				</div>
				<ul class="toc">
					{#each toc as section (section.id)}
						<li>
							<a
								href={`#${section.id}`}
								class="toc-link top"
								class:active={activeId === section.id}>{section.title}</a
							>
							{#if section.children}
								<ul class="toc-sub">
									{#each section.children as child (child.id)}
										<li>
											<a
												href={`#${child.id}`}
												class="toc-link"
												class:active={activeId === child.id}>{child.title}</a
											>
										</li>
									{/each}
								</ul>
							{/if}
						</li>
					{/each}
				</ul>
				<div class="sidebar-foot">
					<a href="/swagger">API reference</a>
					<a href="/">Pricing</a>
					<a href="/faq">FAQ</a>
					<a href="/skills">Skills</a>
					<a href="/docs.txt">docs.txt</a>
					<a href="https://github.com/buriedsignals/scoutpost-os" target="_blank" rel="noopener noreferrer">
						GitHub
						<ExternalLink size={11} />
					</a>
					<a href="/llms.txt">llms.txt</a>
					<a href="/llms-full.txt">llms-full.txt</a>
				</div>
			</div>
		</aside>

		<main class="content">
			<article>
				<header class="hero">
					<span class="eyebrow">Documentation</span>
					<h1>Scoutpost for humans and AI assistants</h1>
					<p class="lede">
						Scoutpost, formerly coJournalist, is monitoring infrastructure for investigative and local journalism. It watches websites, news
						coverage, social profiles, council agendas, and watched transport activity on schedules you define, extracts atomic
						facts, de-duplicates across sources, and hands the results to you — or to your AI
						assistant — as a searchable knowledge base.
					</p>
					<div class="pills">
						<SharpAction href="#quickstart" variant="primary" className="pill">Quickstart</SharpAction>
						<SharpAction href="#mcp" className="pill">Connect via MCP</SharpAction>
						<SharpAction href="/swagger" className="pill">API reference</SharpAction>
					</div>

					<SharpPanel tone="soft" className="callout llms">
						<div class="callout-head">
							<Bot size={14} />
							<strong>For AI assistants</strong>
						</div>
						<p>
							This site follows the
							<a href="https://llmstxt.org" target="_blank" rel="noopener noreferrer">llms.txt</a>
							convention. Machine-readable indexes are available:
						</p>
						<ul>
							<li><a href="/llms.txt"><code>/llms.txt</code></a> — curated link index</li>
							<li><a href="/llms-full.txt"><code>/llms-full.txt</code></a> — full flattened docs</li>
							<li><a href="/docs.txt"><code>/docs.txt</code></a> — short text version of the public docs</li>
							<li><a href="/skills"><code>/skills</code></a> — public skills index</li>
							<li><a href="/skills/scoutpost.md"><code>/skills/scoutpost.md</code></a> — product skill</li>
							<li><a href="/skills/scoutpost-setup.md"><code>/skills/scoutpost-setup.md</code></a> — setup skill</li>
							<li>
								<a href="/swagger"><code>/swagger</code></a> — interactive OpenAPI 3.1 browser; raw
								spec at <code>/functions/v1/openapi-spec</code>
							</li>
							<li><code>/mcp</code> — MCP server endpoint (OAuth 2.1 required)</li>
						</ul>
					</SharpPanel>
				</header>

				<!-- INTRODUCTION -->
				<section id="intro">
					<h2>Introduction</h2>
					<p>
						Scoutpost turns three tedious parts of reporting into background infrastructure:
						<strong>noticing</strong> that a page changed,
						<strong>understanding</strong> whether the change matters, and
						<strong>remembering</strong> what you already knew. You define a <em>scout</em> — a
						URL, a location, a social handle, a council domain — and Scoutpost runs it on a
						schedule, extracts structured information, and drops the results into a knowledge
						graph you own.
					</p>
					<p>
						Everything is addressable by API, so your AI assistant can drive the workflow:
						pull unverified findings, group them by topic, flag dollar amounts and deadlines,
						draft a brief for your morning read. You stay the verifier. Every promotion stamps
						your user ID into an audit trail.
					</p>

					<div class="grid-2">
						<SharpPanel className="card">
							<h4>Who it's for</h4>
							<ul>
								<li>Local and investigative reporters monitoring beats</li>
								<li>Newsrooms tracking government and civic sources</li>
								<li>Researchers following social accounts and niche publications</li>
								<li>Anyone who wants an AI assistant with editorial guardrails</li>
							</ul>
						</SharpPanel>
						<SharpPanel className="card">
							<h4>What makes it different</h4>
							<ul>
								<li>Per-scout change baselines — only real changes fire</li>
								<li>Atomic-fact extraction with vector dedup across sources</li>
								<li>Entity resolution tracked longitudinally</li>
								<li>OAuth-authenticated MCP server plus REST and CLI</li>
							</ul>
						</SharpPanel>
					</div>
				</section>

				<!-- QUICKSTART -->
				<section id="quickstart">
					<h2>Quickstart</h2>
					<p>Five minutes from zero to a running scout.</p>

					<ol class="steps">
						<li>
							<div class="step-num">1</div>
							<div>
								<h4>Sign in</h4>
								<p>
									Open <a href="https://scoutpost.ai" target="_blank" rel="noopener noreferrer"
										>scoutpost.ai</a
									>
									and sign in with your email address.
								</p>
							</div>
						</li>
						<li>
							<div class="step-num">2</div>
							<div>
								<h4>Create your first scout</h4>
								<p>
									Click <strong>+ New scout</strong> in the sidebar. Pick a type (start with Page
									Scout or Beat Scout), name it, paste a URL, criteria, or a geography, and schedule it
									(Page Scouts can run daily; Beat and Civic Scouts run weekly or monthly).
									Scheduling saves the current page as the baseline; only later changes create inbox units.
								</p>
							</div>
						</li>
						<li>
							<div class="step-num">3</div>
							<div>
								<h4>Connect an AI assistant (optional)</h4>
								<p>
									Click <strong>Connect Agent</strong> in the topbar and choose your assistant.
									Scoutpost shows its recommended CLI or MCP path; REST keys remain under
									<strong>API keys &amp; REST</strong>.
								</p>
							</div>
						</li>
						<li>
							<div class="step-num">4</div>
							<div>
								<h4>Verify findings</h4>
								<p>
									Open a scout, skim new information units, click <strong>Verify</strong> on the
									ones that matter. Verified units are the ones your assistant can safely cite in
									drafts. Rejected units stay in the audit trail.
								</p>
							</div>
						</li>
					</ol>
				</section>

				<!-- SCOUTS -->
				<section id="scouts">
					<h2>Scouts</h2>
					<p>
						Scouts are the unit of monitoring. Each one has a type (determines the pipeline), a
						schedule, and a project it belongs to. Page Scouts may run daily; Beat and Civic
						Scouts are capped at weekly/monthly schedules. Per-run credit costs depend on type — see the
						<a href="#ref-costs">credit table</a>.
					</p>

					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th>Type</th>
									<th>Purpose</th>
									<th>Scope</th>
									<th>Cost / run</th>
								</tr>
							</thead>
							<tbody>
								<tr>
									<td><a href="#scout-page"><code>web</code> — Page Scout</a></td>
									<td>Watches a single URL for content changes</td>
									<td>URL + optional topic filter</td>
									<td>1 credit</td>
								</tr>
								<tr>
									<td><a href="#scout-beat"><code>beat</code> — Beat Scout</a></td>
									<td>Topic- or geography-scoped monitoring across niche or reliable outlets</td>
									<td>Criteria, geography, or both</td>
									<td>7 credits</td>
								</tr>
								<tr>
									<td><a href="#scout-social"><code>social</code> — Social Scout</a></td>
									<td>Monitors a social profile for new/removed posts</td>
									<td>Platform + handle</td>
									<td>2–15 credits</td>
								</tr>
								<tr>
									<td><a href="#scout-civic"><code>civic</code> — Civic Scout</a></td>
									<td>Council agendas + promise extraction from PDFs</td>
									<td>Council domain</td>
									<td>10 credits</td>
								</tr>
								<tr>
									<td><a href="#scout-fleet"><code>transport</code> — Fleet Scout</a></td>
									<td>Alerts when watched vessels, aircraft, or satellites enter an area</td>
									<td>Named watch list + optional or required geofence</td>
									<td>1–2 credits</td>
								</tr>
							</tbody>
						</table>
					</div>

					<h3 id="scout-page">Page Scout</h3>
					<p>
						Point it at any URL. Scoutpost fetches a fresh page snapshot, canonicalizes the
						markdown, and compares it with that scout's stored baseline. Only meaningful content
						changes fire notifications. Optional topic filter lets AI skip changes that don't match
						your criteria. Scheduling establishes a baseline only; the inbox gets units later when
						the page changes and those changes survive extraction + dedup.
					</p>

					<h3 id="page-archive">Page Archive</h3>
					<p>
						Page Scouts can optionally retain tamper-evident evidence snapshots: MHTML, a screenshot,
						markdown, artifact hashes, and an RFC 3161 timestamp. On hosted Scoutpost, Page Archive is
						available on Pro and Team; Wayback submission is enabled by default but can be turned off per scout.
						Agents can list and retrieve snapshots through the CLI, MCP, or REST API.
					</p>

					<h3 id="scout-beat">Beat Scout</h3>
					<p>
						Beat Scout covers the product's recurring news-monitoring surface. It can be scoped by
						criteria, geography, or both. In geography-heavy use cases it can favour niche local
						sources; in topic-driven use cases it can focus on more established outlets. Use it to
						watch a town, a district, or a topic such as <em>housing supply decisions</em>,
						<em>state AG activity</em>, or <em>FCC filings</em>.
						Beat Scout schedules are weekly or monthly; daily runs are intentionally rejected.
					</p>

					<h3 id="scout-social">Social Scout</h3>
					<p>
						Monitors Instagram, X, Facebook, LinkedIn, TikTok profiles via Apify. Captures new
						posts and — importantly — <strong>deletions</strong> (useful for politicians and PR
						firms). Image-aware criteria: your filter can match on caption text, alt text, or
						image content. Facebook is more expensive because Meta makes it hard.
					</p>

					<h3 id="scout-civic">Civic Scout</h3>
					<p>
						Give it a council domain. Civic Scout discovers meeting pages, downloads agendas and
							minutes (often PDFs), has Gemini via OpenRouter's Google Vertex route extract <strong>promises</strong> — commitments,
						deadlines, and dollar figures — with meeting-date context. Those promises dedup into the
						same canonical unit layer as Page Scout and Beat Scout findings, so civic hits add
						provenance instead of spawning parallel cards.
					</p>

					<h3 id="scout-fleet">Fleet Scout</h3>
					<p>
						Fleet Scout monitors named vessels, aircraft, or satellites and alerts when a watched object enters
						a defined area. It is designed for focused monitoring, not broad traffic surveillance: every scout
						requires a watch list of up to 20 MMSIs, ICAO hexes, or NORAD IDs. Vessels and satellites require a
						geofence; aircraft may also be watched globally. Fleet Scouts run every 3, 6, or 12 hours, or daily
						(satellites are daily only), and are Pro-gated on hosted Scoutpost.
					</p>
				</section>

				<!-- CONCEPTS -->
				<section id="concepts">
					<h2>Core concepts</h2>

					<h3 id="units">Information units</h3>
					<p>
						A unit is an atomic fact extracted from one or more sources. "Council approved $2.3M
						for SRP road paving with a Q4 2026 target" is one unit. Six articles reporting that
						decision become one unit with six <code>source_url</code>s. Units carry fields for the
						event date (<code>occurred_at</code>), when the scout found it (<code>extracted_at</code>),
						who verified it (<code>verified_by</code>), and free-form tags. Units are embedded
						locally with EmbeddingGemma and stored in pgvector for semantic search.
					</p>

					<h3 id="entities">Entities</h3>
					<p>
						People, organisations, locations, and documents are resolved into
						<strong>entities</strong> across units. "Salt River Pima Community" mentioned in four
						units resolves to one entity your assistant can follow over time. Entities have their
						own knowledge page and cross-link to every unit that mentions them.
					</p>

					<h3 id="dedup">Deduplication</h3>
					<p>Dedup operates at four layers, with one canonical fact layer shared across all scouts:</p>
					<ul>
						<li>
							<strong>Canonical fact-level</strong> — Page Scout, Beat Scout, Civic Scout, Social
							Scout, and manual ingest all write through one canonical-unit layer. Repeats attach as
							new provenance, not new cards.
						</li>
						<li>
							<strong>Source-level</strong> — each unit stores linked sources and linked scouts, so
							your assistant can cite the original and the follow-ups.
						</li>
						<li>
							<strong>Entity-level</strong> — entity resolution means "SRP", "Salt River Project",
							and "Salt River Pima" don't fracture into three histories.
						</li>
						<li>
							<strong>Time-level</strong> — queries can filter by <code>occurred_at</code> (when
							the event happened) or <code>extracted_at</code> (when we found it).
						</li>
					</ul>

					<h3 id="verification">Verification</h3>
					<p>
						Units land in an <em>unverified</em> state. An editor (you) reviews and calls
						<code>promoteUnit</code> or <code>rejectUnit</code>. Every verification stamps your
						user ID into <code>verified_by</code> with a timestamp, so an editor can later audit
						who cleared what. AI assistants can draft using any unit but by convention only cite
						verified ones — the verification state is exposed on every API response so agents can
						be configured to hold the line.
					</p>

					<h3 id="credits">Credits</h3>
					<p>
						Credits are the unit of cost. Every scout run decrements the credit balance on the
						project (individual users) or organisation (team plans). Free tier: 100/month. Pro:
						1,000/month. Team: 5,000/month shared. See
						<a href="/">pricing</a> and the <a href="#ref-costs">cost table</a>.
					</p>
				</section>

				<!-- INTEGRATIONS -->
				<section id="integrations">
					<h2>Integrations</h2>
					<p>
						Three surfaces; pick the one that matches your client. Most journalists end up using
						all three at different points.
					</p>

					<div class="surface-grid">
						<SharpPanel href="#mcp" className="surface">
							<div class="surface-icon"><Plug size={18} /></div>
							<h4>MCP</h4>
							<p>For Claude Desktop, Cursor, Windsurf, Goose, any MCP client.</p>
						</SharpPanel>
						<SharpPanel href="#rest" className="surface">
							<div class="surface-icon"><FileCode size={18} /></div>
							<h4>REST API</h4>
							<p>For ChatGPT Actions, custom agents, browser automations, scripts.</p>
						</SharpPanel>
						<SharpPanel href="#cli" className="surface">
							<div class="surface-icon"><Terminal size={18} /></div>
							<h4>CLI (<code>scout</code>)</h4>
							<p>Deno-based binary for terminal workflows and shell automation.</p>
						</SharpPanel>
					</div>

					<h3 id="mcp">MCP server</h3>
					<p>
						Scoutpost ships an embedded MCP server with its own OAuth 2.1 authorization server
						(RFC 8414 metadata + RFC 7591 dynamic registration). Your MCP client handles the full
						OAuth dance — you never paste tokens. The endpoint is:
					</p>

					<SharpCodeBlock code={`${mcpOrigin}/mcp`} ariaLabel="Copy MCP URL" />

					<p>Drop this into your MCP client config (example: <code>claude_desktop_config.json</code>):</p>

					<SharpCodeBlock code={mcpConfig} ariaLabel="Copy MCP config" />

					<p>Tools exposed over MCP (non-exhaustive):</p>
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th>Tool</th>
									<th>Does</th>
								</tr>
							</thead>
							<tbody>
								<tr><td><code>list_scouts</code></td><td>List scouts in the current project</td></tr>
								<tr><td><code>get_scout</code></td><td>Fetch a scout by ID with latest run status</td></tr>
								<tr><td><code>run_scout</code></td><td>Trigger an on-demand run (counts against credits)</td></tr>
								<tr><td><code>list_units</code></td><td>List information units, filterable by scout / verified / time</td></tr>
								<tr><td><code>search_units</code></td><td>Semantic, keyword, or hybrid search across units</td></tr>
								<tr><td><code>verify_unit</code> / <code>reject_unit</code></td><td>Verification actions; stamps your user ID</td></tr>
								<tr><td><code>search_entities</code></td><td>People, orgs, locations, documents</td></tr>
								<tr><td><code>ingest_content</code></td><td>Ingest an ad-hoc URL or text into the knowledge base</td></tr>
								<tr><td><code>mark_unit_used</code></td><td>Mark a unit used in a published story</td></tr>
							</tbody>
						</table>
					</div>

					<h3 id="rest">REST API</h3>
					<p>
						Base URL: <code>https://scoutpost.ai/functions/v1</code>. Auth via a
						<code>cj_…</code> API key (create one from <strong>Connect Agent → API keys &amp; REST</strong> in the app) sent
						as <code>Authorization: Bearer cj_…</code>. Full OpenAPI 3.1 spec at
						<a href="/swagger">/swagger</a>; raw JSON at <code>/functions/v1/openapi-spec</code>.
					</p>

					<SharpCodeBlock
						ariaLabel="Copy curl example"
						code={`curl https://scoutpost.ai/functions/v1/scouts \\
  -H "Authorization: Bearer $COJO_TOKEN"

curl "https://scoutpost.ai/functions/v1/units?verified=false&limit=20" \\
  -H "Authorization: Bearer $COJO_TOKEN"`}
					/>

					<p>
						Responses are JSON. Lists return a paginated envelope:
						<code>{`{ "items": [...], "pagination": { "total", "offset", "limit", "has_more" } }`}</code>.
						Errors return <code>{`{ "error": "…", "code": "…" }`}</code>.
					</p>

					<h3 id="cli">CLI</h3>
					<p>
						<code>scout</code> is a tiny Deno-based binary that speaks the same REST API. Useful for
						shell pipelines, nightly scripts, and direct unit triage workflows.
					</p>

					<SharpCodeBlock
						ariaLabel="Copy CLI install"
						copyValue={`deno install -A -g -n scout https://raw.githubusercontent.com/buriedsignals/scoutpost-os/master/cli/scout.ts
scout config set api_url=https://scoutpost.ai/functions/v1
scout config set api_key=<cj_... API key>
scout scouts list`}
						code={`# Install (requires Deno 2.x)
deno install -A -g -n scout https://raw.githubusercontent.com/buriedsignals/scoutpost-os/master/cli/scout.ts

# Configure (generate a cj_... API key in the app: Connect Agent → API keys & REST → Create key)
scout config set api_url=https://scoutpost.ai/functions/v1
scout config set api_key=<cj_... API key>

# Use
scout scouts list
scout units list --verified
scout units verify <id> --notes "Cross-checked with minutes"
scout units search --query "zoning variance" --mode hybrid --project <id>`}
					/>
				</section>

				<!-- COOKBOOK -->
				<section id="cookbook">
					<h2>Cookbook</h2>
					<p>Worked examples. Copy, adapt, ship.</p>

					<h3 id="recipe-triage">Daily triage with an AI assistant</h3>
					<SharpPanel className="recipe">
						<div class="recipe-block">
							<div class="recipe-label">You → Claude Desktop</div>
							<p class="recipe-prompt">
								Pull all unverified units from my Phoenix Council and Oakland local scouts this
								week. Group by topic, flag anything mentioning dollar amounts or deadlines, and
								draft a 150-word brief I can read over coffee.
							</p>
						</div>
						<div class="recipe-block">
							<div class="recipe-label">Claude Desktop</div>
							<ol class="recipe-steps">
								<li>Calls <code>list_scouts()</code> → finds Phoenix Council and Oakland local.</li>
								<li>
									Calls <code>list_units(scout_id=…, verified=false)</code> → 9 units.
								</li>
								<li>
									Calls <code>search_units(query_text='$M OR deadline OR by 2026', mode='hybrid')</code> → narrows to 4.
								</li>
								<li>Drafts a 150-word brief with source links.</li>
								<li>Waits for your <code>verify_unit</code> / <code>reject_unit</code> calls.</li>
							</ol>
						</div>
						<p class="recipe-note">
							The assistant never publishes on its own. <code>verify_unit</code> is the editorial
							checkpoint — it stamps your user ID into the audit trail.
						</p>
					</SharpPanel>

					<h3 id="recipe-extract">Structured extraction</h3>
					<SharpPanel className="recipe">
						<div class="recipe-block">
							<div class="recipe-label">You → ChatGPT (REST Action)</div>
							<p class="recipe-prompt">
								Pull the last 30 agenda items from my cityof-oakland civic scout. For each, return
								title, meeting date, and a one-line summary. Give it to me as a markdown table I
								can paste into our CMS.
							</p>
						</div>
						<p>
							Behind the scenes: <code>GET /units?scout_id=…&amp;limit=30</code> →
							<code>/units/search</code> narrows to agenda-relevant ones → assistant renders the
							table. All on-the-fly, no storage on your machine.
						</p>
					</SharpPanel>

					<h3 id="recipe-lifecycle">Manage unit lifecycle</h3>
					<SharpPanel className="recipe">
<pre><code>{`# Mark facts as published once they make it into a story
scout units mark-used <unit-id> --url https://cms.example.com/story/slug

# Soft-delete facts you want out of the active pool
scout units delete <unit-id>`}</code></pre>
						<p class="recipe-note">
							Agents can keep working from the same searchable unit pool while these lifecycle
							flags track what has been reviewed, published, or removed.
						</p>
					</SharpPanel>
				</section>

				<!-- REFERENCE -->
				<section id="reference">
					<h2>Reference</h2>

					<h3 id="ref-urls">Base URLs</h3>
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th>Surface</th>
									<th>URL</th>
								</tr>
							</thead>
							<tbody>
								<tr><td>App</td><td><code>https://scoutpost.ai</code></td></tr>
								<tr><td>REST API</td><td><code>https://scoutpost.ai/functions/v1</code></td></tr>
								<tr><td>MCP server</td><td><code>https://scoutpost.ai/mcp</code></td></tr>
								<tr><td>OpenAPI spec</td><td><code>/functions/v1/openapi-spec</code> (JSON)</td></tr>
								<tr><td>Swagger UI</td><td><a href="/swagger">/swagger</a></td></tr>
								<tr><td>llms.txt</td><td><a href="/llms.txt">/llms.txt</a></td></tr>
								<tr><td>llms-full.txt</td><td><a href="/llms-full.txt">/llms-full.txt</a></td></tr>
								<tr><td>docs.txt</td><td><a href="/docs.txt">/docs.txt</a></td></tr>
								<tr><td>skills</td><td><a href="/skills">/skills</a></td></tr>
								<tr><td>Product skill</td><td><a href="/skills/scoutpost.md">/skills/scoutpost.md</a></td></tr>
								<tr><td>Setup skill</td><td><a href="/skills/scoutpost-setup.md">/skills/scoutpost-setup.md</a></td></tr>
							</tbody>
						</table>
					</div>

					<h3 id="ref-auth">Authentication</h3>
					<p>
						<strong>REST / CLI</strong>: <code>cj_…</code> API key in the <code>Authorization: Bearer</code>
						header. Generate keys from <strong>Connect Agent → API keys &amp; REST</strong> in the app — they are scoped to
						your account and revocable from the same modal. <strong>MCP</strong>: OAuth via the
						connector; no manual token handling.
					</p>
					<p>
						<strong>MCP</strong>: full OAuth 2.1 with PKCE, RFC 8414 metadata, and RFC 7591 dynamic
						client registration. Your MCP client handles the flow — you only paste the URL.
					</p>

					<h3 id="ref-endpoints">Endpoints (summary)</h3>
					<p>Full spec at <a href="/swagger">/swagger</a>. Highlights:</p>
					<div class="table-wrap">
						<table>
							<thead>
								<tr><th>Method</th><th>Path</th><th>What</th></tr>
							</thead>
							<tbody>
								<tr><td>GET</td><td><code>/projects</code></td><td>List projects</td></tr>
								<tr><td>POST</td><td><code>/projects</code></td><td>Create a project</td></tr>
								<tr><td>GET</td><td><code>/scouts</code></td><td>List scouts</td></tr>
								<tr><td>POST</td><td><code>/scouts</code></td><td>Create a scout</td></tr>
								<tr><td>POST</td><td><code>/scouts/:id/run</code></td><td>Trigger a scout run</td></tr>
								<tr><td>GET</td><td><code>/units</code></td><td>List information units</td></tr>
								<tr><td>POST</td><td><code>/units/search</code></td><td>Semantic, keyword, or hybrid search</td></tr>
								<tr><td>PATCH</td><td><code>/units/:id</code></td><td>Verify, reject, or mark used</td></tr>
								<tr><td>GET</td><td><code>/entities</code></td><td>List resolved entities</td></tr>
								<tr><td>POST</td><td><code>/ingest</code></td><td>Ingest a URL or raw text</td></tr>
								<tr><td>DELETE</td><td><code>/units/:id</code></td><td>Soft-delete a unit</td></tr>
							</tbody>
						</table>
					</div>

					<h3 id="ref-errors">Errors</h3>
					<p>Every error response uses the same shape:</p>
<pre><code>{`{
  "error": "human-readable message",
  "code": "machine_code"
}`}</code></pre>
					<p>Common codes:</p>
					<ul>
						<li><code>unauthorized</code> — missing or expired token</li>
						<li><code>forbidden</code> — token valid, resource not yours</li>
						<li><code>not_found</code> — no such resource</li>
						<li><code>insufficient_credits</code> — run would exceed your plan</li>
						<li><code>rate_limited</code> — too many requests; retry with exponential backoff</li>
						<li><code>validation_error</code> — request body failed schema validation</li>
					</ul>

					<h3 id="ref-costs">Credit costs</h3>
					<div class="table-wrap">
						<table>
							<thead>
								<tr><th>Action</th><th>Credits</th></tr>
							</thead>
							<tbody>
								<tr><td>Page Scout run (<code>web</code>)</td><td>1</td></tr>
								<tr><td>Beat Scout run (<code>beat</code>, weekly or monthly only)</td><td>7</td></tr>
								<tr><td>Social Scout — Instagram / X / TikTok</td><td>2</td></tr>
								<tr><td>Social Scout — Facebook</td><td>15</td></tr>
								<tr><td>Civic Scout run (weekly or monthly only)</td><td>10 <small>(refunded when a run queues 0 docs)</small></td></tr>
								<tr><td>Ad-hoc data extraction</td><td>varies by channel</td></tr>
							</tbody>
						</table>
					</div>
					<p>
						Monthly budget = (cost per run) × (runs per month). A daily Page Scout = 30 credits/mo;
						a weekly Beat Scout = 28 credits/mo, and a weekly Civic Scout = up to 40 credits/mo
						(less when a week passes with no new council documents — those runs refund the 10 credits automatically). Plan math lives on the <a href="/">pricing page</a>.
					</p>
				</section>

				<!-- SELF-HOSTING -->
				<section id="selfhost">
					<h2>Self-hosting</h2>
					<p>
						Scoutpost is source-available under the
						<a href="/faq">Sustainable Use License</a> — use it for your newsroom freely, don't
						resell it as a service. Self-hosted deployments run on your own Supabase project with
						your Firecrawl, Gemini, Apify, and Resend keys. Same feature set as SaaS. No telemetry.
					</p>
					<p>
						The <a href="https://github.com/buriedsignals/scoutpost-os" target="_blank" rel="noopener noreferrer"
							>GitHub repo</a
						>
						has an automated setup flow — drop your AI coding agent into the repo, run the
						<code>setup</code> skill, and it provisions everything from a fresh Supabase project
						to the Edge Functions and the frontend.
					</p>
				</section>

				<!-- HELP -->
				<section id="help">
					<h2>Getting help</h2>
					<ul class="flat-list">
						<li><a href="/faq">FAQ</a> — licensing, self-hosting, editorial workflow</li>
						<li><a href="/">Pricing</a> — plans, credits, team seats</li>
						<li>
							<a href="https://github.com/buriedsignals/scoutpost-os/issues" target="_blank" rel="noopener noreferrer"
								>Open an issue</a
							>
							— bugs and feature requests
						</li>
						<li>
							In-app <strong>Feedback</strong> button — routes to Linear, a human reads it
						</li>
						<li>
							<a href="https://github.com/buriedsignals/scoutpost-os/discussions" target="_blank" rel="noopener">GitHub discussions</a>
							— for questions and help from the community
						</li>
					</ul>
				</section>

				<footer class="foot">
					<a href={backHref} class="foot-link">← Back to Scoutpost</a>
					<a
						href="https://github.com/buriedsignals/scoutpost-os"
						target="_blank"
						rel="noopener noreferrer"
						class="foot-link"
					>
						GitHub <ExternalLink size={12} />
					</a>
				</footer>
			</article>
		</main>
	</div>
</div>

<style>
	.docs {
		min-height: 100vh;
		background: var(--color-bg);
		font-family: var(--font-body);
		color: var(--color-ink);
	}

	.mobile-back-wrap {
		margin-top: 1rem;
		margin-left: 1.5rem;
	}
	@media (min-width: 960px) { .mobile-back-wrap { display: none; } }

	:global(.sidebar-back) {
		margin-bottom: 1.5rem;
	}

	.layout {
		display: grid;
		grid-template-columns: 1fr;
		max-width: 1200px;
		margin: 0 auto;
		padding: 0 1.5rem;
	}

	@media (min-width: 960px) {
		.layout {
			grid-template-columns: 220px 1fr;
			gap: 3rem;
		}
	}

	.sidebar { display: none; }
	@media (min-width: 960px) { .sidebar { display: block; } }

	.sidebar-inner {
		position: sticky;
		top: 0;
		padding: 3rem 0;
		max-height: 100vh;
		overflow-y: auto;
	}

	.sidebar-head {
		margin-bottom: 1rem;
	}

	.eyebrow {
		display: inline-block;
		font-size: 0.6875rem;
		font-weight: 700;
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--color-primary-deep);
	}

	.toc, .toc-sub {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.toc > li { margin-bottom: 0.125rem; }
	.toc-sub {
		margin: 0.25rem 0 0.5rem 0;
		padding-left: 0.75rem;
		border-left: 1px solid var(--color-border);
	}
	.toc-link {
		display: block;
		padding: 0.3125rem 0.5rem;
		font-size: 0.8125rem;
		color: var(--color-ink-muted);
		text-decoration: none;
		border-radius: var(--radius-sm);
		line-height: 1.4;
		transition: background 0.12s ease, color 0.12s ease;
	}
	.toc-link.top { font-weight: 600; color: var(--color-ink); }
	.toc-link:hover { background: var(--color-secondary-soft); color: var(--color-ink); }
	.toc-link.active { color: var(--color-ink); background: var(--color-surface-hover); }

	.sidebar-foot {
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid var(--color-border);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.sidebar-foot a {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.75rem;
		color: var(--color-ink-muted);
		text-decoration: none;
	}
	.sidebar-foot a:hover { color: var(--color-primary-deep); }

	.content { padding: 3rem 0 6rem; min-width: 0; }
	article { max-width: 760px; }

	.hero { margin-bottom: 4rem; }

	.hero h1 {
		font-family: var(--font-display);
		font-size: clamp(2rem, 4vw, 2.75rem);
		font-weight: 600;
		line-height: 1.2;
		color: var(--color-ink);
		margin: 0.875rem 0 1rem 0;
		letter-spacing: -0.015em;
	}

	.lede {
		font-size: 1.0625rem;
		line-height: 1.7;
		color: var(--color-ink-muted);
		margin: 0;
		max-width: 640px;
	}

	.pills {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 1.5rem;
	}
	:global(.pill) {
		font-size: 0.8125rem;
	}

	:global(.callout) {
		margin-top: 2rem;
		padding: 1rem 1.125rem;
	}
	:global(.callout.llms ul) {
		margin: 0.5rem 0 0 0;
		padding-left: 1.125rem;
		font-size: 0.8125rem;
		line-height: 1.8;
		color: var(--color-ink-muted);
	}
	:global(.callout.llms p) {
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.6;
		color: var(--color-ink-muted);
	}
	.callout-head {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--color-primary-deep);
		letter-spacing: 0.02em;
		text-transform: uppercase;
		margin-bottom: 0.375rem;
	}

	section { margin-top: 4rem; scroll-margin-top: 2rem; }

	section h2 {
		font-family: var(--font-display);
		font-size: 1.875rem;
		font-weight: 600;
		color: var(--color-ink);
		margin: 0 0 1rem 0;
		letter-spacing: -0.015em;
	}

	section h3 {
		font-family: var(--font-body);
		font-size: 1.0625rem;
		font-weight: 600;
		color: var(--color-ink);
		margin: 2rem 0 0.75rem 0;
		letter-spacing: -0.005em;
		scroll-margin-top: 2rem;
	}

	h4 {
		font-family: var(--font-body);
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--color-ink);
		margin: 0 0 0.5rem 0;
	}

	section p, .content p {
		font-size: 0.9375rem;
		line-height: 1.7;
		color: var(--color-ink-muted);
		margin: 0 0 1rem 0;
	}
	section p:last-child { margin-bottom: 0; }

	section ul, .content ul {
		margin: 0 0 1rem 0;
		padding-left: 1.25rem;
		font-size: 0.9375rem;
		line-height: 1.7;
		color: var(--color-ink-muted);
	}
	section ul li { margin-bottom: 0.375rem; }
	section ul strong { color: var(--color-ink); font-weight: 600; }

	a {
		color: var(--color-primary-deep);
		text-decoration: none;
		font-weight: 500;
	}
	a:hover { text-decoration: underline; }

	code {
		font-family: var(--font-mono);
		font-size: 0.8125em;
		padding: 0.0625rem 0.375rem;
		background: var(--color-primary-soft);
		color: var(--color-primary);
		border-radius: var(--radius-sm);
		font-weight: 500;
	}

	pre {
		margin: 0.75rem 0 1rem 0;
		font-size: 0.75rem;
		line-height: 1.6;
	}
	pre code {
		background: transparent;
		color: inherit;
		padding: 0;
		font-weight: 400;
	}

	.grid-2 {
		display: grid;
		grid-template-columns: 1fr;
		gap: 0.875rem;
		margin: 1.25rem 0 0 0;
	}
	@media (min-width: 720px) {
		.grid-2 { grid-template-columns: 1fr 1fr; }
	}

	:global(.card) {
		padding: 1.125rem 1.25rem;
	}
	:global(.card h4) { margin-bottom: 0.625rem; }
	:global(.card ul) {
		margin: 0;
		padding-left: 1.125rem;
		font-size: 0.8125rem;
		line-height: 1.6;
	}
	:global(.card ul li) { margin-bottom: 0.25rem; }

	.steps {
		list-style: none;
		margin: 1.25rem 0 0 0;
		padding: 0;
		counter-reset: step;
	}
	.steps > li {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.875rem;
		padding: 1rem 0;
		border-bottom: 1px solid var(--color-border);
	}
	.steps > li:last-child { border-bottom: none; }
	.step-num {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--color-primary) 24%, var(--color-border));
		background: var(--color-primary-soft);
		color: var(--color-primary-deep);
		font-size: 0.75rem;
		font-weight: 700;
	}
	.steps h4 { margin-top: 0.125rem; }
	.steps p { margin-top: 0.25rem; font-size: 0.875rem; }

	.table-wrap {
		margin: 0.75rem 0 1.25rem 0;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		overflow: hidden;
		background: var(--color-surface-alt);
	}
	.table-wrap table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.8125rem;
	}
	.table-wrap th, .table-wrap td {
		text-align: left;
		padding: 0.625rem 0.875rem;
		border-bottom: 1px solid var(--color-border);
		vertical-align: top;
	}
	.table-wrap thead {
		background: var(--color-surface);
		font-weight: 600;
		color: var(--color-ink);
	}
	.table-wrap tr:last-child td { border-bottom: none; }

	.surface-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 0.75rem;
		margin: 1.25rem 0 0 0;
	}
	@media (min-width: 720px) {
		.surface-grid { grid-template-columns: repeat(3, 1fr); }
	}
	:global(.surface) {
		display: block;
		padding: 1rem 1.125rem;
		text-decoration: none;
		color: var(--color-ink);
	}
	.surface-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--color-primary) 24%, var(--color-border));
		background: var(--color-secondary-soft);
		color: var(--color-primary-deep);
		margin-bottom: 0.5rem;
	}
	:global(.surface h4) { margin: 0 0 0.25rem 0; }
	:global(.surface p) {
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--color-ink-muted);
	}

	:global(.recipe) {
		margin: 0.75rem 0 1.5rem 0;
		padding: 1.125rem 1.25rem;
	}
	.recipe-block {
		margin-bottom: 0.875rem;
	}
	.recipe-label {
		font-size: 0.6875rem;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-primary-deep);
		margin-bottom: 0.375rem;
	}
	.recipe-prompt {
		padding: 0.75rem 0.875rem;
		background: var(--color-primary-soft);
		border: 1px solid color-mix(in oklab, var(--color-primary) 28%, var(--color-border));
		border-radius: var(--radius-md);
		font-size: 0.875rem;
		line-height: 1.6;
		margin: 0;
		color: var(--color-ink);
	}
	.recipe-steps {
		margin: 0.5rem 0 0 0;
		padding-left: 1.125rem;
		font-size: 0.8125rem;
		line-height: 1.65;
		color: var(--color-ink-muted);
	}
	.recipe-steps li { margin-bottom: 0.25rem; }
	.recipe-note {
		margin-top: 0.875rem;
		padding-top: 0.875rem;
		border-top: 1px dashed var(--color-border-strong);
		font-size: 0.8125rem;
		color: var(--color-ink-muted);
	}

	.flat-list {
		list-style: none;
		padding-left: 0;
	}
	.flat-list li {
		padding: 0.375rem 0;
		border-bottom: 1px dashed var(--color-border);
	}
	.flat-list li:last-child { border-bottom: none; }

	.foot {
		margin-top: 5rem;
		padding-top: 2rem;
		border-top: 1px solid var(--color-border);
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.foot-link {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-ink-muted);
	}
	.foot-link:hover { color: var(--color-primary-deep); }
</style>
