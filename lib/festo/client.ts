import { setTimeout as delay } from "node:timers/promises";
import type { Machine, Incident, RepairRow, Filters, Progress, MachineIncidents, RepairResult } from "./types.ts";
import { dateBounds, isIncidentState, UUID } from "./shared.ts";
import { plainText } from "./plain-text.ts";
import { allCustomFields, repairCustomFields } from "./custom-fields.ts";
import {
  BulkExportUnsupported, bulkDownloadUrl, bulkRecords, fieldDefinitions,
  needsFieldDefinitions, normalizeBulkIncidents, parseBulkDocument,
} from "./bulk-export.ts";
export const API_BASE = "https://api.festo.com/apps/smartenance/v1";
export const AUTH_POLICIES = ["b2c_1_apisignin_ropc", "b2c_1_ropc_apisignin"] as const;
// /incidents supports at most 1,000 records per page.
const INCIDENT_PAGE_SIZE = 1000;
// Shared by all clients in this local server, including concurrent browser tabs.
let nextRequestAt = 0;
let cooldownUntil = 0;
const BASE_REQUEST_INTERVAL_MS = 500;
let requestIntervalMs = BASE_REQUEST_INTERVAL_MS;
let lastRateLimitAt = 0;

export function retryAfterMs(headers: Headers, now = Date.now(), fallbackMs = 60000) {
  const waits = [headers.get("Retry-After"), headers.get("X-Retry-After")]
    .filter((value): value is string => value !== null)
    .map((value) => /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value) * 1000
      : Date.parse(value) - now)
    .filter((value) => Number.isFinite(value) && value >= 0);
  return waits.length ? Math.max(...waits) : fallbackMs;
}

async function waitForRequest(signal?: AbortSignal) {
  while (true) {
    signal?.throwIfAborted();
    const wait = Math.max(nextRequestAt, cooldownUntil) - Date.now();
    if (wait <= 0) {
      // Recover the normal pace after five minutes without another rate limit.
      if (Date.now() - lastRateLimitAt >= 300000) requestIntervalMs = BASE_REQUEST_INTERVAL_MS;
      nextRequestAt = Date.now() + requestIntervalMs;
      return;
    }
    await delay(Math.min(wait, 60000), undefined, { signal });
  }
}

