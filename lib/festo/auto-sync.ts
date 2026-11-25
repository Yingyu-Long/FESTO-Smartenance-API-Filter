import { setTimeout as delay } from "node:timers/promises";
import { AUTH_POLICIES, errorMessage, FestoClient, FestoError, loginAccount, validateToken } from "./client.ts";
import { syncDatabase } from "./cached-repairs.ts";
import { accountKeyForVerifiedToken, getIncidentStore, type PostgresIncidentStore } from "./database.ts";
import type { AutoSyncStatus, SyncResult } from "./types.ts";

const UTC8_OFFSET_MS = 8 * 3600_000;
// Node.js timers cap delays at 2^31 - 1 ms; wake periodically to avoid overflow and clock drift.
export const MAX_TIMER_SLEEP_MS = 6 * 3600_000;

export interface SyncScheduleConfig {
  enabled: boolean;
  hasCredentials: boolean;
  daysOfMonth: number[];
  timeUtc8: string;
  hourUtc8: number;
  minuteUtc8: number;
  catchUp: boolean;
  maxRetries: number;
  retryDelayMs: number;
}

export function parseSyncSchedule(env: NodeJS.ProcessEnv = process.env): SyncScheduleConfig {
  const rawDays = (env.SYNC_DAYS_OF_MONTH ?? "25").trim();
  const parsedDays = rawDays
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  if (!parsedDays.length || parsedDays.some((d) => !Number.isInteger(d) || d < 1 || d > 28)) {
    throw new FestoError("SYNC_DAYS_OF_MONTH must be comma-separated day numbers between 1 and 28 (for example: 25 or 10,25).", 400);
  }
  const daysOfMonth = [...new Set(parsedDays)].sort((a, b) => a - b);

  const timeUtc8 = (env.SYNC_TIME_UTC8 ?? "02:00").trim();
  const timeMatch = timeUtc8.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!timeMatch) {
    throw new FestoError("SYNC_TIME_UTC8 must be in HH:MM 24-hour format (for example: 02:00).", 400);
  }
  const hourUtc8 = Number(timeMatch[1]);
  const minuteUtc8 = Number(timeMatch[2]);

  const maxRetries = Number(env.SYNC_MAX_RETRIES ?? "2");
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
    throw new FestoError("SYNC_MAX_RETRIES must be an integer between 0 and 10.", 400);
  }
  const retryDelaySeconds = Number(env.SYNC_RETRY_DELAY_SECONDS ?? "1800");
  if (!Number.isFinite(retryDelaySeconds) || retryDelaySeconds < 1 || retryDelaySeconds > 86400) {
    throw new FestoError("SYNC_RETRY_DELAY_SECONDS must be between 1 and 86400.", 400);
  }

  const hasAccount = Boolean(env.FESTO_SYNC_USERNAME?.trim() && env.FESTO_SYNC_PASSWORD);
  const hasToken = Boolean(env.FESTO_SYNC_TOKEN?.trim());
  const hasConfiguredFlag = env.FESTO_SYNC_CONFIGURED === "1" || env.FESTO_SYNC_CONFIGURED === "true";
  const hasCredentials = hasAccount || hasToken || hasConfiguredFlag;
  const enabledFlag = (env.SYNC_ENABLED ?? "true").trim().toLowerCase();
  const enabled = enabledFlag !== "false" && enabledFlag !== "0" && hasCredentials;
  const catchUpFlag = (env.SYNC_CATCH_UP ?? "true").trim().toLowerCase();
  const catchUp = catchUpFlag !== "false" && catchUpFlag !== "0";

  return {
    enabled,
    hasCredentials,
    daysOfMonth,
    timeUtc8,
    hourUtc8,
    minuteUtc8,
    catchUp,
    maxRetries,
    retryDelayMs: Math.round(retryDelaySeconds * 1000),
  };
}

function utcFromUtc8Slot(year: number, monthZeroBased: number, day: number, hour: number, minute: number): Date {
  return new Date(Date.UTC(year, monthZeroBased, day, hour, minute, 0, 0) - UTC8_OFFSET_MS);
}

