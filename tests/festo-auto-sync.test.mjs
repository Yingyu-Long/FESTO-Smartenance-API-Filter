import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authenticateAutoSync,
  nextScheduledRun,
  parseSyncSchedule,
  previousScheduledRun,
  runScheduledSyncWithRetries,
  shouldRunCatchUp,
} from '../lib/festo/auto-sync.ts';
import { FestoClient, FestoError } from '../lib/festo/client.ts';
import { syncDatabase } from '../lib/festo/cached-repairs.ts';
import { incidentRowHash } from '../lib/festo/database.ts';

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const jwt = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

test('incidentRowHash is deterministic across property order and detects nested task edits', () => {
  const a = {
    id: id(1),
    machineId: id(100),
    state: 'Open',
    summary: '压力异常',
    repairTasks: [{ id: id(2), createdAt: '2026-10-01T00:00:00Z', description: '更换密封圈', result: 'Success' }],
  };
  const b = {
    repairTasks: [{ result: 'Success', description: '更换密封圈', createdAt: '2026-10-01T00:00:00Z', id: id(2) }],
    summary: '压力异常',
    state: 'Open',
    machineId: id(100),
    id: id(1),
  };
  assert.equal(incidentRowHash(a), incidentRowHash(b));

  const modified = structuredClone(a);
  modified.repairTasks[0].description = '更换密封圈与阀芯';
  assert.notEqual(incidentRowHash(a), incidentRowHash(modified));
});

test('semi-monthly schedule computes exact 1st and 16th 02:00 UTC+8 slots across month/year boundaries', () => {
  const schedule = parseSyncSchedule({
    FESTO_SYNC_USERNAME: 'api-user',
    FESTO_SYNC_PASSWORD: 'secret',
    SYNC_DAYS_OF_MONTH: '1,16',
    SYNC_TIME_UTC8: '02:00',
  });
  assert.equal(schedule.enabled, true);
  assert.deepEqual(schedule.daysOfMonth, [1, 16]);

  // 2026-11-10 10:00 UTC+8 -> next is 2026-11-16 02:00 UTC+8 (= 2026-11-15T18:00:00.000Z)
  const midMonth = new Date('2026-11-10T02:00:00Z');
  assert.equal(nextScheduledRun(midMonth, schedule).toISOString(), '2026-11-15T18:00:00.000Z');
  assert.equal(previousScheduledRun(midMonth, schedule).toISOString(), '2026-10-31T18:00:00.000Z');

  // 2026-12-20 10:00 UTC+8 -> next rolls over to 2027-01-01 02:00 UTC+8 (= 2026-12-31T18:00:00.000Z)
  const lateDec = new Date('2026-12-20T02:00:00Z');
  assert.equal(nextScheduledRun(lateDec, schedule).toISOString(), '2026-12-31T18:00:00.000Z');
  assert.equal(previousScheduledRun(lateDec, schedule).toISOString(), '2026-12-15T18:00:00.000Z');

  // Catch-up logic: runs when never synced or older than previous slot; skips when up-to-date.
  assert.equal(shouldRunCatchUp(null, lateDec, schedule), true);
  assert.equal(shouldRunCatchUp('2026-12-10T00:00:00Z', lateDec, schedule), true);
  assert.equal(shouldRunCatchUp('2026-12-16T00:00:00Z', lateDec, schedule), false);
  assert.equal(shouldRunCatchUp(null, lateDec, { ...schedule, catchUp: false }), false);

  // Default day of month is 25; web container flag enables status reporting without exposing password.
  const webOnly = parseSyncSchedule({ FESTO_SYNC_CONFIGURED: '1' });
  assert.equal(webOnly.enabled, true);
  assert.deepEqual(webOnly.daysOfMonth, [25]);
  assert.equal(
    nextScheduledRun(new Date('2026-11-24T17:59:00Z'), webOnly).toISOString(),
    '2026-11-24T18:00:00.000Z', // 2026-11-25 02:00 UTC+8
  );
  assert.throws(() => parseSyncSchedule({ SYNC_DAYS_OF_MONTH: '1,31' }), /between 1 and 28/);
  assert.throws(() => parseSyncSchedule({ SYNC_TIME_UTC8: '25:00' }), /HH:MM/);
});

test('authenticateAutoSync auto-selects working Festo ROPC policy on 401', async () => {
  const triedPolicies = [];
  const token = jwt({ iss: 'festo', sub: 'service-user', aud: 'api' });
  const fetcher = async (url) => {
    const policy = new URL(url).searchParams.get('p');
    triedPolicies.push(policy);
    if (policy === 'b2c_1_apisignin_ropc') {
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 401 });
    }
    return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), { status: 200 });
  };
  const auth = await authenticateAutoSync(
    { FESTO_SYNC_USERNAME: 'u@example.com', FESTO_SYNC_PASSWORD: 'pw', FESTO_SYNC_POLICY: 'auto' },
    fetcher,
  );
  assert.equal(auth.token, token);
  assert.equal(auth.expiresIn, 3600);
  assert.deepEqual(triedPolicies, ['b2c_1_apisignin_ropc', 'b2c_1_ropc_apisignin']);
});

