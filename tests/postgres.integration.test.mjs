import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { PostgresIncidentStore } from '../lib/festo/database.ts';

const connectionString = process.env.DATABASE_URL;
// Only synthetic, randomly scoped records are created/removed. Real cached
// accounts and machines are never touched by this integration test.
await test('real PostgreSQL persistence, isolation, rollback, concurrency and completeness', { skip: !connectionString }, async (t) => {
  const scopes = [`test-${randomUUID()}`, `test-${randomUUID()}`];
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
  let store = new PostgresIncidentStore(connectionString);
  const machine = { id: randomUUID(), name: '测试设备', number: 'T1' };
  const row = { id: randomUUID(), machineId: machine.id, number: 14887, state: 'Open', type: 'Incident',
    repairTasks: [{ id: randomUUID(), createdAt: '2026-10-01T01:00:00Z', description: '中文维修' }] };
  try {
    await store.initialize();
    await t.test('initial miss, full write, reopen and account isolation', async () => {
      assert.equal(await store.read(scopes[0], machine.id), null);
      await store.replace(scopes[0], machine, [row], await store.revision());
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
  } finally {
    await pool.query('DELETE FROM smartenance_machines WHERE account_key = ANY($1::text[])', [scopes]).catch(() => {});
    await store.close(); await pool.end();
  }
});
