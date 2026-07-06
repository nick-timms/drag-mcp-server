import type { DragClient } from "../api/client.js";
import type { Card } from "../api/types.js";
import { shapeCardCompact } from "../api/shaping.js";
import { withPagination } from "../utils/pagination.js";
import { encodeTitleForCreate, isoToBackendDueDate } from "../utils/encoding.js";

export const cardTools = [
  {
    name: "list_cards_in_column",
    description:
      "List all cards in a specific column of a DragApp board. Supports pagination. Cards are email threads or tasks with titles, assignees, due dates, and custom fields.",
    inputSchema: {
      type: "object" as const,
      properties: {
        boardId: { type: "number", description: "The board ID" },
        columnId: { type: "number", description: "The column ID" },
        page: { type: "number", description: "Page number (default: 1)" },
        limit: { type: "number", description: "Cards per page (default: 10)" },
      },
      required: ["boardId", "columnId"],
    },
  },
  {
    name: "get_card",
    description:
      "Get full details of a card (task or email thread) by ID. Returns title, status, assignees, due date, column, board, note, and timestamps.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cardId: {
          type: "string",
          description: "The card ID. Numeric task IDs and hex thread IDs both work.",
        },
        boardId: {
          type: "number",
          description: "Optional board ID. Speeds up the lookup; not required.",
        },
      },
      required: ["cardId"],
    },
  },
  {
    name: "create_card",
    description:
      "Create a new card (task) on a DragApp board. You can set the title, assign it to a team member, and add a note or comment.",
    inputSchema: {
      type: "object" as const,
      properties: {
        boardId: { type: "number", description: "Board to add the card to" },
        columnId: {
          type: "string",
          description: "Column ID string (e.g. 'Label_1') — use list_columns to find it",
        },
        title: { type: "string", description: "Card title" },
        assignee: {
          type: "string",
          description: "Email address of an assignee (single email).",
        },
        note: { type: "string", description: "Note to add to the card" },
        comment: { type: "string", description: "Comment to add to the card" },
      },
      required: ["boardId", "columnId", "title"],
    },
  },
  {
    name: "update_card",
    description:
      "Update an existing card. Change the title, reassign, add a note, set a due date, or change status. Comments cannot be modified via this tool.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cardId: { type: "string", description: "The card ID to update" },
        boardId: { type: "number", description: "Board the card belongs to" },
        columnId: {
          type: "string",
          description: "Column the card is in (string column ID like 'Label_1')",
        },
        title: { type: "string", description: "New card title" },
        assignee: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          description: "Assignee email(s). Single string or array of strings.",
        },
        note: { type: "string", description: "New note body" },
        dueDate: {
          type: "string",
          description: "Due date in ISO-8601 (e.g. 2026-05-20T00:00:00.000Z)",
        },
        status: {
          type: "string",
          enum: ["read", "unread", "OPEN", "PENDING", "CLOSED"],
          description: "Card status",
        },
        color: { type: "string", description: "Card color code" },
      },
      required: ["cardId"],
    },
  },
  {
    name: "move_card",
    description:
      "Move a card to a different column on the same board, or to another board. newColumnId is the label-style column ID like 'Label_1' (returned by list_columns).",
    inputSchema: {
      type: "object" as const,
      properties: {
        cardId: { type: "string", description: "The card ID to move" },
        newColumnId: {
          type: "string",
          description: "Target column ID (label-style string, e.g. 'Label_2'). Get it from list_columns.",
        },
        newBoardId: {
          type: "number",
          description: "Target board ID. Required for cross-board moves; auto-resolved from the card's current board when omitted.",
        },
        newPosition: {
          type: "number",
          description: "Position in the target column (0 = top, default 0)",
        },
      },
      required: ["cardId", "newColumnId"],
    },
  },
  {
    name: "archive_card",
    description: "Archive (delete) a card from a DragApp board.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cardId: { type: "number", description: "The card ID to archive" },
      },
      required: ["cardId"],
    },
  },
];

/**
 * Task IDs are numeric with length < 15.
 * Email/thread IDs are hex strings of ~16 chars; task IDs are short integers.
 * WhatsApp card IDs are "<id>-<phoneNumber>" — the only ID form with a dash.
 */
