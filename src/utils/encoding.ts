/**
 * UTF-8-safe base64 encoder matching the extension's specialEncoder:
 *   btoa(unescape(encodeURIComponent(str)))
 * The backend stores task/card titles as base64 and decodes them on read.
 */
export function encodeTitleForCreate(title: string): string {
  return Buffer.from(title, "utf-8").toString("base64");
}

/** Strip HTML tags and collapse whitespace for the contentPlain article field. */
export function stripHtmlToPlain(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Convert ISO-8601 to the `YYYY-MM-DD HH:mm:ss` format the SaveDueDate
 * validator expects (joi-date-extensions with that exact format string).
 */
export function isoToBackendDueDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${iso}`);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}
