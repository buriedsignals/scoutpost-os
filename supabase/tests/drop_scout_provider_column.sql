BEGIN;
SELECT plan(2);

SELECT has_table(
  'public',
  'scouts',
  'scouts table remains available after provider cleanup'
);

SELECT hasnt_column(
  'public',
  'scouts',
  'provider',
  'obsolete per-scout provider column is removed'
);

SELECT * FROM finish();
ROLLBACK;
