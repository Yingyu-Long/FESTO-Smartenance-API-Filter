import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { FestoError } from "./client.ts";
import type { Incident, Machine, SyncDiffStats, SyncRunSummary } from "./types.ts";

export interface IncidentSnapshot { incidents: Incident[]; syncedAt: string }
export interface ReplaceResult extends SyncDiffStats { applied: boolean }
export interface IncidentStore {
  read(account: string, machineId: string): Promise<IncidentSnapshot | null>;
  revision(): Promise<string>;
  replace(
    account: string,
    machine: Machine,
    incidents: Incident[],
    revision: string,
    signal?: AbortSignal,
  ): Promise<ReplaceResult | void>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function incidentRowHash(incident: Incident): string {
  return createHash("sha256").update(canonicalJson(incident)).digest("hex");
}

// Only call after the same token has successfully authenticated with Festo.
// Upstream authentication, not merely decoding a JWT, establishes the identity.
export function accountKeyForVerifiedToken(token: string): string {
  let identity = `token:${token}`;
  try {
    const parts = token.split('.');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (parts.length === 3 && typeof claims.iss === 'string' && claims.iss &&
        typeof claims.sub === 'string' && claims.sub) {
      identity = JSON.stringify([claims.iss, claims.sub, claims.aud ?? null, claims.tid ?? null]);
    }
  } catch { /* Opaque tokens use isolated hashes and cannot share accounts. */ }
  return createHash('sha256').update(identity).digest('hex');
}

function databaseError() {
  return new FestoError("PostgreSQL is unavailable. Check DATABASE_URL and the database service, then try again.", 503);
}

function toSyncRunSummary(row: Record<string, unknown>): SyncRunSummary {
  return {
    id: String(row.id),
    triggerSource: row.trigger_source as "scheduled" | "manual",
    status: row.status as "running" | "succeeded" | "failed",
    machinesTotal: Number(row.machines_total ?? 0),
    machinesSynced: Number(row.machines_synced ?? 0),
    incidentsTotal: Number(row.incidents_total ?? 0),
    diff: {
      inserted: Number(row.incidents_inserted ?? 0),
      updated: Number(row.incidents_updated ?? 0),
      unchanged: Number(row.incidents_unchanged ?? 0),
      deleted: Number(row.incidents_deleted ?? 0),
    },
    startedAt: (row.started_at as Date).toISOString(),
    finishedAt: row.finished_at ? (row.finished_at as Date).toISOString() : null,
    errorMessage: typeof row.error_message === "string" ? row.error_message : null,
  };
}

export class PostgresIncidentStore implements IncidentStore {
  private pool: pg.Pool;
  private ready?: Promise<void>;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000, statement_timeout: 30000 });
    // Never log connection strings, credentials or database rows.
    this.pool.on('error', () => {});
  }
  async initialize() {
    this.ready ??= (async () => {
      const sql = await readFile(resolve(process.cwd(), 'db/schema.sql'), 'utf8');
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('smartenance-schema-v1', 0))");
        await client.query(sql);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    })().catch(() => { this.ready = undefined; throw databaseError(); });
    return this.ready;
  }
  async read(account: string, machineId: string): Promise<IncidentSnapshot | null> {
    await this.initialize();
    try {
      // One statement sees a consistent committed machine snapshot, including
      // an explicitly complete empty machine. Missing rows are a cache miss.
      const result = await this.pool.query(`
        SELECT m.synced_at, m.incident_count,
          COALESCE(jsonb_agg(i.incident ORDER BY i.incident_id)
            FILTER (WHERE i.incident_id IS NOT NULL), '[]'::jsonb) AS incidents
        FROM smartenance_machines m LEFT JOIN smartenance_incidents i
          USING (account_key, machine_id)
        WHERE m.account_key = $1 AND m.machine_id = $2
        GROUP BY m.account_key, m.machine_id`, [account, machineId]);
      const row = result.rows[0];
      if (!row || row.incidents.length !== row.incident_count) return null;
      return { incidents: row.incidents, syncedAt: row.synced_at.toISOString() };
    } catch { throw databaseError(); }
  }
  async revision(): Promise<string> {
    await this.initialize();
    try {
      const result = await this.pool.query("SELECT nextval('smartenance_snapshot_revision') AS revision");
      return String(result.rows[0].revision);
    } catch { throw databaseError(); }
  }
  async replace(
    account: string,
    machine: Machine,
    incidents: Incident[],
    revision: string,
    signal?: AbortSignal,
  ): Promise<ReplaceResult> {
    await this.initialize();
    signal?.throwIfAborted();
    const client = await this.pool.connect().catch(() => { throw databaseError(); });
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${account}:${machine.id}`]);
      signal?.throwIfAborted();
      // Older in-flight queries must not overwrite a newer sync snapshot.
      const updated = await client.query(`
        INSERT INTO smartenance_machines (account_key, machine_id, machine, revision, incident_count)
        VALUES ($1, $2, $3::jsonb, $4, $5)
        ON CONFLICT (account_key, machine_id) DO UPDATE
          SET machine = EXCLUDED.machine, revision = EXCLUDED.revision,
              incident_count = EXCLUDED.incident_count, synced_at = clock_timestamp()
          WHERE smartenance_machines.revision < EXCLUDED.revision
        RETURNING machine_id`, [account, machine.id, JSON.stringify(machine), revision, incidents.length]);
      if (!updated.rowCount) {
        await client.query('COMMIT');
        return { applied: false, inserted: 0, updated: 0, unchanged: 0, deleted: 0 };
      }

      // Incremental row_hash diff: only insert new rows, update modified rows,
      // and delete rows that no longer exist upstream.
      const existingResult = await client.query<{ incident_id: string; row_hash: string }>(
        'SELECT incident_id, row_hash FROM smartenance_incidents WHERE account_key = $1 AND machine_id = $2',
        [account, machine.id],
      );
      const existing = new Map(existingResult.rows.map((r) => [r.incident_id, r.row_hash]));
      const seen = new Set<string>();
      let inserted = 0;
      let updatedCount = 0;
      let unchanged = 0;
      const toInsert: { id: string; incident: Incident; hash: string }[] = [];
      const toUpdate: { id: string; incident: Incident; hash: string }[] = [];

      for (const incident of incidents) {
        const hash = incidentRowHash(incident);
        if (seen.has(incident.id)) {
          // Force a genuine PostgreSQL primary-key violation and full transaction rollback.
          toInsert.push({ id: incident.id, incident, hash });
          continue;
        }
        seen.add(incident.id);
        const prevHash = existing.get(incident.id);
        if (prevHash === undefined) {
          inserted++;
          toInsert.push({ id: incident.id, incident, hash });
        } else if (prevHash !== hash) {
          updatedCount++;
          toUpdate.push({ id: incident.id, incident, hash });
        } else {
          unchanged++;
        }
      }

      const removedIds: string[] = [];
      for (const existingId of existing.keys()) {
        if (!seen.has(existingId)) removedIds.push(existingId);
      }

      if (removedIds.length > 0) {
        signal?.throwIfAborted();
        await client.query(
          'DELETE FROM smartenance_incidents WHERE account_key = $1 AND machine_id = $2 AND incident_id = ANY($3::uuid[])',
          [account, machine.id, removedIds],
        );
      }

      for (let offset = 0; offset < toInsert.length; offset += 500) {
        signal?.throwIfAborted();
        await client.query(`
          INSERT INTO smartenance_incidents (account_key, machine_id, incident_id, incident, row_hash, updated_at)
          SELECT $1, $2, (item->>'id')::uuid, item->'incident', item->>'hash', clock_timestamp()
          FROM jsonb_array_elements($3::jsonb) AS item`,
        [account, machine.id, JSON.stringify(toInsert.slice(offset, offset + 500))]);
      }

      for (let offset = 0; offset < toUpdate.length; offset += 500) {
        signal?.throwIfAborted();
        await client.query(`
          INSERT INTO smartenance_incidents (account_key, machine_id, incident_id, incident, row_hash, updated_at)
          SELECT $1, $2, (item->>'id')::uuid, item->'incident', item->>'hash', clock_timestamp()
          FROM jsonb_array_elements($3::jsonb) AS item
          ON CONFLICT (account_key, machine_id, incident_id) DO UPDATE
            SET incident = EXCLUDED.incident,
                row_hash = EXCLUDED.row_hash,
                updated_at = clock_timestamp()`,
        [account, machine.id, JSON.stringify(toUpdate.slice(offset, offset + 500))]);
      }

      signal?.throwIfAborted();
      await client.query('COMMIT');
      return { applied: true, inserted, updated: updatedCount, unchanged, deleted: removedIds.length };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (signal?.aborted) throw signal.reason;
      if (error instanceof FestoError) throw error;
      throw databaseError();
    } finally { client.release(); }
  }
  async withAutoSyncLock<T>(
    run: () => Promise<T>,
  ): Promise<{ acquired: false } | { acquired: true; value: T }> {
    await this.initialize();
    const client = await this.pool.connect().catch(() => { throw databaseError(); });
    let locked = false;
    try {
      const res = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended('smartenance-auto-sync-v1', 0)) AS locked",
      );
      locked = Boolean(res.rows[0]?.locked);
      if (!locked) return { acquired: false };
      const value = await run();
      return { acquired: true, value };
    } finally {
      if (locked) {
        await client
          .query("SELECT pg_advisory_unlock(hashtextextended('smartenance-auto-sync-v1', 0))")
          .catch(() => {});
      }
      client.release();
    }
  }
  async startSyncRun(
    triggerSource: "scheduled" | "manual",
    accountKey: string | null = null,
  ): Promise<string> {
    await this.initialize();
    try {
      const result = await this.pool.query<{ id: string }>(
        `INSERT INTO smartenance_sync_runs (trigger_source, account_key, status)
         VALUES ($1, $2, 'running')
         RETURNING id`,
        [triggerSource, accountKey],
      );
      return String(result.rows[0].id);
    } catch { throw databaseError(); }
  }
  async finishSyncRun(
    id: string,
    outcome: {
      status: "succeeded" | "failed";
      accountKey?: string | null;
      machinesTotal?: number;
      machinesSynced?: number;
      incidentsTotal?: number;
      diff?: SyncDiffStats;
      errorMessage?: string | null;
    },
  ): Promise<void> {
    await this.initialize();
    try {
      await this.pool.query(
        `UPDATE smartenance_sync_runs
         SET status = $2,
             account_key = COALESCE($3, account_key),
             machines_total = $4,
             machines_synced = $5,
             incidents_total = $6,
             incidents_inserted = $7,
             incidents_updated = $8,
             incidents_unchanged = $9,
             incidents_deleted = $10,
             finished_at = clock_timestamp(),
             error_message = $11
         WHERE id = $1`,
        [
          id,
          outcome.status,
          outcome.accountKey ?? null,
          outcome.machinesTotal ?? 0,
          outcome.machinesSynced ?? 0,
          outcome.incidentsTotal ?? 0,
          outcome.diff?.inserted ?? 0,
          outcome.diff?.updated ?? 0,
          outcome.diff?.unchanged ?? 0,
          outcome.diff?.deleted ?? 0,
          outcome.errorMessage ?? null,
        ],
      );
    } catch { throw databaseError(); }
  }
  async latestScheduledRun(): Promise<SyncRunSummary | null> {
    await this.initialize();
    try {
      const result = await this.pool.query(
        `SELECT *
         FROM smartenance_sync_runs
         WHERE trigger_source = 'scheduled'
         ORDER BY started_at DESC, id DESC
         LIMIT 1`,
      );
      return result.rows[0] ? toSyncRunSummary(result.rows[0]) : null;
    } catch { throw databaseError(); }
  }
  async lastSucceededScheduledAt(): Promise<string | null> {
    await this.initialize();
    try {
      const result = await this.pool.query<{ finished_at: Date }>(
        `SELECT finished_at
         FROM smartenance_sync_runs
         WHERE trigger_source = 'scheduled' AND status = 'succeeded' AND finished_at IS NOT NULL
         ORDER BY finished_at DESC, id DESC
         LIMIT 1`,
      );
      return result.rows[0]?.finished_at ? result.rows[0].finished_at.toISOString() : null;
    } catch { throw databaseError(); }
  }
  async close() { await this.pool.end(); }
}

// Reuse the pool across Vite development reloads, as well as production requests.
const shared = globalThis as typeof globalThis & { festoPostgres?: PostgresIncidentStore };
export function getIncidentStore(): PostgresIncidentStore {
  if (!process.env.DATABASE_URL)
    throw new FestoError("Configure DATABASE_URL to enable the PostgreSQL database.", 503);
  return shared.festoPostgres ??= new PostgresIncidentStore(process.env.DATABASE_URL);
}
