"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowUp,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  Globe,
  KeyRound,
  Layers,
  LoaderCircle,
  Settings2,
  ShieldAlert,
  Trash2,
  Wrench,
  Zap,
} from "lucide-react";

export type HermesView = "chat" | "settings";

const FESTO_ART = [
  "███████╗███████╗███████╗████████╗ ██████╗ ",
  "██╔════╝██╔════╝██╔════╝╚══██╔══╝██╔═══██╗",
  "█████╗  █████╗  ███████╗   ██║   ██║   ██║",
  "██╔══╝  ██╔══╝  ╚════██║   ██║   ██║   ██║",
  "██║     ███████╗███████║   ██║   ╚██████╔╝",
  "╚═╝     ╚══════╝╚══════╝   ╚═╝    ╚═════╝ ",
].join("\n");

function FestoAsciiLogo() {
  return (
    <pre className="hermes-festo-ascii" aria-label="FESTO">
      {FESTO_ART}
    </pre>
  );
}

interface HermesConfigClient {
  provider: string;
  apiFormat: "openai" | "anthropic";
  baseUrl: string;
  model: string;
  smartenanceAccountKey: string;
  temperature: number;
  maxToolSteps: number;
  systemPrompt: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
  requiresApiKey: boolean;
  configured: boolean;
  source: "database" | "env";
}

interface HermesToolDefinition {
  name: string;
  category: "smartenance";
  description: string;
}

interface ToolCallTrace {
  ok: boolean;
  tool: string;
  arguments: Record<string, unknown>;
  durationMs: number;
  result?: unknown;
  error?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallTrace[];
  error?: boolean;
  createdAt: string;
}

interface HermesAgentModuleProps {
  language: "en" | "zh";
  activeView: HermesView;
  onViewChange: (view: HermesView) => void;
}

function renderInlineMarkdown(text: string) {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return tokens.map((token, idx) => {
    if (token.startsWith("`") && token.endsWith("`") && token.length >= 2) {
      return (
        <code key={idx} className="hermes-inline-code">
          {token.slice(1, -1)}
        </code>
      );
    }
    if (token.startsWith("**") && token.endsWith("**") && token.length >= 4) {
      return <strong key={idx}>{token.slice(2, -2)}</strong>;
    }
    return <span key={idx}>{token}</span>;
  });
}

