"use client";
import Image from "next/image";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Cable,
  CalendarDays,
  Factory,
  Database,
  RefreshCw,
  ListFilter,
  LoaderCircle,
  Search,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import {
  Combobox,
  ComboboxChips,
  ComboboxChip,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Pagination, PaginationContent, PaginationItem } from "@/components/ui/pagination";
import { chinaDate, customFieldColumns, filterExistingResult, formatTime, INCIDENT_STATE_OPTIONS, incidentStateLabels, resultLabels, toCsv, validateFilters } from "@/lib/festo/shared";
import type { AutoSyncStatus, ExportEvent, Filters, IncidentStateFilter, Machine, RepairResult, SyncResult } from "@/lib/festo/types";

import { translate, type Language } from "@/lib/festo/i18n";

import { readOperationResult } from "@/lib/festo/stream-client";

type Result = RepairResult;
const firstPolicy = "b2c_1_apisignin_ropc";
export default function Home() {
  const [language, setLanguage] = useState<Language>("en");
  const t = (text: string) => translate(text, language);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("festo-language");
      if (saved === "en" || saved === "zh") setLanguage(saved);
    } catch {}
  }, []);
  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    document.title = translate("Repair task export", language) + " · Smartenance";
  }, [language]);
  function changeLanguage(value: Language) {
    setLanguage(value);
    setPage(1);
    try {
      localStorage.setItem("festo-language", value);
    } catch {}
  }
  const today = chinaDate();
  const [mode, setMode] = useState("token");
  const [tokenDraft, setTokenDraft] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [policy, setPolicy] = useState(firstPolicy);
  const [token, setToken] = useState("");
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [from, setFrom] = useState(today.slice(0, 8) + "01");
  const [to, setTo] = useState(today);
  const [incidentState, setIncidentState] = useState<IncidentStateFilter>("All");
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncResult | null>(null);
  const [autoSync, setAutoSync] = useState<AutoSyncStatus | null>(null);
  async function loadAutoSyncStatus() {
    try {
      const res = await fetch("/api/sync/status", { cache: "no-store" });
      if (res.ok) setAutoSync((await res.json()) as AutoSyncStatus);
    } catch {}
  }
  useEffect(() => {
    void loadAutoSyncStatus();
  }, []);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const sourceResult = useRef<Result | null>(null);
  const snapshotRows = sourceResult.current?.rows;
  const customColumns = useMemo(() => customFieldColumns(snapshotRows ?? [], "zh"), [snapshotRows]);
  const [page, setPage] = useState(1);
  const abortRef = useRef<AbortController | null>(null);
  const lock = useRef(false);
  const anchor = useComboboxAnchor();
  const latest = useRef({ machines, selected, from, to, incidentState, result, busy, token });
  useLayoutEffect(() => {
    latest.current = { machines, selected, from, to, incidentState, result, busy, token };
  }, [machines, selected, from, to, incidentState, result, busy, token]);
  useEffect(() => () => abortRef.current?.abort(), []);
  function clearResult() {
    sourceResult.current = null;
    setResult(null);
    setPage(1);
    setNotice("");
    setError("");
  }
  function changeFilters(patch: Partial<Filters>) {
    const current = latest.current;
    const filters = {
      machineIds: current.selected, from: current.from, to: current.to, incidentState: current.incidentState,
      ...patch,
    };
    setSelected(filters.machineIds);
    setFrom(filters.from);
    setTo(filters.to);
    setIncidentState(filters.incidentState);
    const filtered = filterExistingResult(sourceResult.current, filters);
    // Keep the original snapshot when temporarily selecting an uncovered range.
    // A fresh query or disconnect still discards it entirely.
    setResult(filtered);
    setPage(1);
    setError("");
    setNotice(filtered ? "Filtered from the last completed query. Click Find repair tasks to refresh." : "");
  }
  async function connect(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setConnecting(true);
    clearResult();
    setToken("");
    setMachines([]);
    setSelected([]);
    setLastSync(null);
    try {
      const response = await fetch("/api/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "token" ? { mode, token: tokenDraft } : { mode, username, password, policy },
        ),
        cache: "no-store",
      });
      const data = (await response.json()) as {
        error?: string;
        token: string;
        machines: Machine[];
      };
      if (!response.ok) throw new Error(data.error || "Connection failed. Please try again.");
      setToken(data.token);
      setMachines(data.machines);
      setTokenDraft("");
      if (data.machines.length === 1) setSelected([data.machines[0].id]);
      setNotice(
        data.machines.length
          ? `Connected. Loaded ${data.machines.length} machines.`
          : "Connected, but this account has no accessible machines.",
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Unable to connect. Check that the local application is running and the network is available.",
      );
    } finally {
      setPassword("");
      setConnecting(false);
      lock.current = false;
    }
  }
  function disconnect() {
    abortRef.current?.abort();
    setToken("");
    setTokenDraft("");
    setPassword("");
    setMachines([]);
    setSelected([]);
    setLastSync(null);
    clearResult();
  }
  async function query(input?: Filters) {
    if (lock.current) throw new Error("Another operation is in progress. Please wait.");
    const current = latest.current;
    if (!current.token) throw new Error("Connect to Smartenance first.");
    const filters = validateFilters(
      input ?? {
        machineIds: current.selected,
        from: current.from,
        to: current.to,
        incidentState: current.incidentState,
      },
    );
    if (filters.machineIds.some((id) => !current.machines.some((m) => m.id === id)))
      throw new Error("A selected machine is unavailable.");
    setSelected(filters.machineIds);
    setFrom(filters.from);
    setTo(filters.to);
    setIncidentState(filters.incidentState);
    clearResult();
    setBusy(true);
    lock.current = true;
    setProgress("Reading incidents for the selected machines…");
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const response = await fetch("/api/repairs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${current.token}`,
        },
        body: JSON.stringify(filters),
        signal: abort.signal,
        cache: "no-store",
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        if (response.status === 401) setToken("");
        throw new Error(data.error || "Query failed.");
      }
      if (!response.body) throw new Error("The server did not return any query results.");
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      let complete: Extract<ExportEvent, { type: "complete" }> | null = null;
      const consume = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line) as ExportEvent;
        if (event.type === "error") {
          if (event.status === 401) setToken("");
          throw new Error(event.message);
        }
        if (event.type === "progress") setProgress(event.message);
        if (event.type === "complete") complete = event;
      };
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            consume(buffer.slice(0, nl));
            buffer = buffer.slice(nl + 1);
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) consume(buffer);
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      abort.signal.throwIfAborted();
      const finalResult = complete as Extract<ExportEvent, { type: "complete" }> | null;
      if (!finalResult)
        throw new Error(
          "The query did not finish. Please try again. Partial results cannot be exported.",
        );
      const completed = { ...finalResult, filters, fetchedAt: new Date().toISOString() };
      sourceResult.current = completed;
      setResult(completed);
      setPage(1);
      return { count: finalResult.rows.length, scanned: finalResult.scanned };
    } catch (e) {
      const message = abort.signal.aborted
        ? "Query cancelled. Partial results were discarded."
        : e instanceof Error
          ? e.message
          : "The query was interrupted. Please try again.";
      setError(message);
      throw new Error(message);
    } finally {
      setBusy(false);
      lock.current = false;
      abortRef.current = null;
      setProgress("");
    }
  }
  async function syncAll() {
    if (lock.current) return;
    const current = latest.current;
    if (!current.token) return;
    lock.current = true;
    setBusy(true);
    setSyncing(true);
    setLastSync(null);
    clearResult();
    setProgress("Loading machines…");
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const response = await fetch("/api/sync", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${current.token}` },
        body: "{}", cache: "no-store", signal: abort.signal,
      });
      const completed = await readOperationResult<SyncResult>(response, setProgress, () => setToken(""));
      abort.signal.throwIfAborted();
      setLastSync(completed);
      setMachines(completed.machines);
      setSelected((ids) => ids.filter((id) => completed.machines.some((m) => m.id === id)));
      const d = completed.diff;
      setNotice(
        d
          ? `Sync complete: ${completed.syncedMachines} machines · ${completed.incidents} incidents (+${d.inserted} new · ~${d.updated} updated · =${d.unchanged} unchanged · -${d.deleted} removed).`
          : `Sync complete: ${completed.syncedMachines} machines · ${completed.incidents} incidents.`,
      );
      void loadAutoSyncStatus();
    } catch (error) {
      setError(abort.signal.aborted ? "Sync cancelled. Completed machines were saved; unfinished machines keep their previous data."
        : `${error instanceof Error ? error.message : "Query failed."}`);
      if (!abort.signal.aborted) setNotice("Sync did not finish. Completed machines were saved; unfinished machines keep their previous data.");
    } finally {
      setBusy(false);
      setSyncing(false);
      lock.current = false;
      abortRef.current = null;
      setProgress("");
    }
  }
  function download() {
    const current = latest.current;
    if (!current.result?.rows.length || current.busy)
      throw new Error("Complete a query with matching results before exporting.");
    const csv = toCsv(current.result.rows, "zh", customColumns),
      blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    const filename = `repair_tasks_${current.result.filters.from}_${current.result.filters.to}.csv`;
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setNotice(
      `Created a CSV with ${current.result.rows.length} repair tasks. Check your browser downloads.`,
    );
    return { filename, count: current.result.rows.length };
  }
  const actions = useRef({ query, download });
  useLayoutEffect(() => {
    actions.current = { query, download };
  });
  useEffect(() => {
    type Tool = {
      name: string;
      description: string;
      inputSchema: object;
      annotations: object;
      execute: (value: unknown) => unknown;
    };
    const context = (
      document as Document & {
        modelContext?: {
          registerTool: (tool: Tool, options: { signal: AbortSignal }) => unknown;
        };
      }
    ).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const tools: Tool[] = [
      {
        name: "query_repair_tasks",
        description:
          "Query repair tasks by machine, incident status and repair task creation date in UTC+8 using the connected Smartenance account. Incident status can be All (default), Open, InWork or Closed. All repair results are included. The user must connect an account first.",
        inputSchema: {
          type: "object",
          properties: {
            machineIds: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
            },
            from: { type: "string", format: "date" },
            to: { type: "string", format: "date" },
            incidentState: {
              type: "string",
              enum: [...INCIDENT_STATE_OPTIONS],
              default: "All",
            },
          },
          required: ["machineIds", "from", "to"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: (input) => actions.current.query(validateFilters(input)),
      },
      {
        name: "get_repair_export_state",
        description:
          "Read available machines, current filters and result count. Credentials are never returned.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: () => {
          const s = latest.current;
          return {
            connected: !!s.token,
            machines: s.machines,
            filters: { machineIds: s.selected, from: s.from, to: s.to, incidentState: s.incidentState },
            fetchedAt: s.result?.fetchedAt ?? null,
            busy: s.busy,
            count: s.result?.rows.length ?? null,
          };
        },
      },
      {
        name: "download_repair_csv",
        description:
          "Download the complete repair task query results shown on this page as a CSV file.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: () => actions.current.download(),
      },
    ];
    for (const tool of tools) {
      try {
        void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(
          () => {},
        );
      } catch {}
    }
    return () => lifecycle.abort();
  }, []);
  const pages = result ? Math.max(1, Math.ceil(result.rows.length / 20)) : 1;
  const machineLabel = (id: string) => {
    const m = machines.find((item) => item.id === id);
    return m ? `${m.name || t("Unnamed machine")}${m.number ? ` · ${m.number}` : ""}` : id;
  };
  return (
    <main className="workspace">
      <header className="topbar">
        <div className="brand">
          <Image
            unoptimized
            src="/brand-icon.png"
            alt={t("Company logo")}
            width={40}
            height={40}
            className="brand-icon"
          />
          <span>
            SMARTENANCE<span className="brand-sub">{t("Repair data export")}</span>
          </span>
        </div>
        <div className="header-settings">
          <label className="language-setting">
            <select
              aria-label="Language / 语言"
              value={language}
              onChange={(event) => changeLanguage(event.target.value as Language)}
            >
              <option value="en">English</option>
              <option value="zh">中文</option>
            </select>
          </label>
          <Image
            unoptimized
            src="/festo-logo.png"
            alt="FESTO"
            width={264}
            height={70}
            className="festo-logo"
          />
        </div>
      </header>
      <div className="content">
        <div className="page-heading">
          <div>
            <p className="eyebrow">{t("REPAIR TASKS / CSV")}</p>
            <h1>{t("Repair task export")}</h1>
          </div>
          <span className={`connection-status ${token ? "connected" : ""}`}>
            {token ? t("Connected to Smartenance") : t("Not connected")}
          </span>
        </div>
        <section className="connection-panel" aria-labelledby="connection-title">
          <div className="section-label">
            <Cable size={19} />
            <h2 id="connection-title">{t("Connect to Smartenance")}</h2>
            {token && (
              <Button className="disconnect" variant="ghost" disabled={busy} onClick={disconnect}>
                {t("Disconnect")}
              </Button>
            )}
          </div>
          {!token ? (
            <>
              <Tabs value={mode} onValueChange={(v) => setMode(String(v))} className="auth-tabs">
                <TabsList>
                  <TabsTrigger value="token" disabled={connecting}>
                    {t("Access token")}
                  </TabsTrigger>
                  <TabsTrigger value="account" disabled={connecting}>
                    {t("API account")}
                  </TabsTrigger>
                </TabsList>
                <form onSubmit={connect}>
                  <TabsContent value="token">
                    <div className="connection-fields">
                      <label htmlFor="access-token">
                        {t("Access token")}
                        <Input
                          id="access-token"
                          type="password"
                          value={tokenDraft}
                          onChange={(e) => setTokenDraft(e.target.value)}
                          placeholder={t("Paste your access token (Bearer prefix optional)")}
                          required={mode === "token"}
                          autoComplete="off"
                          disabled={connecting}
                        />
                      </label>
                      <Button type="submit" disabled={connecting || !tokenDraft.trim()}>
                        {connecting && <LoaderCircle className="spin" />}
                        {t("Connect & load machines")}
                      </Button>
                    </div>
                  </TabsContent>
                  <TabsContent value="account">
                    <div className="connection-fields">
                      <label htmlFor="api-username">
                        {t("API username")}
                        <Input
                          id="api-username"
                          value={username}
                          onChange={(e) => setUsername(e.target.value)}
                          placeholder={t("Smartenance Premium API username")}
                          required={mode === "account"}
                          autoComplete="username"
                          disabled={connecting}
                        />
                      </label>
                      <label htmlFor="api-password">
                        {t("Password")}
                        <Input
                          id="api-password"
                          type="password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          required={mode === "account"}
                          autoComplete="off"
                          disabled={connecting}
                        />
                      </label>
                      <Button type="submit" disabled={connecting || !username.trim() || !password}>
                        {connecting && <LoaderCircle className="spin" />}
                        {t("Sign in & load machines")}
                      </Button>
                    </div>
                    <details className="auth-help">
                      <summary>{t("Trouble signing in?")}</summary>
                      <p>
                        {t(
                          "Use an account with API access. The official guide and example list different authentication policies. If the default does not work, select the alternative manually or use an access token.",
                        )}
                      </p>
                      <Select
                        value={policy}
                        onValueChange={(v) => v && setPolicy(v)}
                        disabled={connecting}
                      >
                        <SelectTrigger aria-label={t("Authentication policy")}>
                          <SelectValue>{policy}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={firstPolicy}>b2c_1_apisignin_ropc</SelectItem>
                          <SelectItem value="b2c_1_ropc_apisignin">b2c_1_ropc_apisignin</SelectItem>
                        </SelectContent>
                      </Select>
                    </details>
                  </TabsContent>
                </form>
              </Tabs>
              <a
                className="doc-link"
                href="https://developers.festo.com/smartenance-authentication"
                target="_blank"
                rel="noreferrer"
              >
                {t("Festo authentication guide ↗")}
              </a>
            </>
          ) : (
            <p className="muted">
              {t(`Loaded ${machines.length} machines. Reconnect when your access token expires.`)}
            </p>
          )}
        </section>
        <section className="database-panel" aria-labelledby="database-title">
          <div className="section-label">
            <Database size={19} />
            <h2 id="database-title">{t("PostgreSQL database")}</h2>
            <Button className="sync-button" variant="outline" disabled={!token || busy || connecting} onClick={() => void syncAll()}>
              {syncing ? <LoaderCircle className="spin" /> : <RefreshCw />}
              {t(syncing ? "Syncing…" : "Sync all machines")}
            </Button>
          </div>
          {autoSync?.autoSyncEnabled && (
            <p className="muted">
              {t(`Auto-sync enabled: day ${autoSync.schedule.daysOfMonth.join(", ")} of each month at ${autoSync.schedule.timeUtc8} (UTC+8)`)}
              {autoSync.schedule.nextRunAt && (
                <> · {t("Next scheduled sync (UTC+8)")}: {formatTime(autoSync.schedule.nextRunAt)}</>
              )}
            </p>
          )}
          {autoSync?.lastScheduledRun && (
            <p className="muted">
              {t("Last scheduled sync (UTC+8)")}:{" "}
              {formatTime(autoSync.lastScheduledRun.finishedAt ?? autoSync.lastScheduledRun.startedAt)} ·{" "}
              <span
                className={`result-tag ${
                  autoSync.lastScheduledRun.status === "succeeded"
                    ? "success"
                    : autoSync.lastScheduledRun.status === "failed"
                      ? "failure"
                      : "unknown"
                }`}
              >
                {t(
                  autoSync.lastScheduledRun.status === "succeeded"
                    ? "Scheduled sync succeeded"
                    : autoSync.lastScheduledRun.status === "failed"
                      ? "Scheduled sync failed"
                      : "Scheduled sync running",
                )}
              </span>
              {autoSync.lastScheduledRun.status === "succeeded" && (
                <>
                  {" · "}
                  {t(
                    `+${autoSync.lastScheduledRun.diff.inserted} new · ~${autoSync.lastScheduledRun.diff.updated} updated · =${autoSync.lastScheduledRun.diff.unchanged} unchanged · -${autoSync.lastScheduledRun.diff.deleted} removed`,
                  )}
                </>
              )}
              {autoSync.lastScheduledRun.status === "failed" && autoSync.lastScheduledRun.errorMessage && (
                <> · {t(autoSync.lastScheduledRun.errorMessage)}</>
              )}
            </p>
          )}
          {lastSync && (
            <p className="muted">
              {t("Last full sync (UTC+8)")}: {formatTime(lastSync.syncedAt)}
              {lastSync.diff && (
                <>
                  {" · "}
                  {t(
                    `+${lastSync.diff.inserted} new · ~${lastSync.diff.updated} updated · =${lastSync.diff.unchanged} unchanged · -${lastSync.diff.deleted} removed`,
                  )}
                </>
              )}
            </p>
          )}
        </section>
        <section className="filter-panel" aria-labelledby="filters-title">
          <div className="section-label">
            <ListFilter size={19} />
            <h2 id="filters-title">{t("Filters")}</h2>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void query().catch((e) => setError(e.message));
            }}
          >
            <div className="filter-grid">
              <div className="machine-field">
                <label htmlFor="machines">
                  <span>
                    <Factory size={16} />
                    {t("Machines · select one or more")}
                  </span>
                </label>
                <Combobox
                  multiple
                  items={machines.map((m) => m.id)}
                  value={selected}
                  onValueChange={(v) => {
                    changeFilters({ machineIds: v });
                  }}
                  itemToStringLabel={machineLabel}
                  disabled={!token || busy}
                >
                  <ComboboxChips ref={anchor} className="machine-chips">
                    <ComboboxValue>
                      {(values: string[]) => (
                        <>
                          {values.map((id) => (
                            <ComboboxChip key={id} aria-label={machineLabel(id)}>
                              {machineLabel(id)}
                            </ComboboxChip>
                          ))}
                          <ComboboxChipsInput
                            id="machines"
                            aria-label={t("Select machines")}
                            placeholder={
                              values.length
                                ? t("Add another…")
                                : t("Search by machine name or number")
                            }
                          />
                        </>
                      )}
                    </ComboboxValue>
                  </ComboboxChips>
                  <ComboboxContent anchor={anchor}>
                    <ComboboxEmpty>{t("No machines found")}</ComboboxEmpty>
                    <ComboboxList>
                      {(id: string) => (
                        <ComboboxItem key={id} value={id}>
                          {machineLabel(id)}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
                <div className="machine-actions">
                  <button
                    type="button"
                    disabled={!token || busy}
                    onClick={() => {
                      changeFilters({ machineIds: machines.map((m) => m.id) });
                    }}
                  >
                    {t("Select all")}
                  </button>
                  <button
                    type="button"
                    disabled={!selected.length || busy}
                    onClick={() => {
                      changeFilters({ machineIds: [] });
                    }}
                  >
                    {t("Clear")}
                  </button>
                  <span>{t(`${selected.length} selected`)}</span>
                </div>
              </div>
              <label htmlFor="incident-state">
                <span>{t("Incident status")}</span>
                <Select<IncidentStateFilter>
                  value={incidentState}
                  onValueChange={(value) => {
                    if (value) {
                      changeFilters({ incidentState: value });
                    }
                  }}
                  disabled={busy}
                >
                  <SelectTrigger id="incident-state" aria-label={t("Incident status")}>
                    <SelectValue>{t(incidentStateLabels[incidentState])}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {INCIDENT_STATE_OPTIONS.map((state) => (
                      <SelectItem key={state} value={state}>
                        {t(incidentStateLabels[state])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label htmlFor="date-from">
                <span>
                  <CalendarDays size={16} />
                  {t("Created from")}
                </span>
                <Input
                  id="date-from"
                  type="date"
                  value={from}
                  onChange={(e) => {
                    changeFilters({ from: e.target.value });
                  }}
                  required
                  disabled={busy}
                />
              </label>
              <label htmlFor="date-to">
                <span>{t("Created through")}</span>
                <Input
                  id="date-to"
                  type="date"
                  value={to}
                  min={from}
                  onChange={(e) => {
                    changeFilters({ to: e.target.value });
                  }}
                  required
                  disabled={busy}
                />
              </label>
              <Button type="submit" disabled={!token || !selected.length || busy || connecting}>
                {busy ? <LoaderCircle className="spin" /> : <Search />}
                {busy ? t(syncing ? "Syncing…" : "Searching…") : t("Find repair tasks")}
              </Button>
            </div>
          </form>
          {busy && (
            <output className="query-progress">
              <LoaderCircle size={17} className="spin" />
              <span>{t(progress)}</span>
              <Button variant="ghost" onClick={() => abortRef.current?.abort()}>
                <X />
                {t("Cancel")}
              </Button>
            </output>
          )}
          {error && (
            <div role="alert" className="notice error">
              {t(error)}
            </div>
          )}
          {notice && (
            <output className="notice info" style={{ display: "block" }}>
              {t(notice)}
            </output>
          )}
        </section>
        <section className="result-panel" aria-labelledby="results-title" aria-busy={busy}>
          <div className="result-header">
            <div>
              <h2 id="results-title">
                {t("Results")}
                {result && <span className="count">{result.rows.length}</span>}
              </h2>
              {result && (
                <p className="muted">
                  {t(
                    `${result.filters.from} — ${result.filters.to} · ${result.scanned} incidents checked`,
                  )}
                  {result.fetchedAt && <> · {t("Data read at (UTC+8)")}: {formatTime(result.fetchedAt)}</>}
                  {result.retrieval?.databaseMachines !== undefined && <><br />{t(`Database: ${result.retrieval.databaseMachines} machines`)}</>}
                  {result.retrieval?.oldestSnapshotAt && <> · {t("Oldest snapshot (UTC+8)")}: {formatTime(result.retrieval.oldestSnapshotAt)}</>}
                  {result.retrieval && <><br />{t(`Bulk export: ${result.retrieval.bulkMachines} machines · Standard query: ${result.retrieval.standardMachines} machines`)}</>}
                </p>
              )}
            </div>
            <Button
              disabled={!result?.rows.length || busy}
              variant={result?.rows.length ? "default" : "outline"}
              onClick={() => {
                try {
                  download();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <ArrowDownToLine />
              {t("Export all to CSV")}
              {result?.rows.length ? ` (${result.rows.length})` : ""}
            </Button>
          </div>
          {result?.rows.length ? (
            <>
              <Table className="repair-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Machine / incident")}</TableHead>
                    <TableHead>{t("Repair task")}</TableHead>
                    <TableHead>{t("Result")}</TableHead>
                    <TableHead>{t("Created at (UTC+8)")}</TableHead>
                    <TableHead>{t("Created by")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.slice((page - 1) * 20, page * 20).map((row) => (
                    <TableRow key={row.taskId}>
                      <TableCell>
                        <strong>{row.machineName || t("Unnamed machine")}</strong>
                        <small>
                          {row.machineNumber || t("No machine number")} ·{" "}
                          {language === "zh" ? "故障 #" : "Incident #"}
                          {row.incidentNumber}
                        </small>
                      </TableCell>
                      <TableCell className="task-description">
                        <strong>{row.description || t("No task description")}</strong>
                        <small>{row.incidentSummary || t("No incident summary")}</small>
                      </TableCell>
                      <TableCell>
                        <span
                          className={`result-tag ${row.result === "Success" ? "success" : row.result === "Failure" ? "failure" : "unknown"}`}
                        >
                          {t(resultLabels[row.result] ?? row.result)}
                        </span>
                      </TableCell>
                      <TableCell className="time-cell">{formatTime(row.createdAt)}</TableCell>
                      <TableCell>{row.createdBy || "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="table-bottom">
                <span>{t(`20 rows per page · CSV includes all ${result.rows.length} rows`)}</span>
                <Pagination aria-label={t("Result pages")}>
                  <PaginationContent>
                    <PaginationItem>
                      <Button
                        variant="ghost"
                        disabled={page === 1}
                        onClick={() => setPage((p) => p - 1)}
                      >
                        {t("Previous")}
                      </Button>
                    </PaginationItem>
                    <PaginationItem>
                      <span aria-live="polite">
                        {page} / {pages}
                      </span>
                    </PaginationItem>
                    <PaginationItem>
                      <Button
                        variant="ghost"
                        disabled={page === pages}
                        onClick={() => setPage((p) => p + 1)}
                      >
                        {t("Next")}
                      </Button>
                    </PaginationItem>
                  </PaginationContent>
                </Pagination>
              </div>
            </>
          ) : (
            <Empty className="result-empty">
              <EmptyHeader>
                <div className="empty-icon">
                  {busy ? <LoaderCircle size={26} className="spin" /> : <Wrench size={26} />}
                </div>
                <EmptyTitle>
                  {busy
                    ? t(syncing ? "Syncing database" : "Collecting repair records")
                    : result
                      ? t("No repair tasks match these filters")
                      : t("Your repair records, ready to export")}
                </EmptyTitle>
                {(busy || result) && (
                  <EmptyDescription>
                    {busy
                      ? t(syncing ? "Completed machines are saved as sync progresses." : "Export becomes available once all records have been read.")
                      : t("Try other machines, dates, or incident statuses.")}
                  </EmptyDescription>
                )}
              </EmptyHeader>
            </Empty>
          )}
        </section>
        <footer>
          <span>{t("Festo AX Smartenance · Read and export repair records")}</span>
          <a
            href="https://developers.festo.com/docs/digismartenance-premiumpublicprod/1/overview"
            target="_blank"
            rel="noreferrer"
          >
            {t("API documentation ↗")}
          </a>
        </footer>
      </div>
    </main>
  );
}