function candidateSlotsAround(now: Date, schedule: Pick<SyncScheduleConfig, "daysOfMonth" | "hourUtc8" | "minuteUtc8">): Date[] {
  const shifted = new Date(now.getTime() + UTC8_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const slots: Date[] = [];
  for (const monthOffset of [-1, 0, 1, 2]) {
    for (const day of schedule.daysOfMonth) {
      slots.push(utcFromUtc8Slot(year, month + monthOffset, day, schedule.hourUtc8, schedule.minuteUtc8));
    }
  }
  return slots.sort((a, b) => a.getTime() - b.getTime());
}

export function nextScheduledRun(
  now: Date,
  schedule: Pick<SyncScheduleConfig, "daysOfMonth" | "hourUtc8" | "minuteUtc8">,
): Date {
  const candidates = candidateSlotsAround(now, schedule);
  const next = candidates.find((slot) => slot.getTime() > now.getTime());
  if (!next) throw new Error("Unable to compute next scheduled sync timestamp.");
  return next;
}

export function previousScheduledRun(
  now: Date,
  schedule: Pick<SyncScheduleConfig, "daysOfMonth" | "hourUtc8" | "minuteUtc8">,
): Date {
  const candidates = candidateSlotsAround(now, schedule).filter((slot) => slot.getTime() <= now.getTime());
  const prev = candidates.at(-1);
  if (!prev) throw new Error("Unable to compute previous scheduled sync timestamp.");
  return prev;
}

export function shouldRunCatchUp(
  lastSucceededAt: string | null,
  now: Date,
  schedule: Pick<SyncScheduleConfig, "daysOfMonth" | "hourUtc8" | "minuteUtc8" | "catchUp">,
): boolean {
  if (!schedule.catchUp) return false;
  if (!lastSucceededAt) return true;
  const parsed = Date.parse(lastSucceededAt);
  if (!Number.isFinite(parsed)) return true;
  return parsed < previousScheduledRun(now, schedule).getTime();
}

export async function authenticateAutoSync(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): Promise<{
  token: string;
  expiresIn: number | null;
  refresh?: () => Promise<{ token: string; expiresIn: number | null }>;
}> {
  const username = env.FESTO_SYNC_USERNAME?.trim();
  const password = env.FESTO_SYNC_PASSWORD;
  if (username && password) {
    const configuredPolicy = (env.FESTO_SYNC_POLICY ?? "auto").trim();
    const signIn = async (): Promise<{ token: string; expiresIn: number | null }> => {
      if (configuredPolicy && configuredPolicy !== "auto") {
        return loginAccount(username, password, configuredPolicy, fetcher);
      }
      let lastError: unknown;
      for (const policy of AUTH_POLICIES) {
        try {
          return await loginAccount(username, password, policy, fetcher);
        } catch (error) {
          lastError = error;
          if (!(error instanceof FestoError && error.status === 401)) throw error;
        }
      }
      throw lastError;
    };
    const initial = await signIn();
    return { ...initial, refresh: signIn };
  }
  if (env.FESTO_SYNC_TOKEN?.trim()) {
    return { token: validateToken(env.FESTO_SYNC_TOKEN), expiresIn: null };
  }
  throw new FestoError(
    "Configure FESTO_SYNC_USERNAME and FESTO_SYNC_PASSWORD in .env to run scheduled database sync.",
    400,
  );
}

export interface RunScheduledSyncOptions {
  env?: NodeJS.ProcessEnv;
  store?: PostgresIncidentStore;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  log?: (message: string) => void;
  createClient?: (token: string, signal: AbortSignal) => FestoClient;
}

export async function runScheduledSyncOnce(
  options: RunScheduledSyncOptions = {},
): Promise<{ skipped: true } | { skipped: false; result: SyncResult }> {
  const env = options.env ?? process.env;
  const store = options.store ?? getIncidentStore();
  const signal = options.signal ?? new AbortController().signal;
  const log = options.log ?? ((msg: string) => console.log(`[auto-sync ${new Date().toISOString()}] ${msg}`));
  const fetcher = options.fetcher ?? fetch;
  const makeClient = options.createClient ?? ((token: string, abort: AbortSignal) => new FestoClient(token, { fetcher, signal: abort }));

  return store
    .withAutoSyncLock(async () => {
      const runId = await store.startSyncRun("scheduled", null);
      let accountKey: string | null = null;
      try {
        log("Signing in to Smartenance…");
        const auth = await authenticateAutoSync(env, fetcher);
        signal.throwIfAborted();
        accountKey = accountKeyForVerifiedToken(auth.token);

        const result = await syncDatabase(
          auth.token,
          (event) => log(event.message),
          signal,
          {
            store,
            expiresIn: auth.expiresIn,
            refreshToken: auth.refresh ? () => auth.refresh!() : undefined,
            createClient: makeClient,
          },
        );

        await store.finishSyncRun(runId, {
          status: "succeeded",
          accountKey,
          machinesTotal: result.machines.length,
          machinesSynced: result.syncedMachines,
          incidentsTotal: result.incidents,
          diff: result.diff,
        });
        const d = result.diff;
        log(
          `Sync succeeded: ${result.syncedMachines}/${result.machines.length} machines, ${result.incidents} incidents` +
            (d ? ` (inserted=${d.inserted}, updated=${d.updated}, unchanged=${d.unchanged}, deleted=${d.deleted})` : "") +
            ".",
        );
        return result;
      } catch (error) {
        const msg = errorMessage(error);
        await store
          .finishSyncRun(runId, {
            status: "failed",
            accountKey,
            errorMessage: msg,
          })
          .catch(() => {});
        log(`Sync failed: ${msg}`);
        throw error;
      }
    })
    .then((outcome) => {
      if (!outcome.acquired) {
        log("Another scheduled sync is already in progress; skipping overlapping trigger.");
        return { skipped: true as const };
      }
      return { skipped: false as const, result: outcome.value };
    });
}

export async function runScheduledSyncWithRetries(
  options: RunScheduledSyncOptions & { maxRetries?: number; retryDelayMs?: number } = {},
): Promise<{ skipped: true } | { skipped: false; result: SyncResult }> {
  const schedule = parseSyncSchedule(options.env ?? process.env);
  const maxRetries = options.maxRetries ?? schedule.maxRetries;
  const retryDelayMs = options.retryDelayMs ?? schedule.retryDelayMs;
  const log = options.log ?? ((msg: string) => console.log(`[auto-sync ${new Date().toISOString()}] ${msg}`));
  let attempt = 0;

  while (true) {
    options.signal?.throwIfAborted();
    try {
      return await runScheduledSyncOnce(options);
    } catch (error) {
      options.signal?.throwIfAborted();
      const nonRetryable = error instanceof FestoError && [400, 401, 403].includes(error.status);
      if (nonRetryable || attempt >= maxRetries) throw error;
      attempt++;
      log(`Retrying scheduled sync (attempt ${attempt}/${maxRetries}) in ${Math.round(retryDelayMs / 1000)}s…`);
      await delay(retryDelayMs, undefined, { signal: options.signal });
    }
  }
}

export async function readAutoSyncStatus(
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
  storeOverride?: PostgresIncidentStore,
): Promise<AutoSyncStatus> {
  const schedule = parseSyncSchedule(env);
  const databaseConfigured = Boolean(env.DATABASE_URL?.trim()) || Boolean(storeOverride);
  const nextRunAt = schedule.enabled ? nextScheduledRun(now, schedule).toISOString() : null;
  if (!databaseConfigured) {
    return {
      databaseConfigured: false,
      databaseAvailable: false,
      autoSyncEnabled: schedule.enabled,
      schedule: { daysOfMonth: schedule.daysOfMonth, timeUtc8: schedule.timeUtc8, nextRunAt },
      lastScheduledRun: null,
    };
  }
  try {
    const store = storeOverride ?? getIncidentStore();
    const lastScheduledRun = await store.latestScheduledRun();
    return {
      databaseConfigured: true,
      databaseAvailable: true,
      autoSyncEnabled: schedule.enabled,
      schedule: { daysOfMonth: schedule.daysOfMonth, timeUtc8: schedule.timeUtc8, nextRunAt },
      lastScheduledRun,
    };
  } catch {
    return {
      databaseConfigured: true,
      databaseAvailable: false,
      autoSyncEnabled: schedule.enabled,
      schedule: { daysOfMonth: schedule.daysOfMonth, timeUtc8: schedule.timeUtc8, nextRunAt },
      lastScheduledRun: null,
    };
  }
}
