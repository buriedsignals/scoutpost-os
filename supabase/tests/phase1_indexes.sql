BEGIN;
SELECT plan(15);

-- Filtering and production vector indexes on information_units
SELECT has_index('public', 'information_units', 'idx_units_project',
  '(project_id, extracted_at DESC)');
SELECT has_index('public', 'information_units', 'idx_units_occurred', '');
SELECT has_index('public', 'information_units', 'idx_units_unused', '');
SELECT has_index('public', 'information_units', 'idx_information_units_embedding_v2_hnsw',
  'embedding_v2', 'HNSW index on the production embedding_v2 column');

-- Raw captures
SELECT has_index('public', 'raw_captures', 'idx_raw_run', '');
SELECT has_index('public', 'raw_captures', 'idx_raw_user_time', '');
SELECT has_index('public', 'raw_captures', 'idx_raw_hash', '');
SELECT has_index('public', 'raw_captures', 'idx_raw_expires', '');

-- Entities
SELECT has_index('public', 'entities', 'idx_entities_user_type', '');
SELECT has_index('public', 'entities', 'idx_entities_embedding_v2_hnsw',
  'embedding_v2', 'HNSW index on the production embedding_v2 column');
SELECT has_index('public', 'unit_entities', 'idx_ue_entity', '');
SELECT has_index('public', 'unit_entities', 'idx_ue_unresolved', 'partial index for unresolved mentions');

-- Reflections
SELECT has_index('public', 'reflections', 'idx_reflections_embedding_v2_hnsw',
  'embedding_v2', 'HNSW index on the production embedding_v2 column');
SELECT has_index('public', 'reflections', 'idx_reflections_timerange', '');

-- Queues
SELECT has_index('public', 'civic_extraction_queue', 'idx_civic_queue_work',
  'partial index for pending/processing items');

SELECT * FROM finish();
ROLLBACK;
