-- 00072_transport_scout.sql
-- Transport Scout (U1): fifth scout type monitoring vessels (AIS), aircraft
-- (ADS-B), and satellites (GP/SGP4) with enter-only alerting.
--
--   * scouts.type gains 'transport'; scouts.regularity gains the transport
--     sub-daily window ('3h','6h','12h') — 3h floor enforced in the scouts
--     Edge Function via schedule_policy.ts.
--   * transport_geofence_presets: seeded, ready-made watch areas.
--   * transport_positions: shared AIS position cache written by the
--     transport-sampler Edge Function (lands in U3), 24h TTL.
--   * transport_gp_cache: daily CelesTrak GP (OMM/JSON) cache (U4).
--   * transport_scout_state: per-scout positional alert state — the
--     enter-only "alert once" dedup replacement.
--   * transport_watchlists: curated identifier lists (plane-alert-db import
--     lands in U5).
--
-- RLS posture:
--   * transport_scout_state is per-user readable (00038 pattern), worker
--     (service-role) written.
--   * shared tables are service-role written; presets/watchlists readable by
--     authenticated users, positions/gp_cache service-only (00068 posture).

BEGIN;

-- ============================================================
-- scouts.type + scouts.regularity constraint extensions
-- ============================================================
ALTER TABLE scouts
DROP CONSTRAINT IF EXISTS scouts_type_check;

ALTER TABLE scouts
ADD CONSTRAINT scouts_type_check
CHECK (type = ANY (ARRAY['web'::text, 'beat'::text, 'social'::text, 'civic'::text, 'transport'::text]));

ALTER TABLE scouts
DROP CONSTRAINT IF EXISTS scouts_regularity_check;

ALTER TABLE scouts
ADD CONSTRAINT scouts_regularity_check
CHECK (regularity = ANY (ARRAY['daily'::text, 'weekly'::text, 'monthly'::text, '3h'::text, '6h'::text, '12h'::text]));

-- ============================================================
-- Geofence presets (seeded reference data)
-- ============================================================
CREATE TABLE transport_geofence_presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    region TEXT NOT NULL,
    min_lat DOUBLE PRECISION NOT NULL,
    min_lon DOUBLE PRECISION NOT NULL,
    max_lat DOUBLE PRECISION NOT NULL,
    max_lon DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_preset_bbox CHECK (min_lat < max_lat AND min_lon < max_lon)
);

ALTER TABLE transport_geofence_presets ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON transport_geofence_presets FROM anon, authenticated;
CREATE POLICY transport_presets_read ON transport_geofence_presets
  FOR SELECT TO anon, authenticated USING (true);

INSERT INTO transport_geofence_presets (id, name, region, min_lat, min_lon, max_lat, max_lon) VALUES
  ('strait-of-hormuz',        'Strait of Hormuz',          'Middle East / Red Sea',      25.5,  55.0,  27.5,  57.5),
  ('bab-el-mandeb',           'Bab-el-Mandeb',             'Middle East / Red Sea',      12.0,  42.5,  14.0,  44.5),
  ('suez-approaches',         'Suez Canal approaches',     'Middle East / Red Sea',      29.0,  32.0,  32.0,  34.5),
  ('strait-of-malacca',       'Strait of Malacca',         'Asia-Pacific',                1.0,  98.0,   6.5, 104.0),
  ('taiwan-strait',           'Taiwan Strait',             'Asia-Pacific',               22.5, 118.0,  26.0, 121.5),
  ('spratly-box',             'Spratly Islands box',       'Asia-Pacific',                7.5, 111.0,  12.0, 116.5),
  ('bosphorus',               'Bosphorus',                 'Europe / Black Sea',         40.8,  28.7,  41.5,  29.4),
  ('kerch-strait',            'Kerch Strait',              'Europe / Black Sea',         44.8,  36.0,  45.7,  37.0),
  ('black-sea-grain-corridor','Black Sea grain corridor',  'Europe / Black Sea',         43.5,  28.5,  46.5,  33.5),
  ('dover-strait',            'Dover Strait',              'Europe',                     50.5,   0.5,  51.5,   2.5),
  ('strait-of-gibraltar',     'Strait of Gibraltar',       'Europe',                     35.5,  -6.5,  36.5,  -4.5),
  ('danish-straits',          'Danish Straits',            'Europe / Baltic',            54.5,   9.5,  56.5,  13.0),
  ('gulf-of-finland',         'Gulf of Finland',           'Europe / Baltic',            59.0,  22.5,  60.8,  30.5),
  ('panama-approaches',       'Panama Canal approaches',   'Americas',                    8.5, -80.5,  10.0, -79.0),
  ('cape-of-good-hope',       'Cape of Good Hope corridor','Africa',                    -35.5,  17.0, -33.5,  20.5);

