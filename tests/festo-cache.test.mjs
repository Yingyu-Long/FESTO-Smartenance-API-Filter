import assert from 'node:assert/strict';
import test from 'node:test';
import { FestoClient, FestoError } from '../lib/festo/client.ts';
import { collectCachedRepairs, syncDatabase, validateSnapshot } from '../lib/festo/cached-repairs.ts';
import { accountKeyForVerifiedToken } from '../lib/festo/database.ts';
import { createOperationStream } from '../lib/festo/export-stream.ts';
import { readOperationResult } from '../lib/festo/stream-client.ts';

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const machine = { id: id(1), name: '设备一', number: 'M1' };
const second = { id: id(2), name: '设备二', number: 'M2' };
const token = 'test-account';
const signal = () => new AbortController().signal;
const emit = () => {};
const filters = { machineIds: [machine.id], from: '2026-10-01', to: '2026-10-01', incidentState: 'Closed' };
const incident = (n, owner = machine.id, state = 'Closed', date = '2026-10-01T01:00:00Z') => ({
  id: id(n), machineId: owner, type: 'Incident', number: n, state,
  repairTasks: [{ id: id(n + 100), createdAt: date, description: '初次维修', result: 'Success' }],
});
class MemoryStore {
  data = new Map(); sequence = 0; reads = 0; writes = 0;
  async revision() { return String(++this.sequence); }
  async read(account, machineId) { this.reads++; return structuredClone(this.data.get(`${account}:${machineId}`) ?? null); }
  async replace(account, machine, incidents, revision, abort) {
    abort?.throwIfAborted();
    this.writes++;
    this.data.set(`${account}:${machine.id}`, { incidents: structuredClone(incidents), revision, syncedAt: new Date().toISOString() });
  }
}
function fixture(records, machines = [machine]) {
  const client = new FestoClient(token); const calls = { machines: 0, bulk: [] };
  client.machines = async () => { calls.machines++; return machines; };
  client.bulkIncidents = async (machineId) => { calls.bulk.push(machineId); return structuredClone(records.filter((r) => r.machineId === machineId)); };
  client.get = async () => assert.fail('Unexpected detail call');
  return { client, calls };
}

test('query miss saves complete machine data; broader date/status queries hit persistent cache', async () => {
  const store = new MemoryStore();
  const records = [incident(10), incident(11, machine.id, 'Open', '2020-01-01T00:00:00Z')];
  const first = fixture(records);
  const result = await collectCachedRepairs(token, filters, emit, signal(), { store, client: first.client });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].incidentNumber, '10');
  assert.equal(result.retrieval.bulkMachines, 1);
  assert.equal(store.writes, 1);
  assert.equal((await store.read(accountKeyForVerifiedToken(token), machine.id)).incidents.length, 2);
  const next = fixture([]);
  const broader = await collectCachedRepairs(token, { ...filters, from: '2019-01-01', incidentState: 'All' }, emit, signal(), { store, client: next.client });
  assert.equal(broader.rows.length, 2);
  assert.equal(broader.retrieval.databaseMachines, 1);
  assert.deepEqual(next.calls, { machines: 1, bulk: [] });
});

test('empty machine snapshot is a cache hit; different account cannot read it', async () => {
  const store = new MemoryStore();
  const first = fixture([]);
  await collectCachedRepairs(token, filters, emit, signal(), { store, client: first.client });
  const next = fixture([]);
  assert.equal((await collectCachedRepairs(token, filters, emit, signal(), { store, client: next.client })).rows.length, 0);
  assert.equal(next.calls.bulk.length, 0);
  const other = fixture([incident(10)]);
  assert.equal((await collectCachedRepairs('other-account', filters, emit, signal(), { store, client: other.client })).rows.length, 1);
  assert.equal(other.calls.bulk.length, 1);
});

test('sync refreshes all machines, updates existing repairs and removes deleted incidents', async () => {
  const store = new MemoryStore();
  await syncDatabase(token, emit, signal(), { store, client: fixture([incident(10), incident(11)], [machine, second]).client });
  const changed = incident(10, machine.id, 'Open'); changed.repairTasks[0].description = '更新维修';
  const current = fixture([changed, incident(12, second.id)], [machine, second]);
  const synced = await syncDatabase(token, emit, signal(), { store, client: current.client });
  assert.equal(synced.syncedMachines, 2);
  assert.equal(synced.incidents, 2);
  assert.deepEqual(current.calls.bulk, [machine.id, second.id]);
  const a = await store.read(accountKeyForVerifiedToken(token), machine.id);
  assert.deepEqual(a.incidents.map((r) => r.id), [id(10)]);
  assert.equal(a.incidents[0].repairTasks[0].description, '更新维修');
  const queried = await collectCachedRepairs(token, { ...filters, machineIds: [machine.id, second.id], incidentState: 'All' }, emit, signal(),
    { store, client: fixture([], [machine, second]).client });
  assert.equal(queried.retrieval.databaseMachines, 2);
});

