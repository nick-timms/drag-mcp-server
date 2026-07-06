import type { DragClient } from "../api/client.js";
import type { Tag } from "../api/types.js";
import { shapeTag } from "../api/shaping.js";

// v2 card-level tags. These are coloured labels attached to individual cards
// via the v2 API. The v1.18 API has a separate "shared labels" concept
// (see labels.ts) which operates on email threads at the board level.
// TODO: verify if tags and shared labels are the same entity

export const tagTools = [
  {
    name: "list_tags",
    description:
      "List all tags (coloured labels) available on a DragApp board. Tags are used to categorise and filter cards. For email thread labels, use list_labels instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        boardId: { type: "number", description: "The board ID" },
      },
      required: ["boardId"],
    },
  },
  {
    name: "add_tag_to_card",
    description:
      "Add a tag to a card. Use list_tags first to find available tag IDs for the board.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cardId: { type: "number", description: "The card ID" },
        tagId: { type: "string", description: "The tag ID to add" },
      },
      required: ["cardId", "tagId"],
    },
  },
];

export async function handleTagTool(
  client: DragClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "list_tags": {
      const tags = await client.get<Tag[]>("/v2/tag", {
        BoardId: args.boardId as number,
      });
      return tags.map(shapeTag);
    }
    case "add_tag_to_card": {
      return client.post(`/v2/card/${args.cardId}/tags`, {
        TagId: args.tagId,
      });
    }
    default:
      throw new Error(`Unknown tag tool: ${name}`);
  }
}
