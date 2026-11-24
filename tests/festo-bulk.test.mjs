import assert from 'node:assert/strict';
import test from 'node:test';
import { API_BASE, FestoClient, FestoError, collectRepairs } from '../lib/festo/client.ts';
import { BulkExportUnsupported, bulkDownloadUrl, bulkRecords, normalizeBulkIncidents, parseBulkDocument } from '../lib/festo/bulk-export.ts';
import { filterExistingResult, toCsv } from '../lib/festo/shared.ts';
import { createExportStream } from '../lib/festo/export-stream.ts';

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const machine = { id: id(1), name: '测试设备', number: 'M-01' };
const fieldId = id(90);
const filters = { machineIds: [machine.id], from: '2026-10-01', to: '2026-10-01', incidentState: 'All' };
const definition = { customFieldId: fieldId, label: 'Repair content', defaultLanguageLabel: '维修内容', translations: { ZH: { title: '维修内容' } } };
function task(n, createdAt = '2026-09-30T16:00:00Z') {
  return { id: id(n), createdAt, description: '<p>修复</p>', result: 'Success', createdBy: { name: '张三' }, modifiedBy: null,
    customFields: [{ customFieldId: fieldId, value: '更换零件' }], comments: [{ id: id(80), message: '完成', createdBy: { name: '李四' }, modifiedBy: null }] };
}
function incident(n = 10) {
  return { id: id(n), logNumber: n, machine, type: 'Incident', state: 'Closed', createdAt: '2020-01-01T00:00:00Z',
    summary: '旧故障', repairTasks: [task(n + 100)], customFields: [] };
}
function mockClient(handler, signal) {
  const calls = [];
  const fetcher = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.href === `${API_BASE}/machines?limit=-1`) return Response.json({ items: [machine], total: 1 });
    const response = await handler(url, init);
    assert.ok(response instanceof Response, `Unexpected request: ${url.pathname}`);
    return response;
  };
  return { client: new FestoClient('test-token', { fetcher, signal }), calls };
}
const path = (url) => url.pathname.replace('/apps/smartenance/v1', '');

// Independent expected values use the regular API's response shape, rather than
// the bulk normalizer, so equality detects mapping regressions.
function regularIncident(raw) {
  return { ...raw, machineId: machine.id, repairTasks: raw.repairTasks.map((t) => ({ ...t,
    createdBy: '张三', modifiedBy: null,
    customFields: [{ ...definition, value: '更换零件' }],
    comments: t.comments.map((c) => ({ ...c, createdBy: '李四', modifiedBy: null })),
  })) };
}

await test('bulk export matches regular CSV, date boundaries and old-incident repairs without detail requests', async () => {
  const raw = incident();
  raw.repairTasks = [task(100, '2026-09-30T15:59:59Z'), task(101), task(102, '2026-10-01T15:59:59Z'), task(103, '2026-10-01T16:00:00Z')];
  const bulk = mockClient((url) => {
    if (path(url).endsWith('/export/incidents')) {
      assert.equal(url.search, '');
      return Response.json([raw]);
    }
    if (path(url) === '/customfields/incidents') return Response.json([]);
    if (path(url) === '/customfields/tasks') return Response.json([definition]);
  });
  const actual = await collectRepairs(bulk.client, filters);
  const regular = mockClient((url) => {
    if (path(url).endsWith('/export/incidents')) return new Response('', { status: 403 });
    if (path(url) === '/incidents') return Response.json({ items: [{ id: raw.id, number: 10, type: 'Incident', state: 'Closed', machineId: machine.id }], total: 1, offset: 0 });
    if (path(url) === `/incidents/${raw.id}`) return Response.json(regularIncident(raw));
  });
  const expected = await collectRepairs(regular.client, filters);
  assert.equal(toCsv(actual.rows, 'zh'), toCsv(expected.rows, 'zh'));
  assert.deepEqual(actual.rows.map((r) => r.taskId), [id(102), id(101)]);
  assert.equal(actual.rows[0].repairContent, '更换零件');
  assert.deepEqual(actual.retrieval, { bulkMachines: 1, standardMachines: 0 });
  assert.ok(bulk.calls.every(({ url }) => !path(url).startsWith('/incidents')));
});

