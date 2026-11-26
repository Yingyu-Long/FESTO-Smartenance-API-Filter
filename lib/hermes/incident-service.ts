export class MachineNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachineNotFoundError";
  }
}

export class AmbiguousMachineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousMachineError";
  }
}

export interface SmartenanceAccountInfo {
  account_key: string;
  machine_count: number;
  total_incidents: number;
  latest_synced_at: string | null;
}

import type pg from "pg";

export interface SnapshotQueryClient {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

export interface SnapshotStore {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
  withReadOnlySnapshot<T>(run: (client: SnapshotQueryClient) => Promise<T>): Promise<T>;
}

interface MachineSnapshot {
  id: string;
  machine: Record<string, unknown>;
  incidents: Record<string, unknown>[];
  incident_count: number;
  synced_at: string;
  snapshot_complete: boolean;
}

interface FactoryMachineRow {
  machine_id: string;
  name: string | null;
  number: string | null;
  revision: number;
  incident_count: number;
  synced_at: Date;
}

type FactoryIncidentRow = {
  machine_id: string;
  state: string | null;
  occurred_at: string | null;
  created_at: string | null;
};

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function jsonObject(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof parsed === "string") {
    parsed = JSON.parse(parsed) as unknown;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Database contains a row with an invalid JSON object");
  }
  return parsed as Record<string, unknown>;
}

function toDateObj(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return new Date(0);
}

export function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const dateMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/i,
  );
  if (!dateMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = dateMatch[4] !== undefined ? Number(dateMatch[4]) : 0;
  const minute = dateMatch[5] !== undefined ? Number(dateMatch[5]) : 0;
  const second = dateMatch[6] !== undefined ? Number(dateMatch[6]) : 0;
  const fracRaw = dateMatch[7] ?? "";
  const ms = fracRaw ? Number(fracRaw.slice(0, 3).padEnd(3, "0")) : 0;
  const tzRaw = dateMatch[8];

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  const utcCheck = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  if (
    utcCheck.getUTCFullYear() !== year ||
    utcCheck.getUTCMonth() !== month - 1 ||
    utcCheck.getUTCDate() !== day
  ) {
    return null;
  }

  if (!tzRaw || tzRaw.toUpperCase() === "Z") {
    return utcCheck;
  }

  const sign = tzRaw.startsWith("-") ? -1 : 1;
  const cleanTz = tzRaw.slice(1).replace(":", "");
  const tzHours = Number(cleanTz.slice(0, 2));
  const tzMinutes = Number(cleanTz.slice(2, 4));
  if (tzHours > 23 || tzMinutes > 59) return null;
  const offsetMs = sign * (tzHours * 60 + tzMinutes) * 60 * 1000;
  return new Date(utcCheck.getTime() - offsetMs);
}

function incidentDate(incident: Record<string, unknown>): Date | null {
  return parseIsoDate(incident.occurredAt) ?? parseIsoDate(incident.createdAt);
}

