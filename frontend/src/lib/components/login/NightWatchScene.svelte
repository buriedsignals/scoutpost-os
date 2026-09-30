<script lang="ts">
	import { onMount } from 'svelte';

	export type SceneRect = { left: number; top: number; right: number; bottom: number };

	let {
		freeRect,
		onsignal
	}: {
		/** Viewport region (at scroll 0) the scope may occupy without covering page content. */
		freeRect?: () => SceneRect | null;
		/** Fires each time the scope finds its point — the auth card's mark pings with it. */
		onsignal?: () => void;
	} = $props();

	// Plates are the Scoutpost teaser b-roll, pre-graded through its night → teal → frost
	// duotone. `page` and `profile` are mirrored so their subjects sit away from the auth card.
	// `lock` is the subject in plate coordinates (0–1).
	const SHOTS = [
		{ id: 'page', src: '/login/page.webp', scout: 'Page scout', event: 'Change detected', lock: [0.345, 0.46], anchor: [0.5, 0.56] },
		{ id: 'vessel', src: '/login/vessel.webp', scout: 'Fleet scout', event: 'Entered watch area', lock: [0.5, 0.49], anchor: [0.4, 0.62] },
		{ id: 'council', src: '/login/council.webp', scout: 'Civic scout', event: 'Agenda item added', lock: [0.33, 0.46], anchor: [0.56, 0.54] },
		{ id: 'profile', src: '/login/profile.webp', scout: 'Social scout', event: 'Post deleted', lock: [0.295, 0.47], anchor: [0.44, 0.6] }
	] as const;

	const PLATE_W = 1600;
	const PLATE_H = 900;
	const OVERSCALE = 1.28;
	// Shot timeline in ms: glide to the subject, focus, draw the sightline, type the event, release.
	const T = { draw: 900, glide: 1100, settle: 1500, tether: 1850, type: 1950, labelOut: 6100, retract: 6300, shot: 6600 };

	type Geo = { x: number; y: number; w: number; h: number; ox: number; oy: number; cx: number; cy: number; R: number; flip: boolean };

	let vw = $state(1440);
	let vh = $state(900);
	let geo = $state<Geo[]>([]);
	let active = $state(0);
	let prev = $state(-1);
	let ready = $state(false);
	let reduced = $state(false);

	let cx = $state(0);
	let cy = $state(0);
	let r = $state(0);
	let draw = $state(0);
	let tether = $state(0);
	let point = $state(0);
	let label = $state(0);
	let chars = $state(0);
	let ping = $state(0);
	let dim = $state(0);
	let lift = $state(0);

	const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
	const unit = (v: number) => clamp(v, 0, 1);
	const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
	const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
	const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

	const mobile = $derived(vw < 640);
	const labelSize = $derived(mobile ? 10 : 12);
	const tetherLen = $derived(r * (mobile ? 1.45 : 1.8));
	const shot = $derived(SHOTS[active]);
	const g = $derived(geo[active]);
	const angle = $derived(g?.flip ? (-3 * Math.PI) / 4 : -Math.PI / 4);
	const px = $derived(cx + Math.cos(angle) * tetherLen);
	const py = $derived(cy + Math.sin(angle) * tetherLen);
	const circ = $derived(2 * Math.PI * r);
	const shade = $derived(
		`radial-gradient(circle at ${cx}px ${cy}px, rgba(9,13,15,0) ${Math.max(0, r - 1)}px, rgba(9,13,15,0.36) ${r + 1}px, rgba(9,13,15,0.6) ${r * 5}px)`
	);

	function labelWidth(s: (typeof SHOTS)[number], size: number) {
		return Math.max(s.scout.length, s.event.length + 1) * size * 0.74 + 8;
	}

	function layout(): Geo[] {
		const w0 = window.innerWidth;
		const h0 = window.innerHeight;
		const free = freeRect?.() ?? { left: 0, top: 0, right: w0, bottom: h0 * 0.6 };
		const base = Math.max(w0 / PLATE_W, h0 / PLATE_H) * OVERSCALE;
		const size = w0 < 640 ? 10 : 12;
		return SHOTS.map((sh) => {
			const k = w0 < 640 ? 1.45 : 1.8;
			// Ring, sightline, and a two-line callout must stack inside the free region's height.
			const fitH = (free.bottom - free.top - 56) / (1 + k * Math.SQRT1_2);
			const R = clamp(PLATE_W * base * 0.068, 36, Math.min(140, w0 * 0.2, fitH));
			const len = R * k;
			const reach = len * Math.SQRT1_2;
			const lw = labelWidth(sh, size);
			// Keep ring, sightline, and callout inside the free region.
			const maxRight = free.right - 16 - 14 - lw - reach;
			const minLeft = free.left + 16 + 14 + lw + reach;
			let ax = lerp(free.left, free.right, sh.anchor[0]);
			let flip = false;
			if (ax > maxRight) {
				if (maxRight >= free.left + R + 12) ax = maxRight;
				else if (ax >= minLeft) flip = true;
				else ax = Math.max(free.left + R + 12, maxRight);
			}
			const ay = clamp(lerp(free.top, free.bottom, sh.anchor[1]), free.top + reach + 44, Math.max(free.top + reach + 44, free.bottom - R - 12));
			// Zoom in just enough that the subject can sit exactly on the anchor without exposing a plate edge.
			const [lx, ly] = sh.lock;
			const s = Math.min(
				base * 1.6,
				Math.max(base, ax / (lx * PLATE_W), (w0 - ax) / ((1 - lx) * PLATE_W), ay / (ly * PLATE_H), (h0 - ay) / ((1 - ly) * PLATE_H))
			);
			const w = PLATE_W * s;
			const h = PLATE_H * s;
			const x = clamp(ax - lx * w, w0 - w, 0);
			const y = clamp(ay - ly * h, h0 - h, 0);
			return { x, y, w, h, ox: lx * w, oy: ly * h, cx: x + lx * w, cy: y + ly * h, R, flip };
		});
	}

	onMount(() => {
		reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

		let raf = 0;
		let start = 0;
		let first = true;
		let signalled = false;
		let from = { cx: 0, cy: 0, r: 0 };
		let hiddenAt = 0;
		let running = false;

		function measure() {
			vw = window.innerWidth;
			vh = window.innerHeight;
			geo = layout();
		}

		function snapTo(i: number) {
			const t = geo[i];
			cx = t.cx;
			cy = t.cy;
			r = t.R;
		}

		function frame(now: number) {
			const e = now - start;
			const t = geo[active];
			if (!t) return;

			if (first) {
				// Opening: the ring draws itself on the first subject, like the teaser's cold open.
				cx = t.cx;
				cy = t.cy;
				r = t.R;
				draw = easeOut(unit(e / T.draw));
			} else {
				const k = easeInOut(unit(e / T.glide));
				cx = lerp(from.cx, t.cx, k);
				cy = lerp(from.cy, t.cy, k);
				r = e < T.glide ? lerp(from.r, t.R * 1.14, k) : lerp(t.R * 1.14, t.R, easeOut(unit((e - T.glide) / (T.settle - T.glide))));
			}

			const rise = easeOut(unit((e - T.settle) / (T.tether - T.settle)));
			const fall = easeInOut(unit((e - T.labelOut) / (T.retract - T.labelOut)));
			tether = rise * (1 - fall);
			point = unit((e - T.tether) / 140) * (1 - fall);
			label = unit((e - T.type) / 220) * (1 - unit((e - T.labelOut) / 180));
			chars = Math.floor(unit((e - T.type - 200) / (SHOTS[active].event.length * 42)) * SHOTS[active].event.length);

			if (!signalled && e >= T.tether) {
				signalled = true;
				ping += 1;
				onsignal?.();
			}

			if (e >= T.shot) {
				first = false;
				from = { cx, cy, r };
				prev = active;
				active = (active + 1) % SHOTS.length;
				start = now;
				signalled = false;
				geo = layout();
			}

			raf = requestAnimationFrame(frame);
		}

		function play() {
			if (running || reduced || document.hidden || dim >= 1) return;
			running = true;
			if (hiddenAt) {
				start += performance.now() - hiddenAt;
				hiddenAt = 0;
			}
			raf = requestAnimationFrame(frame);
		}

		function pause() {
			if (!running) return;
			running = false;
			hiddenAt = performance.now();
			cancelAnimationFrame(raf);
		}

		function onScroll() {
			dim = unit(window.scrollY / (window.innerHeight * 0.85));
			// The scope clears out before scrolled content reaches it; the plate fades slower.
			lift = unit(window.scrollY / (window.innerHeight * 0.3));
			if (dim >= 1) pause();
			else play();
		}

		function onResize() {
			measure();
			snapTo(active);
		}

		function onVisibility() {
			if (document.hidden) pause();
			else play();
		}

		// Wait a frame so the page's bound elements exist before the free region is measured.
		const boot = requestAnimationFrame(() => {
			measure();
			snapTo(0);
			ready = true;
			if (reduced) {
				draw = 1;
				tether = 1;
				point = 1;
				label = 1;
				chars = SHOTS[0].event.length;
				return;
			}
			start = performance.now();
			onScroll();
			play();
		});

		document.fonts?.ready.then(() => {
			if (!ready) return;
			geo = layout();
		});

		window.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('resize', onResize);
		document.addEventListener('visibilitychange', onVisibility);

		return () => {
			cancelAnimationFrame(boot);
			cancelAnimationFrame(raf);
			window.removeEventListener('scroll', onScroll);
			window.removeEventListener('resize', onResize);
			document.removeEventListener('visibilitychange', onVisibility);
		};
	});
