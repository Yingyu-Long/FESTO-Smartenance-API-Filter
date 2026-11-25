import { translate, type Language } from "./i18n.ts";
import type { CustomFieldValue, Filters, IncidentState, IncidentStateFilter, RepairResult, RepairRow } from "./types.ts";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const INCIDENT_STATE_OPTIONS = ["All", "Open", "InWork", "Closed"] as const;
export const incidentStateLabels: Record<IncidentStateFilter, string> = {
  All: "All statuses",
  Open: "Open",
  InWork: "In progress (InWork)",
  Closed: "Closed",
};
export function isIncidentState(value: unknown): value is IncidentState {
  return value === "Open" || value === "InWork" || value === "Closed";
}
/** Reuse a complete snapshot only inside its machine/date/state coverage. */
export function filterExistingResult(source: RepairResult | null, filters: Filters): RepairResult | null {
  if (!source || !filters.machineIds.length ||
    (source.filters.incidentState !== "All" && source.filters.incidentState !== filters.incidentState)) return null;
  let bounds: ReturnType<typeof dateBounds>;
  try {
    bounds = dateBounds(filters.from, filters.to);
    const coverage = dateBounds(source.filters.from, source.filters.to);
    if (bounds.start < coverage.start || bounds.end > coverage.end) return null;
  } catch { return null; }
  const machines = new Set(source.filters.machineIds);
  if (filters.machineIds.some((id) => !machines.has(id))) return null;
  const selected = new Set(filters.machineIds);
  return {
    rows: source.rows.filter((row) => {
      const created = Date.parse(row.createdAt);
      return selected.has(row.machineId) && created >= bounds.start && created < bounds.end &&
        (filters.incidentState === "All" || row.incidentState === filters.incidentState);
    }),
    scanned: source.scanned,
    fetchedAt: source.fetchedAt,
    retrieval: source.retrieval,
    filters: { ...filters, machineIds: [...filters.machineIds] },
  };
}
const DAY = 86400000;
export function dateBounds(from: string, to: string) {
  function parse(value: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Select valid start and end dates.");
    const utc = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== value)
      throw new Error("This date does not exist. Choose another date.");
    return utc - 8 * 3600000;
  }
  const start = parse(from),
    end = parse(to) + DAY;
  if (start >= end) throw new Error("The start date cannot be after the end date.");
  return { start, end };
}
export function validateFilters(value: unknown): Filters {
  const v = value as Partial<Filters> | null;
  if (
    !v ||
    !Array.isArray(v.machineIds) ||
    !v.machineIds.length ||
    !v.machineIds.every((id) => typeof id === "string" && UUID.test(id))
  )
    throw new Error("Select at least one valid machine.");
  if (typeof v.from !== "string" || typeof v.to !== "string")
    throw new Error("Select a start and end date.");
  // Match the page default when clients omit the status filter.
  const incidentState = v.incidentState === undefined ? "All" : v.incidentState;
  if (incidentState !== "All" && !isIncidentState(incidentState))
    throw new Error("Select a valid incident status.");
  dateBounds(v.from, v.to);
  return { machineIds: [...new Set(v.machineIds)], from: v.from, to: v.to, incidentState };
}
export function chinaDate(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
export function formatTime(value: string) {
  if (!value) return "";
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Date(time + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ")
    : value;
}
export const resultLabels: Record<string, string> = {
  Unknown: "Not recorded",
  Success: "Success",
  Failure: "Failure",
};
export const CSV_COLUMNS: {
  key: Exclude<keyof RepairRow, "customFields">;
  label: string;
  time?: boolean;
}[] = [
  { key: "machineName", label: "Machine name" },
  { key: "machineNumber", label: "Machine number" },
  { key: "machineId", label: "Machine ID" },
  { key: "incidentNumber", label: "Incident number" },
  { key: "incidentId", label: "Incident ID" },
  { key: "incidentSummary", label: "Incident summary" },
  { key: "incidentState", label: "Incident status" },
  {
    key: "incidentOccurredAt",
    label: "Incident occurred at (UTC+8)",
    time: true,
  },
  { key: "incidentFixedAt", label: "Incident fixed at (UTC+8)", time: true },
  { key: "incidentDescription", label: "Incident description" },
  { key: "incidentCause", label: "Incident cause" },
  { key: "taskId", label: "Repair task ID" },
  { key: "description", label: "Repair task description" },
  { key: "result", label: "Repair result" },
  { key: "createdAt", label: "Task created at (UTC+8)", time: true },
  { key: "createdBy", label: "Task created by" },
  { key: "modifiedAt", label: "Task modified at (UTC+8)", time: true },
  { key: "modifiedBy", label: "Task modified by" },
  { key: "comments", label: "Task comments (JSON)" },
  { key: "repairContent", label: "Repair content" },
  { key: "repairTime", label: "Repair time" },
  { key: "repairLaborHours", label: "Repair labor hours" },
  { key: "downtime", label: "Downtime" },
  { key: "repairRemarks", label: "Remarks" },
  { key: "repairOwner", label: "Repair owner" },
  { key: "repairCollaborators", label: "Collaborators" },
];
export function csvCell(value: string) {
  // Quoting alone does not stop spreadsheet formula execution.
  const safe =
    /^[\s\p{Cc}]*[=+\-@＝＋－＠]/u.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function customFieldKey(field: CustomFieldValue) {
  return `custom:${field.scope}:${encodeURIComponent(field.id)}`;
}
export function customFieldLabel(field: CustomFieldValue, language: Language) {
  const scope = language === "zh"
    ? field.scope === "incident" ? "故障" : "维修任务"
    : field.scope === "incident" ? "Incident" : "Repair task";
  return `${scope} · ${language === "zh" && field.labelZh ? field.labelZh : field.label}`;
}
export function customFieldColumns(rows: RepairRow[], language: Language = "zh") {
  const fields = new Map<string, CustomFieldValue>();
  for (const row of rows) for (const field of row.customFields ?? []) {
    const key = customFieldKey(field);
    if (!fields.has(key)) fields.set(key, field);
  }
  const columns = [...fields].map(([key, field]) => ({ key, label: customFieldLabel(field, language) }));
  const labels = new Map<string, number>();
  for (const column of columns) labels.set(column.label, (labels.get(column.label) ?? 0) + 1);
  // Distinct IDs with the same label must remain distinguishable to the customer.
  return columns.map((column) => ({ ...column,
    label: labels.get(column.label)! > 1 ? `${column.label} (${fields.get(column.key)!.id})` : column.label,
  }));
}
export function toCsv(rows: RepairRow[], _language: Language = "zh", customColumns = customFieldColumns(rows, "zh")) {
  const csvLanguage: Language = "zh";
  return (
    "\uFEFF" +
    [
      [...CSV_COLUMNS.map((c) => csvCell(translate(c.label, csvLanguage))),
        ...customColumns.map((c) => csvCell(c.label))].join(","),
      ...rows.map((row) => {
        const custom = new Map((row.customFields ?? []).map((field) => [customFieldKey(field), field.value]));
        return [...CSV_COLUMNS.map((c) =>
          csvCell(
            c.time
              ? formatTime(row[c.key])
              : c.key === "result"
                ? translate(resultLabels[row.result] ?? row.result, csvLanguage)
                : row[c.key],
          ),
        ), ...customColumns.map((c) => csvCell(custom.get(c.key) ?? ""))].join(",");
      }),
    ].join("\r\n") +
    "\r\n"
  );
}