function isActiveIncident(incident: Record<string, unknown>): boolean {
  return String(incident.state ?? "").trim().toLowerCase() !== "closed";
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isoWeekKey(dateUtc: Date): string {
  const target = new Date(
    Date.UTC(dateUtc.getUTCFullYear(), dateUtc.getUTCMonth(), dateUtc.getUTCDate()),
  );
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const isoYear = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(((target.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${isoYear}-W${String(isoWeek).padStart(2, "0")}`;
}

function formatShanghaiMidnightIso(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01T00:00:00+08:00`;
}

export async function listSmartenanceAccounts(
  store: SnapshotStore,
): Promise<SmartenanceAccountInfo[]> {
  const result = await store.query<{
    account_key: string;
    machine_count: number;
    total_incidents: number;
    latest_synced_at: Date | string | null;
  }>(
    `SELECT
       m.account_key,
       COUNT(DISTINCT m.machine_id)::int AS machine_count,
       COUNT(i.incident_id)::int AS total_incidents,
       MAX(m.synced_at) AS latest_synced_at
     FROM smartenance_machines m
     LEFT JOIN smartenance_incidents i
       ON i.account_key = m.account_key AND i.machine_id = m.machine_id
     GROUP BY m.account_key
     ORDER BY MAX(m.synced_at) DESC NULLS LAST, m.account_key ASC`,
  );
  return result.rows.map((row) => ({
    account_key: String(row.account_key),
    machine_count: Number(row.machine_count ?? 0),
    total_incidents: Number(row.total_incidents ?? 0),
    latest_synced_at: row.latest_synced_at ? toDateObj(row.latest_synced_at).toISOString() : null,
  }));
}

export async function resolveSmartenanceAccountKey(
  store: SnapshotStore,
  preferred?: string | null,
): Promise<{ accountKey: string; accounts: SmartenanceAccountInfo[] }> {
  const accounts = await listSmartenanceAccounts(store);
  const explicit = (preferred ?? "").trim();
  if (explicit && explicit !== "auto") {
    return { accountKey: explicit, accounts };
  }
  const envAccount = (process.env.SMARTENANCE_ACCOUNT_KEY ?? "").trim();
  if (envAccount && envAccount !== "auto") {
    return { accountKey: envAccount, accounts };
  }
  return { accountKey: accounts[0]?.account_key ?? "", accounts };
}

export class IncidentService {
  private readonly store: SnapshotStore;
  private readonly account: string;

  constructor(store: SnapshotStore, account: string) {
    this.store = store;
    this.account = account;
  }

  private async snapshots(): Promise<MachineSnapshot[]> {
    const { machineRows, incidentRows } = await this.store.withReadOnlySnapshot(async (client) => {
      const machines = await client.query<{
        machine_id: string;
        machine: unknown;
        incident_count: number;
        synced_at: Date | string;
      }>(
        `SELECT machine_id::text AS machine_id, machine, incident_count, synced_at
         FROM smartenance_machines
         WHERE account_key = $1
         ORDER BY machine_id`,
        [this.account],
      );
      const incidents = await client.query<{
        machine_id: string;
        incident: unknown;
      }>(
        `SELECT machine_id::text AS machine_id, incident
         FROM smartenance_incidents
         WHERE account_key = $1
         ORDER BY machine_id, incident_id`,
        [this.account],
      );
      return { machineRows: machines.rows, incidentRows: incidents.rows };
    });

    const byMachine = new Map<string, Record<string, unknown>[]>();
    for (const row of incidentRows) {
      const list = byMachine.get(row.machine_id);
      const parsed = jsonObject(row.incident);
      if (list) list.push(parsed);
      else byMachine.set(row.machine_id, [parsed]);
    }

    return machineRows.map((row) => {
      const snapshotIncidents = byMachine.get(row.machine_id) ?? [];
      const recordedCount = Number(row.incident_count ?? 0);
      return {
        id: row.machine_id,
        machine: jsonObject(row.machine),
        incidents: snapshotIncidents,
        incident_count: recordedCount,
        synced_at: toDateObj(row.synced_at).toISOString(),
        snapshot_complete: snapshotIncidents.length === recordedCount,
      };
    });
  }

  private async factoryRows(): Promise<{
    machines: FactoryMachineRow[];
    incidents: FactoryIncidentRow[];
  }> {
    return this.store.withReadOnlySnapshot(async (client) => {
      const machines = await client.query<{
        machine_id: string;
        name: string | null;
        number: string | null;
        revision: string | number;
        incident_count: number;
        synced_at: Date | string;
      }>(
        `SELECT
           machine_id::text AS machine_id,
           machine->>'name' AS name,
           machine->>'number' AS number,
           revision,
           incident_count,
           synced_at
         FROM smartenance_machines
         WHERE account_key = $1
         ORDER BY machine_id`,
        [this.account],
      );
      const incidents = await client.query<FactoryIncidentRow>(
        `SELECT
           machine_id::text AS machine_id,
           incident->>'state' AS state,
           incident->>'occurredAt' AS occurred_at,
           incident->>'createdAt' AS created_at
         FROM smartenance_incidents
         WHERE account_key = $1
         ORDER BY machine_id, incident_id`,
        [this.account],
      );
      return {
        machines: machines.rows.map((row) => ({
          machine_id: row.machine_id,
          name: row.name ?? null,
          number: row.number ?? null,
          revision: Number(row.revision),
          incident_count: Number(row.incident_count ?? 0),
          synced_at: toDateObj(row.synced_at),
        })),
        incidents: incidents.rows,
      };
    });
  }

  private static stateLabel(value: unknown): string {
    const state = String(value ?? "").trim();
    return state || "Unknown";
  }

  private static summaryWindow(
    lookbackDays?: number | null,
    startDate?: string | null,
    endDate?: string | null,
    now: Date = new Date(),
  ): [Date, Date] {
    let start: Date;
    let end: Date;
    if (lookbackDays !== undefined && lookbackDays !== null) {
      if (startDate != null || endDate != null) {
        throw new Error("Use lookback_days or start_date/end_date, not both");
      }
      if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 36500) {
        throw new Error("lookback_days must be between 1 and 36500");
      }
      start = new Date(now.getTime() - lookbackDays * DAY_MS);
      end = now;
    } else {
      if (!startDate) {
        throw new Error("Provide lookback_days or start_date");
      }
      const parsedStart = parseIsoDate(startDate);
      if (!parsedStart) {
        throw new Error("start_date must be an ISO-8601 date or timestamp");
      }
      const parsedEnd = endDate ? parseIsoDate(endDate) : now;
      if (!parsedEnd) {
        throw new Error("end_date must be an ISO-8601 date or timestamp");
      }
      start = parsedStart;
      end = parsedEnd;
    }
    if (start.getTime() >= end.getTime()) {
      throw new Error("The start of the range must be earlier than its end");
    }
    return [start, end];
  }

  private static periodKey(value: Date, granularity: string): string {
    if (granularity === "day") return value.toISOString().slice(0, 10);
    if (granularity === "week") return isoWeekKey(value);
    return value.toISOString().slice(0, 7);
  }

  async getFactoryOverview(machineLimit = 10): Promise<Record<string, unknown>> {
    if (!Number.isInteger(machineLimit) || machineLimit < 1 || machineLimit > 100) {
      throw new Error("machine_limit must be between 1 and 100");
    }

    const { machines, incidents } = await this.factoryRows();
    const machineCounts = new Map<string, { incident_count: number; active_incident_count: number }>();
    for (const row of machines) {
      machineCounts.set(row.machine_id, { incident_count: 0, active_incident_count: 0 });
    }

    const stateCounts = new Map<string, { state: string; incident_count: number }>();
    let undatedIncidentCount = 0;

    for (const incident of incidents) {
      const count = machineCounts.get(incident.machine_id);
      if (!count) continue;
      if (!incidentDate({ occurredAt: incident.occurred_at, createdAt: incident.created_at })) {
        undatedIncidentCount += 1;
      }
      count.incident_count += 1;
      const state = IncidentService.stateLabel(incident.state);
      const stateKey = state.toLowerCase();
      const stateItem = stateCounts.get(stateKey) ?? { state, incident_count: 0 };
      stateItem.incident_count += 1;
      stateCounts.set(stateKey, stateItem);
      if (stateKey !== "closed") {
        count.active_incident_count += 1;
      }
    }

    const machineSummaries: Array<{
      machine_id: string;
      name: string | null;
      number: string | null;
      incident_count: number;
      recorded_incident_count: number;
      active_incident_count: number;
      closed_incident_count: number;
      snapshot_complete: boolean;
    }> = [];
    let incompleteMachineCount = 0;
    let machinesWithIncidents = 0;
    let machinesWithActiveIncidents = 0;

    for (const machine of machines) {
      const counts = machineCounts.get(machine.machine_id)!;
      const isComplete = counts.incident_count === machine.incident_count;
      if (!isComplete) incompleteMachineCount += 1;
      if (counts.incident_count > 0) machinesWithIncidents += 1;
      if (counts.active_incident_count > 0) machinesWithActiveIncidents += 1;
      machineSummaries.push({
        machine_id: machine.machine_id,
        name: machine.name,
        number: machine.number,
        incident_count: counts.incident_count,
        recorded_incident_count: machine.incident_count,
        active_incident_count: counts.active_incident_count,
        closed_incident_count: counts.incident_count - counts.active_incident_count,
        snapshot_complete: isComplete,
      });
    }

    machineSummaries.sort(
      (a, b) =>
        b.active_incident_count - a.active_incident_count ||
        b.incident_count - a.incident_count ||
        a.machine_id.localeCompare(b.machine_id),
    );

    const syncTimes = machines.map((row) => row.synced_at.getTime());
    const revisions = machines.map((row) => row.revision);
    let activeCount = 0;
    for (const item of machineCounts.values()) activeCount += item.active_incident_count;

    return {
      machine_count: machines.length,
      incident_count: incidents.length,
      recorded_incident_count: machines.reduce((sum, row) => sum + row.incident_count, 0),
      active_incident_count: activeCount,
      closed_incident_count: incidents.length - activeCount,
      incidents_by_state: [...stateCounts.values()].sort(
        (a, b) =>
          b.incident_count - a.incident_count ||
          a.state.toLowerCase().localeCompare(b.state.toLowerCase()),
      ),
      machines_with_incidents: machinesWithIncidents,
      machines_with_active_incidents: machinesWithActiveIncidents,
      undated_incident_count_in_snapshot: undatedIncidentCount,
      snapshot_complete: incompleteMachineCount === 0,
      incomplete_machine_count: incompleteMachineCount,
      latest_synced_at: syncTimes.length ? new Date(Math.max(...syncTimes)).toISOString() : null,
      oldest_synced_at: syncTimes.length ? new Date(Math.min(...syncTimes)).toISOString() : null,
      revision_min: revisions.length ? Math.min(...revisions) : null,
      revision_max: revisions.length ? Math.max(...revisions) : null,
      top_machines: machineSummaries.slice(0, machineLimit),
    };
  }

  async getFactoryIncidentSummary(
    lookbackDays?: number | null,
    startDate?: string | null,
    endDate?: string | null,
    granularity = "month",
    machineLimit = 20,
    now: Date = new Date(),
  ): Promise<Record<string, unknown>> {
    if (!["day", "week", "month"].includes(granularity)) {
      throw new Error("granularity must be day, week, or month");
    }
    if (!Number.isInteger(machineLimit) || machineLimit < 1 || machineLimit > 100) {
      throw new Error("machine_limit must be between 1 and 100");
    }
    const [start, end] = IncidentService.summaryWindow(lookbackDays, startDate, endDate, now);
    const { machines, incidents } = await this.factoryRows();
    const machineById = new Map(machines.map((row) => [row.machine_id, row]));
    const byState = new Map<string, { state: string; incident_count: number }>();
    const byMachine = new Map<string, { incident_count: number; active_incident_count: number }>();
    const byPeriod = new Map<
      string,
      { incident_count: number; active_incident_count: number; closed_incident_count: number }
    >();
    let undatedIncidentCount = 0;

    for (const incident of incidents) {
      const occurred = incidentDate({
        occurredAt: incident.occurred_at,
        createdAt: incident.created_at,
      });
      if (!occurred) {
        undatedIncidentCount += 1;
        continue;
      }
      if (occurred.getTime() < start.getTime() || occurred.getTime() >= end.getTime()) {
        continue;
      }

      const state = IncidentService.stateLabel(incident.state);
      const stateKey = state.toLowerCase();
      const isActive = stateKey !== "closed";
      const stateItem = byState.get(stateKey) ?? { state, incident_count: 0 };
      stateItem.incident_count += 1;
      byState.set(stateKey, stateItem);

      const machineItem = byMachine.get(incident.machine_id) ?? {
        incident_count: 0,
        active_incident_count: 0,
      };
      machineItem.incident_count += 1;
      if (isActive) machineItem.active_incident_count += 1;
      byMachine.set(incident.machine_id, machineItem);

      const period = IncidentService.periodKey(occurred, granularity);
      const periodItem = byPeriod.get(period) ?? {
        incident_count: 0,
        active_incident_count: 0,
        closed_incident_count: 0,
      };
      periodItem.incident_count += 1;
      if (isActive) periodItem.active_incident_count += 1;
      else periodItem.closed_incident_count += 1;
      byPeriod.set(period, periodItem);
    }

    const machineSummaries = [...byMachine.entries()]
      .filter(([machineId]) => machineById.has(machineId))
      .map(([machineId, counts]) => {
        const machine = machineById.get(machineId)!;
        return {
          machine_id: machineId,
          name: machine.name,
          number: machine.number,
          ...counts,
          closed_incident_count: counts.incident_count - counts.active_incident_count,
        };
      })
      .sort(
        (a, b) =>
          b.incident_count - a.incident_count ||
          b.active_incident_count - a.active_incident_count ||
          a.machine_id.localeCompare(b.machine_id),
      );

    const actualCountByMachine = new Map<string, number>();
    for (const incident of incidents) {
      actualCountByMachine.set(
        incident.machine_id,
        (actualCountByMachine.get(incident.machine_id) ?? 0) + 1,
      );
    }
    const incompleteMachineCount = machines.filter(
      (m) => (actualCountByMachine.get(m.machine_id) ?? 0) !== m.incident_count,
    ).length;
    const syncTimes = machines.map((row) => row.synced_at.getTime());

    return {
      range: {
        start_inclusive: start.toISOString(),
        end_exclusive: end.toISOString(),
        timezone: "UTC",
      },
      date_basis: "occurredAt, falling back to createdAt",
      granularity,
      incident_count: [...byState.values()].reduce((sum, item) => sum + item.incident_count, 0),
      active_incident_count: [...byPeriod.values()].reduce(
        (sum, item) => sum + item.active_incident_count,
        0,
      ),
      closed_incident_count: [...byPeriod.values()].reduce(
        (sum, item) => sum + item.closed_incident_count,
        0,
      ),
      machines_affected: byMachine.size,
      incidents_by_state: [...byState.values()].sort(
        (a, b) =>
          b.incident_count - a.incident_count ||
          a.state.toLowerCase().localeCompare(b.state.toLowerCase()),
      ),
      trend: [...byPeriod.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([period, counts]) => ({ period, ...counts })),
      top_machines: machineSummaries.slice(0, machineLimit),
      undated_incident_count_in_snapshot: undatedIncidentCount,
      machine_count: machines.length,
      snapshot_complete: incompleteMachineCount === 0,
      incomplete_machine_count: incompleteMachineCount,
      latest_synced_at: syncTimes.length ? new Date(Math.max(...syncTimes)).toISOString() : null,
    };
  }

  static employeeHoursMonthWindow(
    month?: string | null,
    now: Date = new Date(),
  ): {
    period: string;
    start: Date;
    end: Date;
    startIso: string;
    endIso: string;
  } {
    let targetMonth = month ?? null;
    if (targetMonth === null || targetMonth === undefined || targetMonth === "") {
      const shanghaiNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
      let year = shanghaiNow.getUTCFullYear();
      let monthNumber = shanghaiNow.getUTCMonth(); // 0-based -> previous month in 1-based!
      if (monthNumber === 0) {
        year -= 1;
        monthNumber = 12;
      }
      targetMonth = `${String(year).padStart(4, "0")}-${String(monthNumber).padStart(2, "0")}`;
    }

    if (typeof targetMonth !== "string" || !/^\d{4}-\d{2}$/.test(targetMonth)) {
      throw new Error("month must use YYYY-MM format");
    }
    const [yearStr, monthStr] = targetMonth.split("-");
    const year = Number(yearStr);
    const monthNumber = Number(monthStr);
    if (!Number.isInteger(year) || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
      throw new Error("month must be a valid calendar month in YYYY-MM format");
    }

    const nextYear = monthNumber === 12 ? year + 1 : year;
    const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
    const startIso = formatShanghaiMidnightIso(year, monthNumber);
    const endIso = formatShanghaiMidnightIso(nextYear, nextMonth);
    return {
      period: targetMonth,
      start: new Date(Date.UTC(year, monthNumber - 1, 1) - SHANGHAI_OFFSET_MS),
      end: new Date(Date.UTC(nextYear, nextMonth - 1, 1) - SHANGHAI_OFFSET_MS),
      startIso,
      endIso,
    };
  }

  async getEmployeeWorkHours(
    month?: string | null,
    now: Date = new Date(),
  ): Promise<Record<string, unknown>> {
    const { period, start, end, startIso, endIso } = IncidentService.employeeHoursMonthWindow(
      month,
      now,
    );
    const { machineRows, incidentRows } = await this.store.withReadOnlySnapshot(async (client) => {
      const machines = await client.query<{
        machine_id: string;
        incident_count: number;
        synced_at: Date | string;
      }>(
        `SELECT machine_id::text AS machine_id, incident_count, synced_at
         FROM smartenance_machines
         WHERE account_key = $1
         ORDER BY machine_id`,
        [this.account],
      );
      const incidents = await client.query<{
        machine_id: string;
        incident: unknown;
      }>(
        `SELECT machine_id::text AS machine_id, incident
         FROM smartenance_incidents
         WHERE account_key = $1
         ORDER BY machine_id, incident_id`,
        [this.account],
      );
      return { machineRows: machines.rows, incidentRows: incidents.rows };
    });

    const actualCountByMachine = new Map<string, number>();
    const employeeTotals = new Map<
      string,
      { employee: string; work_hours: number; repair_task_count: number }
    >();
    let totalWorkHours = 0;
    let unattributedWorkHours = 0;
    let repairTaskCount = 0;
    let repairTasksWithWorkHours = 0;
    let repairTasksWithoutWorkHours = 0;
    let repairTasksWithoutStaff = 0;
    let repairTasksWithInvalidWorkHours = 0;
    let crewCountMismatchTaskCount = 0;
    let undatedRepairTaskCountInSnapshot = 0;

    const addEmployee = (rawName: unknown, people: Map<string, string>) => {
      if (typeof rawName !== "string") return;
      const name = rawName.trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (!people.has(key)) people.set(key, name);
    };

    for (const row of incidentRows) {
      actualCountByMachine.set(
        row.machine_id,
        (actualCountByMachine.get(row.machine_id) ?? 0) + 1,
      );
      const incident = jsonObject(row.incident);
      const tasks = Array.isArray(incident.repairTasks) ? incident.repairTasks : [];

      for (const rawTask of tasks) {
        if (!rawTask || typeof rawTask !== "object" || Array.isArray(rawTask)) continue;
        const task = rawTask as Record<string, unknown>;
        const taskDate = parseIsoDate(task.createdAt);
        if (!taskDate) {
          undatedRepairTaskCountInSnapshot += 1;
          continue;
        }
        if (taskDate.getTime() < start.getTime() || taskDate.getTime() >= end.getTime()) {
          continue;
        }

        repairTaskCount += 1;
        const fields = new Map<string, unknown>();
        const customFields = Array.isArray(task.customFields) ? task.customFields : [];
        for (const rawField of customFields) {
          if (!rawField || typeof rawField !== "object" || Array.isArray(rawField)) continue;
          const field = rawField as Record<string, unknown>;
          if (field.isDeleted === true) continue;
          const primaryLabel = String(field.label ?? "").trim();
          fields.set(primaryLabel, field.value);
          const defaultLabel = String(field.defaultLanguageLabel ?? "").trim();
          if (defaultLabel && !fields.has(defaultLabel)) {
            fields.set(defaultLabel, field.value);
          }
          if (field.translations && typeof field.translations === "object") {
            for (const item of Object.values(field.translations as Record<string, unknown>)) {
              if (item && typeof item === "object") {
                const title = String((item as Record<string, unknown>).title ?? "").trim();
                if (title && !fields.has(title)) fields.set(title, field.value);
              }
            }
          }
        }

        const rawHours = fields.get("维修工时");
        if (rawHours === undefined || rawHours === null) {
          repairTasksWithoutWorkHours += 1;
          continue;
        }
        if (
          typeof rawHours === "boolean" ||
          typeof rawHours !== "number" ||
          !Number.isFinite(rawHours) ||
          rawHours < 0
        ) {
          repairTasksWithInvalidWorkHours += 1;
          continue;
        }

        const workHours = Number(rawHours);
        totalWorkHours += workHours;
        repairTasksWithWorkHours += 1;

        const people = new Map<string, string>();
        addEmployee(fields.get("维修负责人"), people);
        const collaborators = fields.get("协作人员");
        if (Array.isArray(collaborators)) {
          for (const collaborator of collaborators) addEmployee(collaborator, people);
        } else if (typeof collaborators === "string") {
          addEmployee(collaborators, people);
        }

        if (people.size === 0) {
          repairTasksWithoutStaff += 1;
          unattributedWorkHours += workHours;
          continue;
        }

        const duration = fields.get("维修时间");
        if (
          typeof duration === "number" &&
          Number.isFinite(duration) &&
          duration > 0 &&
          Math.abs(workHours / duration - people.size) > 0.05
        ) {
          crewCountMismatchTaskCount += 1;
        }

        const perEmployeeHours = workHours / people.size;
        for (const [key, name] of people.entries()) {
          const existing = employeeTotals.get(key) ?? {
            employee: name,
            work_hours: 0,
            repair_task_count: 0,
          };
          existing.work_hours += perEmployeeHours;
          existing.repair_task_count += 1;
          employeeTotals.set(key, existing);
        }
      }
    }

    const incompleteMachineCount = machineRows.filter(
      (row) => (actualCountByMachine.get(row.machine_id) ?? 0) !== Number(row.incident_count ?? 0),
    ).length;
    const syncTimes = machineRows.map((row) => toDateObj(row.synced_at).getTime());
    const employees = [...employeeTotals.values()]
      .sort(
        (a, b) =>
          b.work_hours - a.work_hours ||
          a.employee.toLowerCase().localeCompare(b.employee.toLowerCase()),
      )
      .map((item) => ({
        ...item,
        work_hours: round2(item.work_hours),
      }));

    return {
      period,
      range: {
        start_inclusive: startIso,
        end_exclusive: endIso,
        timezone: "Asia/Shanghai",
      },
      date_basis: "repairTask.createdAt",
      work_hours_field: "维修工时",
      allocation:
        "Split each repair task's recorded work hours equally among its distinct 维修负责人 and 协作人员 values.",
      total_work_hours: round2(totalWorkHours),
      attributed_work_hours: round2(totalWorkHours - unattributedWorkHours),
      unattributed_work_hours: round2(unattributedWorkHours),
      employee_count: employees.length,
      employees,
      repair_task_count: repairTaskCount,
      repair_tasks_with_work_hours: repairTasksWithWorkHours,
      repair_tasks_without_work_hours: repairTasksWithoutWorkHours,
      repair_tasks_without_staff: repairTasksWithoutStaff,
      repair_tasks_with_invalid_work_hours: repairTasksWithInvalidWorkHours,
      crew_count_mismatch_task_count: crewCountMismatchTaskCount,
      undated_repair_task_count_in_snapshot: undatedRepairTaskCountInSnapshot,
      machine_count: machineRows.length,
      snapshot_complete: incompleteMachineCount === 0,
      incomplete_machine_count: incompleteMachineCount,
      latest_synced_at: syncTimes.length ? new Date(Math.max(...syncTimes)).toISOString() : null,
    };
  }

  private resolveMachine(snapshots: MachineSnapshot[], identifier: string): MachineSnapshot {
    const target = String(identifier ?? "").trim().toLowerCase();
    if (!target) {
      throw new Error("machine_id must not be empty");
    }
    const matches = snapshots.filter((item) => {
      const candidates = new Set([
        item.id.toLowerCase(),
        String(item.machine.id ?? "").toLowerCase(),
        String(item.machine.number ?? "").toLowerCase(),
        String(item.machine.name ?? "").toLowerCase(),
      ]);
      return candidates.has(target);
    });
    if (matches.length === 0) {
      throw new MachineNotFoundError(
        `No machine matched ${JSON.stringify(identifier)} in the configured account`,
      );
    }
    if (matches.length > 1) {
      throw new AmbiguousMachineError(
        `${JSON.stringify(identifier)} matches multiple machines; use a machine UUID`,
      );
    }
    return matches[0];
  }

  private static statistics(snapshot: MachineSnapshot, recentDays = 90, now: Date = new Date()) {
    const cutoffMs = now.getTime() - recentDays * DAY_MS;
    const recent = snapshot.incidents.filter((incident) => {
      const occurred = incidentDate(incident);
      return occurred !== null && occurred.getTime() >= cutoffMs;
    });
    const active = snapshot.incidents.filter((incident) => isActiveIncident(incident));
    return {
      machine_id: snapshot.id,
      machine: snapshot.machine,
      incident_count: snapshot.incidents.length,
      recorded_incident_count: snapshot.incident_count,
      active_incident_count: active.length,
      closed_incident_count: snapshot.incidents.length - active.length,
      recent_incident_count: recent.length,
      recent_days: recentDays,
      snapshot_complete: snapshot.snapshot_complete,
      synced_at: snapshot.synced_at,
    };
  }

  private static health(snapshot: MachineSnapshot, now: Date = new Date()) {
    const stats = IncidentService.statistics(snapshot, 90, now);
    const activePenalty = Math.min(stats.active_incident_count, 3) * 20;
    const recentPenalty = Math.min(stats.recent_incident_count, 5) * 5;
    const score = Math.max(0, 100 - activePenalty - recentPenalty);
    return {
      ...stats,
      health_score: score,
      risk_level: score < 50 ? "high" : score < 80 ? "medium" : "low",
      scoring: {
        baseline: 100,
        active_incident_penalty_each: 20,
        active_incident_penalty_cap: 60,
        recent_incident_penalty_each: 5,
        recent_incident_penalty_cap: 25,
        recent_days: 90,
      },
    };
  }

  async getMachines(
    search?: string | null,
    limit = 100,
    offset = 0,
  ): Promise<Record<string, unknown>> {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const safeOffset = Math.max(0, Math.trunc(offset));
    const snapshots = await this.snapshots();
    const query = search?.trim().toLowerCase() || null;

    const results: Array<Record<string, unknown>> = [];
    for (const snapshot of snapshots) {
      const values = [
        snapshot.id,
        String(snapshot.machine.name ?? ""),
        String(snapshot.machine.number ?? ""),
      ];
      if (query && !values.some((v) => v.toLowerCase().includes(query))) {
        continue;
      }
      const activeCount = snapshot.incidents.filter((i) => isActiveIncident(i)).length;
      results.push({
        id: snapshot.id,
        name: snapshot.machine.name ?? null,
        number: snapshot.machine.number ?? null,
        incident_count: snapshot.incidents.length,
        active_incident_count: activeCount,
        synced_at: snapshot.synced_at,
        snapshot_complete: snapshot.snapshot_complete,
      });
    }

    const total = results.length;
    const page = results.slice(safeOffset, safeOffset + safeLimit);
    return {
      count: page.length,
      total,
      offset: safeOffset,
      limit: safeLimit,
      has_more: safeOffset + page.length < total,
      machines: page,
    };
  }

  async getMachineDetails(machineId: string): Promise<Record<string, unknown>> {
    const snapshot = this.resolveMachine(await this.snapshots(), machineId);
    return {
      id: snapshot.id,
      machine: snapshot.machine,
      incident_count: snapshot.incidents.length,
      snapshot_complete: snapshot.snapshot_complete,
      synced_at: snapshot.synced_at,
    };
  }

  async getMachineStatistics(now: Date = new Date()): Promise<Record<string, unknown>> {
    const snapshots = await this.snapshots();
    const ranked = snapshots
      .map((snapshot) => IncidentService.statistics(snapshot, 90, now))
      .sort(
        (a, b) =>
          b.incident_count - a.incident_count ||
          b.active_incident_count - a.active_incident_count ||
          a.machine_id.localeCompare(b.machine_id),
      );
    return { count: ranked.length, machines: ranked };
  }

  async getMachineIncidentHistory(
    machineId: string,
    limit = 100,
    state?: string | null,
  ): Promise<Record<string, unknown>> {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const snapshot = this.resolveMachine(await this.snapshots(), machineId);
    const normalizedState = state ? state.trim() : "";
    const stateFilter = normalizedState.toLowerCase() || null;

    const incidents = snapshot.incidents
      .filter(
        (incident) =>
          stateFilter === null ||
          String(incident.state ?? "").toLowerCase() === stateFilter,
      )
      .sort((a, b) => {
        const da = incidentDate(a)?.getTime() ?? Number.NEGATIVE_INFINITY;
        const db = incidentDate(b)?.getTime() ?? Number.NEGATIVE_INFINITY;
        return db - da;
      });

    return {
      machine_id: snapshot.id,
      count: Math.min(incidents.length, safeLimit),
      total: incidents.length,
      state_filter: normalizedState || null,
      incidents: incidents.slice(0, safeLimit),
      synced_at: snapshot.synced_at,
      snapshot_complete: snapshot.snapshot_complete,
    };
  }

  async getMachineMaintenanceHistory(
    machineId: string,
    limit = 100,
  ): Promise<Record<string, unknown>> {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const snapshot = this.resolveMachine(await this.snapshots(), machineId);
    const tasks: Array<Record<string, unknown>> = [];

    for (const incident of snapshot.incidents) {
      const repairTasks = Array.isArray(incident.repairTasks) ? incident.repairTasks : [];
      for (const task of repairTasks) {
        if (task && typeof task === "object" && !Array.isArray(task)) {
          tasks.push({
            ...(task as Record<string, unknown>),
            incident_id: incident.id,
            incident_number: incident.logNumber ?? incident.number,
            incident_summary: incident.summary,
            state: incident.state,
          });
        }
      }
    }

    tasks.sort((a, b) => {
      const da = parseIsoDate(a.createdAt)?.getTime() ?? Number.NEGATIVE_INFINITY;
      const db = parseIsoDate(b.createdAt)?.getTime() ?? Number.NEGATIVE_INFINITY;
      return db - da;
    });

    return {
      machine_id: snapshot.id,
      count: Math.min(tasks.length, safeLimit),
      total: tasks.length,
      maintenance: tasks.slice(0, safeLimit),
      synced_at: snapshot.synced_at,
      snapshot_complete: snapshot.snapshot_complete,
    };
  }

  async compareMachines(
    machineIds: string[],
    now: Date = new Date(),
  ): Promise<Record<string, unknown>> {
    if (!Array.isArray(machineIds) || machineIds.length < 2) {
      throw new Error("Provide at least two machine identifiers");
    }
    if (machineIds.length > 20) {
      throw new Error("Compare at most 20 machines at once");
    }
    const snapshots = await this.snapshots();
    const selected = machineIds.map((item) => this.resolveMachine(snapshots, item));
    const uniqueIds = new Set(selected.map((item) => item.id));
    if (uniqueIds.size !== selected.length) {
      throw new Error("Machine identifiers must be unique");
    }
    const comparison = selected
      .map((item) => IncidentService.health(item, now))
      .sort(
        (a, b) =>
          a.health_score - b.health_score ||
          b.active_incident_count - a.active_incident_count ||
          b.recent_incident_count - a.recent_incident_count,
      );
    return {
      machines: comparison,
      least_healthy_machine_id: comparison[0].machine_id,
    };
  }

  async getMachineHealthScore(
    machineId: string,
    now: Date = new Date(),
  ): Promise<Record<string, unknown>> {
    const snapshot = this.resolveMachine(await this.snapshots(), machineId);
    return IncidentService.health(snapshot, now);
  }

  async getMachineRiskRanking(
    limit = 20,
    now: Date = new Date(),
  ): Promise<Record<string, unknown>> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const snapshots = await this.snapshots();
    const ranking = snapshots
      .map((snapshot) => IncidentService.health(snapshot, now))
      .sort(
        (a, b) =>
          a.health_score - b.health_score ||
          b.active_incident_count - a.active_incident_count ||
          b.recent_incident_count - a.recent_incident_count ||
          a.machine_id.localeCompare(b.machine_id),
      );
    return {
      count: Math.min(ranking.length, safeLimit),
      total: ranking.length,
      machines: ranking.slice(0, safeLimit),
    };
  }
}