await test('signed blob download carries no credentials and preserves Unicode JSON', async () => {
  const blobUrl = 'https://festotest.blob.core.windows.net/exports/incidents.json?sig=example';
  const raw = incident(); raw.repairTasks[0].customFields = [];
  const { client, calls } = mockClient((url, init) => {
    if (url.href === blobUrl) {
      assert.equal(new Headers(init.headers).get('authorization'), null);
      assert.equal(new Headers(init.headers).get('SMRTNC-LANGUAGE'), null);
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'manual');
      return new Response('\uFEFF' + JSON.stringify([raw]));
    }
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-token');
    return new Response(blobUrl);
  });
  const result = await collectRepairs(client, filters);
  assert.equal(result.rows[0].createdBy, '张三');
  assert.equal(calls.length, 3);
});

await test('untrusted download destinations are rejected before fetching', () => {
  for (const url of ['http://festotest.blob.core.windows.net/file', 'https://127.0.0.1/file', 'https://festotest.blob.core.windows.net.evil.test/file', 'https://user:pass@festotest.blob.core.windows.net/file', 'https://festotest.blob.core.windows.net:8443/file']) {
    assert.throws(() => bulkDownloadUrl(url), BulkExportUnsupported);
  }
  assert.equal(bulkDownloadUrl({ uri: 'https://festotest.blob.core.windows.net/a/b' }).hostname, 'festotest.blob.core.windows.net');
});

await test('incomplete, duplicate or cross-machine exports cannot be accepted as complete', () => {
  const raw = incident(); raw.repairTasks = [];
  assert.throws(() => bulkRecords({ items: [raw], total: 2 }), BulkExportUnsupported);
  assert.throws(() => bulkRecords({ items: [raw], total: 1, offset: 1 }), BulkExportUnsupported);
  assert.throws(() => normalizeBulkIncidents([raw, raw], machine.id), BulkExportUnsupported);
  assert.throws(() => normalizeBulkIncidents([{ ...raw, machine: { id: id(2) } }], machine.id), BulkExportUnsupported);
  assert.throws(() => normalizeBulkIncidents([{ ...raw, repairTasks: undefined }], machine.id), BulkExportUnsupported);
  assert.throws(() => parseBulkDocument('<html>error</html>'), BulkExportUnsupported);
  assert.deepEqual(bulkRecords([]), []);
});

await test('unsupported data falls back for the entire machine with no partial bulk rows', async () => {
  const raw = incident(); raw.repairTasks[0].customFields = [];
  const { client } = mockClient((url) => {
    if (path(url).endsWith('/export/incidents')) return Response.json([raw, { ...incident(11), repairTasks: undefined }]);
    if (path(url) === '/incidents') return Response.json({ items: [{ id: raw.id, state: 'Closed', machineId: machine.id }], total: 1, offset: 0 });
    if (path(url) === `/incidents/${raw.id}`) return Response.json(regularIncident(raw));
  });
  const events = [];
  const result = await collectRepairs(client, filters, (event) => events.push(event));
  assert.equal(result.rows.length, 1);
  assert.equal(result.scanned, 1);
  assert.deepEqual(result.retrieval, { bulkMachines: 0, standardMachines: 1 });
  assert.ok(events.some((event) => event.message.includes('Using the standard query')));
});

