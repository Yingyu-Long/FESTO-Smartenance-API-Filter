import {
  providerRequiresApiKey,
  validateBaseUrl,
  type HermesConfigServer,
} from "./config.ts";
import { HERMES_TOOLS, executeHermesTool, type HermesToolDefinition } from "./tools.ts";

export interface ToolCallTrace {
  ok: boolean;
  tool: string;
  arguments: Record<string, unknown>;
  durationMs: number;
  result?: unknown;
  error?: string;
}

export interface ChatTurnInput {
  role: "user" | "assistant";
  content: string;
}

export interface HermesChatResult {
  reply: string;
  toolCalls: ToolCallTrace[];
  model: string;
}

function buildOpenAiChatUrl(baseUrl: string): string {
  const clean = validateBaseUrl(baseUrl);
  if (clean.endsWith("/chat/completions")) return clean;
  return `${clean}/chat/completions`;
}

function buildAnthropicMessagesUrl(baseUrl: string): string {
  const clean = validateBaseUrl(baseUrl);
  if (clean.endsWith("/messages")) return clean;
  if (clean.endsWith("/v1")) return `${clean}/messages`;
  return `${clean}/v1/messages`;
}

function buildSystemPrompt(language: "en" | "zh", extraPrompt: string): string {
  const base =
    language === "zh"
      ? [
          "你是 Festo Smartenance Agent（设备维保与故障诊断智能助手），已直连本地 PostgreSQL 数据库中的 Smartenance 设备与故障快照。",
          "回答任何关于工厂概览、设备清单、故障历史、健康度评分、风险排行、故障趋势或维修人员月度工时的问题时，必须先调用对应的 Smartenance 工具获取真实数据库数据，严禁凭空编造设备编号、故障数量或工时数据。",
          "如果数据库中尚未同步任何设备（machine_count 为 0），请清晰提示用户先在「维修任务导出」页面连接 Smartenance 账号并点击「同步全部设备」。",
          "请使用清晰、结构化的中文（支持 Markdown 标题、加粗与列表）总结诊断结论、关键指标与整改建议。",
        ].join("\n")
      : [
          "You are the Festo Smartenance Agent, an industrial maintenance and diagnostics assistant connected directly to the local PostgreSQL Smartenance snapshot database.",
          "Always call the appropriate Smartenance tools to retrieve real database records before answering questions about factory overview, machines, incident history, health scores, risk rankings, incident trends, or employee repair work hours. Never fabricate numbers, machine IDs, or hours.",
          "If the database has 0 synced machines, clearly guide the user to connect to Smartenance and sync machines on the Repair Task Export page first.",
          "Present concise, structured Markdown summaries highlighting key metrics, risks, and actionable maintenance recommendations.",
        ].join("\n");

  return extraPrompt.trim() ? `${base}\n\nAdditional site instructions:\n${extraPrompt.trim()}` : base;
}

function truncateToolPayloadForLlm(value: unknown, maxChars = 48_000): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxChars) return serialized;
  return `${serialized.slice(0, maxChars)}\n...[truncated ${serialized.length - maxChars} chars]`;
}

async function parseErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return `Upstream LLM returned HTTP ${res.status}.`;
  try {
    const data = JSON.parse(text) as {
      error?: string | { message?: string; type?: string };
      message?: string;
    };
    if (typeof data.error === "string") return data.error;
    if (data.error && typeof data.error.message === "string") return data.error.message;
    if (typeof data.message === "string") return data.message;
  } catch {
    // Fall back to raw text snippet.
  }
  return `Upstream LLM HTTP ${res.status}: ${text.slice(0, 280)}`;
}