function FormattedMessage({ content }: { content: string }) {
  const blocks = content.split(/```([\s\S]*?)```/g);
  return (
    <div className="hermes-markdown">
      {blocks.map((block, blockIdx) => {
        if (blockIdx % 2 === 1) {
          const firstNewline = block.indexOf("\n");
          const codeBody = firstNewline >= 0 ? block.slice(firstNewline + 1) : block;
          return (
            <pre key={blockIdx} className="hermes-code-block">
              <code>{codeBody.trimEnd()}</code>
            </pre>
          );
        }

        const lines = block.split("\n");
        const elements: React.ReactNode[] = [];
        let listItems: string[] = [];

        const flushList = (keyPrefix: string) => {
          if (listItems.length === 0) return;
          elements.push(
            <ul key={`${keyPrefix}-ul`} className="hermes-md-list">
              {listItems.map((item, idx) => (
                <li key={idx}>{renderInlineMarkdown(item)}</li>
              ))}
            </ul>,
          );
          listItems = [];
        };

        lines.forEach((rawLine, lineIdx) => {
          const line = rawLine.trimEnd();
          const trimmed = line.trim();
          if (!trimmed) {
            flushList(`${blockIdx}-${lineIdx}`);
            return;
          }
          if (/^#{1,4}\s+/.test(trimmed)) {
            flushList(`${blockIdx}-${lineIdx}`);
            const headingText = trimmed.replace(/^#{1,4}\s+/, "");
            elements.push(
              <h4 key={`${blockIdx}-${lineIdx}`} className="hermes-md-heading">
                {renderInlineMarkdown(headingText)}
              </h4>,
            );
            return;
          }
          if (/^[-*•]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
            listItems.push(trimmed.replace(/^(?:[-*•]|\d+\.)\s+/, ""));
            return;
          }
          flushList(`${blockIdx}-${lineIdx}`);
          elements.push(
            <p key={`${blockIdx}-${lineIdx}`} className="hermes-md-p">
              {renderInlineMarkdown(trimmed)}
            </p>,
          );
        });
        flushList(`${blockIdx}-end`);
        return <div key={blockIdx}>{elements}</div>;
      })}
    </div>
  );
}

function ToolTraceCard({ trace, zh }: { trace: ToolCallTrace; zh: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`hermes-trace-item is-smartenance ${trace.ok ? "is-ok" : "is-error"}`}>
      <button
        type="button"
        className="hermes-trace-header"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className="hermes-trace-chevron">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
        <Wrench size={12} className="hermes-trace-icon" />
        <span className="hermes-trace-name">{trace.tool}</span>
        <span
          className={`hermes-trace-state ${trace.ok ? "is-ok" : "is-error"}`}
          aria-label={trace.ok ? (zh ? "成功" : "OK") : zh ? "异常" : "Error"}
        >
          {trace.ok ? <Check size={12} /> : <AlertCircle size={12} />}
        </span>
        <span className="hermes-trace-time">{trace.durationMs}ms</span>
      </button>
      {expanded && (
        <div className="hermes-trace-body">
          {Object.keys(trace.arguments || {}).length > 0 && (
            <div className="hermes-trace-section">
              <div className="hermes-trace-label">Args</div>
              <pre>{JSON.stringify(trace.arguments, null, 2)}</pre>
            </div>
          )}
          <div className="hermes-trace-section">
            <div className="hermes-trace-label">{trace.ok ? "Result" : "Error"}</div>
            <pre>{trace.ok ? JSON.stringify(trace.result, null, 2) : trace.error}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

export default function HermesAgentModule({
  language,
  activeView,
  onViewChange,
}: HermesAgentModuleProps) {
  const zh = language === "zh";

  const [config, setConfig] = useState<HermesConfigClient | null>(null);
  const [tools, setTools] = useState<HermesToolDefinition[]>([]);
  const [connectionState, setConnectionState] = useState<"idle" | "connected" | "failed">("idle");

  // Settings form state
  const [apiFormat, setApiFormat] = useState<"openai" | "anthropic">("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [model, setModel] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [testingSettings, setTestingSettings] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<{
    type: "ok" | "error";
    text: string;
  } | null>(null);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const loadInitialState = useCallback(async () => {
    try {
      const [cfgRes, toolsRes] = await Promise.all([
        fetch("/api/hermes/config", { cache: "no-store" }),
        fetch("/api/hermes/tools", { cache: "no-store" }),
      ]);
      if (cfgRes.ok) {
        const data = (await cfgRes.json()) as {
          config: HermesConfigClient;
        };
        setConfig(data.config);
        setConnectionState(data.config.configured ? "connected" : "idle");
        setApiFormat(data.config.apiFormat);
        setBaseUrl(data.config.baseUrl ?? "");
        setModel(data.config.model ?? "");
      }
      if (toolsRes.ok) {
        const data = (await toolsRes.json()) as { tools: HermesToolDefinition[] };
        setTools(data.tools ?? []);
      }
    } catch {
      // Ignore initial load errors; user can retry in settings.
    }
  }, []);

  useEffect(() => {
    void loadInitialState();
  }, [loadInitialState]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  async function handleSaveSettings(event: React.FormEvent) {
    event.preventDefault();
    setSavingSettings(true);
    setSettingsNotice(null);
    try {
      const res = await fetch("/api/hermes/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "custom",
          apiFormat,
          baseUrl,
          ...(apiKeyDraft.trim() ? { apiKey: apiKeyDraft.trim() } : {}),
          model,
        }),
      });
      const data = (await res.json()) as {
        saved?: boolean;
        config?: HermesConfigClient;
        error?: string;
      };
      if (!res.ok || !data.config) {
        throw new Error(data.error || "Save failed");
      }
      setConfig(data.config);
      setConnectionState(data.config.configured ? "connected" : "idle");
      setApiKeyDraft("");
      setSettingsNotice({
        type: "ok",
        text: zh ? "已保存" : "Saved",
      });
    } catch (err) {
      setSettingsNotice({
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleClearApiKey() {
    setSavingSettings(true);
    setSettingsNotice(null);
    try {
      const res = await fetch("/api/hermes/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clearApiKey: true }),
      });
      const data = (await res.json()) as { config?: HermesConfigClient; error?: string };
      if (!res.ok || !data.config) throw new Error(data.error || "Failed");
      setConfig(data.config);
      setConnectionState(data.config.configured ? "connected" : "idle");
      setApiKeyDraft("");
      setSettingsNotice({
        type: "ok",
        text: zh ? "Key 已清除" : "Key cleared",
      });
    } catch (err) {
      setSettingsNotice({
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleTestConnection() {
    setTestingSettings(true);
    setSettingsNotice(null);
    try {
      const res = await fetch("/api/hermes/config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "custom",
          apiFormat,
          baseUrl,
          ...(apiKeyDraft.trim() ? { apiKey: apiKeyDraft.trim() } : {}),
          model,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        model?: string;
        latencyMs?: number;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setConnectionState("failed");
        throw new Error(data.error || "Connection failed");
      }
      setConnectionState("connected");
      setSettingsNotice({
        type: "ok",
        text: `${data.latencyMs}ms`,
      });
    } catch (err) {
      setConnectionState("failed");
      setSettingsNotice({
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTestingSettings(false);
    }
  }

  async function sendMessage() {
    const content = input.trim();
    if (!content || sending) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    setInput("");
    setSending(true);

    try {
      const res = await fetch("/api/hermes/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language,
          messages: nextHistory.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const data = (await res.json()) as {
        reply?: string;
        toolCalls?: ToolCallTrace[];
        error?: string;
      };
      if (!res.ok) {
        setConnectionState("failed");
        throw new Error(data.error || "Request failed");
      }
      setConnectionState("connected");
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: data.reply || "—",
          toolCalls: data.toolCalls ?? [],
          createdAt: new Date().toISOString(),
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: "assistant",
          content: err instanceof Error ? err.message : String(err),
          error: true,
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  const statusLabel = testingSettings
    ? zh
      ? "连接中…"
      : "Connecting…"
    : connectionState === "connected"
      ? zh
        ? "模型已连接"
        : "Connected"
      : connectionState === "failed"
        ? zh
          ? "连接异常"
          : "Connection Error"
        : zh
          ? "模型未连接"
          : "Not Connected";

  const statusClass = testingSettings
    ? ""
    : connectionState === "connected"
      ? "is-ready"
      : connectionState === "failed"
        ? "is-error"
        : "";

  return (
    <div className="unified-module-container hermes-scope">
      <div className="hermes-minimal-bar">
        <div className="hermes-minimal-brand">
          <span className="hermes-minimal-avatar">
            <Bot size={18} />
          </span>
          <span className={`hermes-model-chip ${statusClass}`}>
            <i />
            <span>{statusLabel}</span>
          </span>
          <span
            className="hermes-tool-count-chip"
            title={zh ? `已接入 ${tools.length || 12} 个工具` : `${tools.length || 12} tools`}
          >
            <Wrench size={13} />
            <span>{tools.length || 12}</span>
          </span>
        </div>

        <div className="hermes-minimal-actions">
          {activeView === "chat" && messages.length > 0 && (
            <button
              type="button"
              className="hermes-icon-btn"
              onClick={() => setMessages([])}
              disabled={sending}
              title={zh ? "清空对话" : "Clear chat"}
              aria-label={zh ? "清空对话" : "Clear chat"}
            >
              <Trash2 size={16} />
            </button>
          )}
          <button
            type="button"
            className={`hermes-icon-btn ${activeView === "settings" ? "is-active" : ""}`}
            onClick={() => onViewChange(activeView === "settings" ? "chat" : "settings")}
            title={
              activeView === "settings"
                ? zh
                  ? "返回对话"
                  : "Chat"
                : zh
                  ? "模型设置"
                  : "Settings"
            }
            aria-label={
              activeView === "settings"
                ? zh
                  ? "返回对话"
                  : "Chat"
                : zh
                  ? "模型设置"
                  : "Settings"
            }
          >
            {activeView === "settings" ? <ArrowLeft size={16} /> : <Settings2 size={16} />}
          </button>
        </div>
      </div>

      {/* VIEW 1: MINIMALIST CHAT */}
      {activeView === "chat" && (
        <div className="hermes-chat-layout">
          {config && !config.configured && (
            <button
              type="button"
              className="hermes-key-alert"
              onClick={() => onViewChange("settings")}
            >
              <KeyRound size={15} />
              <span>{zh ? "请先配置模型与 API Key" : "Configure Model & API Key"}</span>
              <Settings2 size={14} className="hermes-key-alert-end" />
            </button>
          )}

          <div className="hermes-chat-card">
            <div className="hermes-chat-messages">
              {messages.length === 0 ? (
                <div className="hermes-empty-state">
                  <FestoAsciiLogo />
                </div>
              ) : (
                messages.map((msg) => (
                  <div key={msg.id} className={`hermes-msg-row is-${msg.role}`}>
                    <div className={`hermes-msg-bubble ${msg.error ? "is-error" : ""}`}>
                      {msg.role === "assistant" && (
                        <div className="hermes-msg-role-head">
                          <span className="hermes-msg-role-tag">
                            <Bot size={13} />
                          </span>
                        </div>
                      )}
                      {msg.toolCalls && msg.toolCalls.length > 0 && (
                        <div className="hermes-trace-list">
                          {msg.toolCalls.map((trace, idx) => (
                            <ToolTraceCard key={`${msg.id}-t-${idx}`} trace={trace} zh={zh} />
                          ))}
                        </div>
                      )}
                      {msg.role === "assistant" ? (
                        <FormattedMessage content={msg.content} />
                      ) : (
                        <div className="hermes-user-text">{msg.content}</div>
                      )}
                    </div>
                  </div>
                ))
              )}

              {sending && (
                <div className="hermes-msg-row is-assistant">
                  <div className="hermes-msg-bubble is-thinking">
                    <LoaderCircle size={16} className="spin" />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <form
              className="hermes-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void sendMessage();
              }}
            >
              <textarea
                rows={1}
                value={input}
                aria-label={zh ? "输入消息" : "Message"}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendMessage();
                  }
                }}
                disabled={sending}
              />
              <button
                type="submit"
                className="hermes-send-btn"
                disabled={sending || !input.trim()}
                title={zh ? "发送" : "Send"}
                aria-label={zh ? "发送" : "Send"}
              >
                {sending ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={17} />}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* VIEW 2: POLISHED MINIMAL MODEL SETTINGS */}
      {activeView === "settings" && (
        <div className="hermes-settings-grid">
          <form className="hermes-panel hermes-config-card" onSubmit={handleSaveSettings}>
            <div className="hermes-panel-head">
              <div className="hermes-panel-title">
                <span className="hermes-panel-icon">
                  <Settings2 size={16} />
                </span>
                <h2>{zh ? "模型配置" : "Model"}</h2>
              </div>
              <div className="hermes-form-actions">
                <button
                  type="button"
                  className="hermes-btn-secondary"
                  disabled={testingSettings || savingSettings}
                  onClick={() => void handleTestConnection()}
                  title={zh ? "测试连接" : "Test"}
                >
                  {testingSettings ? <LoaderCircle size={14} className="spin" /> : <Zap size={14} />}
                  <span>{zh ? "测试" : "Test"}</span>
                </button>
                <button type="submit" className="hermes-btn-primary" disabled={savingSettings}>
                  {savingSettings ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <Check size={14} />
                  )}
                  <span>{zh ? "保存" : "Save"}</span>
                </button>
              </div>
            </div>

            <div className="hermes-config-fields">
              <label className="hermes-field">
                <span>
                  <Globe size={13} />
                  Base URL
                </span>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  required
                />
              </label>

              <div className="hermes-form-grid">
                <label className="hermes-field">
                  <span>
                    <Cpu size={13} />
                    Model
                  </span>
                  <input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    required
                  />
                </label>

                <div className="hermes-field">
                  <span className="hermes-field-label">
                    <Layers size={13} />
                    {zh ? "协议" : "Format"}
                  </span>
                  <div className="hermes-segmented" role="group" aria-label={zh ? "协议" : "Format"}>
                    <button
                      type="button"
                      className={apiFormat === "openai" ? "is-active" : ""}
                      onClick={() => setApiFormat("openai")}
                    >
                      OpenAI
                    </button>
                    <button
                      type="button"
                      className={apiFormat === "anthropic" ? "is-active" : ""}
                      onClick={() => setApiFormat("anthropic")}
                    >
                      Anthropic
                    </button>
                  </div>
                </div>
              </div>

              <label className="hermes-field">
                <span>
                  <KeyRound size={13} />
                  API Key
                  {config?.hasApiKey && (
                    <em className="hermes-saved-key-tag">{config.apiKeyMasked}</em>
                  )}
                </span>
                <div className="hermes-key-row">
                  <input
                    type="password"
                    value={apiKeyDraft}
                    onChange={(e) => setApiKeyDraft(e.target.value)}
                    autoComplete="off"
                  />
                  {config?.hasApiKey && (
                    <button
                      type="button"
                      className="hermes-icon-btn"
                      onClick={() => void handleClearApiKey()}
                      disabled={savingSettings}
                      title={zh ? "清除 Key" : "Clear Key"}
                      aria-label={zh ? "清除 Key" : "Clear Key"}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              </label>
            </div>

            {settingsNotice && (
              <div className={`hermes-settings-notice is-${settingsNotice.type}`}>
                {settingsNotice.type === "ok" ? (
                  <CheckCircle2 size={15} />
                ) : (
                  <ShieldAlert size={15} />
                )}
                <span>{settingsNotice.text}</span>
              </div>
            )}
          </form>

          {/* Compact Tools Inventory */}
          <aside className="hermes-panel hermes-tools-card">
            <div className="hermes-panel-head">
              <div className="hermes-panel-title">
                <span className="hermes-panel-icon">
                  <Wrench size={15} />
                </span>
                <h2>Tools</h2>
              </div>
              <span className="hermes-tools-badge">{tools.length}</span>
            </div>

            <div className="hermes-tools-list">
              {tools.map((tool) => (
                <details key={tool.name} className="hermes-tool-row">
                  <summary className="hermes-tool-summary">
                    <code>{tool.name}</code>
                  </summary>
                  <p>{tool.description}</p>
                </details>
              ))}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
