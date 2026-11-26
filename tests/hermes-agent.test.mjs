import assert from "node:assert/strict";
import test from "node:test";
import {
  maskApiKey,
  readHermesConfig,
  saveHermesConfig,
  toClientConfig,
} from "../lib/hermes/config.ts";
import {
  AmbiguousMachineError,
  IncidentService,
  MachineNotFoundError,
  parseIsoDate,
} from "../lib/hermes/incident-service.ts";
import {
  buildAnthropicThinkingParams,
  buildOpenAiThinkingParams,
  runHermesAgentChat,
  testModelConnection,
} from "../lib/hermes/llm.ts";
import { executeHermesTool, HERMES_TOOLS } from "../lib/hermes/tools.ts";

function createMockSnapshotStore(seed = {}) {
  const machines = seed.machines ?? [];
  const incidents = seed.incidents ?? [];
  let configRow = seed.configRow ?? null;

  const client = {
    async query(sql, values = []) {
      if (sql.includes("FROM hermes_agent_config")) {
        return { rows: configRow ? [configRow] : [] };
      }
      if (sql.includes("INSERT INTO hermes_agent_config")) {
        configRow = {
          id: 1,
          provider: values[0],
          api_format: values[1],
          base_url: values[2],
          api_key: values[3],
          model: values[4],
          smartenance_account_key: values[5],
          temperature: values[6],
          max_tool_steps: values[7],
          think_level: values[8],
          system_prompt: values[9],
        };
        return { rows: [] };
      }
      if (sql.includes("GROUP BY m.account_key")) {
        const grouped = new Map();
        for (const m of machines) {
          const item = grouped.get(m.account_key) ?? {
            account_key: m.account_key,
            machine_count: 0,
            total_incidents: 0,
            latest_synced_at: null,
          };
          item.machine_count += 1;
          item.total_incidents += incidents.filter(
            (i) => i.account_key === m.account_key && i.machine_id === m.machine_id,
          ).length;
          if (!item.latest_synced_at || m.synced_at > item.latest_synced_at) {
            item.latest_synced_at = m.synced_at;
          }
          grouped.set(m.account_key, item);
        }
        const rows = [...grouped.values()].sort((a, b) =>
          String(b.latest_synced_at ?? "").localeCompare(String(a.latest_synced_at ?? "")),
        );
        return { rows };
      }
      if (sql.includes("FROM smartenance_machines") && sql.includes("machine->>'name'")) {
        const acct = values[0];
        const rows = machines
          .filter((m) => m.account_key === acct)
          .sort((a, b) => a.machine_id.localeCompare(b.machine_id))
          .map((m) => ({
            machine_id: m.machine_id,
            name: m.machine.name ?? null,
            number: m.machine.number ?? null,
            revision: m.revision,
            incident_count: m.incident_count,
            synced_at: new Date(m.synced_at),
          }));
        return { rows };
      }
      if (sql.includes("FROM smartenance_machines")) {
        const acct = values[0];
        const rows = machines
          .filter((m) => m.account_key === acct)
          .sort((a, b) => a.machine_id.localeCompare(b.machine_id))
          .map((m) => ({
            machine_id: m.machine_id,
            machine: m.machine,
            incident_count: m.incident_count,
            synced_at: new Date(m.synced_at),
          }));
        return { rows };
      }
      if (sql.includes("FROM smartenance_incidents") && sql.includes("incident->>'state'")) {
        const acct = values[0];
        const rows = incidents
          .filter((i) => i.account_key === acct)
          .sort(
            (a, b) =>
              a.machine_id.localeCompare(b.machine_id) ||
              a.incident_id.localeCompare(b.incident_id),
          )
          .map((i) => ({
            machine_id: i.machine_id,
            state: i.incident.state ?? null,
            occurred_at: i.incident.occurredAt ?? null,
            created_at: i.incident.createdAt ?? null,
          }));
        return { rows };
      }
      if (sql.includes("FROM smartenance_incidents")) {
        const acct = values[0];
        const rows = incidents
          .filter((i) => i.account_key === acct)
          .sort(
            (a, b) =>
              a.machine_id.localeCompare(b.machine_id) ||
              a.incident_id.localeCompare(b.incident_id),
          )
          .map((i) => ({
            machine_id: i.machine_id,
            incident: i.incident,
          }));
        return { rows };
      }
      throw new Error(`Unhandled SQL in mock store: ${sql}`);
    },
  };

  return {
    query: (sql, values) => client.query(sql, values),
    withReadOnlySnapshot: (fn) => fn(client),
  };
}