export async function testModelConnection(
  input: {
    provider: string;
    apiFormat: "openai" | "anthropic";
    baseUrl: string;
    apiKey: string;
    model: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true; model: string; latencyMs: number }> {
  const model = input.model.trim();
  if (!model) throw new Error("Model name is required.");
  const requiresKey = providerRequiresApiKey(input.provider, input.baseUrl);
  if (requiresKey && !input.apiKey.trim()) {
    throw new Error("API Key is required for this provider.");
  }

  const started = Date.now();
  const signal = AbortSignal.timeout(25_000);

  if (input.apiFormat === "anthropic") {
    const url = buildAnthropicMessagesUrl(input.baseUrl);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (input.apiKey.trim()) headers["x-api-key"] = input.apiKey.trim();

    const res = await fetcher(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with OK." }],
      }),
      signal,
    });
    if (!res.ok) throw new Error(await parseErrorMessage(res));
    const data = (await res.json()) as { model?: string };
    return { ok: true, model: data.model || model, latencyMs: Date.now() - started };
  }

  const url = buildOpenAiChatUrl(input.baseUrl);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (input.apiKey.trim()) headers.Authorization = `Bearer ${input.apiKey.trim()}`;

  const res = await fetcher(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with OK." }],
    }),
    signal,
  });
  if (!res.ok) throw new Error(await parseErrorMessage(res));
  const data = (await res.json()) as { model?: string };
  return { ok: true, model: data.model || model, latencyMs: Date.now() - started };
}

