/**
 * Type Definitions -- shared TypeScript types for the Scoutpost frontend.
 *
 * USED BY: api-client.ts, stores/auth.ts, stores/location.ts,
 *          stores/notifications.ts, stores/pulse.ts, stores/recent-locations.ts,
 *          utils/scouts.ts, data/onboarding-placeholders.ts,
 *          ActiveJobsModal, OnboardingModal, ScoutScheduleModal, AINewsCard,
 *          BeatScoutView, LocationAutocomplete,
 *          +layout.svelte
 * DEPENDS ON: (none)
 *
 * Central type registry. Changes here affect the entire frontend.
 * Key types: User, AuthState, GeocodedLocation, ScoutType, ActiveJob,
 * AINewsArticle, PulseSearchResponse, SearchCategory.
 */

// Scraper/Scout types
export type RegularityType = 'daily' | 'weekly' | 'monthly';
// Sub-daily cadences are transport-only; the backend rejects them for other
// scout types. Kept separate so shared scheduling stays daily/weekly/monthly.
export type TransportRegularity = '3h' | '6h' | '12h';
export type ScheduleRegularity = RegularityType | TransportRegularity;
export type MonitoringType = 'EMAIL' | 'SMS' | 'WEBHOOK';
export type ScrapeChannel = 'website' | 'social' | 'instagram' | 'facebook' | 'tiktok' | 'instagram_comments';
export interface MonitoringSetupRequest {
	name: string;
	regularity: RegularityType;
	day_number: number;
	time: string;
	monitoring: MonitoringType;
	url?: string;
	criteria?: string;
	channel?: ScrapeChannel;
	location?: GeocodedLocation;
	topic?: string;
	content_hash?: string;
	provider?: string;
}

export interface MonitoringSetupResponse {
	name: string;
	url?: string;
	criteria?: string;
	channel?: ScrapeChannel;
	monitoring: MonitoringType;
	regularity: RegularityType;
	day_number: number;
	time: string;
	timezone: string;
	cron_expression: string;
	metadata: Record<string, unknown>;
}

// Active Jobs types
export interface ActiveJobLastRun {
	last_run: string; // Format: MM:DD:YYYY HH:MM
	scraper_status: boolean;
	criteria_status: boolean;
	// Extended fields from scout execution (for expanded card view)
	summary?: string;
	card_summary?: string; // AI-generated 1-sentence summary from EXEC# (max 150 chars)
	url?: string;
	criteria?: string;
	notification_sent?: boolean;
	// Type-specific run data
	articles_count?: number;
	results_count?: number;
	matched_count?: number;
	total_items?: number;
	matched_items?: number;
}

// Scout types for multi-type system
export type ScoutType = 'web' | 'pulse' | 'social' | 'civic' | 'transport';

export interface ActiveJob {
	scraper_name: string;
	scout_type?: ScoutType;  // Scout type (defaults to 'web' for legacy)
	regularity?: 'daily' | 'weekly' | 'monthly';  // From SCRAPER# metadata
	time?: string;  // Original schedule time (e.g., "10:20") for display
	last_run: ActiveJobLastRun | null;
	// Type-specific fields
	url?: string;  // web
	criteria?: string;  // web, pulse
	location?: GeocodedLocation;  // pulse
	topic?: string;  // pulse (free-text topic)
	created_at?: string;
	// Social scout fields
	platform?: string;  // social (instagram, x)
	profile_handle?: string;  // social (@username)
	monitor_mode?: string;  // social (summarize, criteria)
	track_removals?: boolean;  // social
	// Civic scout fields
	root_domain?: string;  // civic
	tracked_urls?: string[];  // civic
}

export interface ActiveJobsResponse {
	user: string;
	scrapers: ActiveJob[];
}

