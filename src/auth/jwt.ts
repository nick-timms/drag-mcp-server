import { DragClient } from "../api/client.js";

/** Create a DragClient from a Drag API token. Get yours from https://app.dragapp.com → Settings → Integrations. */
export function createClientFromToken(token: string): DragClient {
  if (!token || token.trim() === "") {
    throw new Error("DRAG_API_KEY is required. Get yours from https://app.dragapp.com/settings");
  }
  return new DragClient(token);
}
