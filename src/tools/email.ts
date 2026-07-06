import type { DragClient } from "../api/client.js";
import type { FetchEmailDataResponse, DetailMessageResponse, SendEmailResponse, ThreadListItem } from "../api/types.js";
import { shapeBoardItem, shapeMessageDetail, shapeSendEmailResponse } from "../api/shaping.js";

export const emailTools = [
  {
    name: "list_threads",
    description:
      "List items in a specific column of a DragApp board. Call list_columns first to get column IDs — they are strings like \"Label_1\", not numbers. A column can mix three item types: email threads (have `threadId`/`from`/`subject`), task cards (have `cardId`/`title`/`status`), and WhatsApp conversations (have `cardId`/`contact`). Use `cardId` with get_card / update_card / move_card, or with the whatsapp tools for WhatsApp items.",
    inputSchema: {
      type: "object" as const,
      properties: {
        boardId: {
          type: "number",
          description: "The board ID to list threads from",
        },
        columnId: {
          type: "string",
          description: "The column ID string (e.g. \"Label_1\") — use list_columns to find available IDs",
        },
      },
      required: ["boardId", "columnId"],
    },
  },
  {
    name: "get_thread",
    description:
      "Get a single email message by ID. Returns the HTML body (and a plain-text version), sender, recipients, attachments, and reply-to info for composing a response. You can pass either messageId or threadId — they are the same value.",
    inputSchema: {
      type: "object" as const,
      properties: {
        boardId: {
          type: "number",
          description: "The board ID the message belongs to",
        },
        messageId: {
          type: "string",
          description: "The message/thread ID to retrieve (same value used for both)",
        },
        threadId: {
          type: "string",
          description: "Alias for messageId — use either one (they are interchangeable)",
        },
      },
      required: ["boardId"],
    },
  },
  {
    name: "reply_to_thread",
    description:
      "Reply to an existing email thread. Sent from the current user's connected Gmail address (the JWT owner). For single-message threads, threadId works as messageId. For multi-message threads, pass the specific messageId you're replying to — get_thread returns it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        threadId: {
          type: "string",
          description: "The thread ID to reply to",
        },
        boardId: {
          type: "number",
          description: "The board ID the thread belongs to",
        },
        to: {
          type: "string",
          description: "Recipient email address (use get_thread's replyTo.to or sender field)",
        },
        body: {
          type: "string",
          description: "HTML body of the reply",
        },
        messageId: {
          type: "string",
          description: "Specific message ID to reply to. Defaults to threadId, which is correct for threads with a single message.",
        },
        cc: {
          type: "string",
          description: "CC recipient email address",
        },
        bcc: {
          type: "string",
          description: "BCC recipient email address",
        },
      },
      required: ["threadId", "boardId", "to", "body"],
    },
  },
  {
    name: "send_new_email",
    description:
      "Compose and send a new email from a DragApp board's connected email address. Creates a new thread in the board.",
    inputSchema: {
      type: "object" as const,
      properties: {
        boardId: {
          type: "number",
          description: "The board to send from (determines the sender email address)",
        },
        to: {
          type: "string",
          description: "Recipient email address",
        },
        subject: {
          type: "string",
          description: "Email subject line",
        },
        body: {
          type: "string",
          description: "HTML body of the email",
        },
      },
      required: ["boardId", "to", "subject", "body"],
    },
  },
  {
    name: "search_threads",
    description:
      "Search items across a board by content or sender. Returns matches with preview snippets. Matches can be email threads (`threadId`), task cards (`cardId`/`title`), or WhatsApp conversations (`cardId`/`contact`). Note: search may return empty results on boards with very few items. Use filter_threads or list_threads as an alternative.",
    inputSchema: {
      type: "object" as const,
      properties: {
        boardId: {
          type: "number",
          description: "The board ID to search within",
        },
        query: {
          type: "string",
          description: "Search query text (must not be empty)",
        },
        searchBy: {
          type: "string",
          enum: ["content", "sender"],
          description: "Search by thread content (subject/body) or by sender email. Defaults to content.",
        },
      },
      required: ["boardId", "query"],
    },
  },
  {
    name: "filter_threads",
    description:
      "Filter email threads by criteria such as assignee, tags, or column. More targeted than search — use this when you know specific filter values.",
    inputSchema: {
      type: "object" as const,
      properties: {
        boardId: {
          type: "number",
          description: "The board ID to filter within",
        },
        columnId: {
          type: "string",
          description: "The column ID to filter within (required)",
        },
        assignees: {
          type: "array",
          items: { type: "string" },
          description: "Filter by assignee user IDs (as strings). Use \"-1\" for unassigned threads. Get user IDs from list_teams or list_board_members.",
        },
        tagList: {
          type: "array",
          items: { type: "string" },
          description: "Filter by shared label IDs (as strings). Use list_labels to get available label IDs.",
        },
      },
      required: ["boardId", "columnId"],
    },
  },
  {
    name: "move_thread",
    description:
      "Move an email thread to a different column or board. Use this to triage emails — e.g. move from Inbox to In Progress, or to a different team's board.",
    inputSchema: {
      type: "object" as const,
      properties: {
        threadId: {
          type: "string",
          description: "The thread/entity ID to move",
        },
        newBoardId: {
          type: "number",
          description: "Target board ID",
        },
        newColumnId: {
          type: "string",
          description: "Target column ID",
        },
        position: {
          type: "number",
          description: "Position in the target column (0 = top, default: 0)",
        },
      },
      required: ["threadId", "newBoardId", "newColumnId"],
    },
  },
  {
    name: "move_threads_bulk",
    description:
      "Move multiple email threads at once to a different column or board. Use this for batch triage operations.",
    inputSchema: {
      type: "object" as const,
      properties: {
        threadIds: {
          type: "array",
          items: { type: "string" },
          description: "Array of thread IDs to move",
        },
        newBoardId: {
          type: "number",
          description: "Target board ID",
        },
        newColumnId: {
          type: "string",
          description: "Target column ID",
        },
      },
      required: ["threadIds", "newBoardId", "newColumnId"],
    },
  },
];

