import assert from 'node:assert/strict';
import test from 'node:test';
import { allCustomFields, repairCustomFields } from '../lib/festo/custom-fields.ts';
import { customFieldColumns, toCsv } from '../lib/festo/shared.ts';

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

test('CSV export removes duplicate built-in repair custom fields and always outputs Chinese headers', () => {
  const repairTaskCustomFields = [
    {
      customFieldId: id(1),
      label: 'Repair content',
      defaultLanguageLabel: '维修内容',
      translations: { ZH: { title: '维修内容' } },
      value: '更换气缸密封圈',
    },
    {
      customFieldId: id(2),
      label: 'Downtime',
      defaultLanguageLabel: '停机时间',
      value: '45min',
    },
    {
      customFieldId: id(3),
      label: 'Spare part code',
      defaultLanguageLabel: '备件编码',
      value: 'SP-9001',
    },
  ];
  const incidentCustomFields = [
    {
      customFieldId: id(4),
      label: 'Severity level',
      defaultLanguageLabel: '故障等级',
      value: '二级',
    },
  ];

  const mapped = repairCustomFields(repairTaskCustomFields);
  assert.equal(mapped.repairContent, '更换气缸密封圈');
  assert.equal(mapped.downtime, '45min');

  const extraRepairFields = allCustomFields(repairTaskCustomFields, 'repair');
  // Built-in fields (`维修内容`, `停机时间`) are excluded from dynamic custom columns:
  assert.deepEqual(extraRepairFields.map((f) => f.id), [id(3)]);
  assert.equal(extraRepairFields[0].labelZh, '备件编码');

  const extraIncidentFields = allCustomFields(incidentCustomFields, 'incident');
  assert.equal(extraIncidentFields[0].labelZh, '故障等级');

  const rows = [{
    machineId: id(10),
    machineName: '装配线一号',
    machineNumber: 'M-01',
    incidentId: id(20),
    incidentNumber: '101',
    incidentSummary: '气压不足',
    incidentState: 'Closed',
    incidentOccurredAt: '2026-11-20T01:00:00Z',
    incidentFixedAt: '2026-11-20T02:00:00Z',
    incidentDescription: '主气路压力偏低',
    incidentCause: '密封磨损',
    taskId: id(30),
    description: '更换密封件',
    result: 'Success',
    createdAt: '2026-11-20T01:30:00Z',
    createdBy: '张三',
    modifiedAt: '',
    modifiedBy: '',
    comments: '[]',
    ...mapped,
    customFields: [...extraIncidentFields, ...extraRepairFields],
  }];

  // Even when UI language is 'en', CSV headers and result labels remain strictly Chinese:
  const csvFromEnMode = toCsv(rows, 'en', customFieldColumns(rows, 'zh'));
  const [headerLine, dataLine] = csvFromEnMode.replace(/^\uFEFF/, '').trim().split('\r\n');
  const headers = headerLine.split(',').map((cell) => cell.slice(1, -1));

  assert.ok(headers.includes('设备名称'));
  assert.ok(headers.includes('维修内容'));
  assert.ok(headers.includes('停机时间'));
  assert.ok(headers.includes('故障 · 故障等级'));
  assert.ok(headers.includes('维修任务 · 备件编码'));

  // No English headers and no duplicate `维修任务 · 维修内容` / `维修任务 · 停机时间`:
  assert.ok(!headers.includes('Machine name'));
  assert.ok(!headers.includes('Repair content'));
  assert.ok(!headers.includes('Downtime'));
  assert.equal(headers.filter((h) => h.includes('维修内容')).length, 1);
  assert.equal(headers.filter((h) => h.includes('停机时间')).length, 1);
  assert.ok(dataLine.includes('"成功"'));
});
