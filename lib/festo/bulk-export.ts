import { isIncidentState, UUID } from "./shared.ts";
import type { Incident, RepairTask } from "./types.ts";

// The published endpoint describes a blob URI but its schema describes an
// incident. Accept both representations; unknown formats use the regular API.
export class BulkExportUnsupported extends Error {
  constructor() {
    super("The bulk export format is not supported. Using the standard query.");
  }
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BulkExportUnsupported();
  return value as ObjectValue;
}
function optionalText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new BulkExportUnsupported();
  return value;
}
function userName(value: unknown): string | undefined {
  if (value == null || typeof value === "string") return optionalText(value);
  return optionalText(object(value).name);
}
function array(value: unknown): unknown[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new BulkExportUnsupported();
  return value;
}

export function parseBulkDocument(text: string): unknown {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (trimmed.startsWith("https://") && !/\s/.test(trimmed)) return trimmed;
  try { return JSON.parse(trimmed); }
  catch { throw new BulkExportUnsupported(); }
}

export function bulkDownloadUrl(value: unknown): URL | null {
  let uri: unknown = value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const item = value as ObjectValue;
    uri = item.uri ?? item.url ?? item.downloadUrl;
  }
  if (typeof uri !== "string") return null;
  let url: URL;
  try { url = new URL(uri); } catch { throw new BulkExportUnsupported(); }
  // Signed Azure blob links are fetched without the API bearer token. Never
  // fetch arbitrary URLs or follow redirects from a server-provided document.
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname) ||
      url.pathname === "/" || url.hash) throw new BulkExportUnsupported();
  return url;
}

export function bulkRecords(value: unknown): ObjectValue[] {
  let entries: unknown[];
  if (Array.isArray(value)) entries = value;
  else {
    const item = object(value);
    if ("items" in item) {
      entries = array(item.items);
      // Do not mistake a paged or truncated result for a complete export.
      if (item.total !== entries.length || (item.offset != null && item.offset !== 0) ||
          (item.count != null && item.count !== entries.length)) throw new BulkExportUnsupported();
    } else if (typeof item.id === "string" && "repairTasks" in item) entries = [item];
    else throw new BulkExportUnsupported();
  }
  return entries.map(object);
}

export function fieldDefinitions(value: unknown): Map<string, ObjectValue> {
  const definitions = new Map<string, ObjectValue>();
  if (!Array.isArray(value)) throw new BulkExportUnsupported();
  for (const entry of value) {
    const field = object(entry);
    if (typeof field.customFieldId !== "string" || !UUID.test(field.customFieldId))
      throw new BulkExportUnsupported();
    definitions.set(field.customFieldId, field);
  }
  return definitions;
}

function hasLabel(field: ObjectValue) {
  return [field.label, field.defaultLanguageLabel].some((v) => typeof v === "string" && v.trim());
}

export function needsFieldDefinitions(records: ObjectValue[]) {
  return records.some((record) => {
    const owners = [record, ...array(record.repairTasks).map(object)];
    return owners.some((owner) => owner.customFields != null && array(owner.customFields).some((value) => {
      const field = object(value);
      return field.isDeleted !== true && !hasLabel(field);
    }));
  });
}

export function normalizeBulkIncidents(
  records: ObjectValue[], machineId: string, definitions = new Map<string, ObjectValue>(),
): Incident[] {
  const seen = new Set<string>();
  function fields(value: unknown) {
    if (value == null) return [];
    return array(value).map((entry) => {
      const field = object(entry);
      if (field.isDeleted === true || hasLabel(field)) return field;
      const definition = definitions.get(String(field.customFieldId));
      if (!definition || !hasLabel(definition)) throw new BulkExportUnsupported();
      return { ...field, ...definition, value: field.value };
    });
  }
  function task(value: unknown): RepairTask {
    const item = object(value);
    if (typeof item.id !== "string" || !UUID.test(item.id) || typeof item.createdAt !== "string")
      throw new BulkExportUnsupported();
    const comments = item.comments == null ? [] : array(item.comments).map((value) => {
      const comment = object(value);
      return { ...comment, createdBy: userName(comment.createdBy) ?? null, modifiedBy: userName(comment.modifiedBy) ?? null };
    });
    const result = optionalText(item.result);
    if (result != null && !["Unknown", "Success", "Failure"].includes(result)) throw new BulkExportUnsupported();
    return {
      id: item.id, createdAt: item.createdAt,
      description: optionalText(item.description), result,
      createdBy: userName(item.createdBy), modifiedBy: userName(item.modifiedBy),
      modifiedAt: optionalText(item.modifiedAt), comments, customFields: fields(item.customFields),
    };
  }
  const result: Incident[] = [];
  for (const item of records) {
    if (typeof item.id !== "string" || !UUID.test(item.id) || seen.has(item.id)) throw new BulkExportUnsupported();
    seen.add(item.id);
    const owner = item.machineId ?? (item.machine ? object(item.machine).id : undefined);
    if (owner !== machineId) throw new BulkExportUnsupported();
    if (item.isDeleted === true) continue;
    if ((item.type != null && item.type !== "Incident") || !isIncidentState(item.state)) throw new BulkExportUnsupported();
    // Missing repairTasks is not evidence of an empty incident; fall back rather
    // than silently exporting an incomplete list. Explicit null means no tasks.
    const tasks = array(item.repairTasks).map(task);
    const number = item.logNumber ?? item.number;
    if (number != null && typeof number !== "number") throw new BulkExportUnsupported();
    result.push({
      id: item.id, machineId, type: "Incident", state: item.state,
      logNumber: number as number | undefined,
      summary: optionalText(item.summary), description: optionalText(item.description),
      cause: optionalText(item.cause), occurredAt: optionalText(item.occurredAt),
      createdAt: optionalText(item.createdAt), fixedDateTime: optionalText(item.fixedDateTime),
      repairTasks: tasks, customFields: fields(item.customFields),
    });
  }
  return result;
}
