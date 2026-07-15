<script lang="ts">
	import { Tag, X } from 'lucide-svelte';
	import { parseTopicTags } from '$lib/utils/topics';
	import * as m from '$lib/paraglide/messages';

	export let topic: string = '';
	export let existingTopics: string[] = [];
	export let placeholder: string = '';

	const MAX_TOPICS = 3;

	let showSuggestions = false;
	let topicInputEl: HTMLInputElement;
	let currentInput = '';

	// Parse comma-separated topic string into array of chips
	$: topicChips = parseTopicTags(topic);

	// Filter suggestions based on current input, excluding already-added topics
	$: filteredTopics = existingTopics.filter(
		t => t.toLowerCase().includes(currentInput.toLowerCase())
			&& !topicChips.map(c => c.toLowerCase()).includes(t.toLowerCase())
	);

	// Update the topic string when chips change
	function updateTopicString() {
		topic = topicChips.join(', ');
	}

	function addTopic(newTopic: string) {
		const trimmed = newTopic.trim();
		if (!trimmed) return;

		// Check if already exists (case-insensitive)
		if (topicChips.map(c => c.toLowerCase()).includes(trimmed.toLowerCase())) return;

		// Check max limit
		if (topicChips.length >= MAX_TOPICS) return;

		topicChips = [...topicChips, trimmed];
		updateTopicString();
		currentInput = '';
		showSuggestions = false;
	}

	function removeTopic(index: number) {
		topicChips = topicChips.filter((_, i) => i !== index);
		updateTopicString();
		// Focus input after removing
		setTimeout(() => topicInputEl?.focus(), 0);
	}

	function selectSuggestion(t: string) {
		addTopic(t);
		topicInputEl?.focus();
	}

	function handleTopicFocus() {
		if (existingTopics.length > 0 && topicChips.length < MAX_TOPICS) {
			showSuggestions = true;
		}
	}

	function handleTopicBlur() {
		// Delay to allow click on suggestion
		setTimeout(() => {
			showSuggestions = false;
			// Add current input as chip if not empty
			if (currentInput.trim()) {
				addTopic(currentInput);
			}
		}, 150);
	}

	function handleTopicInput() {
		if (existingTopics.length > 0 && topicChips.length < MAX_TOPICS) {
			showSuggestions = true;
		}
	}

	function handleTopicKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',') {
			if (currentInput.trim()) {
				e.preventDefault();
				// Remove trailing comma if user pressed comma
				const cleanInput = currentInput.replace(/,+$/, '').trim();
				addTopic(cleanInput);
			}
		} else if (e.key === 'Backspace' && !currentInput && topicChips.length > 0) {
			// Remove last chip on backspace when input is empty
			e.preventDefault();
			removeTopic(topicChips.length - 1);
		}
	}
</script>

<!-- Topic chips and input -->
<div class="topic-chips-wrapper">
	<!-- Tag icon (matches location field's MapPin) -->
	<Tag size={14} class="topic-field-icon" />
	<!-- Existing topic chips -->
	{#each topicChips as chip, index}
		<div class="topic-chip">
			<span>{chip}</span>
			<button type="button" class="chip-remove" on:click={() => removeTopic(index)}>
				<X size={12} />
			</button>
		</div>
	{/each}

	<!-- Input for new topics (hidden when max reached) -->
	{#if topicChips.length < MAX_TOPICS}
		<div class="topic-input-wrapper">
			<input
				type="text"
				bind:this={topicInputEl}
				bind:value={currentInput}
				on:focus={handleTopicFocus}
				on:blur={handleTopicBlur}
				on:input={handleTopicInput}
				on:keydown={handleTopicKeydown}
				placeholder={topicChips.length === 0 ? (placeholder || m.filter_topicPlaceholder()) : 'Add another...'}
				maxlength="50"
				class="topic-chip-input"
				autocomplete="off"
			/>
			{#if showSuggestions && filteredTopics.length > 0}
				<div class="topic-suggestions">
					{#each filteredTopics as suggestion}
						<button
							type="button"
							class="topic-suggestion"
							on:mousedown|preventDefault={() => selectSuggestion(suggestion)}
						>
							<Tag size={12} />
							<span>{suggestion}</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>
	{:else}
		<span class="max-topics-hint">Max {MAX_TOPICS} projects</span>
	{/if}
</div>

<style>
	.topic-chips-wrapper {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		min-height: 2.5rem;
		transition:
			border-color 150ms ease,
			box-shadow 150ms ease;
	}

	.topic-chips-wrapper:focus-within {
		border-color: var(--color-primary);
		box-shadow: 0 0 0 3px var(--color-primary-soft);
	}

	.topic-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.5rem;
		background: var(--color-primary-soft);
		border: 1px solid var(--color-primary);
		border-radius: 9999px;
		color: var(--color-primary-deep);
		font-size: 0.75rem;
		font-weight: 500;
		font-family: var(--font-body);
	}

	.topic-chip :global(svg) {
		flex-shrink: 0;
	}

	.chip-remove {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.125rem;
		border-radius: 9999px;
		background: transparent;
		border: none;
		color: var(--color-primary);
		cursor: pointer;
		transition:
			background 150ms ease,
			color 150ms ease;
	}

	.chip-remove:hover {
		background: color-mix(in srgb, var(--color-primary-soft) 60%, var(--color-surface-alt));
		color: var(--color-primary-deep);
	}

	.topic-input-wrapper {
		position: relative;
		flex: 1;
		min-width: 80px;
	}

	.topic-chip-input {
		width: 100%;
		padding: 0.25rem 0;
		font-size: 0.8125rem;
		font-family: var(--font-body);
		border: none;
		color: var(--color-ink);
		background: transparent;
		outline: none;
	}

	.topic-chip-input::placeholder {
		color: var(--color-ink-subtle);
	}

	.max-topics-hint {
		font-size: 0.75rem;
		color: var(--color-ink-subtle);
		font-style: italic;
	}

	.topic-suggestions {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		margin-top: 0.25rem;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		z-index: 50;
		max-height: 200px;
		overflow-y: auto;
	}

	.topic-suggestion {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.5rem 0.75rem;
		font-size: 0.8125rem;
		font-family: var(--font-body);
		color: var(--color-ink);
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
		transition: background 150ms ease;
	}

	.topic-suggestion:hover {
		background: var(--color-surface);
		color: var(--color-primary);
	}

	.topic-suggestion :global(svg) {
		color: var(--color-ink-subtle);
		flex-shrink: 0;
	}

	.topic-suggestion:hover :global(svg) {
		color: var(--color-primary);
	}

	.topic-chips-wrapper :global(.topic-field-icon) {
		color: var(--color-primary);
		flex-shrink: 0;
	}
</style>
