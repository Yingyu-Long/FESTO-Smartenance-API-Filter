import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getIncidentStore } from "../festo/database.ts";
import { listSmartenanceAccounts, type SnapshotStore, type SmartenanceAccountInfo } from "./incident-service.ts";

export type ThinkLevel = "off" | "low" | "medium" | "high";

export const THINK_LEVELS: readonly ThinkLevel[] = ["off", "low", "medium", "high"] as const;

export function normalizeThinkLevel(value: unknown, fallback: ThinkLevel = "off"): ThinkLevel {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "off" || normalized === "none" || normalized === "nothink") return "off";
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return fallback;
}

export interface ProviderPreset {
  id: string;
  label: string;
  apiFormat: "openai" | "anthropic";
  defaultBaseUrl: string;
  defaultModel: string;
  requiresApiKey: boolean;
}

export interface HermesConfigServer {
  provider: string;
  apiFormat: "openai" | "anthropic";
  baseUrl: string;
  apiKey: string;
  model: string;
  smartenanceAccountKey: string;
  temperature: number;
  maxToolSteps: number;
  thinkLevel: ThinkLevel;
  systemPrompt: string;
  source: "database" | "env";
}

export interface HermesConfigClient {
  provider: string;
  apiFormat: "openai" | "anthropic";
  baseUrl: string;
  model: string;
  smartenanceAccountKey: string;
  temperature: number;
  maxToolSteps: number;
  thinkLevel: ThinkLevel;
  systemPrompt: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
  requiresApiKey: boolean;
  configured: boolean;
  source: "database" | "env";
}

export interface PythonBridgeStatus {
  bridgeExists: boolean;
  pythonPath: string;
  usingVenv: boolean;
}

export interface HermesConfigPatch {
  provider?: string;
  apiFormat?: "openai" | "anthropic";
  baseUrl?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  model?: string;
  smartenanceAccountKey?: string;
  temperature?: number;
  maxToolSteps?: number;
  thinkLevel?: ThinkLevel;
  systemPrompt?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    apiFormat: "openai",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    requiresApiKey: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    apiFormat: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    requiresApiKey: true,
  },
  {
    id: "qwen",
    label: "通义千问 (Qwen)",
    apiFormat: "openai",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    requiresApiKey: true,
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    apiFormat: "openai",
    defaultBaseUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "deepseek-ai/DeepSeek-V3",
    requiresApiKey: true,
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    apiFormat: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-3-5-sonnet-latest",
    requiresApiKey: true,
  },
  {
    id: "ollama",
    label: "Ollama (Local)",
    apiFormat: "openai",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "qwen2.5:14b",
    requiresApiKey: false,
  },
  {
    id: "custom",
    label: "Custom OpenAI",
    apiFormat: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    requiresApiKey: true,
  },
];

export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "••••••••";
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

export function providerRequiresApiKey(provider: string, baseUrl: string): boolean {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "ollama" || normalized === "local" || normalized === "vllm") {
    return false;
  }
  try {
    const parsed = new URL(baseUrl);
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      return false;
    }
  } catch {
    // Fall through to preset lookup.
  }
  const preset = PROVIDER_PRESETS.find((item) => item.id === normalized);
  return preset ? preset.requiresApiKey : true;
}

export function toClientConfig(server: HermesConfigServer): HermesConfigClient {
  const hasApiKey = Boolean(server.apiKey.trim());
  const requiresApiKey = providerRequiresApiKey(server.provider, server.baseUrl);
  const configured =
    Boolean(server.baseUrl.trim() && server.model.trim()) && (!requiresApiKey || hasApiKey);
  return {
    provider: server.provider,
    apiFormat: server.apiFormat,
    baseUrl: server.baseUrl,
    model: server.model,
    smartenanceAccountKey: server.smartenanceAccountKey || "auto",
    temperature: server.temperature,
    maxToolSteps: server.maxToolSteps,
    thinkLevel: normalizeThinkLevel(server.thinkLevel),
    systemPrompt: server.systemPrompt,
    hasApiKey,
    apiKeyMasked: maskApiKey(server.apiKey),
    requiresApiKey,
    configured,
    source: server.source,
  };
}