test('syncDatabase renews expiring or 401 tokens mid-sync and aggregates diff stats', async () => {
  const m1 = { id: id(1), name: 'M1', number: '1' };
  const m2 = { id: id(2), name: 'M2', number: '2' };
  const initialToken = jwt({ iss: 'festo', sub: 'svc', aud: 'api', exp: 1 });
  const renewedToken = jwt({ iss: 'festo', sub: 'svc', aud: 'api', exp: 2 });
  const tokensUsed = [];

  const data = new Map();
  const store = {
    seq: 0,
    async revision() { return String(++this.seq); },
    async read(account, machineId) { return data.get(`${account}:${machineId}`) ?? null; },
    async replace(account, machine, incidents) {
      data.set(`${account}:${machine.id}`, { incidents, syncedAt: new Date().toISOString() });
      return { applied: true, inserted: incidents.length, updated: 0, unchanged: 0, deleted: 0 };
    },
  };

  let failOnceOnM2 = true;
  const makeClient = (tok) => {
    const c = new FestoClient(tok);
    c.machines = async () => [m1, m2];
    c.bulkIncidents = async (machineId) => {
      tokensUsed.push({ machineId, tok });
      if (machineId === m2.id && failOnceOnM2) {
        failOnceOnM2 = false;
        throw new FestoError('expired', 401);
      }
      return [{
        id: id(machineId === m1.id ? 10 : 20),
        machineId,
        type: 'Incident',
        state: 'Closed',
        repairTasks: [{ id: id(machineId === m1.id ? 110 : 120), createdAt: '2026-10-01T00:00:00Z', result: 'Success' }],
      }];
    };
    return c;
  };

  let refreshes = 0;
  const result = await syncDatabase(
    initialToken,
    () => {},
    new AbortController().signal,
    {
      store,
      createClient: makeClient,
      refreshToken: async () => {
        refreshes++;
        return { token: renewedToken, expiresIn: 3600 };
      },
    },
  );

  assert.equal(refreshes, 1);
  assert.equal(result.syncedMachines, 2);
  assert.deepEqual(result.diff, { inserted: 2, updated: 0, unchanged: 0, deleted: 0 });
  assert.deepEqual(tokensUsed, [
    { machineId: m1.id, tok: initialToken },
    { machineId: m2.id, tok: initialToken },
    { machineId: m2.id, tok: renewedToken },
  ]);
});

test('runScheduledSyncWithRetries retries transient errors and skips overlapping locked runs', async () => {
  const token = jwt({ iss: 'festo', sub: 'svc', aud: 'api' });
  const runs = [];
  let lockAvailable = true;
  let attempts = 0;

  const mockStore = {
    seq: 0,
    data: new Map(),
    async revision() { return String(++this.seq); },
    async read(account, machineId) { return this.data.get(`${account}:${machineId}`) ?? null; },
    async replace(account, machine, incidents) {
      this.data.set(`${account}:${machine.id}`, { incidents, syncedAt: new Date().toISOString() });
      return { applied: true, inserted: 0, updated: 0, unchanged: incidents.length, deleted: 0 };
    },
    async withAutoSyncLock(fn) {
      if (!lockAvailable) return { acquired: false };
      return { acquired: true, value: await fn() };
    },
    async startSyncRun(source) {
      const runId = String(runs.length + 1);
      runs.push({ id: runId, source, status: 'running' });
      return runId;
    },
    async finishSyncRun(runId, outcome) {
      const item = runs.find((r) => r.id === runId);
      Object.assign(item, outcome);
    },
  };

  const outcome = await runScheduledSyncWithRetries({
    env: { FESTO_SYNC_TOKEN: token, SYNC_MAX_RETRIES: '2', SYNC_RETRY_DELAY_SECONDS: '1' },
    store: mockStore,
    retryDelayMs: 5,
    log: () => {},
    createClient: (tok) => {
      const c = new FestoClient(tok);
      c.machines = async () => {
        attempts++;
        if (attempts === 1) throw new FestoError('upstream gateway timeout', 504);
        return [{ id: id(1), name: 'M1', number: '1' }];
      };
      c.bulkIncidents = async (machineId) => [{
        id: id(10),
        machineId,
        type: 'Incident',
        state: 'Open',
        repairTasks: [],
      }];
      return c;
    },
  });

  assert.equal(outcome.skipped, false);
  assert.equal(attempts, 2);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].status, 'failed');
  assert.equal(runs[1].status, 'succeeded');

  lockAvailable = false;
  const skipped = await runScheduledSyncWithRetries({
    env: { FESTO_SYNC_TOKEN: token },
    store: mockStore,
    log: () => {},
  });
  assert.deepEqual(skipped, { skipped: true });
});
