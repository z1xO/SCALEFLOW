-- Index experiment: the dead-letter view (status = 'failed', newest first) with and without
-- jobs_project_status_id_idx, on the project with the most jobs. Run after a load test:
--   psql "$DATABASE_URL" -f load/sql/index-experiment.sql
-- The DROP INDEX happens inside a transaction that is rolled back: nothing is changed.
\timing on
SELECT project_id AS big_project, count(*) AS jobs FROM jobs GROUP BY 1 ORDER BY 2 DESC LIMIT 1 \gset
\echo 'project' :big_project 'jobs' :jobs
SELECT status, count(*) FROM jobs WHERE project_id = :'big_project' GROUP BY 1 ORDER BY 1;

\echo '--- WITH (project_id, status, id DESC) index'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, status FROM jobs WHERE project_id = :'big_project' AND status = ANY('{failed}') ORDER BY id DESC LIMIT 51;

BEGIN;
DROP INDEX jobs_project_status_id_idx;
\echo '--- WITHOUT it (only (project_id, id DESC) remains)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, status FROM jobs WHERE project_id = :'big_project' AND status = ANY('{failed}') ORDER BY id DESC LIMIT 51;
ROLLBACK;

SELECT (:jobs * 9 / 10)::int AS deep \gset
\echo '--- page' :deep 'rows deep: keyset cursor (the cursor id is known from the previous page) vs OFFSET'
SELECT id AS cursor_id FROM jobs WHERE project_id = :'big_project' ORDER BY id DESC OFFSET :deep LIMIT 1 \gset
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id FROM jobs WHERE project_id = :'big_project'
  AND id < :'cursor_id'
ORDER BY id DESC LIMIT 51;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id FROM jobs WHERE project_id = :'big_project' ORDER BY id DESC OFFSET :deep LIMIT 51;