export function envDefaultHermesConfig(
  env: NodeJS.ProcessEnv = process.env,
): HermesConfigServer {
  const provider = (env.HERMES_PROVIDER ?? "custom").trim() || "custom";
  const rawFormat = (env.HERMES_API_FORMAT ?? "openai").trim().toLowerCase();
  const apiFormat = rawFormat === "anthropic" ? "anthropic" : "openai";
  const temp = Number(env.HERMES_TEMPERATURE ?? 0.2);
  const steps = Number(env.HERMES_MAX_TOOL_STEPS ?? 8);
  return {
    provider,
    apiFormat,
    baseUrl: (env.HERMES_BASE_URL ?? "").trim(),
    apiKey: (env.HERMES_API_KEY ?? "").trim(),
    model: (env.HERMES_MODEL ?? "").trim(),
    smartenanceAccountKey: (env.SMARTENANCE_ACCOUNT_KEY ?? "auto").trim() || "auto",
    temperature: Number.isFinite(temp) ? Math.min(2, Math.max(0, temp)) : 0.2,
    maxToolSteps: Number.isFinite(steps) ? Math.min(16, Math.max(1, Math.trunc(steps))) : 8,
    thinkLevel: normalizeThinkLevel(env.HERMES_THINK_LEVEL, "off"),
    systemPrompt: (env.HERMES_SYSTEM_PROMPT ?? "").trim(),
    source: "env",
  };
}

export async function readHermesConfig(store?: SnapshotStore): Promise<HermesConfigServer> {
  const fallback = envDefaultHermesConfig();
  if (!store && !process.env.DATABASE_URL) {
    return fallback;
  }
  try {
    const db: SnapshotStore = store ?? getIncidentStore();
    const res = await db.query<{
      provider: string;
      api_format: string;
      base_url: string;
      api_key: string;
      model: string;
      smartenance_account_key: string;
      temperature: number;
      max_tool_steps: number;
      think_level?: string;
      system_prompt: string;
    }>(`SELECT * FROM hermes_agent_config WHERE id = 1`);
    const row = res.rows[0];
    if (!row) return fallback;
    return {
      provider: row.provider || fallback.provider,
      apiFormat: row.api_format === "anthropic" ? "anthropic" : "openai",
      baseUrl: row.base_url ?? fallback.baseUrl,
      apiKey: row.api_key ?? "",
      model: row.model ?? fallback.model,
      smartenanceAccountKey: row.smartenance_account_key || "auto",
      temperature: Number.isFinite(Number(row.temperature)) ? Number(row.temperature) : 0.2,
      maxToolSteps: Number.isFinite(Number(row.max_tool_steps))
        ? Math.min(16, Math.max(1, Math.trunc(Number(row.max_tool_steps))))
        : 8,
      thinkLevel: normalizeThinkLevel(row.think_level, fallback.thinkLevel),
      systemPrompt: row.system_prompt ?? "",
      source: "database",
    };
  } catch {
    return fallback;
  }
}

export function validateBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Base URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Base URL must be a valid http:// or https:// URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL must use http:// or https://.");
  }
  return trimmed;
}

