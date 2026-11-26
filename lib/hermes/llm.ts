import {
  normalizeThinkLevel,
  providerRequiresApiKey,
  validateBaseUrl,
  type HermesConfigServer,
  type ThinkLevel,
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
  reasoning?: string;
  toolCalls: ToolCallTrace[];
  model: string;
  thinkLevel: ThinkLevel;
}

const THINK_BUDGET_TOKENS: Record<Exclude<ThinkLevel, "off">, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
};

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

function buildSystemPrompt(
  language: "en" | "zh",
  extraPrompt: string,
  thinkLevel: ThinkLevel,
): string {
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

  const thinkHint =
    thinkLevel === "off"
      ? language === "zh"
        ? "直接给出简洁准确的最终答案，不要输出冗长的思考过程。"
        : "Answer directly and concisely without verbose chain-of-thought reasoning."
      : "";

  return [
    base,
    thinkHint,
    extraPrompt.trim() ? `Additional site instructions:\n${extraPrompt.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildOpenAiThinkingParams(
  baseUrl: string,
  model: string,
  thinkLevel: ThinkLevel,
): Record<string, unknown> {
  const lowerUrl = baseUrl.toLowerCase();
  const lowerModel = model.toLowerCase();

  // Qwen3 / DashScope / QwQ: native enable_thinking + thinking_budget
  if (lowerUrl.includes("dashscope") || /\b(qwen3|qwq)/i.test(lowerModel)) {
    if (thinkLevel === "off") {
      return { enable_thinking: false };
    }
    return {
      enable_thinking: true,
      thinking_budget: THINK_BUDGET_TOKENS[thinkLevel],
    };
  }

  // DeepSeek V3.2+ / deepseek-reasoner: native thinking object + reasoning_effort
  if (lowerUrl.includes("deepseek") || lowerModel.includes("deepseek")) {
    if (thinkLevel === "off") {
      return { thinking: { type: "disabled" } };
    }
    return {
      thinking: { type: "enabled" },
      reasoning_effort: thinkLevel,
    };
  }

  // Standard OpenAI-compatible (OpenAI, Gemini, OpenRouter, Ollama, vLLM, SiliconFlow, Custom)
  if (thinkLevel === "off") {
    return { reasoning_effort: "none" };
  }
  return { reasoning_effort: thinkLevel };
}

export function buildAnthropicThinkingParams(
  thinkLevel: ThinkLevel,
  temperature: number,
): { max_tokens: number; temperature?: number; thinking?: { type: "enabled"; budget_tokens: number } } {
  if (thinkLevel === "off") {
    return { max_tokens: 4096, temperature };
  }
  const budgetTokens = THINK_BUDGET_TOKENS[thinkLevel];
  return {
    max_tokens: Math.max(4096, budgetTokens + 4096),
    thinking: { type: "enabled", budget_tokens: budgetTokens },
  };
}

function isUnsupportedThinkingParamError(status: number, errorMessage: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return /reasoning_effort|enable_thinking|thinking_budget|"thinking"|'thinking'|thinking\b|unrecognized|unknown (?:field|parameter)|extra_forbidden|not supported/i.test(
    errorMessage,
  );
}

function extractInlineThinkTags(content: string): { reply: string; inlineReasoning: string } {
  const segments: string[] = [];
  const cleaned = content
    .replace(/<think>([\s\S]*?)<\/think>/gi, (_, inner: string) => {
      const trimmed = inner.trim();
      if (trimmed) segments.push(trimmed);
      return "";
    })
    .trim();
  return { reply: cleaned, inlineReasoning: segments.join("\n\n") };
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
  thinkLevel?: ThinkLevel;
  tools?: HermesToolDefinition[];
  runTool?: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}): Promise<HermesChatResult> {
  const { config, language } = options;
  const thinkLevel = normalizeThinkLevel(options.thinkLevel ?? config.thinkLevel, "off");
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

  const systemPrompt = buildSystemPrompt(language, config.systemPrompt, thinkLevel);
  const traces: ToolCallTrace[] = [];
  const reasoningParts: string[] = [];
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
    let useThinkingParams = thinkLevel !== "off";

    for (let step = 0; step <= maxSteps; step++) {
      const allowTools = step < maxSteps;
      const buildBody = (withThinking: boolean) => {
        const thinkingOpts = buildAnthropicThinkingParams(
          withThinking ? thinkLevel : "off",
          config.temperature,
        );
        return {
          model: config.model,
          ...thinkingOpts,
          system: systemPrompt,
          messages: convo,
          ...(allowTools ? { tools: anthropicTools } : {}),
        };
      };

      let res = await fetcher(url, {
        method: "POST",
        headers,
        body: JSON.stringify(buildBody(useThinkingParams)),
        signal: options.signal ?? AbortSignal.timeout(90_000),
      });
      if (!res.ok && useThinkingParams) {
        const errMsg = await parseErrorMessage(res);
        if (isUnsupportedThinkingParamError(res.status, errMsg)) {
          useThinkingParams = false;
          res = await fetcher(url, {
            method: "POST",
            headers,
            body: JSON.stringify(buildBody(false)),
            signal: options.signal ?? AbortSignal.timeout(90_000),
          });
        } else {
          throw new Error(errMsg);
        }
      }
      if (!res.ok) throw new Error(await parseErrorMessage(res));

      const data = (await res.json()) as {
        model?: string;
        stop_reason?: string;
        content?: Array<{
          type: string;
          text?: string;
          thinking?: string;
          id?: string;
          name?: string;
          input?: unknown;
        }>;
      };
      if (data.model) resolvedModel = data.model;
      const blocks = Array.isArray(data.content) ? data.content : [];
      for (const b of blocks) {
        if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
          reasoningParts.push(b.thinking.trim());
        }
      }
      const toolUses = blocks.filter((b) => b.type === "tool_use" && b.id && b.name);

      if (!allowTools || toolUses.length === 0) {
        const reply = blocks
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n")
          .trim();
        const reasoning = thinkLevel !== "off" ? reasoningParts.join("\n\n").trim() : "";
        return {
          reply,
          ...(reasoning ? { reasoning } : {}),
          toolCalls: traces,
          model: resolvedModel,
          thinkLevel,
        };
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

    return { reply: "", toolCalls: traces, model: resolvedModel, thinkLevel };
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
  let thinkingParams = buildOpenAiThinkingParams(config.baseUrl, config.model, thinkLevel);

  for (let step = 0; step <= maxSteps; step++) {
    const allowTools = step < maxSteps;
    const buildBody = (extraThinking: Record<string, unknown>) => ({
      model: config.model,
      temperature: config.temperature,
      messages: convo,
      ...extraThinking,
      ...(allowTools ? { tools: openAiTools, tool_choice: "auto" } : {}),
    });

    let res = await fetcher(url, {
      method: "POST",
      headers,
      body: JSON.stringify(buildBody(thinkingParams)),
      signal: options.signal ?? AbortSignal.timeout(90_000),
    });
    if (!res.ok && Object.keys(thinkingParams).length > 0) {
      const errMsg = await parseErrorMessage(res);
      if (isUnsupportedThinkingParamError(res.status, errMsg)) {
        thinkingParams = {};
        res = await fetcher(url, {
          method: "POST",
          headers,
          body: JSON.stringify(buildBody({})),
          signal: options.signal ?? AbortSignal.timeout(90_000),
        });
      } else {
        throw new Error(errMsg);
      }
    }
    if (!res.ok) throw new Error(await parseErrorMessage(res));

    const data = (await res.json()) as {
      model?: string;
      choices?: Array<{
        message?: {
          role?: string;
          content?: string | null;
          reasoning_content?: string | null;
          reasoning?: string | null;
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

    const rawReasoning =
      typeof msg.reasoning_content === "string"
        ? msg.reasoning_content.trim()
        : typeof msg.reasoning === "string"
          ? msg.reasoning.trim()
          : "";
    if (rawReasoning) reasoningParts.push(rawReasoning);

    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!allowTools || toolCalls.length === 0) {
      const rawContent = typeof msg.content === "string" ? msg.content.trim() : "";
      const { reply, inlineReasoning } = extractInlineThinkTags(rawContent);
      if (inlineReasoning) reasoningParts.push(inlineReasoning);
      const reasoning = thinkLevel !== "off" ? reasoningParts.join("\n\n").trim() : "";
      return {
        reply,
        ...(reasoning ? { reasoning } : {}),
        toolCalls: traces,
        model: resolvedModel,
        thinkLevel,
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

  return { reply: "", toolCalls: traces, model: resolvedModel, thinkLevel };
}