-- ============================================================
-- Shared AIS position cache (written by transport-sampler, U3)
-- ============================================================
CREATE TABLE transport_positions (
    mmsi TEXT PRIMARY KEY,
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    course DOUBLE PRECISION,
    speed_knots DOUBLE PRECISION,
    heading DOUBLE PRECISION,
    nav_status INT,
    ship_type INT,
    classification TEXT,
    name TEXT,
    flag TEXT,
    seen_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_transport_positions_seen_at ON transport_positions (seen_at);
-- Worker geofence queries are lat/lon range scans over a bounded table.
CREATE INDEX idx_transport_positions_lat_lon ON transport_positions (lat, lon);

ALTER TABLE transport_positions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON transport_positions FROM anon, authenticated;

-- ============================================================
-- Satellite GP (OMM/JSON) cache — refreshed daily from CelesTrak (U4)
-- ============================================================
CREATE TABLE transport_gp_cache (
    norad_id INT PRIMARY KEY,
    name TEXT,
    omm JSONB NOT NULL,
    epoch TIMESTAMPTZ,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE transport_gp_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON transport_gp_cache FROM anon, authenticated;

-- ============================================================
-- Per-scout positional alert state (enter-only alerting)
-- ============================================================
CREATE TABLE transport_scout_state (
    scout_id UUID NOT NULL REFERENCES scouts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    object_id TEXT NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    alerted_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (scout_id, object_id)
);

CREATE INDEX idx_transport_scout_state_user ON transport_scout_state (user_id);
CREATE INDEX idx_transport_scout_state_last_seen ON transport_scout_state (last_seen);

ALTER TABLE transport_scout_state ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON transport_scout_state FROM anon, authenticated;
CREATE POLICY transport_state_read ON transport_scout_state
  FOR SELECT USING ((SELECT auth.uid()) = user_id);

-- ============================================================
-- Curated watchlists (plane-alert-db import lands in U5)
-- ============================================================
CREATE TABLE transport_watchlists (
    ident_type TEXT NOT NULL CHECK (ident_type IN ('mmsi', 'icao_hex', 'norad')),
    ident TEXT NOT NULL,
    name TEXT,
    category TEXT NOT NULL,
    source TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (ident_type, ident)
);

CREATE INDEX idx_transport_watchlists_category ON transport_watchlists (category);

ALTER TABLE transport_watchlists ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON transport_watchlists FROM anon, authenticated;
CREATE POLICY transport_watchlists_read ON transport_watchlists
  FOR SELECT TO authenticated USING (true);

-- ============================================================
-- Retention: positions age out after 24h; satellite pass-state rows after
-- 30 days; GP rows gone stale (no refresh in 7 days) are dropped.
-- Bounded DELETEs mirror cleanup_raw_captures (00014).
-- ============================================================
CREATE OR REPLACE FUNCTION cleanup_transport_data()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    DELETE FROM transport_positions WHERE mmsi IN (
        SELECT mmsi FROM transport_positions
        WHERE seen_at < NOW() - INTERVAL '24 hours'
        LIMIT 50000
    );
    DELETE FROM transport_scout_state WHERE (scout_id, object_id) IN (
        SELECT scout_id, object_id FROM transport_scout_state
        WHERE object_id LIKE 'pass:%'
          AND last_seen < NOW() - INTERVAL '30 days'
        LIMIT 50000
    );
    DELETE FROM transport_gp_cache WHERE norad_id IN (
        SELECT norad_id FROM transport_gp_cache
        WHERE fetched_at < NOW() - INTERVAL '7 days'
        LIMIT 50000
    );
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_transport_data()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_transport_data()
  TO service_role;

SELECT cron.unschedule('cleanup-transport-data')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'cleanup-transport-data'
);

SELECT cron.schedule(
  'cleanup-transport-data',
  '23 * * * *',
  'SELECT public.cleanup_transport_data();'
);

COMMIT;