export async function saveHermesConfig(
  patch: HermesConfigPatch,
  store?: SnapshotStore,
): Promise<HermesConfigServer> {
  const db: SnapshotStore = store ?? getIncidentStore();
  const current = await readHermesConfig(db);

  const isPartialControlPatch =
    patch.baseUrl === undefined &&
    patch.model === undefined &&
    patch.apiKey === undefined &&
    patch.provider === undefined &&
    patch.apiFormat === undefined;

  const provider =
    patch.provider !== undefined ? patch.provider.trim() || current.provider : current.provider;
  const apiFormat =
    patch.apiFormat !== undefined
      ? patch.apiFormat === "anthropic"
        ? "anthropic"
        : "openai"
      : current.apiFormat;
  const baseUrl =
    patch.baseUrl !== undefined
      ? validateBaseUrl(patch.baseUrl)
      : isPartialControlPatch && !current.baseUrl.trim()
        ? ""
        : validateBaseUrl(current.baseUrl);
  const model = patch.model !== undefined ? patch.model.trim() : current.model.trim();
  if (!isPartialControlPatch && !model) throw new Error("Model name is required.");

  const apiKey = patch.clearApiKey
    ? ""
    : patch.apiKey !== undefined && patch.apiKey.trim()
      ? patch.apiKey.trim()
      : current.apiKey;
  const smartenanceAccountKey =
    patch.smartenanceAccountKey !== undefined
      ? patch.smartenanceAccountKey.trim() || "auto"
      : current.smartenanceAccountKey || "auto";

  const temperature =
    patch.temperature !== undefined ? Number(patch.temperature) : current.temperature;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error("Temperature must be between 0 and 2.");
  }

  const maxToolSteps =
    patch.maxToolSteps !== undefined
      ? Math.trunc(Number(patch.maxToolSteps))
      : current.maxToolSteps;
  if (!Number.isFinite(maxToolSteps) || maxToolSteps < 1 || maxToolSteps > 16) {
    throw new Error("Max tool steps must be between 1 and 16.");
  }

  const thinkLevel =
    patch.thinkLevel !== undefined
      ? normalizeThinkLevel(patch.thinkLevel, current.thinkLevel)
      : current.thinkLevel;

  const systemPrompt =
    patch.systemPrompt !== undefined ? String(patch.systemPrompt).trim() : current.systemPrompt;

  await db.query(
    `INSERT INTO hermes_agent_config (
       id, provider, api_format, base_url, api_key, model,
       smartenance_account_key, temperature, max_tool_steps, think_level, system_prompt, updated_at
     )
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp())
     ON CONFLICT (id) DO UPDATE SET
       provider = EXCLUDED.provider,
       api_format = EXCLUDED.api_format,
       base_url = EXCLUDED.base_url,
       api_key = EXCLUDED.api_key,
       model = EXCLUDED.model,
       smartenance_account_key = EXCLUDED.smartenance_account_key,
       temperature = EXCLUDED.temperature,
       max_tool_steps = EXCLUDED.max_tool_steps,
       think_level = EXCLUDED.think_level,
       system_prompt = EXCLUDED.system_prompt,
       updated_at = clock_timestamp()`,
    [
      provider,
      apiFormat,
      baseUrl,
      apiKey,
      model,
      smartenanceAccountKey,
      temperature,
      maxToolSteps,
      thinkLevel,
      systemPrompt,
    ],
  );

  return readHermesConfig(db);
}

export function detectPythonBridge(cwd: string = process.cwd()): PythonBridgeStatus {
  const bridgeFile = resolve(cwd, "backend/tool_runner.py");
  const bridgeExists = existsSync(bridgeFile);
  const venvCandidates = [
    process.env.HERMES_PYTHON_PATH,
    resolve(cwd, ".venv/bin/python"),
    resolve(cwd, "venv/bin/python"),
  ].filter((p): p is string => Boolean(p && p.trim()));

  for (const candidate of venvCandidates) {
    if (existsSync(candidate)) {
      return { bridgeExists, pythonPath: candidate, usingVenv: true };
    }
  }
  return {
    bridgeExists,
    pythonPath: bridgeExists ? "Native Node.js PG · backend/tool_runner.py" : "Native Node.js PG",
    usingVenv: false,
  };
}

export async function readHermesBootstrap(store?: SnapshotStore): Promise<{
  config: HermesConfigClient;
  presets: ProviderPreset[];
  accounts: SmartenanceAccountInfo[];
  pythonBridge: PythonBridgeStatus;
}> {
  const serverConfig = await readHermesConfig(store);
  let accounts: SmartenanceAccountInfo[] = [];
  if (store || process.env.DATABASE_URL) {
    try {
      accounts = await listSmartenanceAccounts(store ?? getIncidentStore());
    } catch {
      accounts = [];
    }
  }
  return {
    config: toClientConfig(serverConfig),
    presets: PROVIDER_PRESETS,
    accounts,
    pythonBridge: detectPythonBridge(),
  };
}