await test('field definitions are fetched only once across multiple machine exports', async () => {
  const secondMachine = { ...machine, id: id(2) };
  const raw = incident();
  const { client, calls } = mockClient((url) => {
    if (path(url).endsWith('/export/incidents')) return Response.json([url.pathname.includes(id(2)) ? { ...incident(11), machine: secondMachine } : raw]);
    if (path(url) === '/customfields/incidents') return Response.json([]);
    if (path(url) === '/customfields/tasks') return Response.json([definition]);
  });
  await client.bulkIncidents(machine.id);
  await client.bulkIncidents(secondMachine.id);
  assert.equal(calls.filter(({ url }) => path(url) === '/customfields/tasks').length, 1);
  assert.equal(calls.filter(({ url }) => path(url) === '/customfields/incidents').length, 1);
});

await test('empty bulk export and state filtering produce valid complete results', async () => {
  const empty = mockClient(() => Response.json([]));
  assert.equal((await collectRepairs(empty.client, filters)).rows.length, 0);
  const raw = incident(); raw.repairTasks[0].customFields = [];
  const filtered = mockClient(() => Response.json([raw]));
  const result = await collectRepairs(filtered.client, { ...filters, incidentState: 'Open' });
  assert.equal(result.rows.length, 0);
  assert.equal(result.scanned, 1);
  const cached = filterExistingResult({ ...result, filters }, { ...filters, incidentState: 'Closed' });
  assert.deepEqual(cached.retrieval, result.retrieval);
});

await test('invalid token stops immediately without regular fallback or automatic retries', async () => {
  const { client, calls } = mockClient(() => new Response('', { status: 401 }));
  await assert.rejects(() => collectRepairs(client, filters), (error) => error instanceof FestoError && error.status === 401);
  assert.equal(calls.length, 2);
});

await test('cancellation during bulk download aborts work and never starts fallback', async () => {
  const abort = new AbortController();
  const { client, calls } = mockClient((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    abort.abort();
  }), abort.signal);
  await assert.rejects(() => collectRepairs(client, filters), { name: 'AbortError' });
  assert.equal(calls.length, 2);
});

await test('export stream retains retrieval metadata and emits no complete event after failure', async () => {
  const stream = createExportStream(async () => ({ rows: [], scanned: 0, retrieval: { bulkMachines: 2, standardMachines: 0 } }));
  const event = JSON.parse(await new Response(stream).text());
  assert.equal(event.retrieval.bulkMachines, 2);
  const failed = createExportStream(async () => { throw new FestoError('test failure'); });
  const output = await new Response(failed).text();
  assert.equal(JSON.parse(output).type, 'error');
  assert.ok(!output.includes('"complete"'));
});

for (const status of [403, 500]) {
await test(`bulk HTTP ${status} is not retried on every selected machine`, async () => {
  const second = { ...machine, id: id(2) };
  const calls = [];
  const client = new FestoClient('test-token', { fetcher: async (input) => {
    const url = new URL(String(input)); calls.push(url);
    if (path(url) === '/machines') return Response.json({ items: [machine, second], total: 2 });
    if (path(url).endsWith('/export/incidents')) return new Response('', { status });
    if (path(url) === '/incidents') return Response.json({ items: [], total: 0, offset: 0 });
    throw new Error('Unexpected request');
  } });
  const result = await collectRepairs(client, { ...filters, machineIds: [machine.id, second.id] });
  assert.deepEqual(result.retrieval, { bulkMachines: 0, standardMachines: 2 });
  assert.equal(calls.filter((url) => path(url).endsWith('/export/incidents')).length, 1);
});

}

await test('blob redirects are rejected without a second destination request', async () => {
  const { client, calls } = mockClient((url) => {
    if (url.hostname === 'festotest.blob.core.windows.net') return new Response(null, { status: 302, headers: { location: 'https://other.example/export' } });
    return Response.json('https://festotest.blob.core.windows.net/exports/data.json');
  });
  await assert.rejects(() => client.bulkIncidents(machine.id), /unexpected redirect/);
  assert.equal(calls.length, 2);
});

await test('missing custom-field definitions cannot silently discard exported values', () => {
  const raw = incident();
  assert.throws(() => normalizeBulkIncidents([raw], machine.id), BulkExportUnsupported);
});

