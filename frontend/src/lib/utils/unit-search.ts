import type { Unit } from '$lib/types/workspace';
import * as m from '$lib/paraglide/messages';

export type SearchMatchCategory = NonNullable<Unit['search_match']>['category'];
export type SearchMatch = NonNullable<Unit['search_match']>;

function formatSimilarity(similarity: number | null): string | null {
	if (typeof similarity !== 'number' || !Number.isFinite(similarity)) return null;
	return `${Math.round(similarity * 100)}%`;
}

export function searchMatchLabel(match: SearchMatch): string {
	switch (match.category) {
		case 'direct':
			return m.unit_directMatch();
		case 'related':
			return formatSimilarity(match.semantic_similarity)
				? `${m.unit_semanticMatch()} ${formatSimilarity(match.semantic_similarity)}`
				: m.unit_semanticMatch();
		case 'loose':
			return m.unit_lowConfidence();
	}
}

export function searchMatchClass(category: SearchMatchCategory): string {
	return category;
}