</script>

<div class="scene" class:ready class:reduced aria-hidden="true">
	<div class="plates">
		{#each SHOTS as s, i (s.id)}
			{@const p = geo[i]}
			<img
				src={s.src}
				alt=""
				decoding="async"
				fetchpriority={i === 0 ? 'high' : 'low'}
				class="plate"
				class:active={i === active}
				class:leaving={i === prev}
				style={p
					? `left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px;transform-origin:${p.ox}px ${p.oy}px`
					: ''}
			/>
		{/each}
	</div>

	<div class="shade" style="background:{shade}"></div>
	<div class="fog fog-a"></div>
	<div class="fog fog-b"></div>
	<div class="legibility"></div>

	<svg class="scope" width={vw} height={vh} viewBox="0 0 {vw} {vh}" style="opacity:{1 - lift}">
		{#key ping}
			{#if ping > 0 && !reduced}
				<circle class="ping" cx={px} cy={py} r="8" />
			{/if}
		{/key}
		<circle
			class="ring"
			{cx}
			{cy}
			{r}
			stroke-width={mobile ? 2 : 2.5}
			stroke-dasharray={circ}
			stroke-dashoffset={circ * (1 - draw)}
			transform="rotate(-45 {cx} {cy})"
		/>
		{#if tether > 0.01}
			<line
				class="sightline"
				x1={cx}
				y1={cy}
				x2={cx + Math.cos(angle) * tetherLen * tether}
				y2={cy + Math.sin(angle) * tetherLen * tether}
				stroke-width={mobile ? 1.5 : 2}
			/>
		{/if}
		<circle class="hub" {cx} {cy} r={3.5 * draw} />
		{#if point > 0}
			<circle class="point" cx={px} cy={py} r={(mobile ? 3.5 : 4.5) * point} />
		{/if}
	</svg>

	{#if label > 0 && g}
		<div
			class="callout"
			class:flip={g.flip}
			style="opacity:{label * (1 - lift)};font-size:{labelSize}px;top:{py - labelSize * 2.35}px;{g.flip
				? `right:${vw - px + 14}px`
				: `left:${px + 14}px`}"
		>
			<div class="callout-scout">{shot.scout}</div>
			<div class="callout-event">
				{shot.event.slice(0, chars)}<span class="caret" class:done={chars >= shot.event.length}>▍</span>
			</div>
		</div>
	{/if}

	<div class="vignette"></div>
	<div class="grain"></div>
	<div class="dim" style="opacity:{dim * 0.82}"></div>
</div>

<style>
	.scene {
		--nw-night: oklch(0.17 0.008 220);
		--nw-teal: oklch(0.71 0.045 200);
		--nw-ochre: oklch(0.81 0.085 82);
		--nw-frost: oklch(0.94 0.008 200);

		position: fixed;
		inset: 0;
		z-index: 0;
		overflow: hidden;
		pointer-events: none;
		background: var(--nw-night);
	}

	.scene > * {
		position: absolute;
		inset: 0;
	}

	/* Faint tripod-on-a-roof drift under a fixed scope. */
	.plates {
		inset: -12px;
		animation: drift 23s ease-in-out infinite alternate;
	}

	.plate {
		position: absolute;
		max-width: none;
		opacity: 0;
		transition: opacity 1100ms ease;
		will-change: opacity, transform;
	}

	.plate.active {
		opacity: 1;
		animation:
			push 8s linear forwards,
			meter 520ms ease-out;
	}

	/* Hold the pushed-in frame while it cross-fades out. */
	.plate.leaving {
		animation: push 8s linear forwards;
		animation-play-state: paused;
	}

	.scene:not(.ready) .plate {
		opacity: 0 !important;
	}

	@keyframes push {
		from { transform: scale(1); }
		to { transform: scale(1.055); }
	}

	/* Exposure kick on the cut, like a camera re-metering. */
	@keyframes meter {
		from { filter: brightness(1.45); }
		to { filter: brightness(1); }
	}

	@keyframes drift {
		0% { transform: translate(0, 0); }
		33% { transform: translate(5px, -3px); }
		66% { transform: translate(-3px, 4px); }
		100% { transform: translate(4px, 2px); }
	}

	.fog {
		inset: -30%;
		opacity: 0.5;
		mix-blend-mode: screen;
	}

	.fog-a {
		background: radial-gradient(ellipse 40% 26% at 30% 62%, oklch(0.5 0.03 205 / 0.22), transparent 70%);
		animation: fog-a 46s ease-in-out infinite alternate;
	}

	.fog-b {
		background: radial-gradient(ellipse 34% 22% at 72% 38%, oklch(0.58 0.025 205 / 0.16), transparent 70%);
		animation: fog-b 61s ease-in-out infinite alternate;
	}

	@keyframes fog-a {
		from { transform: translate(-6%, 2%); }
		to { transform: translate(8%, -3%); }
	}

	@keyframes fog-b {
		from { transform: translate(5%, -2%); }
		to { transform: translate(-9%, 4%); }
	}

	/* Keeps the hero caption and the auth card legible over the plate. */
	.legibility {
		background:
			linear-gradient(to top, oklch(0.15 0.008 220 / 0.9) 0%, oklch(0.15 0.008 220 / 0.5) 28%, transparent 52%),
			linear-gradient(to left, oklch(0.15 0.008 220 / 0.45) 0%, transparent 34%);
	}

	.scope {
		overflow: visible;
	}

	.ring {
		fill: none;
		stroke: var(--nw-teal);
	}

	.hub {
		fill: var(--nw-teal);
	}

	.sightline {
		stroke: var(--nw-ochre);
		stroke-linecap: round;
	}

	.point {
		fill: var(--nw-ochre);
	}

	.ping {
		fill: none;
		stroke: var(--nw-ochre);
		stroke-width: 1.5;
		transform-box: fill-box;
		transform-origin: center;
		animation: ping 900ms cubic-bezier(0.2, 0.7, 0.3, 1) forwards;
	}

	@keyframes ping {
		from { transform: scale(1); opacity: 0.85; }
		to { transform: scale(6.5); opacity: 0; }
	}

	.callout {
		inset: auto;
		position: absolute;
		font-family: var(--font-mono);
		line-height: 1.4;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.callout.flip {
		text-align: right;
	}

	.callout-scout {
		color: var(--nw-ochre);
		font-weight: 500;
	}

	.callout-event {
		color: var(--nw-frost);
	}

	.caret {
		color: var(--nw-ochre);
		animation: blink 1s steps(1) infinite;
	}

	.caret.done {
		opacity: 0;
		animation: none;
	}

	@keyframes blink {
		50% { opacity: 0; }
	}

	.vignette {
		background: radial-gradient(ellipse 85% 80% at 45% 45%, transparent 60%, oklch(0.1 0.008 220 / 0.5) 100%);
	}

	/* Film grain: one noise tile, re-seeded by jumping its position a few times a second. */
	.grain {
		inset: -120px;
		opacity: 0.11;
		mix-blend-mode: overlay;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
		animation: grain 0.8s steps(1) infinite;
	}

	@keyframes grain {
		0% { transform: translate(0, 0); }
		17% { transform: translate(-37px, 21px); }
		33% { transform: translate(53px, -44px); }
		50% { transform: translate(-18px, 67px); }
		67% { transform: translate(71px, 12px); }
		83% { transform: translate(-62px, -29px); }
	}

	.dim {
		background: var(--nw-night);
		transition: opacity 120ms linear;
	}

	@media (prefers-reduced-motion: reduce) {
		.plates,
		.plate.active,
		.fog,
		.grain,
		.caret {
			animation: none;
		}
	}
</style>