for (const failingStage of ['bulk endpoint', 'blob download', 'field definitions']) {
  await test(`HTTP 500 in ${failingStage} falls back and still exports the complete repair CSV`, async () => {
    const raw = incident();
    const events = [];
    const { client, calls } = mockClient((url) => {
      if (path(url).endsWith('/export/incidents')) {
        if (failingStage === 'bulk endpoint') return new Response('', { status: 500 });
        if (failingStage === 'blob download') return Response.json('https://festotest.blob.core.windows.net/exports/data.json');
        return Response.json([raw]);
      }
      if (url.hostname === 'festotest.blob.core.windows.net' || path(url).startsWith('/customfields/'))
        return new Response('', { status: 500 });
      if (path(url) === '/incidents') return Response.json({ items: [{ id: raw.id, state: 'Closed', machineId: machine.id }], total: 1, offset: 0 });
      if (path(url) === `/incidents/${raw.id}`) return Response.json(regularIncident(raw));
    });
    const result = await collectRepairs(client, filters, (event) => events.push(event));
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].repairContent, '更换零件');
    assert.deepEqual(result.retrieval, { bulkMachines: 0, standardMachines: 1 });
    assert.ok(events.some((event) => event.message === 'Bulk export failed (500). Using the standard query.'));
    assert.equal(calls.filter(({ url }) => path(url).endsWith('/export/incidents')).length, 1);
  });
}

await test('standard detail HTTP 500 remains a failed query with no partial CSV', async () => {
  const { client } = mockClient((url) => {
    if (path(url).endsWith('/export/incidents')) return new Response('', { status: 500 });
    if (path(url) === '/incidents') return Response.json({ items: [{ id: id(10), state: 'Closed', machineId: machine.id }], total: 1, offset: 0 });
    return new Response('', { status: 500 });
  });
  const stream = createExportStream((emit, signal) => collectRepairs(client, filters, emit, signal));
  const events = (await new Response(stream).text()).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).message, /error \(500\)/);
  assert.ok(!events.some((event) => event.type === 'complete'));
});

await test('an immediate machine-list HTTP 500 identifies the stage before any bulk request', async () => {
  const calls = [];
  const progress = [];
  const client = new FestoClient('test-token', { fetcher: async (url) => {
    calls.push(String(url));
    return new Response('', { status: 500 });
  } });
  await assert.rejects(() => collectRepairs(client, filters, (event) => progress.push(event)),
    /error \(500\) while loading machines/);
  assert.deepEqual(calls, [`${API_BASE}/machines?limit=-1`]);
  assert.equal(progress[0].message, 'Loading machines…');
});

await test('HTTP error stages distinguish API operations without exposing request URLs', async () => {
  const { translate } = await import('../lib/festo/i18n.ts');
  const cases = [
    [`/machines/${machine.id}/export/incidents`, 'reading bulk export', '读取批量导出'],
    ['/incidents', 'reading incident list', '读取故障列表'],
    [`/incidents/${id(10)}`, 'reading incident details', '读取故障详情'],
    ['/customfields/tasks', 'loading custom fields', '加载自定义栏位'],
  ];
  const client = new FestoClient('secret-test-token', { fetcher: async () => new Response('', { status: 500 }) });
  for (const [endpoint, operation, chinese] of cases) {
    await assert.rejects(() => client.get(endpoint, { secret: 'test-secret' }), (error) => {
      assert.equal(error.upstreamStatus, 500);
      assert.equal(error.message, `Festo returned an error (500) while ${operation}. No results were exported.`);
      assert.equal(translate(error.message, 'zh'), `${chinese}时 Festo 返回错误（500），未导出任何结果。`);
      assert.ok(!error.message.includes('test-secret'));
      assert.ok(!error.message.includes(machine.id));
      return true;
    });
  }
});
