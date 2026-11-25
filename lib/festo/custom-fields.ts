import { plainText } from "./plain-text.ts";
import type { CustomFieldValue } from "./types.ts";

const fields = {
  repairContent: ["维修内容", "Repair content", "Repair work", "Maintenance content"],
  repairTime: ["维修时间", "Repair time", "Repair duration", "Maintenance time"],
  repairLaborHours: ["维修工时", "Repair labor hours", "Repair labour hours", "Repair working hours", "Maintenance man-hours"],
  downtime: ["停机时间", "Downtime", "Machine downtime"],
  repairRemarks: ["备注", "Remarks", "Notes", "Comment"],
  repairOwner: ["维修负责人", "Repair owner", "Repair responsible", "Person responsible", "Responsible person", "Maintenance responsible"],
  repairCollaborators: ["协作人员", "Collaborators", "Assistants", "Supporting personnel"],
} as const;

const normalize = (value: string) => value.toLowerCase().replace(/[\s_\-:：()（）]/g, "");
const BUILTIN_REPAIR_ALIASES = new Set(
  Object.values(fields).flatMap((aliases) => aliases.map(normalize)),
);

function extractFieldLabels(field: Record<string, unknown>): string[] {
  const translations = field.translations && typeof field.translations === "object"
    ? Object.values(field.translations).map((item) =>
        item && typeof item === "object" ? (item as Record<string, unknown>).title : null)
    : [];
  return [field.label, field.defaultLanguageLabel, ...translations]
    .filter((label): label is string => typeof label === "string" && !!label.trim());
}

function isBuiltInRepairField(field: Record<string, unknown>): boolean {
  return extractFieldLabels(field).some((label) => BUILTIN_REPAIR_ALIASES.has(normalize(label)));
}

function readable(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return plainText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(readable).filter(Boolean).join("; ");
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of ["name", "label", "value"]) {
      if (object[key] != null) return readable(object[key]);
    }
    return Object.entries(object).map(([key, item]) => `${key}: ${readable(item)}`).join("; ");
  }
  return "";
}

export function repairCustomFields(values: unknown[] | null | undefined) {
  const result = Object.fromEntries(Object.keys(fields).map(key => [key, ""])) as Record<keyof typeof fields, string>;
  for (const value of values ?? []) {
    if (!value || typeof value !== "object") continue;
    const field = value as Record<string, unknown>;
    if (field.isDeleted === true) continue;
    // Match original and translated labels, independent of the requested API language.
    const labels = extractFieldLabels(field).map(normalize);
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      if (fields[key].some(alias => labels.includes(normalize(alias)))) {
        const text = readable(field.value);
        if (text) result[key] = result[key] ? `${result[key]}; ${text}` : text;
      }
    }
  }
  return result;
}

/** Retain customer-defined fields while skipping repair fields already mapped to built-in columns. */
export function allCustomFields(values: unknown[] | null | undefined, scope: CustomFieldValue["scope"]): CustomFieldValue[] {
  const result = new Map<string, CustomFieldValue>();
  for (const value of Array.isArray(values) ? values : []) {
    if (!value || typeof value !== "object") continue;
    const field = value as Record<string, unknown>;
    if (field.isDeleted === true) continue;
    if (scope === "repair" && isBuiltInRepairField(field)) continue;
    const labels = [field.label, field.defaultLanguageLabel]
      .filter((label): label is string => typeof label === "string" && !!label.trim());
    const id = typeof field.customFieldId === "string" && field.customFieldId
      ? field.customFieldId : labels[0];
    if (!id) continue;
    const translations = field.translations as Record<string, { title?: unknown }> | null;
    const explicitZh = translations?.ZH?.title ?? translations?.zh?.title;
    const chineseLabel = [explicitZh, field.defaultLanguageLabel, field.label]
      .find((candidate): candidate is string =>
        typeof candidate === "string" && !!candidate.trim() && /[\u4e00-\u9fff]/.test(candidate));
    const resolvedZh = typeof explicitZh === "string" && explicitZh.trim()
      ? plainText(explicitZh)
      : chineseLabel
        ? plainText(chineseLabel)
        : undefined;
    const text = readable(field.value);
    const previous = result.get(id);
    result.set(id, {
      id,
      scope,
      label: plainText(labels[0] ?? id),
      labelZh: resolvedZh ?? previous?.labelZh,
      value: previous?.value && text ? `${previous.value}; ${text}` : text || previous?.value || "",
    });
  }
  return [...result.values()];
}
