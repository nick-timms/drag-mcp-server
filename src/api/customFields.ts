import { DragApiError, type DragClient } from "./client.js";
import { cleanText } from "./addresses.js";

/**
 * CUSTOM FIELDS on cards (Plus plan and above).
 *
 * A board defines its fields (label, type, options); a card holds a value per
 * field. Values are written in the shapes the DragApp Chrome extension writes,
 * because that is what every client reads back:
 *   short-text, long-text, email, id, document-id -> string
 *   numeric                                       -> number
 *   phone-number, currency                        -> { country, value }
 *   dropdown-text, radio-select                   -> { selected }
 */

export interface CustomFieldDefinition {
  id: number;
  label: string;
  fieldType: string;
  options?: string[];
  defaultCountry?: string;
}

export interface CardCustomField {
  fieldId: number;
  name: string;
  type: string;
  value: unknown;
  options?: string[];
}

/** Parse a JSON object or array stored as text. Plain text such as "007" stays text. */
const parseJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

/** A stored value as people read it: a dropdown's choice as its text, everything else as stored. */
export function readableValue(raw: unknown): unknown {
  const value = parseJson(raw);
  if (value && typeof value === "object" && !Array.isArray(value) && "selected" in (value as Record<string, unknown>)) {
    return (value as { selected: unknown }).selected ?? null;
  }
  return value ?? null;
}

/**
 * The custom fields a board listing carries on each card (a JSON array of
 * { id, value, field: { label, fieldType, options } }), named and readable.
 * Entries without a field (the listing's "{}" placeholders) are dropped.
 */
export function shapeCustomFields(raw: unknown): CardCustomField[] {
  const list = parseJson(raw);
  if (!Array.isArray(list)) return [];
  const out: CardCustomField[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const field = parseJson(e.field) as Record<string, unknown> | null;
    const fieldId = Number(e.id ?? e.fieldId ?? (field && field.id));
    if (!field || typeof field !== "object" || !Number.isInteger(fieldId)) continue;
    out.push({
      fieldId,
      name: cleanText(field.label),
      type: cleanText(field.fieldType),
      value: readableValue(e.value),
      ...(Array.isArray(field.options) ? { options: field.options as string[] } : {}),
    });
  }
  return out;
}

const PLAN_MESSAGE = "Custom fields are part of DragApp's Plus plan and above, so they aren't available for this board.";

function planAware(err: unknown): never {
  if (err instanceof DragApiError && err.code === 402) throw new DragApiError(PLAN_MESSAGE, 402);
  throw err;
}

/** The board's field definitions. */
export async function listFieldDefinitions(client: DragClient, boardId: number): Promise<CustomFieldDefinition[]> {
  const rows = await client
    .get<CustomFieldDefinition[]>(`/v1.18/customField/list/${boardId}`, { boardId })
    .catch(planAware);
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: Number(row.id),
    label: cleanText(row.label),
    fieldType: cleanText(row.fieldType),
    ...(Array.isArray(row.options) ? { options: row.options } : {}),
    ...(row.defaultCountry ? { defaultCountry: row.defaultCountry } : {}),
  }));
}

interface EntityFieldRow {
  relationId: number;
  value: unknown;
  field: { id: number | string; label?: string; fieldType?: string; options?: string[] };
}

async function entityFieldRows(client: DragClient, boardId: number, entityId: string): Promise<EntityFieldRow[]> {
  const rows = await client
    .get<EntityFieldRow[]>(`/v1.18/customField/list/${boardId}/${encodeURIComponent(entityId)}`, { boardId })
    .catch(planAware);
  return Array.isArray(rows) ? rows : [];
}

