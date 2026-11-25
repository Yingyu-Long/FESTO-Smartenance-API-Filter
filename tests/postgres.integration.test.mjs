import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import { PostgresIncidentStore } from '../lib/festo/database.ts';

const connectionString = process.env.DATABASE_URL;
// Only synthetic, randomly scoped records are created/removed. Real cached
// accounts and machines are never touched by this integration test.
await test('real PostgreSQL persistence, isolation, rollback, concurrency and completeness', { skip: !connectionString }, async (t) => {
  const scopes = [`test-${randomUUID()}`, `test-${randomUUID()}`];
  const createdRunIds = [];
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
  let store = new PostgresIncidentStore(connectionString);
  const machine = { id: randomUUID(), name: '测试设备', number: 'T1' };
  const row = { id: randomUUID(), machineId: machine.id, number: 14887, state: 'Open', type: 'Incident',
    repairTasks: [{ id: randomUUID(), createdAt: '2026-10-01T01:00:00Z', description: '中文维修' }] };
  try {
    await store.initialize();
    await t.test('initial miss, full write, reopen and account isolation', async () => {
      assert.equal(await store.read(scopes[0], machine.id), null);
      const firstStats = await store.replace(scopes[0], machine, [row], await store.revision());
      assert.deepEqual(firstStats, { applied: true, inserted: 1, updated: 0, unchanged: 0, deleted: 0 });
      await store.close(); store = new PostgresIncidentStore(connectionString);
      const cached = await store.read(scopes[0], machine.id);
      assert.deepEqual(cached.incidents, [row]);
      assert.ok(Number.isFinite(Date.parse(cached.syncedAt)));
      assert.equal(await store.read(scopes[1], machine.id), null);
    });
    await t.test('failed multirow write rolls back old snapshot and metadata', async () => {
      const before = await store.read(scopes[0], machine.id);
      await assert.rejects(() => store.replace(scopes[0], machine, [row, row], '999999999'));
      assert.deepEqual(await store.read(scopes[0], machine.id), before);
    });
    await t.test('incremental row_hash upsert skips unchanged rows, updates changed rows and deletes removed rows', async () => {
      const a = { ...row, id: randomUUID(), number: 1 };
      const b = { ...row, id: randomUUID(), number: 2, state: 'Open' };
      const c = { ...row, id: randomUUID(), number: 3 };
      const d = { ...row, id: randomUUID(), number: 4 };

      const seedStats = await store.replace(scopes[0], machine, [a, b, c], await store.revision());
      assert.equal(seedStats.inserted, 3);
      assert.equal(seedStats.deleted, 1); // previous `row` removed

      const timestampsBefore = await pool.query(
        'SELECT incident_id, updated_at, row_hash FROM smartenance_incidents WHERE account_key = $1 AND machine_id = $2',
        [scopes[0], machine.id],
      );
      const beforeById = new Map(timestampsBefore.rows.map((r) => [r.incident_id, r]));
      assert.equal(beforeById.get(a.id).row_hash.length, 64);

      await delay(25);
      const bModified = { ...b, state: 'Closed' };
      const diffStats = await store.replace(scopes[0], machine, [a, bModified, d], await store.revision());
      assert.deepEqual(diffStats, {
        applied: true,
        inserted: 1,
        updated: 1,
        unchanged: 1,
        deleted: 1,
      });

      const timestampsAfter = await pool.query(
        'SELECT incident_id, updated_at, row_hash FROM smartenance_incidents WHERE account_key = $1 AND machine_id = $2',
        [scopes[0], machine.id],
      );
      const afterById = new Map(timestampsAfter.rows.map((r) => [r.incident_id, r]));
      // Unchanged row `a` was never rewritten in PostgreSQL:
      assert.equal(afterById.get(a.id).updated_at.toISOString(), beforeById.get(a.id).updated_at.toISOString());
      assert.equal(afterById.get(a.id).row_hash, beforeById.get(a.id).row_hash);
      // Modified row `b` was updated in place with a new hash and timestamp:
      assert.ok(afterById.get(b.id).updated_at.getTime() > beforeById.get(b.id).updated_at.getTime());
      assert.notEqual(afterById.get(b.id).row_hash, beforeById.get(b.id).row_hash);
      // Removed row `c` is gone and new row `d` exists:
      assert.equal(afterById.has(c.id), false);
      assert.equal(afterById.has(d.id), true);

      // Restore single `row` for subsequent subtests:
      await store.replace(scopes[0], machine, [row], await store.revision());
    });
    await t.test('new snapshot updates existing details and cannot be overwritten by older work', async () => {
      const oldRevision = await store.revision(), newRevision = await store.revision();
      const changed = { ...row, state: 'Closed' };
      await Promise.all([
        store.replace(scopes[0], machine, [changed], newRevision),
        store.replace(scopes[0], machine, [row], oldRevision),
      ]);
      assert.equal((await store.read(scopes[0], machine.id)).incidents[0].state, 'Closed');
    });
    await t.test('empty snapshot remains a hit and removes deleted incidents', async () => {
      await store.replace(scopes[0], machine, [], await store.revision());
      assert.deepEqual((await store.read(scopes[0], machine.id)).incidents, []);
    });
    await t.test('cancelled writes do not replace the committed snapshot', async () => {
      const abort = new AbortController(); abort.abort();
      await assert.rejects(() => store.replace(scopes[0], machine, [row], '999999999', abort.signal), { name: 'AbortError' });
      assert.deepEqual((await store.read(scopes[0], machine.id)).incidents, []);
    });
    await t.test('missing incident rows are cache misses, never complete partial snapshots', async () => {
      await store.replace(scopes[0], machine, [row], await store.revision());
      await pool.query('DELETE FROM smartenance_incidents WHERE account_key = $1 AND machine_id = $2', [scopes[0], machine.id]);
      assert.equal(await store.read(scopes[0], machine.id), null);
    });
    await t.test('advisory auto-sync lock and sync run history work across connections', async () => {
      const secondStore = new PostgresIncidentStore(connectionString);
      try {
        await secondStore.initialize();
        const lockOutcome = await store.withAutoSyncLock(async () => {
          const competing = await secondStore.withAutoSyncLock(async () => 'should-not-run');
          assert.deepEqual(competing, { acquired: false });
          return 'ok';
        });
        assert.deepEqual(lockOutcome, { acquired: true, value: 'ok' });

        const afterRelease = await secondStore.withAutoSyncLock(async () => 'acquired-after-release');
        assert.deepEqual(afterRelease, { acquired: true, value: 'acquired-after-release' });

        const runId = await store.startSyncRun('scheduled', scopes[0]);
        createdRunIds.push(runId);
        await store.finishSyncRun(runId, {
          status: 'succeeded',
          accountKey: scopes[0],
          machinesTotal: 2,
          machinesSynced: 2,
          incidentsTotal: 10,
          diff: { inserted: 2, updated: 1, unchanged: 7, deleted: 0 },
        });
        const latest = await store.latestScheduledRun();
        assert.ok(latest);
        assert.equal(latest.id, runId);
        assert.deepEqual(latest.diff, { inserted: 2, updated: 1, unchanged: 7, deleted: 0 });
        assert.ok(await store.lastSucceededScheduledAt());
      } finally {
        await secondStore.close();
      }
    });
  } finally {
    if (createdRunIds.length) {
      await pool.query('DELETE FROM smartenance_sync_runs WHERE id = ANY($1::bigint[])', [createdRunIds]).catch(() => {});
    }
    await pool.query('DELETE FROM smartenance_machines WHERE account_key = ANY($1::text[])', [scopes]).catch(() => {});
    await store.close(); await pool.end();
  }
});
