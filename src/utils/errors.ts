import { DragApiError } from "../api/client.js";

export function normaliseError(err: unknown): { error: string; code: number } {
  if (err instanceof DragApiError) {
    return { error: err.message, code: err.code };
  }
  if (err instanceof Error) {
    return { error: err.message, code: 500 };
  }
  return { error: "Unknown error", code: 500 };
}