/** One card's field values, named. Null when the plan has no custom fields or they can't be read. */
export async function cardCustomFields(client: DragClient, boardId: number, entityId: string): Promise<CardCustomField[] | null> {
  try {
    const rows = await entityFieldRows(client, boardId, entityId);
    return rows
      .filter((row) => row && row.field)
      .map((row) => ({
        fieldId: Number(row.field.id),
        name: cleanText(row.field.label),
        type: cleanText(row.field.fieldType),
        value: readableValue(row.value),
        ...(Array.isArray(row.field.options) ? { options: row.field.options } : {}),
      }));
  } catch {
    return null;
  }
}

/** The stored form of a value for a field, or an error saying what the field accepts. */
export function storedValue(field: CustomFieldDefinition, value: unknown, country?: string): unknown {
  const text = cleanText(typeof value === "object" && value !== null ? JSON.stringify(value) : value);
  const label = field.label || `field ${field.id}`;
  switch (field.fieldType) {
    case "numeric": {
      const number = Number(String(value).replace(/,/g, "").trim());
      if (!text || !Number.isFinite(number)) throw new DragApiError(`"${label}" is a number field; "${text}" is not a number.`, 400);
      return number;
    }
    case "phone-number":
    case "currency": {
      const code = cleanText(country) || cleanText(field.defaultCountry);
      if (!code) {
        throw new DragApiError(`"${label}" also needs the country, as a two-letter code (e.g. GB, US, BR). Pass it as country.`, 400);
      }
      if (!text) throw new DragApiError(`"${label}" needs a value.`, 400);
      return { country: code.toUpperCase(), value: text };
    }
    case "dropdown-text":
    case "radio-select": {
      const options = field.options ?? [];
      const chosen = options.find((option) => option.toLowerCase() === text.toLowerCase());
      if (!chosen) {
        throw new DragApiError(`"${label}" only accepts one of: ${options.join(", ") || "(no options defined)"}. "${text}" is not one of them.`, 400);
      }
      return { selected: chosen };
    }
    case "email": {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw new DragApiError(`"${label}" is an email field; "${text}" is not an email address.`, 400);
      return text;
    }
    default: {
      if (!text) throw new DragApiError(`"${label}" needs a value. To empty the field, pass clear: true.`, 400);
      return text;
    }
  }
}

/** Find a field by id or (case-insensitive) name. */
export function findField(fields: CustomFieldDefinition[], key: string | number): CustomFieldDefinition {
  const asNumber = Number(key);
  const byId = Number.isInteger(asNumber) ? fields.find((f) => f.id === asNumber) : undefined;
  const byName = fields.find((f) => f.label.toLowerCase() === String(key).trim().toLowerCase());
  const field = byId ?? byName;
  if (!field) {
    throw new DragApiError(
      `This board has no custom field "${key}". Its fields: ${fields.map((f) => `${f.label} (id ${f.id}, ${f.fieldType})`).join(", ") || "none"}.`,
      404,
    );
  }
  return field;
}

/** Set (or, with clear, empty) one field on one card. */
export async function setCardField(
  client: DragClient,
  boardId: number,
  entityId: string,
  field: CustomFieldDefinition,
  input: { value?: unknown; country?: string; clear?: boolean },
): Promise<{ fieldId: number; name: string; value: unknown }> {
  const current = (await entityFieldRows(client, boardId, entityId)).find((row) => Number(row.field?.id) === field.id);
  const path = (op: "assign" | "unassign") =>
    `/v1.18/customField/${op}/${field.id}/${encodeURIComponent(entityId)}?boardId=${encodeURIComponent(String(boardId))}`;

  if (input.clear) {
    if (current) {
      await client
        .put(path("unassign"), { boardId, fieldId: field.id, entityId, relationId: current.relationId })
        .catch(planAware);
    }
    return { fieldId: field.id, name: field.label, value: null };
  }

  const value = storedValue(field, input.value, input.country);
  await client
    .put(path("assign"), { boardId, fieldId: field.id, entityId, relationId: current?.relationId ?? null, value })
    .catch(planAware);
  return { fieldId: field.id, name: field.label, value: readableValue(value) };
}
