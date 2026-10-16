import type { Queryable } from '../../infra/db/pool.js';
import type { JobEventRow } from '../jobs/model.js';

/**
 * Commit-ordered cursor over job_events: (tx_id, id). See docs/architecture.md §6 for why a plain
 * `id > last` cursor loses events under concurrent writers.
 */
export interface EventCursor {
  txId: string;
  id: string;
}

export const ORIGIN: EventCursor = { txId: '0', id: '0' };

export function formatCursor(c: EventCursor): string {
  return `${c.txId}.${c.id}`;
}

export function parseCursor(raw: string | undefined | null): EventCursor | null {
  if (!raw) return null;
  const m = /^(\d{1,20})\.(\d{1,19})$/.exec(raw.trim());
  if (!m?.[1] || !m[2]) return null;
  return { txId: m[1], id: m[2] };
}

// NB: ORDER BY must use the qualified columns (e.tx_id, e.id). Unqualified names would resolve to the
// ::text output aliases and sort lexically ('10' < '9'), silently breaking the cursor.
const COLUMNS =
  'e.id::text AS id, e.tx_id::text AS tx_id, e.project_id, e.job_id, e.type, e.data, e.created_at';

/**
 * Events after `after`, in commit order, restricted to transactions older than the oldest one
 * still running - so nothing can later appear behind the returned rows.
 */
export async function readCommittedEvents(
  db: Queryable,
  after: EventCursor,
  limit: number,
  projectIds?: readonly string[],
): Promise<JobEventRow[]> {
  const params: unknown[] = [after.txId, after.id, limit];
  let projectFilter = '';
  if (projectIds) {
    params.push(projectIds);
    projectFilter = 'AND e.project_id = ANY($4::uuid[])';
  }
  const { rows } = await db.query<JobEventRow>(
    `SELECT ${COLUMNS} FROM job_events e
     WHERE (e.tx_id, e.id) > ($1::xid8, $2::bigint)
       AND e.tx_id < pg_snapshot_xmin(pg_current_snapshot())
       ${projectFilter}
     ORDER BY e.tx_id, e.id
     LIMIT $3`,
    params,
  );
  return rows;
}

/** The newest position that is safe to start tailing from ("now"). */
export async function headCursor(db: Queryable): Promise<EventCursor> {
  const { rows } = await db.query<{ tx_id: string; id: string }>(
    `SELECT e.tx_id::text AS tx_id, e.id::text AS id FROM job_events e
     WHERE e.tx_id < pg_snapshot_xmin(pg_current_snapshot())
     ORDER BY e.tx_id DESC, e.id DESC LIMIT 1`,
  );
  const r = rows[0];
  return r ? { txId: r.tx_id, id: r.id } : ORIGIN;
}

export function cursorOf(row: Pick<JobEventRow, 'tx_id' | 'id'>): EventCursor {
  return { txId: row.tx_id, id: row.id };
}
