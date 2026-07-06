import type { DragClient } from "../api/client.js";
import type { Comment } from "../api/types.js";
import { shapeComment } from "../api/shaping.js";

export const commentTools = [
  {
    name: "add_comment",
    description:
      "Add a comment to a card. Comments are internal team messages attached to cards, visible to all board members.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cardId: { type: "string", description: "The card ID to comment on" },
        body: { type: "string", description: "Comment text" },
      },
      required: ["cardId", "body"],
    },
  },
  {
    name: "get_comment",
    description: "Retrieve a specific comment by its ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        commentId: { type: "number", description: "The comment ID" },
      },
      required: ["commentId"],
    },
  },
];

export async function handleCommentTool(
  client: DragClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "add_comment": {
      // Accept both "body" (schema name) and "content" (common model guess)
      const commentBody = (args.body ?? args.content) as string;
      const result = await client.post<{ CommentDetails: Comment }>("/v2/comment", {
        CardId: args.cardId,
        Body: commentBody,
      });
      return shapeComment(result.CommentDetails);
    }
    case "get_comment": {
      const comment = await client.get<Comment>(`/v2/comment/${args.commentId}`);
      return shapeComment(comment);
    }
    default:
      throw new Error(`Unknown comment tool: ${name}`);
  }
}