function entityTypeFor(cardId: string | number): "0" | "1" | "3" {
  const s = String(cardId);
  if (s.includes("-")) return "3";
  const isTask = /^\d+$/.test(s) && s.length < 15;
  return isTask ? "1" : "0";
}

/**
 * Accept either a label-style column ID ("Label_1", "Label_9726643905") or
 * a plain numeric column index (1, "1") and coerce to the label form the
 * backend expects. The board's `taskModel.SaveTask` happily writes whatever
 * string it's given to `Teamboard_Task.ColumnId`, so passing the bare number
 * "1" yields a row that never matches a real column and never appears in
 * the UI.
 */
function normalizeColumnId(columnId: unknown): string {
  if (typeof columnId === "number") return `Label_${columnId}`;
  if (typeof columnId === "string") {
    if (/^\d+$/.test(columnId)) return `Label_${columnId}`;
    return columnId;
  }
  throw new Error(`Invalid columnId: ${JSON.stringify(columnId)}`);
}

interface DetailPageResponse {
  Title?: string;
  Note?: string;
  Color?: string;
  ColumnId?: string;
  BoardId?: number;
  CreatedAt?: string;
  Starred?: number;
  Status?: number;
  CardStatus?: string;
  Snoozed?: number;
  DueDate?: string | null;
  Duration?: number | null;
  Emails?: unknown[];
  ContactDetails?: unknown;
  Error?: boolean;
  Success?: boolean;
}

interface AssigneesResponse {
  Response?: { Assignees?: string };
  Assignees?: string;
}

