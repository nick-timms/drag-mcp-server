import { DragApiError } from "../api/client.js";

/**
 * The plain sentence inside an API error. DragClient's errors read
 * "Drag API error: <status> — <body>"; when the body is JSON with a `message`
 * (or `Error` string), that sentence is what the user should see.
 */
export function apiErrorMessage(err: unknown): string | null {
  if (!(err instanceof DragApiError)) return null;
  const dash = err.message.indexOf("— ");
  const body = dash >= 0 ? err.message.slice(dash + 2) : "";
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    for (const key of ["message", "Error", "error"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch {
    // not JSON
  }
  return null;
}

/** The parsed JSON body of an API error, or null. */
export function apiErrorBody(err: unknown): Record<string, unknown> | null {
  if (!(err instanceof DragApiError)) return null;
  const dash = err.message.indexOf("— ");
  if (dash < 0) return null;
  try {
    const parsed = JSON.parse(err.message.slice(dash + 2));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Re-throw an API error with its own sentence as the message, keeping the status. */
export function rethrowWithApiMessage(err: unknown, fallback?: string): never {
  if (err instanceof DragApiError) {
    const message = apiErrorMessage(err) ?? fallback;
    if (message) throw new DragApiError(message, err.code);
  }
  throw err;
}
