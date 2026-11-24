import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { FestoError } from "./client.ts";
import type { Incident, Machine } from "./types.ts";

export interface IncidentSnapshot { incidents: Incident[]; syncedAt: string }
export interface IncidentStore {
  read(account: string, machineId: string): Promise<IncidentSnapshot | null>;
  revision(): Promise<string>;
  replace(account: string, machine: Machine, incidents: Incident[], revision: string, signal?: AbortSignal): Promise<void>;
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
  async replace(account: string, machine: Machine, incidents: Incident[], revision: string, signal?: AbortSignal) {
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
      if (updated.rowCount) {
        await client.query('DELETE FROM smartenance_incidents WHERE account_key = $1 AND machine_id = $2', [account, machine.id]);
        for (let offset = 0; offset < incidents.length; offset += 500) {
          signal?.throwIfAborted();
          await client.query(`INSERT INTO smartenance_incidents (account_key, machine_id, incident_id, incident)
            SELECT $1, $2, (item->>'id')::uuid, item FROM jsonb_array_elements($3::jsonb) AS item`,
          [account, machine.id, JSON.stringify(incidents.slice(offset, offset + 500))]);
        }
      }
      signal?.throwIfAborted();
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (signal?.aborted) throw signal.reason;
      if (error instanceof FestoError) throw error;
      throw databaseError();
    } finally { client.release(); }
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
