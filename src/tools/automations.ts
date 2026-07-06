import type { DragClient } from "../api/client.js";
import type { Automation } from "../api/types.js";
import { shapeAutomation } from "../api/shaping.js";

export const automationTools = [
  {
    name: "list_automations",
    description:
      "List all automations configured on a board. Shows automation name, trigger type, actions, and whether each is active. Returns an empty array if no automations exist.",
    inputSchema: {
      type: "object" as const,
      properties: {
        boardId: {
          type: "number",
          description: "The board ID",
        },
      },
      required: ["boardId"],
    },
  },
  {
    name: "toggle_automation",
    description:
      "Activate or deactivate a board automation. Pass active=true to enable or active=false to disable.",
    inputSchema: {
      type: "object" as const,
      properties: {
        automationId: {
          type: "number",
          description: "The automation ID",
        },
        boardId: {
          type: "number",
          description: "The board the automation belongs to (required by the API)",
        },
        active: {
          type: "boolean",
          description: "true to activate, false to deactivate",
        },
      },
      required: ["automationId", "boardId", "active"],
    },
  },
  {
    name: "toggle_ai_drafts",
    description:
      "Enable or disable AI-generated draft replies for a board. When enabling, you must choose a category: 'automatic' (drafts created without prompting) or 'manual' (drafts created on demand).",
    inputSchema: {
      type: "object" as const,
      properties: {
        boardId: {
          type: "number",
          description: "The board ID",
        },
        enabled: {
          type: "boolean",
          description: "true to enable AI drafts, false to disable",
        },
        category: {
          type: "string",
          enum: ["automatic", "manual"],
          description: "Required when enabling. Defaults to 'automatic'.",
        },
      },
      required: ["boardId", "enabled"],
    },
  },
];

export async function handleAutomationTool(
  client: DragClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "list_automations": {
      const result = await client.post<Automation[] | false>(
        "/v1.18/teamBoard/automation/list",
        { boardId: args.boardId },
      );
      if (result === false || !Array.isArray(result)) {
        return [];
      }
      return result.map(shapeAutomation);
    }
    case "toggle_automation": {
      // Validator: { automationId: number, boardId: number } (both lowercase,
      // both required). The previous PascalCase keys silently failed validation.
      const endpoint = args.active
        ? "/v1.18/teamBoard/automation/activate"
        : "/v1.18/teamBoard/automation/deactivate";
      return client.put(endpoint, {
        automationId: args.automationId,
        boardId: args.boardId,
      });
    }
    case "toggle_ai_drafts": {
      // Validator: { boardId, enabled, category? } — all lowercase. `category`
      // is required when `enabled: true`. Default to 'automatic' if missing.
      const body: Record<string, unknown> = {
        boardId: args.boardId,
        enabled: args.enabled,
      };
      if (args.enabled) {
        body.category = (args.category as string | undefined) ?? "automatic";
      }
      return client.post("/v1.18/ai/drafts", body);
    }
    default:
      throw new Error(`Unknown automation tool: ${name}`);
  }
}