// Scout Setup types
export interface ScoutSetupRequest {
	name: string;
	scout_type: ScoutType;
	regularity: ScheduleRegularity;
	day_number: number;
	time: string;
	monitoring: MonitoringType;
	// Type-specific fields
	url?: string;  // web
	config?: Record<string, unknown>;  // transport (mode/geofence/watch_ids/…)
	criteria?: string;  // web, pulse
	location?: GeocodedLocation;  // pulse
	topic?: string;  // pulse (free-text topic)
	source_mode?: 'reliable' | 'niche';  // pulse only
	excluded_domains?: string[];  // pulse only
	priority_sources?: string[];  // pulse only
	// Social scout fields
	platform?: string;  // social
	profile_handle?: string;  // social
	monitor_mode?: string;  // social
	track_removals?: boolean;  // social
	baseline_posts?: Record<string, unknown>[];  // social (baseline from scan)
	// Civic scout fields
	root_domain?: string;  // civic
	tracked_urls?: string[];  // civic
	initial_promises?: Array<{ promise_text: string; context: string; source_url: string; source_date: string; due_date?: string; date_confidence: string; criteria_match: boolean }>;  // civic
}

export interface ScoutSetupResponse extends MonitoringSetupResponse {
	scout_type: ScoutType;
	location?: GeocodedLocation;
	topic?: string;
}

// Notification types for browser-based notifications
export interface Notification {
	id: string;
	scraperName: string;
	timestamp: number;
}

// Auth types
export type UserTier = 'free' | 'pro' | 'team';

export interface TeamInfo {
	org_id: string;
	org_name: string;
	seat_count: number;
}

export interface User {
	user_id: string;
	email?: string | null;
	muckrock_id: string;
	username?: string;
	credits: number;
	timezone: string | null;
	default_location: GeocodedLocation | null;
	needs_initialization: boolean;
	onboarding_completed: boolean;
	preferred_language: string | null;
	tier: UserTier;
	upgrade_url?: string;
	team_upgrade_url?: string;
	excluded_domains: string[];
	team?: TeamInfo | null;
	org_id?: string | null;
	// Weekly scout-health-monitor digest opt-in (default true server-side).
	health_notifications_enabled?: boolean;
}

export interface AuthState {
	authenticated: boolean;
	user: User | null;
}

// News types
export interface GeocodedLocation {
	displayName: string;      // "Zurich, Switzerland" - for display
	city?: string;            // "Zurich" - for Perigon cities[]
	state?: string;           // "ZH" - for Perigon states[] (2-char ISO)
	country: string;          // "CH" - for Perigon countries[] (2-letter ISO)
	locationType: 'city' | 'state' | 'country';  // What level was selected
	maptilerId?: string;      // Original MapTiler feature ID for reference
	coordinates?: {
		lat: number;
		lon: number;
	};
}

export type SearchCategory = 'news' | 'government' | 'analysis';

/**
 * AI-verified news article with summary.
 */
export interface AINewsArticle {
	title: string;
	url: string;
	source: string;
	summary: string;
	date?: string | null;
	imageUrl?: string | null;
	verified: boolean;
}

/**
 * Base fields shared by all local search responses.
 */
interface BaseSearchResponse {
	status: 'completed' | 'partial' | 'not_found' | 'failed';
	category: SearchCategory;
	task_completed: boolean;
	articles: AINewsArticle[];
	totalResults: number;
	search_queries_used: string[];
	urls_scraped: string[];
	processing_time_ms?: number | null;
	error?: string;
}

/**
 * Pulse search response (Beat Scout).
 * Primary output: summary field.
 */
export interface PulseSearchResponse extends BaseSearchResponse {
	summary: string;
	response_markdown: string;
	filteredOutCount?: number;
}

/**
 * Structured summary combining news and government summaries.
 */
export interface StructuredSummary {
	news_summary: string;
	gov_summary: string;
}

/**
 * Custom filter prompts for AI filtering.
 */
export interface FilterPrompts {
	news: string | null;
	government: string | null;
}
