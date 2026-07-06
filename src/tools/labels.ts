import type { DragClient } from "../api/client.js";
import type { LabelsResponse } from "../api/types.js";
import { shapeLabel } from "../api/shaping.js";

export const labelTools = [
  {
    name: "list_labels",
    description:
      "List all shared labels on a board. Labels are coloured markers used to categorise and filter email threads across the team.",
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
    name: "add_label_to_thread",
    description:
      "Add a shared label to an email thread (or task). Use list_labels first to find available label IDs for the board.",
    inputSchema: {
      type: "object" as const,
      properties: {
        threadId: {
          type: "string",
          description: "The thread or task ID to label",
        },
        labelId: {
          type: "number",
          description: "The label ID to assign",
        },
        boardId: {
          type: "number",
          description: "The board ID the thread belongs to",
        },
      },
      required: ["threadId", "labelId", "boardId"],
    },
  },
  {
    name: "remove_label_from_thread",
    description:
      "Remove a shared label from an email thread (or task).",
    inputSchema: {
      type: "object" as const,
      properties: {
        threadId: {
          type: "string",
          description: "The thread or task ID to remove the label from",
        },
        labelId: {
          type: "number",
          description: "The label ID to remove",
        },
        boardId: {
          type: "number",
          description: "The board ID the thread belongs to",
        },
      },
      required: ["threadId", "labelId", "boardId"],
    },
  },
  {
    name: "toggle_labels",
    description:
      "Add some labels and/or remove others from a thread in one call. The backend toggle endpoint is one-label-at-a-time, so this iterates internally.",
    inputSchema: {
      type: "object" as const,
      properties: {
        threadId: {
          type: "string",
          description: "The thread or task ID",
        },
        boardId: {
          type: "number",
          description: "The board ID the thread belongs to",
        },
        addLabelIds: {
          type: "array",
          items: { type: "number" },
          description: "Label IDs to add",
        },
        removeLabelIds: {
          type: "array",
          items: { type: "number" },
          description: "Label IDs to remove",
        },
      },
      required: ["threadId", "boardId"],
    },
  },
];

interface ToggleArgs {
  boardId: number;
  threadId: string;
  labelId: number;
  remove: boolean;
}

function toggleLabel(client: DragClient, { boardId, threadId, labelId, remove }: ToggleArgs) {
  // Backend validator (ToggleLabelsValidationSchema):
  //   { tagId: number, boardId: number, isEveryCardAssigned: boolean, entitiesIds: (string|number)[] }
  // isEveryCardAssigned=true → remove from all entities; false → add to all.
  return client.post("/v1.18/sharedLabel/toggle-labels", {
    tagId: labelId,
    boardId,
    isEveryCardAssigned: remove,
    entitiesIds: [threadId],
  });
}

export async function handleLabelTool(
  client: DragClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "list_labels": {
      const response = await client.get<LabelsResponse>("/v1.18/sharedLabel/list", {
        BoardId: args.boardId as number,
      });
      return response.list.map(shapeLabel);
    }
    case "add_label_to_thread": {
      // /sharedLabel/assign requires EntityIds as a JSON-stringified array
      // plus EntityType ("THREAD"/"TASK") which the caller doesn't know.
      // /toggle-labels handles both add and remove uniformly.
      return toggleLabel(client, {
        boardId: args.boardId as number,
        threadId: args.threadId as string,
        labelId: args.labelId as number,
        remove: false,
      });
    }
    case "remove_label_from_thread": {
      // /sharedLabel/remove-assigned-label-new needs EntityLabelId (the
      // junction-table row id), which the caller doesn't have. /toggle-labels
      // looks it up internally from (entitiesIds, tagId, boardId).
      return toggleLabel(client, {
        boardId: args.boardId as number,
        threadId: args.threadId as string,
        labelId: args.labelId as number,
        remove: true,
      });
    }
    case "toggle_labels": {
      const boardId = args.boardId as number;
      const threadId = args.threadId as string;
      const addLabelIds = (args.addLabelIds as number[] | undefined) ?? [];
      const removeLabelIds = (args.removeLabelIds as number[] | undefined) ?? [];

      const results = await Promise.all([
        ...addLabelIds.map((labelId) =>
          toggleLabel(client, { boardId, threadId, labelId, remove: false }),
        ),
        ...removeLabelIds.map((labelId) =>
          toggleLabel(client, { boardId, threadId, labelId, remove: true }),
        ),
      ]);
      return { added: addLabelIds, removed: removeLabelIds, results };
    }
    default:
      throw new Error(`Unknown label tool: ${name}`);
  }
}
