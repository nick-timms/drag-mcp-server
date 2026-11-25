/**
 * A tool result that is not JSON: text and images handed to the client as MCP
 * content blocks (a file's text, a picture for the client's model to read).
 * Every other tool result is still serialised as JSON text by the server.
 */

export type ToolContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const MARK = "__dragappToolContent" as const;

export interface ToolContent {
  [MARK]: true;
  content: ToolContentBlock[];
}

export function toolContent(content: ToolContentBlock[]): ToolContent {
  return { [MARK]: true, content };
}

export function isToolContent(value: unknown): value is ToolContent {
  return !!value && typeof value === "object" && (value as Record<string, unknown>)[MARK] === true;
}