/**
 * Extract threads from a FetchEmailDataResponse, flattening all label keys.
 * Response shape: { "Label_1": { threadId1: {...}, threadId2: {...} } }
 * Each label value is an object keyed by threadId, NOT an array.
 */
function extractThreads(data: FetchEmailDataResponse): ThreadListItem[] {
  const threads: ThreadListItem[] = [];
  if (data.Response && typeof data.Response === "object") {
    for (const labelThreads of Object.values(data.Response)) {
      if (labelThreads && typeof labelThreads === "object") {
        threads.push(...Object.values(labelThreads));
      }
    }
  }
  return threads;
}

export async function handleEmailTool(
  client: DragClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "list_threads": {
      // v1.18 fetch returns { Response: { "Label_1": { threadId: {...} } }, Success, isEmail }
      // Response keys are column labels; values are objects keyed by threadId
      const data = await client.get<FetchEmailDataResponse>(
        "/v1.18/teamBoard/emailData/fetch",
        {
          boardId: args.boardId as number,
          columnId: args.columnId as string,
        },
      );
      return extractThreads(data).map(shapeBoardItem);
    }
    case "get_thread": {
      // threadId in query string, boardId + messageId in POST body
      // messageId and threadId are the same value — accept either
      const id = (args.messageId ?? args.threadId) as string | undefined;
      if (!id) {
        throw new Error("Either messageId or threadId is required");
      }
      const response = await client.post<DetailMessageResponse>(
        "/v1.18/entityConversation/detail-message",
        { boardId: args.boardId, messageId: id },
        { threadId: id },
      );
      return shapeMessageDetail(response.Response);
    }
    case "reply_to_thread": {
      // The canonical reply endpoint is /entityConversation/send-as-email-content.
      // The older /send-email-content has the same intent but exhibits a long
      // hang on some accounts; switching endpoints unblocks the call.
      // Empty `from` + `fromName` makes the backend resolve the sender from
      // the JWT and look up the default sendAs.
      const threadId = args.threadId as string;
      const messageId = (args.messageId as string | undefined) ?? threadId;
      const replyBody: Record<string, unknown> = {
        threadId,
        boardId: args.boardId,
        messageId,
        emailType: "reply",
        to: args.to,
        emailContent: args.body,
        subject: "",
        from: "",
        fromName: "",
        sentByBoardMemberEmail: null,
        draftId: null,
        // Backend expects these as strings, not booleans
        isNewSubject: "false",
        isExtension: "false",
      };
      if (args.cc) replyBody.cc = args.cc;
      if (args.bcc) replyBody.bcc = args.bcc;

      const response = await client.post<SendEmailResponse>(
        "/v1.18/entityConversation/send-as-email-content",
        replyBody,
      );
      return shapeSendEmailResponse(response);
    }
    case "send_new_email": {
      // TODO: verify send_new_email endpoint params against live API
      return client.post("/v1.18/entityConversation/send-new-email", {
        boardId: args.boardId,
        to: args.to,
        subject: args.subject,
        body: args.body,
      });
    }
    case "search_threads": {
      const query = args.query as string;
      if (!query || query.trim() === "") {
        throw new Error("query must not be empty");
      }
      // Backend reads req.body fields with JSON.parse() — they must be sent
      // as JSON-stringified strings, not raw arrays/objects. The Joi validator
      // accepts JSON strings via auto-conversion, but req.body keeps the raw
      // string and the controller/SQL/ES service parses it itself.
      // key: "ThreadInfo" for content search, "MsgFrom" for sender search.
      // value: wrapped with % for SQL LIKE; the ES service strips % itself.
      const searchKey = args.searchBy === "sender" ? "MsgFrom" : "ThreadInfo";
      const data = await client.post<FetchEmailDataResponse>(
        "/v1.18/teamBoard/emailData/search-emails",
        {
          boardIds: JSON.stringify([args.boardId]),
          searchParams: JSON.stringify({
            key: searchKey,
            value: `%${query}%`,
          }),
          filterParams: JSON.stringify({ readStatus: [1, 0], labelColor: [] }),
          assignees: JSON.stringify([]),
          tagList: JSON.stringify([]),
          includeArchived: 0,
          offsetTask: 0,
          offsetEmail: 0,
        },
      );
      return {
        threads: extractThreads(data).map(shapeBoardItem),
        isEmail: data.isEmail,
      };
    }
    case "filter_threads": {
      // Backend SQL model does JSON.parse(assignees) and JSON.parse(tagList),
      // so these must be sent as JSON-stringified strings, not raw arrays.
      const filterBody: Record<string, unknown> = {
        boardId: args.boardId,
        columnId: args.columnId,
      };
      if (args.assignees) filterBody.assignees = JSON.stringify(args.assignees);
      if (args.tagList) filterBody.tagList = JSON.stringify(args.tagList);

      const data = await client.post<FetchEmailDataResponse>(
        "/v1.18/teamBoard/emailData/filter-emails",
        filterBody,
      );
      return { threads: extractThreads(data).map(shapeBoardItem) };
    }
    case "move_thread": {
      // Backend validator: all params are strings
      // Accept both schema names (newBoardId/newColumnId) and intuitive alternatives (boardId/targetColumnId)
      const boardId = (args.newBoardId ?? args.boardId) as number;
      const columnId = (args.newColumnId ?? args.targetColumnId) as string;
      return client.post("/v1.18/emailData/move", {
        entityId: String(args.threadId),
        entityType: "0", // 0 = email thread
        newColumnId: String(columnId),
        newBoardId: String(boardId),
        newPosition: String(args.position ?? 0),
      });
    }
    case "move_threads_bulk": {
      // Backend validator: threadIds string[], newColumnId/newBoardId strings
      return client.post("/v1.18/emailData/move-bulk", {
        threadIds: args.threadIds,
        newColumnId: String(args.newColumnId),
        newBoardId: String(args.newBoardId),
      });
    }
    default:
      throw new Error(`Unknown email tool: ${name}`);
  }
}
