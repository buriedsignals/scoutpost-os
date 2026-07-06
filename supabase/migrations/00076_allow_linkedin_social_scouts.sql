-- Allow LinkedIn as a first-class social scout platform (personal profiles
-- only — company-page inputs are rejected at validation in the scouts and
-- social-test Edge Functions). Mirrors 00045_allow_tiktok_social_scouts.sql.

ALTER TABLE scouts
DROP CONSTRAINT IF EXISTS scouts_platform_check;

ALTER TABLE scouts
ADD CONSTRAINT scouts_platform_check
CHECK (platform IN ('instagram', 'x', 'facebook', 'tiktok', 'linkedin'));