const sampleSeed = () => {
  const m1 = "00000000-0000-0000-0000-000000000001";
  const m2 = "00000000-0000-0000-0000-000000000002";
  const m3 = "00000000-0000-0000-0000-000000000003";
  return {
    machines: [
      {
        account_key: "acct-alpha",
        machine_id: m1,
        machine: { id: m1, name: "Assembly Line 1", number: "M-101" },
        revision: 10,
        incident_count: 3,
        synced_at: "2026-11-25T18:00:00.000Z",
      },
      {
        account_key: "acct-alpha",
        machine_id: m2,
        machine: { id: m2, name: "Packaging Cell", number: "M-202" },
        revision: 11,
        incident_count: 1,
        synced_at: "2026-11-25T18:05:00.000Z",
      },
      {
        account_key: "acct-alpha",
        machine_id: m3,
        machine: { id: m3, name: "Packaging Cell", number: "M-203" },
        revision: 12,
        incident_count: 0,
        synced_at: "2026-11-25T18:06:00.000Z",
      },
    ],
    incidents: [
      {
        account_key: "acct-alpha",
        machine_id: m1,
        incident_id: "10000000-0000-0000-0000-000000000001",
        incident: {
          id: "10000000-0000-0000-0000-000000000001",
          logNumber: 501,
          state: "Open",
          summary: "Cylinder pressure drop",
          occurredAt: "2026-10-12T03:00:00Z",
          repairTasks: [
            {
              id: "20000000-0000-0000-0000-000000000001",
              createdAt: "2026-10-12T04:00:00Z",
              description: "Replace seal",
              customFields: [
                { label: "维修工时", value: 3 },
                { label: "维修时间", value: 1.5 },
                { label: "维修负责人", value: "Alice" },
                { label: "协作人员", value: ["Bob", "alice"] },
              ],
            },
          ],
        },
      },
      {
        account_key: "acct-alpha",
        machine_id: m1,
        incident_id: "10000000-0000-0000-0000-000000000002",
        incident: {
          id: "10000000-0000-0000-0000-000000000002",
          logNumber: 502,
          state: "InWork",
          summary: "Sensor fault",
          occurredAt: "2026-10-20T06:00:00Z",
          repairTasks: [
            {
              id: "20000000-0000-0000-0000-000000000002",
              createdAt: "2026-10-20T07:00:00Z",
              description: "Unassigned calibration",
              customFields: [{ label: "维修工时", value: 1.5 }],
            },
          ],
        },
      },
      {
        account_key: "acct-alpha",
        machine_id: m1,
        incident_id: "10000000-0000-0000-0000-000000000003",
        incident: {
          id: "10000000-0000-0000-0000-000000000003",
          logNumber: 503,
          state: "Closed",
          summary: "Valve replaced",
          occurredAt: "2026-10-25T10:00:00Z",
          repairTasks: [
            {
              id: "20000000-0000-0000-0000-000000000003",
              createdAt: "2026-10-25T11:00:00Z",
              description: "Missing hours entry",
              customFields: [],
            },
          ],
        },
      },
      {
        account_key: "acct-alpha",
        machine_id: m2,
        incident_id: "10000000-0000-0000-0000-000000000004",
        incident: {
          id: "10000000-0000-0000-0000-000000000004",
          logNumber: 601,
          state: "Closed",
          summary: "Routine check",
          occurredAt: "2026-01-10T00:00:00Z",
          repairTasks: [],
        },
      },
    ],
  };
};