export class FestoError extends Error {
  retryMs?: number;
  upstreamStatus?: number;
  retryable = false;
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "FestoError";
    this.status = status;
  }
}
export function errorMessage(error: unknown) {
  return error instanceof FestoError
    ? error.message
    : error instanceof Error && error.name === "AbortError"
      ? "Query cancelled."
      : "The connection was interrupted or the response was invalid. Please try again.";
}
export function validateToken(value: unknown) {
  if (typeof value !== "string") throw new FestoError("Enter an API access token.", 400);
  const token = value.trim().replace(/^Bearer\s+/i, "");
  if (!token || token.length > 16000 || /[\s\r\n]/.test(token))
    throw new FestoError("The access token format is invalid.", 400);
  return token;
}
export class FestoClient {
  private token: string;
  private fetcher: typeof fetch;
  private signal: AbortSignal;
  private abort = new AbortController();
  onRateLimit?: (seconds: number) => void;
  private definitions?: Promise<Map<string, Record<string, unknown>>>;
  constructor(token: string, options: { fetcher?: typeof fetch; signal?: AbortSignal } = {}) {
    this.token = validateToken(token);
    this.fetcher = options.fetcher ?? fetch;
    this.signal = options.signal
      ? AbortSignal.any([options.signal, this.abort.signal]) : this.abort.signal;
  }
  cancel() { this.abort.abort(); }
  throwIfAborted() { this.signal.throwIfAborted(); }
  async get(path: string, params: Record<string, string | number> = {}): Promise<unknown> {
    const url = new URL(API_BASE + path);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return this.readWithRetry(url);
  }
  private async readWithRetry(url: URL, bulk = false, authenticated = true): Promise<unknown> {
    let rateLimitRetries = 0;
    let transientRetries = 0;
    while (true) {
      this.signal?.throwIfAborted();
      if (cooldownUntil > Date.now()) {
        const remaining = cooldownUntil - Date.now();
        if (remaining > 300000)
          throw new FestoError(`Festo is rate limited. Please wait at least ${Math.ceil(remaining / 1000)} seconds before trying again.`, 429);
        this.onRateLimit?.(Math.ceil(remaining / 1000));
      }
      await waitForRequest(this.signal);
      try {
        return await this.request(url, bulk, authenticated);
      } catch (error) {
        this.signal.throwIfAborted();
        if (!(error instanceof FestoError)) throw error;
        if (error.status !== 429) {
          // Retry only temporary transport/HTTP failures of these read-only GETs.
          // Invalid JSON, permissions and record validation failures are not retryable.
          const wait = Math.max(error.retryMs ?? 0, 1000 * 2 ** transientRetries);
          if (!error.retryable || transientRetries >= 2 || wait > 300000) throw error;
          transientRetries++;
          await delay(wait, undefined, { signal: this.signal });
          continue;
        }
        lastRateLimitAt = Date.now();
        requestIntervalMs = Math.min(4000, requestIntervalMs * 2);
        const wait = Math.max(error.retryMs ?? 60000, 60000 * 2 ** rateLimitRetries);
        cooldownUntil = Math.max(cooldownUntil, Date.now() + wait);
        if (rateLimitRetries++ >= 3 || wait > 300000)
          throw new FestoError(`Festo is still rate limited. Please wait at least ${Math.ceil(wait / 1000)} seconds before trying again. No partial results were exported.`, 429);
      }
    }
  }
  private async request(url: URL, bulk: boolean, authenticated: boolean): Promise<unknown> {
    this.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(bulk ? 120000 : 30000);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        headers: {
          ...(authenticated ? { Authorization: `Bearer ${this.token}`, "SMRTNC-LANGUAGE": "en" } : {}),
          Accept: "application/json",
        },
        redirect: "manual",
        cache: "no-store",
        credentials: "omit",
        signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout,
      });
    } catch (error) {
      this.signal?.throwIfAborted();
      const failure = new FestoError(
        error instanceof Error && error.name === "TimeoutError"
          ? "Festo did not respond in time. Please try again."
          : "Unable to connect to Festo. Check the connection and try again.",
      );
      failure.retryable = true;
      throw failure;
    }
    // Release error bodies so connections can be reused, even for non-retryable errors.
    if (!response.ok) await response.body?.cancel().catch(() => {});
    // Workerd supports manual redirects, but not redirect: 'error'.
    // Never follow a redirect with the user's bearer token.
    if (response.status >= 300 && response.status < 400)
      throw new FestoError(
        "Festo returned an unexpected redirect. The request was stopped to protect your credentials.",
      );
    if (!response.ok) {
      const retry = response.headers.get("X-Retry-After") ?? response.headers.get("Retry-After");
      const wait =
        retry && /^\d+$/.test(retry)
          ? ` Please wait at least ${retry} seconds before trying again.`
          : "";
      // Festo explicitly warns against retrying an invalid access token.
      if (!authenticated && [401, 403, 404].includes(response.status))
        throw new BulkExportUnsupported();
      if (bulk && [405, 501].includes(response.status))
        throw new BulkExportUnsupported();
      if (response.status === 401)
        throw new FestoError(
          "The access token has expired or is invalid. Reconnect to continue. This request will not be retried automatically.",
          401,
        );
      if (response.status === 403)
        throw new FestoError(
          `Festo denied access. Check API account permissions or access restrictions.${wait}`,
          403,
        );
      if (response.status === 429) {
        const error = new FestoError("Festo has limited the request rate.", 429);
        error.retryMs = retryAfterMs(response.headers);
        throw error;
      }
      if (response.status === 404)
        throw new FestoError("A machine or incident no longer exists. Run the query again.", 404);
      // Report only fixed operation names, never IDs, tokens or signed blob URLs.
      const path = url.pathname;
      const operation = !authenticated ? "downloading bulk export"
        : path.endsWith("/export/incidents") ? "reading bulk export"
        : path.includes("/customfields/") ? "loading custom fields"
        : path.endsWith("/machines") ? "loading machines"
        : path.endsWith("/incidents") ? "reading incident list"
        : path.includes("/incidents/") ? "reading incident details"
        : "reading API data";
      const error = new FestoError(
        `Festo returned an error (${response.status}) while ${operation}. No results were exported.`,
      );
      error.upstreamStatus = response.status;
      error.retryable = [408, 502, 503, 504].includes(response.status);
      error.retryMs = retryAfterMs(response.headers, Date.now(), 0);
      throw error;
    }
    try {
      if (bulk) {
        // Enforce the limit on decoded bytes, including chunked/compressed bodies.
        const reader = response.body?.getReader();
        if (!reader) throw new BulkExportUnsupported();
        const decoder = new TextDecoder();
        const chunks: string[] = [];
        let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 64 * 1024 * 1024) throw new BulkExportUnsupported();
            chunks.push(decoder.decode(value, { stream: true }));
          }
          chunks.push(decoder.decode());
          return parseBulkDocument(chunks.join(""));
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      return await response.json();
    } catch (error) {
      this.signal.throwIfAborted();
      if (error instanceof BulkExportUnsupported) throw error;
      const failure = new FestoError(timeout.aborted
        ? "Festo did not respond in time. Please try again."
        : "Festo returned an unreadable response. No results were exported.");
      failure.retryable = timeout.aborted || error instanceof TypeError;
      throw failure;
    }
  }
  async bulkIncidents(machineId: string): Promise<Incident[]> {
    let document = await this.readWithRetry(
      new URL(`${API_BASE}/machines/${encodeURIComponent(machineId)}/export/incidents`), true,
    );
    const download = bulkDownloadUrl(document);
    if (download) document = await this.readWithRetry(download, true, false);
    this.throwIfAborted();
    const records = bulkRecords(document);
    let definitions: Map<string, Record<string, unknown>> | undefined;
    if (needsFieldDefinitions(records)) {
      // Export values lack display labels. Load the definitions once per query,
      // including task fields, and join by ID before the existing CSV mapping.
      this.definitions ??= (async () => {
        const incidents = fieldDefinitions(await this.get("/customfields/incidents"));
        const tasks = fieldDefinitions(await this.get("/customfields/tasks"));
        return new Map([...incidents, ...tasks]);
      })();
      definitions = await this.definitions;
    }
    return normalizeBulkIncidents(records, machineId, definitions);
  }
  async *pages<T extends { id: string }>(
    path: string,
    params: Record<string, string | number> = {},
    limit = 200,
  ): AsyncGenerator<T[]> {
    let offset = 0,
      expectedTotal: number | undefined;
    const seen = new Set<string>();
    while (true) {
      const page = (await this.get(path, { ...params, offset, limit })) as {
        items?: T[] | null;
        total?: number;
        offset?: number;
      };
      if (page?.items === null && page.total === 0) page.items = [];
      if (
        !page ||
        !Array.isArray(page.items) ||
        !Number.isInteger(page.total) ||
        page.total! < 0 ||
        page.offset !== offset
      )
        throw new FestoError(
          "The Festo pagination response is invalid. The query stopped to avoid missing records.",
        );
      if (expectedTotal !== undefined && expectedTotal !== page.total)
        throw new FestoError(
          "The record count changed during the query. Run it again to obtain complete results.",
        );
      expectedTotal = page.total;
      if (
        offset + page.items.length > expectedTotal! ||
        (!page.items.length && offset < expectedTotal!)
      )
        throw new FestoError("Festo returned an incomplete page. Run the query again.");
      for (const item of page.items) {
        if (!item || typeof item.id !== "string" || !UUID.test(item.id) || seen.has(item.id))
          throw new FestoError(
            "A page contains duplicate or invalid records. Run the query again.",
          );
        seen.add(item.id);
      }
      if (seen.size > 100000)
        throw new FestoError(
          "This machine has more than 100,000 records. Contact your administrator to use the bulk export API.",
          413,
        );
      yield page.items;
      offset += page.items.length;
      if (offset >= expectedTotal!) return;
    }
  }
  async machines(): Promise<Machine[]> {
    // Festo explicitly supports limit=-1 for all machines, ignoring offset.
    // Incident pagination remains separate and retains its page size.
    const response = (await this.get("/machines", { limit: -1 })) as {
      items?: Machine[] | null;
      total?: number;
    };
    const items = response?.items === null && response.total === 0 ? [] : response?.items;
    if (
      !Array.isArray(items) ||
      !Number.isInteger(response?.total) ||
      response.total !== items.length
    )
      throw new FestoError(
        "Festo did not return the complete machine list. Reconnect to try again.",
      );
    const ids = new Set<string>();
    for (const machine of items) {
      if (
        !machine ||
        typeof machine.id !== "string" ||
        !UUID.test(machine.id) ||
        ids.has(machine.id)
      )
        throw new FestoError(
          "Festo returned duplicate or invalid machines. Reconnect to try again.",
        );
      ids.add(machine.id);
    }
    return items;
  }
}
export async function loginAccount(
  username: unknown,
  password: unknown,
  policy: unknown,
  fetcher: typeof fetch = fetch,
) {
  if (
    typeof username !== "string" ||
    !username.trim() ||
    username.length > 500 ||
    typeof password !== "string" ||
    !password ||
    password.length > 4000
  )
    throw new FestoError("Enter your Smartenance Premium API username and password.", 400);
  if (typeof policy !== "string" || !(AUTH_POLICIES as readonly string[]).includes(policy))
    throw new FestoError("The authentication policy is invalid.", 400);
  const body = new URLSearchParams({
    grant_type: "password",
    scope:
      "offline_access https://smartenance.onmicrosoft.com/f10ca0d5-d3ce-47d0-92fa-5c73a3ed6436/access",
    client_id: "9601ab4b-7c37-43b9-8b58-ffc5cf7cc642",
    response_type: "token",
    username: username.trim(),
    password,
  });
  let response: Response;
  try {
    response = await fetcher(
      `https://smartenance.b2clogin.com/smartenance.onmicrosoft.com/oauth2/v2.0/token?p=${policy}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      },
    );
  } catch {
    throw new FestoError(
      "Unable to connect to the Smartenance sign-in service. Check the connection.",
    );
  }
  // Do not forward account credentials to a redirected destination.
  if (response.status >= 300 && response.status < 400)
    throw new FestoError(
      "The Smartenance sign-in service returned an unexpected redirect. Sign-in was stopped.",
    );
  if (!response.ok)
    throw new FestoError(
      `Smartenance sign-in failed (${response.status}). Check your API username, password and authentication policy, or use an access token.`,
      response.status === 429 ? 429 : 401,
    );
  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  return {
    token: validateToken(data.access_token),
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : null,
  };
}
async function visitIncidents<T>(
  logs: AsyncIterable<T>, client: FestoClient, visit: (log: T) => Promise<void>,
) {
  const iterator = logs[Symbol.asyncIterator]();
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (!failed) {
      try {
        client.throwIfAborted();
        const next = await iterator.next();
        if (failed || next.done) return;
        client.throwIfAborted();
        await visit(next.value);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
          client.cancel();
        }
      }
    }
  }));
  await iterator.return?.();
  if (failed) throw failure;
}

export async function collectRepairs(
  client: FestoClient,
  filters: Filters,
  onProgress: (event: Progress) => void = () => {},
  signal?: AbortSignal,
  source?: { machines: Machine[]; read: (machine: Machine) => Promise<MachineIncidents> },
) {
  signal?.throwIfAborted();
  client.throwIfAborted();
  const { start, end } = dateBounds(filters.from, filters.to);
  const rows: RepairRow[] = [];
  let scanned = 0;
  client.onRateLimit = (seconds) => onProgress({
    type: "progress",
    message: `Festo rate limit reached. Waiting at least ${seconds} seconds, then resuming automatically. You can cancel this query.`,
    scanned,
    matched: rows.length,
  });
  onProgress({ type: "progress", message: "Loading machines…", scanned, matched: rows.length });
  const machines = source?.machines ?? await client.machines();
  const machinesById = new Map(machines.map((machine) => [machine.id, machine]));
  const selected = filters.machineIds.map((id) => machinesById.get(id));
  if (selected.some((m) => !m))
    throw new FestoError(
      "A selected machine no longer exists or is inaccessible. Reconnect to reload machines.",
      400,
    );
  const taskIds = new Set<string>();
  const createdTimes = new Map<string, number>();
  let lastProgressAt = 0;
  const reportProgress = (force = false) => {
    if (!force && Date.now() - lastProgressAt < 100) return;
    lastProgressAt = Date.now();
    onProgress({
      type: "progress",
      message: `Checked ${scanned} incidents. Found ${rows.length} matching repair tasks.`,
      scanned,
      matched: rows.length,
    });
  };
  const retrieval: NonNullable<RepairResult["retrieval"]> = { bulkMachines: 0, standardMachines: 0 };
  if (source) retrieval.databaseMachines = 0;
  let bulkAvailable = true;
  // Validate a whole machine export before yielding any records. A fallback can
  // then restart that machine without mixing partial bulk and regular results.
  async function* incidents(): AsyncGenerator<{ machine: Machine; log: Incident; detail?: Incident }> {
    for (const machine of selected as Machine[]) {
      onProgress({
        type: "progress",
        message: `Reading incidents for ${machine.name || machine.id}…`,
        scanned,
        matched: rows.length,
      });
      if (source) {
        const batch = await source.read(machine);
        if (batch.source === "database") retrieval.databaseMachines!++;
        else if (batch.source === "bulk") retrieval.bulkMachines++;
        else retrieval.standardMachines++;
        if (!retrieval.oldestSnapshotAt || batch.syncedAt < retrieval.oldestSnapshotAt)
          retrieval.oldestSnapshotAt = batch.syncedAt;
        for (const incident of batch.incidents) yield { machine, log: incident, detail: incident };
        reportProgress(true);
        continue;
      }
      if (bulkAvailable) {
        onProgress({ type: "progress", message: `Reading bulk export for ${machine.name || machine.id}…`, scanned, matched: rows.length });
        let batch: Incident[] | undefined;
        try {
          batch = await client.bulkIncidents(machine.id);
        } catch (error) {
          client.throwIfAborted();
          // Use the actual HTTP status, not our default 502 error envelope:
          // validation and redirect failures must not look like server outages.
          const serverFailure = error instanceof FestoError &&
            [500, 502, 503, 504].includes(error.upstreamStatus ?? 0);
          if (!(error instanceof BulkExportUnsupported) &&
              !(error instanceof FestoError && [403, 404].includes(error.status)) &&
              !serverFailure) throw error;
          // After permission/server failures, use the standard API for the
          // remaining machines in this query instead of repeating bulk failures.
          if (error instanceof FestoError) bulkAvailable = false;
          onProgress({ type: "progress", message: serverFailure
            ? `Bulk export failed (${error.upstreamStatus}). Using the standard query.`
            : "Bulk export unavailable for this machine. Using the standard query.", scanned, matched: rows.length });
        }
        if (batch !== undefined) {
          retrieval.bulkMachines++;
          for (const incident of batch) yield { machine, log: incident, detail: incident };
          reportProgress(true);
          continue;
        }
      }
      retrieval.standardMachines++;
      // Do not apply incident from/to filters: a repair can be created long after its incident.
      for await (const logs of client.pages<Incident>(
        "/incidents",
        { machineId: machine.id },
        INCIDENT_PAGE_SIZE,
      )) {
        for (const log of logs) yield { machine, log };
        reportProgress(true);
      }
    }
  }
  await visitIncidents(incidents(), client, async ({ machine, log, detail }) => {
    signal?.throwIfAborted();
    if (log.machineId !== machine.id)
      throw new FestoError(
        "Festo returned an incident for a different machine. The query was stopped.",
      );
    // The list may also contain maintenance/information logs.
    if (log.type && log.type !== "Incident") return;
    // Avoid detail requests when the list already rules out the selected state.
    // Missing/unrecognized list states still require details so we do not lose tasks.
    if (
      filters.incidentState !== "All" &&
      isIncidentState(log.state) &&
      log.state !== filters.incidentState
    ) {
      scanned++;
      return;
    }
    const incident = detail ?? (await client.get(`/incidents/${encodeURIComponent(log.id)}`)) as Incident;
    signal?.throwIfAborted();
    client.throwIfAborted();
    if (
      !incident ||
      incident.id !== log.id ||
      (incident.machineId && incident.machineId !== machine.id) ||
      !isIncidentState(incident.state) ||
      (incident.repairTasks != null && !Array.isArray(incident.repairTasks))
    )
      throw new FestoError(
        "The incident details are invalid. The query stopped to avoid missing tasks.",
      );
    // Recheck the detail response in case the incident state changed after listing.
    if (filters.incidentState !== "All" && incident.state !== filters.incidentState) {
      scanned++;
      reportProgress();
      return;
    }
    let incidentFields: Pick<RepairRow, "incidentSummary" | "incidentDescription" | "incidentCause" | "customFields"> | undefined;
    for (const task of incident.repairTasks ?? []) {
      const created = Date.parse(task.createdAt);
      if (
        !UUID.test(task.id) ||
        !Number.isFinite(created) ||
        !/(Z|[+-]\d{2}:\d{2})$/i.test(task.createdAt)
      )
        throw new FestoError(
          "A repair task has an invalid ID or creation time and cannot be filtered reliably.",
        );
      if (created < start || created >= end) continue;
      if (taskIds.has(task.id))
        throw new FestoError("Festo returned a duplicate repair task. Run the query again.");
      taskIds.add(task.id);
      createdTimes.set(task.id, created);
      // HTML conversion is comparatively expensive; do it once per matched incident.
      incidentFields ??= {
        incidentSummary: plainText(incident.summary),
        incidentDescription: plainText(incident.description),
        incidentCause: plainText(incident.cause),
        customFields: allCustomFields(incident.customFields, "incident"),
      };
      rows.push({
        machineId: machine.id,
        machineName: machine.name ?? "",
        machineNumber: machine.number ?? "",
        incidentId: log.id,
        incidentNumber: String(incident.logNumber ?? log.number ?? ""),
        ...incidentFields,
        customFields: [...incidentFields.customFields!, ...allCustomFields(task.customFields, "repair")],
        incidentState: incident.state ?? "",
        incidentOccurredAt: incident.occurredAt ?? "",
        incidentFixedAt: incident.fixedDateTime ?? "",
        taskId: task.id,
        description: plainText(task.description),
        result: task.result ?? "Unknown",
        createdAt: task.createdAt,
        createdBy: task.createdBy ?? "",
        modifiedAt: task.modifiedAt ?? "",
        modifiedBy: task.modifiedBy ?? "",
        comments: JSON.stringify(task.comments ?? []),
        ...repairCustomFields(task.customFields),
      });
      if (rows.length > 100000)
        throw new FestoError(
          "More than 100,000 tasks matched. Select fewer machines or a shorter date range.",
          413,
        );
    }
    scanned++;
    reportProgress();
  });
  reportProgress(true);
  rows.sort(
    (a, b) => createdTimes.get(b.taskId)! - createdTimes.get(a.taskId)! || a.taskId.localeCompare(b.taskId),
  );
  return { rows, scanned, retrieval };
}