test('failed or cancelled machine never replaces old complete data; completed machines remain saved', async () => {
  const store = new MemoryStore();
  await syncDatabase(token, emit, signal(), { store, client: fixture([incident(10), incident(11, second.id)], [machine, second]).client });
  const broken = fixture([incident(12)], [machine, second]);
  const bulk = broken.client.bulkIncidents;
  broken.client.bulkIncidents = async (machineId) => {
    if (machineId === second.id) throw new FestoError('test failure', 401);
    return bulk(machineId);
  };
  await assert.rejects(() => syncDatabase(token, emit, signal(), { store, client: broken.client }), /test failure/);
  assert.equal((await store.read(accountKeyForVerifiedToken(token), machine.id)).incidents[0].id, id(12));
  assert.equal((await store.read(accountKeyForVerifiedToken(token), second.id)).incidents[0].id, id(11));
  const abort = new AbortController(); const cancelled = fixture([incident(13)]);
  cancelled.client.bulkIncidents = async () => { abort.abort(); return [incident(13)]; };
  await assert.rejects(() => syncDatabase(token, emit, abort.signal, { store, client: cancelled.client }), { name: 'AbortError' });
  assert.equal((await store.read(accountKeyForVerifiedToken(token), machine.id)).incidents[0].id, id(12));
});

test('expired tokens and removed machine permissions are checked before reading cache', async () => {
  const store = new MemoryStore();
  const revoked = fixture([]); revoked.client.machines = async () => { throw new FestoError('expired', 401); };
  await assert.rejects(() => collectCachedRepairs(token, filters, emit, signal(), { store, client: revoked.client }), /expired/);
  assert.equal(store.reads, 0);
  await assert.rejects(() => collectCachedRepairs(token, filters, emit, signal(), { store, client: fixture([], []).client }), /inaccessible/);
  assert.equal(store.reads, 0);
});

test('standard fallback stores all states and dates and fails on incomplete details', async () => {
  const store = new MemoryStore(); const f = fixture([]);
  f.client.bulkIncidents = async () => { throw new FestoError('no bulk permission', 403); };
  const records = [incident(10), incident(11, machine.id, 'Open', '2020-01-01T00:00:00Z')];
  f.client.get = async (path, params) => {
    if (path === '/incidents') {
      assert.deepEqual(params, { machineId: machine.id, offset: 0, limit: 1000 });
      return { items: records.map(({ repairTasks: _tasks, ...rest }) => rest), offset: 0, total: 2 };
    }
    return records.find((r) => path.endsWith(r.id));
  };
  const result = await collectCachedRepairs(token, filters, emit, signal(), { store, client: f.client });
  assert.equal(result.rows.length, 1);
  assert.equal(result.retrieval.standardMachines, 1);
  assert.equal((await store.read(accountKeyForVerifiedToken(token), machine.id)).incidents.length, 2);
  const invalid = fixture([{ ...incident(12), repairTasks: undefined }]);
  await assert.rejects(() => syncDatabase(token, emit, signal(), { store, client: invalid.client }), /details are invalid/);
  assert.equal(store.writes, 1);
});

test('account scope survives JWT rotation but isolates issuer and subject', () => {
  const jwt = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  const key = accountKeyForVerifiedToken(jwt({ iss: 'festo', sub: 'a', aud: 'api', exp: 1 }));
  assert.equal(key, accountKeyForVerifiedToken(jwt({ iss: 'festo', sub: 'a', aud: 'api', exp: 2 })));
  assert.notEqual(key, accountKeyForVerifiedToken(jwt({ iss: 'festo', sub: 'b', aud: 'api' })));
  assert.notEqual(key, accountKeyForVerifiedToken(jwt({ iss: 'other', sub: 'a', aud: 'api' })));
});

test('snapshot validation rejects cross-machine and duplicate repair data', () => {
  assert.throws(() => validateSnapshot([incident(10, second.id)], machine.id));
  assert.throws(() => validateSnapshot([incident(10), incident(10)], machine.id));
  assert.throws(() => validateSnapshot([{ ...incident(10), repairTasks: [{ id: id(1), createdAt: 'bad' }] }], machine.id));
});

test('sync stream parses completion and propagates errors without false success', async () => {
  const stream = createOperationStream(async (emit) => {
    emit({ type: 'progress', message: '中文进度', scanned: 0, matched: 0 });
    return { machines: [], syncedMachines: 0, incidents: 0, syncedAt: '2026-10-30T00:00:00Z' };
  });
  const messages = [];
  const result = await readOperationResult(new Response(stream), (m) => messages.push(m), () => {});
  assert.equal(result.syncedMachines, 0);
  assert.deepEqual(messages, ['中文进度']);
  let unauthorized = false;
  const failed = createOperationStream(async () => { throw new FestoError('expired', 401); });
  await assert.rejects(() => readOperationResult(new Response(failed), emit, () => { unauthorized = true; }), /expired/);
  assert.equal(unauthorized, true);
});