function parseAssignees(raw: AssigneesResponse | null | undefined): string[] {
  if (!raw) return [];
  const json = raw.Response?.Assignees ?? raw.Assignees;
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function handleCardTool(
  client: DragClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "list_cards_in_column": {
      const pagination = withPagination({
        page: args.page as number | undefined,
        limit: args.limit as number | undefined,
      });
      const cards = await client.get<Card[]>(
        `/v2/board/${args.boardId}/column/${args.columnId}/cards`,
        pagination,
      );
      return cards.map(shapeCardCompact);
    }
    case "get_card": {
      // The v2 /v2/card/:id GET path only returns
      // { Id, Title, Note, BoardId } — assignees, dueDate, createdAt all
      // come back null. The v1.18 detail-page endpoint exposes the full
      // record, and a parallel call to GetEmailAssignees fills in the
      // assignees array (stored as a JSON string in the Checklist tables).
      const cardId = String(args.cardId);
      const entityType = entityTypeFor(cardId);

      const params: Record<string, string | number> = {
        entityId: cardId,
        entityType,
        skipUpdateReadStatus: "true",
      };
      if (args.boardId !== undefined) params.boardId = args.boardId as number;

      const [detail, assignees] = await Promise.all([
        client.get<DetailPageResponse>("/v1.18/entityConversation/detail-page", params),
        client
          .get<AssigneesResponse>("/v1.18/checklistComment/GetEmailAssignees", {
            threadId: cardId,
          })
          .catch(() => null),
      ]);

      return {
        id: cardId,
        title: detail.Title ?? null,
        boardId: detail.BoardId ?? null,
        columnId: detail.ColumnId ?? null,
        note: detail.Note ?? null,
        color: detail.Color ?? null,
        createdAt: detail.CreatedAt ?? null,
        dueDate: detail.DueDate ?? null,
        duration: detail.Duration ?? null,
        starred: detail.Starred === 1,
        status: detail.Status ?? null,
        cardStatus: detail.CardStatus ?? null,
        snoozed: detail.Snoozed ?? null,
        assignees: parseAssignees(assignees),
        entityType,
      };
    }
    case "create_card": {
      // Use /v1.18/task/create directly (matches what the extension does).
      // Pre-encoding the title means v2 GET (which base64-decodes) renders it.
      // columnId is normalized: "1" or 1 -> "Label_1". The backend stores the
      // raw value, so a bare numeric ID produces a ghost row that never
      // appears in any column (see Bug L1).
      const body: Record<string, unknown> = {
        boardId: args.boardId,
        columnId: normalizeColumnId(args.columnId),
        taskName: encodeTitleForCreate(args.title as string),
      };
      if (args.assignee) {
        const a = args.assignee;
        body.assignee = Array.isArray(a) ? (a as string[])[0] : a;
      }
      if (args.note) body.note = args.note;
      if (args.comment) body.comment = args.comment;

      return client.post("/v1.18/task/create", body);
    }
    case "update_card": {
      // The v2 /v2/card/:id PUT (UpdateCard) calls cardModelV1.SaveTitle
      // *as a model* — it skips the controller-level socket broadcast that
      // /v1.18/card/save-title fires (ADD_AND_UPDATE_TASK). Without that
      // event, every open client keeps the cached title until manual reload
      // (Bug L2). For title-only/title-plus-other updates, route the title
      // through /save-title so the board list view live-updates.
      const cardId = String(args.cardId);
      const entityType = entityTypeFor(cardId);
      const results: Record<string, unknown> = {};

      const otherFieldsBody: Record<string, unknown> = {};
      if (args.boardId !== undefined) otherFieldsBody.boardId = args.boardId;
      if (args.columnId !== undefined) {
        otherFieldsBody.columnId = normalizeColumnId(args.columnId);
      }
      if (args.assignee !== undefined) otherFieldsBody.assignee = args.assignee;
      if (args.note !== undefined) otherFieldsBody.note = args.note;
      if (args.dueDate !== undefined) {
        otherFieldsBody.dueDate = isoToBackendDueDate(args.dueDate as string);
      }
      if (args.status !== undefined) otherFieldsBody.status = args.status;
      if (args.color !== undefined) otherFieldsBody.color = args.color;

      const hasOtherFields = Object.keys(otherFieldsBody).length > 0;

      if (hasOtherFields) {
        results.fieldUpdate = await client.put(`/v2/card/${cardId}`, otherFieldsBody);
      }

      if (args.title !== undefined) {
        // /save-title's validator requires boardId. Resolve it if the caller
        // didn't pass it (matches the get_card lookup path).
        let boardId = args.boardId as number | undefined;
        if (boardId === undefined) {
          const detail = await client.get<DetailPageResponse>(
            "/v1.18/entityConversation/detail-page",
            {
              entityId: cardId,
              entityType,
              skipUpdateReadStatus: "true",
            },
          );
          boardId = detail.BoardId;
        }
        if (boardId === undefined) {
          throw new Error(
            "Could not resolve boardId for title update; pass boardId explicitly.",
          );
        }
        results.titleUpdate = await client.post("/v1.18/card/save-title", {
          entityId: cardId,
          entityType,
          title: args.title,
          boardId,
        });
      }

      return results;
    }
    case "move_card": {
      // Use /v1.18/emailData/move directly. The v2 /v2/card/move-card
      // endpoint looks up columns by their numeric BoardColumnId, which
      // callers don't have — list_columns and move_thread both speak the
      // label-style "Label_N" ColumnId. v1 accepts those.
      const cardId = String(args.cardId);
      const entityType = entityTypeFor(cardId);

      let newBoardId = args.newBoardId as number | string | undefined;
      if (newBoardId === undefined) {
        // Auto-resolve the card's current board (matches the v2 controller's
        // behaviour) so callers can move within a board without specifying it.
        const detail = await client.get<DetailPageResponse>(
          "/v1.18/entityConversation/detail-page",
          {
            entityId: cardId,
            entityType,
            skipUpdateReadStatus: "true",
          },
        );
        if (!detail.BoardId) {
          throw new Error(
            "Could not resolve the card's current board; pass newBoardId explicitly.",
          );
        }
        newBoardId = detail.BoardId;
      }

      return client.post("/v1.18/emailData/move", {
        entityId: cardId,
        entityType,
        newColumnId: String(args.newColumnId),
        newBoardId: String(newBoardId),
        newPosition: String(args.newPosition ?? 0),
      });
    }
    case "archive_card": {
      return client.delete(`/v2/card/${args.cardId}`);
    }
    default:
      throw new Error(`Unknown card tool: ${name}`);
  }
}