export async function runHermesAgentChat(options: {
  messages: ChatTurnInput[];
  language: "en" | "zh";
  config: HermesConfigServer;
  tools?: HermesToolDefinition[];
  runTool?: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}): Promise<HermesChatResult> {
  const { config, language } = options;
  const fetcher = options.fetcher ?? fetch;
  const tools = options.tools ?? HERMES_TOOLS;
  const runTool =
    options.runTool ??
    ((name: string, args: Record<string, unknown>) =>
      executeHermesTool(name, args, { accountKey: config.smartenanceAccountKey }));

  const requiresKey = providerRequiresApiKey(config.provider, config.baseUrl);
  if (requiresKey && !config.apiKey.trim()) {
    throw new Error(
      language === "zh"
        ? "尚未配置大模型 API Key，请先在「模型配置」中填入并保存 API Key。"
        : "LLM API Key is not configured yet. Please configure and save an API Key in Model Settings.",
    );
  }

  const sanitizedHistory = options.messages
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0,
    )
    .slice(-24);

  if (sanitizedHistory.length === 0) {
    throw new Error("At least one user message is required.");
  }

  const systemPrompt = buildSystemPrompt(language, config.systemPrompt);
  const traces: ToolCallTrace[] = [];
  const maxSteps = Math.min(16, Math.max(1, config.maxToolSteps || 8));

  const invokeToolWithTrace = async (
    name: string,
    rawArguments: unknown,
  ): Promise<{ trace: ToolCallTrace; payloadForLlm: unknown }> => {
    let parsedArgs: Record<string, unknown> = {};
    if (typeof rawArguments === "string") {
      if (rawArguments.trim()) {
        try {
          const decoded = JSON.parse(rawArguments) as unknown;
          if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
            parsedArgs = decoded as Record<string, unknown>;
          }
        } catch {
          const trace: ToolCallTrace = {
            ok: false,
            tool: name,
            arguments: {},
            durationMs: 0,
            error: `Invalid JSON tool arguments: ${rawArguments.slice(0, 200)}`,
          };
          traces.push(trace);
          return { trace, payloadForLlm: { ok: false, error: trace.error } };
        }
      }
    } else if (rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)) {
      parsedArgs = rawArguments as Record<string, unknown>;
    }

    const t0 = Date.now();
    try {
      const result = await runTool(name, parsedArgs);
      const trace: ToolCallTrace = {
        ok: true,
        tool: name,
        arguments: parsedArgs,
        durationMs: Date.now() - t0,
        result,
      };
      traces.push(trace);
      return { trace, payloadForLlm: { ok: true, result } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const trace: ToolCallTrace = {
        ok: false,
        tool: name,
        arguments: parsedArgs,
        durationMs: Date.now() - t0,
        error: message,
      };
      traces.push(trace);
      return { trace, payloadForLlm: { ok: false, error: message } };
    }
  };

  if (config.apiFormat === "anthropic") {
    const url = buildAnthropicMessagesUrl(config.baseUrl);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (config.apiKey.trim()) headers["x-api-key"] = config.apiKey.trim();

    const anthropicTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

    const convo: Array<{ role: "user" | "assistant"; content: unknown }> = sanitizedHistory.map(
      (m) => ({ role: m.role, content: m.content }),
    );
    let resolvedModel = config.model;

    for (let step = 0; step <= maxSteps; step++) {
      const allowTools = step < maxSteps;
      const res = await fetcher(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.model,
          max_tokens: 4096,
          temperature: config.temperature,
          system: systemPrompt,
          messages: convo,
          ...(allowTools ? { tools: anthropicTools } : {}),
        }),
        signal: options.signal ?? AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(await parseErrorMessage(res));

      const data = (await res.json()) as {
        model?: string;
        stop_reason?: string;
        content?: Array<{
          type: string;
          text?: string;
          id?: string;
          name?: string;
          input?: unknown;
        }>;
      };
      if (data.model) resolvedModel = data.model;
      const blocks = Array.isArray(data.content) ? data.content : [];
      const toolUses = blocks.filter((b) => b.type === "tool_use" && b.id && b.name);

      if (!allowTools || toolUses.length === 0) {
        const reply = blocks
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n")
          .trim();
        return { reply, toolCalls: traces, model: resolvedModel };
      }

      convo.push({ role: "assistant", content: blocks });
      const toolResults: Array<Record<string, unknown>> = [];
      for (const tu of toolUses) {
        const { trace, payloadForLlm } = await invokeToolWithTrace(tu.name!, tu.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id!,
          content: truncateToolPayloadForLlm(payloadForLlm),
          is_error: !trace.ok,
        });
      }
      convo.push({ role: "user", content: toolResults });
    }

    return { reply: "", toolCalls: traces, model: resolvedModel };
  }

  // OpenAI-compatible (/chat/completions)
  const url = buildOpenAiChatUrl(config.baseUrl);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`;

  const openAiTools = tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const convo: Array<Record<string, unknown>> = [
    { role: "system", content: systemPrompt },
    ...sanitizedHistory.map((m) => ({ role: m.role, content: m.content })),
  ];
  let resolvedModel = config.model;

  for (let step = 0; step <= maxSteps; step++) {
    const allowTools = step < maxSteps;
    const res = await fetcher(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        messages: convo,
        ...(allowTools ? { tools: openAiTools, tool_choice: "auto" } : {}),
      }),
      signal: options.signal ?? AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(await parseErrorMessage(res));

    const data = (await res.json()) as {
      model?: string;
      choices?: Array<{
        message?: {
          role?: string;
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: Array<{
            id: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };
    if (data.model) resolvedModel = data.model;
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("Upstream LLM returned an empty choices response.");

    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!allowTools || toolCalls.length === 0) {
      return {
        reply: typeof msg.content === "string" ? msg.content.trim() : "",
        toolCalls: traces,
        model: resolvedModel,
      };
    }

    const assistantTurn: Record<string, unknown> = {
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: toolCalls,
    };
    if (typeof msg.reasoning_content === "string") {
      assistantTurn.reasoning_content = msg.reasoning_content;
    }
    convo.push(assistantTurn);

    for (const call of toolCalls) {
      const toolName = call.function?.name ?? "";
      const { payloadForLlm } = await invokeToolWithTrace(toolName, call.function?.arguments ?? "{}");
      convo.push({
        role: "tool",
        tool_call_id: call.id,
        content: truncateToolPayloadForLlm(payloadForLlm),
      });
    }
  }

  return { reply: "", toolCalls: traces, model: resolvedModel };
}