test("parseIsoDate handles UTC, explicit offsets, naive timestamps, and rejects invalid dates", () => {
  assert.equal(parseIsoDate("2026-10-01")?.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(parseIsoDate("2026-10-01T08:00:00+08:00")?.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(parseIsoDate("2026-10-01T05:30:00")?.toISOString(), "2026-10-01T05:30:00.000Z");
  assert.equal(parseIsoDate("2026-02-30"), null);
  assert.equal(parseIsoDate(""), null);
});

test("IncidentService computes factory overview, trend summary, health score, risk ranking, and work hours", async () => {
  const store = createMockSnapshotStore(sampleSeed());
  const now = new Date("2026-11-26T02:00:00Z"); // 2026-11-26 10:00 Asia/Shanghai
  const svc = new IncidentService(store, "acct-alpha");

  const overview = await svc.getFactoryOverview(10);
  assert.equal(overview.machine_count, 3);
  assert.equal(overview.incident_count, 4);
  assert.equal(overview.active_incident_count, 2);
  assert.equal(overview.closed_incident_count, 2);
  assert.equal(overview.snapshot_complete, true);
  assert.equal(overview.machines_with_active_incidents, 1);
  assert.equal(overview.top_machines[0].number, "M-101");

  const summary = await svc.getFactoryIncidentSummary(
    null,
    "2026-10-01",
    "2026-11-01",
    "week",
    10,
    now,
  );
  assert.equal(summary.incident_count, 3);
  assert.equal(summary.active_incident_count, 2);
  assert.equal(summary.closed_incident_count, 1);
  assert.equal(summary.machines_affected, 1);
  assert.deepEqual(summary.trend, [
    { period: "2026-W42", incident_count: 1, active_incident_count: 1, closed_incident_count: 0 },
    { period: "2026-W43", incident_count: 2, active_incident_count: 1, closed_incident_count: 1 },
  ]);

  // Employee work hours for previous month (2026-10 in Asia/Shanghai):
  // Task 1: 3h split between Alice and Bob (duplicate "alice" ignored) -> 1.5h each
  // Task 2: 1.5h without staff -> unattributed
  // Task 3: missing 维修工时
  const hours = await svc.getEmployeeWorkHours(null, now);
  assert.equal(hours.period, "2026-10");
  assert.equal(hours.total_work_hours, 4.5);
  assert.equal(hours.attributed_work_hours, 3);
  assert.equal(hours.unattributed_work_hours, 1.5);
  assert.equal(hours.repair_task_count, 3);
  assert.equal(hours.repair_tasks_without_work_hours, 1);
  assert.equal(hours.repair_tasks_without_staff, 1);
  assert.deepEqual(hours.employees, [
    { employee: "Alice", work_hours: 1.5, repair_task_count: 1 },
    { employee: "Bob", work_hours: 1.5, repair_task_count: 1 },
  ]);

  // Health & Risk Ranking:
  // M-101 has 2 active (-40) and 3 recent (-15) -> health_score 45 ("high")
  // M-202 has 0 active, 0 recent -> health_score 100 ("low")
  const healthM1 = await svc.getMachineHealthScore("M-101", now);
  assert.equal(healthM1.health_score, 45);
  assert.equal(healthM1.risk_level, "high");

  const ranking = await svc.getMachineRiskRanking(10, now);
  assert.equal(ranking.machines[0].machine_id, "00000000-0000-0000-0000-000000000001");
  assert.equal(ranking.machines[0].health_score, 45);

  const compared = await svc.compareMachines(["M-101", "M-202"], now);
  assert.equal(compared.least_healthy_machine_id, "00000000-0000-0000-0000-000000000001");

  const maint = await svc.getMachineMaintenanceHistory("M-101", 10);
  assert.equal(maint.total, 3);
  assert.equal(maint.maintenance[0].incident_number, 503);

  const openHistory = await svc.getMachineIncidentHistory("M-101", 10, "Open");
  assert.equal(openHistory.total, 1);
  assert.equal(openHistory.incidents[0].logNumber, 501);

  await assert.rejects(() => svc.getMachineDetails("NON-EXISTENT"), MachineNotFoundError);
  await assert.rejects(() => svc.getMachineDetails("Packaging Cell"), AmbiguousMachineError);
});

test("HERMES_TOOLS and executeHermesTool expose all 12 Smartenance tools and auto-resolve account", async () => {
  assert.equal(HERMES_TOOLS.length, 12);
  const store = createMockSnapshotStore(sampleSeed());

  const accountsRes = await executeHermesTool("list_smartenance_accounts", {}, { store });
  assert.equal(accountsRes.count, 1);
  assert.equal(accountsRes.selected_account_key, "acct-alpha");

  const machinesRes = await executeHermesTool(
    "get_machines",
    { search: "m-101", limit: 5 },
    { store },
  );
  assert.equal(machinesRes.total, 1);
  assert.equal(machinesRes.machines[0].number, "M-101");
});

test("Hermes config persists, masks API key, preserves saved key on blank update, and supports clearApiKey", async () => {
  const store = createMockSnapshotStore();
  assert.equal(maskApiKey("sk-1234567890abcdef"), "sk-1••••cdef");

  const saved = await saveHermesConfig(
    {
      provider: "deepseek",
      apiFormat: "openai",
      baseUrl: "https://api.deepseek.com/v1/",
      apiKey: "sk-secret-key-9999",
      model: "deepseek-chat",
      temperature: 0.3,
      maxToolSteps: 6,
    },
    store,
  );
  assert.equal(saved.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(saved.apiKey, "sk-secret-key-9999");

  const clientView = toClientConfig(saved);
  assert.equal(clientView.configured, true);
  assert.equal(clientView.hasApiKey, true);
  assert.equal(clientView.apiKeyMasked, "sk-s••••9999");
  assert.equal("apiKey" in clientView, false);

  // Updating model without resending apiKey preserves existing key:
  const updated = await saveHermesConfig({ model: "deepseek-reasoner" }, store);
  assert.equal(updated.model, "deepseek-reasoner");
  assert.equal(updated.apiKey, "sk-secret-key-9999");

  // Explicit clearApiKey wipes key:
  const cleared = await saveHermesConfig({ clearApiKey: true }, store);
  assert.equal(cleared.apiKey, "");
  assert.equal(toClientConfig(readHermesConfig ? cleared : cleared).configured, false);

  // Partial thinkLevel toggle works even on a fresh unconfigured store:
  const freshStore = createMockSnapshotStore();
  const toggled = await saveHermesConfig({ thinkLevel: "high" }, freshStore);
  assert.equal(toggled.thinkLevel, "high");
  assert.equal(toClientConfig(toggled).thinkLevel, "high");
  const backOff = await saveHermesConfig({ thinkLevel: "off" }, freshStore);
  assert.equal(backOff.thinkLevel, "off");
});

test("thinkLevel maps provider-native NoThink / Low / Medium / High params and falls back on HTTP 400", async () => {
  assert.deepEqual(
    buildOpenAiThinkingParams("https://api.openai.com/v1", "gpt-5", "off"),
    { reasoning_effort: "none" },
  );
  assert.deepEqual(
    buildOpenAiThinkingParams("https://api.openai.com/v1", "gpt-5", "high"),
    { reasoning_effort: "high" },
  );
  assert.deepEqual(
    buildOpenAiThinkingParams("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3-max", "off"),
    { enable_thinking: false },
  );
  assert.deepEqual(
    buildOpenAiThinkingParams("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3-max", "medium"),
    { enable_thinking: true, thinking_budget: 8192 },
  );
  assert.deepEqual(
    buildOpenAiThinkingParams("https://api.deepseek.com/v1", "deepseek-chat", "off"),
    { thinking: { type: "disabled" } },
  );
  assert.deepEqual(
    buildOpenAiThinkingParams("https://api.deepseek.com/v1", "deepseek-chat", "low"),
    { thinking: { type: "enabled" }, reasoning_effort: "low" },
  );

  const anthropicHigh = buildAnthropicThinkingParams("high", 0.2);
  assert.deepEqual(anthropicHigh.thinking, { type: "enabled", budget_tokens: 16384 });
  assert.equal(anthropicHigh.temperature, undefined);
  assert.ok(anthropicHigh.max_tokens > 16384);

  const anthropicOff = buildAnthropicThinkingParams("off", 0.2);
  assert.equal(anthropicOff.thinking, undefined);
  assert.equal(anthropicOff.temperature, 0.2);

  // Automatic fallback when upstream rejects reasoning_effort:
  const payloads = [];
  const store = createMockSnapshotStore(sampleSeed());
  const fallbackRes = await runHermesAgentChat({
    language: "zh",
    thinkLevel: "off",
    messages: [{ role: "user", content: "你好" }],
    config: {
      provider: "custom",
      apiFormat: "openai",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-test-12345678",
      model: "legacy-chat",
      smartenanceAccountKey: "auto",
      temperature: 0.2,
      maxToolSteps: 4,
      thinkLevel: "off",
      systemPrompt: "",
      source: "database",
    },
    runTool: (name, args) => executeHermesTool(name, args, { store }),
    fetcher: async (_url, init) => {
      const body = JSON.parse(init.body);
      payloads.push(body);
      if (body.reasoning_effort !== undefined) {
        return new Response(
          JSON.stringify({ error: { message: "Unknown parameter: 'reasoning_effort'" } }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({
          model: "legacy-chat",
          choices: [{ message: { role: "assistant", content: "<think>hidden</think>你好！" } }],
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].reasoning_effort, "none");
  assert.equal(payloads[1].reasoning_effort, undefined);
  assert.equal(fallbackRes.reply, "你好！");
  assert.equal(fallbackRes.reasoning, undefined);
});

test("runHermesAgentChat executes multi-step tool calls for OpenAI and Anthropic formats", async () => {
  const store = createMockSnapshotStore(sampleSeed());
  let openAiCalls = 0;

  const openAiResult = await runHermesAgentChat({
    language: "zh",
    messages: [{ role: "user", content: "查看工厂概览" }],
    config: {
      provider: "deepseek",
      apiFormat: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test-12345678",
      model: "deepseek-reasoner",
      smartenanceAccountKey: "auto",
      temperature: 0.2,
      maxToolSteps: 4,
      thinkLevel: "medium",
      systemPrompt: "",
      source: "database",
    },
    runTool: (name, args) => executeHermesTool(name, args, { store }),
    fetcher: async (_url, init) => {
      openAiCalls += 1;
      const body = JSON.parse(init.body);
      if (openAiCalls === 1) {
        return new Response(
          JSON.stringify({
            model: "deepseek-reasoner",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  reasoning_content: "先调用 get_factory_overview 查询快照",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "get_factory_overview",
                        arguments: JSON.stringify({ machine_limit: 5 }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      // Verify reasoning_content was preserved on assistant turn:
      const assistantTurn = body.messages.find((m) => m.role === "assistant");
      assert.equal(assistantTurn.reasoning_content, "先调用 get_factory_overview 查询快照");
      return new Response(
        JSON.stringify({
          model: "deepseek-reasoner",
          choices: [{ message: { role: "assistant", content: "当前共有 **3** 台设备，未关闭故障 **2** 条。" } }],
        }),
        { status: 200 },
      );
    },
  });

  assert.equal(openAiResult.toolCalls.length, 1);
  assert.equal(openAiResult.toolCalls[0].tool, "get_factory_overview");
  assert.equal(openAiResult.toolCalls[0].ok, true);
  assert.match(openAiResult.reply, /3/);

  // Anthropic format test + connection test:
  let anthropicCalls = 0;
  const anthropicResult = await runHermesAgentChat({
    language: "en",
    messages: [{ role: "user", content: "Rank machine risk" }],
    config: {
      provider: "anthropic",
      apiFormat: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-12345678",
      model: "claude-3-5-sonnet-latest",
      smartenanceAccountKey: "auto",
      temperature: 0.2,
      maxToolSteps: 4,
      thinkLevel: "medium",
      systemPrompt: "",
      source: "database",
    },
    runTool: (name, args) => executeHermesTool(name, args, { store }),
    fetcher: async () => {
      anthropicCalls += 1;
      if (anthropicCalls === 1) {
        return new Response(
          JSON.stringify({
            model: "claude-3-5-sonnet-20241022",
            stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "toolu_1", name: "get_machine_risk_ranking", input: { limit: 5 } }],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          model: "claude-3-5-sonnet-20241022",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Highest risk machine is M-101 (score 45)." }],
        }),
        { status: 200 },
      );
    },
  });

  assert.equal(anthropicResult.toolCalls.length, 1);
  assert.equal(anthropicResult.toolCalls[0].tool, "get_machine_risk_ranking");
  assert.match(anthropicResult.reply, /M-101/);

  const ping = await testModelConnection(
    {
      provider: "ollama",
      apiFormat: "openai",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "",
      model: "qwen2.5:14b",
    },
    async () => new Response(JSON.stringify({ model: "qwen2.5:14b" }), { status: 200 }),
  );
  assert.equal(ping.ok, true);
  assert.equal(ping.model, "qwen2.5:14b");
});
