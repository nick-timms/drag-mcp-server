import type { DragClient } from "../api/client.js";
import { DragApiError } from "../api/client.js";
import type { FetchEmailDataResponse, DetailMessageResponse, SendEmailResponse, ThreadListItem } from "../api/types.js";
import { shapeBoardItem, shapeSearchResultItem, shapeMessageDetail, shapeSendEmailResponse } from "../api/shaping.js";

export const emailTools = [
  {
    name: "list_threads",
    title: "List threads",
    annotations: { title: "List threads", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description:
      "List the emails and other items in one column of a shared inbox board (e.g. its Inbox, To Do or Done column). Call list_columns first to get column IDs — they are strings like \"Label_1\", not numbers. A column can mix three item types: email threads (have `threadId`/`from`/`subject`), task cards (have `cardId`/`title`/`status`), and WhatsApp conversations (have `cardId`/`contact`). Every item is a card: to assign it to a teammate, set a due date or change its status, call update_card with the `threadId` or `cardId` as cardId; get_card and move_card take the same ID, and the whatsapp tools take WhatsApp `cardId`s.",
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
    title: "Read a thread",
    annotations: { title: "Read a thread", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description:
      "Read an email thread (a conversation in the shared inbox) by the threadId from list_threads, search_threads or filter_threads. Returns the thread's newest message — HTML body plus a plain-text version, sender, recipients, attachments, and reply-to details for composing a response — together with the `threadId` and that message's `messageId`. Pass messageId only to read one specific earlier message in the thread.",
    inputSchema: {
      type: "object" as const,
      properties: {
        boardId: {
          type: "number",
          description: "The board ID the thread belongs to",
        },
        threadId: {
          type: "string",
          description: "The thread ID (from list_threads, search_threads or filter_threads). The thread's newest message is read automatically.",
        },
        messageId: {
          type: "string",
          description: "Optional: a specific message ID within the thread to read instead of the newest message. Pass it together with threadId.",
        },
      },
      required: ["boardId"],
    },
  },
  {
    name: "reply_to_thread",
    title: "Reply to a thread",
    annotations: { title: "Reply to a thread", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    description:
      "Reply to an email thread (a customer conversation) in the shared inbox. Pass the threadId from list_threads, search_threads or get_thread — the reply is attached to the thread's newest message automatically, so no messageId is needed. Sent from the current user's connected Gmail address. Confirm with the user before sending when intent is unclear. Reference: https://www.dragapp.com/docs/mcp/",
    inputSchema: {
      type: "object" as const,
      properties: {
        threadId: {
          type: "string",
          description: "The thread ID to reply to (from list_threads, search_threads or get_thread)",
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
          description: "Optional: reply to a specific earlier message in the thread instead of the newest one. Omit in normal use.",
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
    title: "Send a new email",
    annotations: { title: "Send a new email", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    description:
      "Compose and send a brand-new email (not a reply) to a customer or anyone else, from the shared inbox's connected address (e.g. support@). Creates a new thread in the board. To answer an existing conversation use reply_to_thread instead. Confirm with the user before sending when intent is unclear. Reference: https://www.dragapp.com/docs/mcp/",
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
    title: "Search threads",
    annotations: { title: "Search threads", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description:
      "Search a shared inbox board's emails and other items by keyword, or by the customer's sender address. Returns matches with preview snippets. Matches can be email threads (`threadId` — reply with reply_to_thread, assign or update with update_card), task cards (`cardId`/`title`), or WhatsApp conversations (`cardId`/`contact`). Note: matching is on whole words with no stemming, so \"cancellation\" will not match \"cancelling\". If a search returns nothing, try a shorter or differently spelled term, or use filter_threads or list_threads.",
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
    title: "Filter threads",
    annotations: { title: "Filter threads", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description:
      "Filter a board's email threads by assignee (teammate), shared label, or column — e.g. everything assigned to one teammate, or the unassigned emails in the Inbox column. More targeted than search — use this when you know specific filter values. Results carry a `threadId`; pass it to update_card to assign or update a thread.",
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
    title: "Move a thread",
    annotations: { title: "Move a thread", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
    title: "Move threads in bulk",
    annotations: { title: "Move threads in bulk", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
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
export function extractThreads(data: FetchEmailDataResponse): ThreadListItem[] {
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

/**
 * The slice of the detail-page response that carries the thread's message
 * list: Gmail thread metadata (drafts already filtered out by the backend)
 * for email threads, an empty array for other entity types.
 */
interface ThreadMessagesResponse {
  Emails?:
    | {
        messages?: Array<{ id?: string; internalDate?: string | number }>;
        deleted?: boolean;
        expired?: boolean;
      }
    | unknown[];
}

/**
 * Resolve a thread ID to the ID of the thread's newest message.
 *
 * The message-level endpoints (detail-message, send-as-email-content) look a
 * message up by exact ID, and a thread ID only doubles as a message ID while
 * the thread has a single message. The detail-page endpoint returns the
 * thread's message list, so pick the entry with the latest internalDate.
 * Returns undefined when the list can't be fetched (e.g. detail-page is
 * paywalled on free plans) so callers can fall back to the thread ID — the
 * pre-existing behaviour — instead of failing outright.
 */
export async function resolveLatestMessageId(
  client: DragClient,
  threadId: string,
  boardId?: number,
): Promise<string | undefined> {
  const params: Record<string, string | number> = {
    entityId: threadId,
    entityType: "0", // 0 = email thread
    skipUpdateReadStatus: "true",
  };
  if (boardId !== undefined) params.boardId = boardId;

  let detail: ThreadMessagesResponse;
  try {
    detail = await client.get<ThreadMessagesResponse>(
      "/v1.18/entityConversation/detail-page",
      params,
    );
  } catch {
    return undefined;
  }

  const emails = detail.Emails;
  const messages =
    emails && !Array.isArray(emails) && Array.isArray(emails.messages)
      ? emails.messages
      : [];

  let latest: { id?: string; internalDate?: string | number } | undefined;
  for (const message of messages) {
    if (!message?.id) continue;
    // Gmail lists a thread's messages oldest-first, so ">=" keeps the last
    // one when internalDate is missing or tied.
    if (
      !latest ||
      Number(message.internalDate ?? 0) >= Number(latest.internalDate ?? 0)
    ) {
      latest = message;
    }
  }
  return latest?.id;
}

/** True for the backend's pre-send rejection of a messageId it can't find in the thread. */
function isMessageNotFound(err: unknown): boolean {
  return (
    err instanceof DragApiError &&
    err.code === 400 &&
    /Message not found/i.test(err.message)
  );
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
      // threadId in query string, boardId + messageId in POST body.
      // The endpoint reads one message, and a thread ID only doubles as a
      // message ID while the thread has a single message — so the ID is
      // resolved to the thread's newest message first. The one exception is
      // a caller naming a specific message alongside its thread (threadId
      // and a different messageId both given): that messageId is used as-is.
      // A messageId passed on its own is treated as the thread ID, because
      // the earlier contract described the two as the same value and that is
      // what older callers still send.
      const threadId = args.threadId as string | undefined;
      const explicitMessageId = args.messageId as string | undefined;
      const id = threadId ?? explicitMessageId;
      if (!id) {
        throw new Error("Either threadId or messageId is required");
      }
      const messageId =
        threadId !== undefined &&
        explicitMessageId !== undefined &&
        explicitMessageId !== threadId
          ? explicitMessageId
          : ((await resolveLatestMessageId(
              client,
              id,
              args.boardId as number | undefined,
            )) ?? id);
      const response = await client.post<DetailMessageResponse>(
        "/v1.18/entityConversation/detail-message",
        { boardId: args.boardId, messageId },
        { threadId: id },
      );
      return {
        threadId: id,
        messageId,
        ...shapeMessageDetail(response.Response),
      };
    }
    case "reply_to_thread": {
      // The canonical reply endpoint is /entityConversation/send-as-email-content.
      // The older /send-email-content has the same intent but exhibits a long
      // hang on some accounts; switching endpoints unblocks the call.
      // Empty `from` + `fromName` makes the backend resolve the sender from
      // the JWT and look up the default sendAs.
      //
      // The endpoint looks messageId up by exact ID inside the Gmail thread
      // and rejects the call ("Message not found") when it isn't one — which
      // is what a caller gets for handing over the threadId of a thread with
      // more than one message. So a missing messageId (or one equal to the
      // threadId) is resolved to the thread's newest message here, and a
      // caller-supplied messageId the backend can't find gets one retry
      // against the newest message. The rejection happens before anything is
      // sent, so the retry can't double-send.
      const threadId = String(args.threadId);
      const boardId = args.boardId as number;
      const explicitMessageId = args.messageId as string | undefined;
      const resolveLatest = () => resolveLatestMessageId(client, threadId, boardId);

      const send = async (messageId: string) => {
        const replyBody: Record<string, unknown> = {
          threadId,
          boardId,
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
      };

      if (!explicitMessageId || explicitMessageId === threadId) {
        return send((await resolveLatest()) ?? threadId);
      }
      try {
        return await send(explicitMessageId);
      } catch (err) {
        if (!isMessageNotFound(err)) throw err;
        const latest = await resolveLatest();
        if (!latest || latest === explicitMessageId) throw err;
        return send(latest);
      }
    }
    case "send_new_email": {
      // Verified against the API: the body field is `emailContent` — a `body`
      // key is silently ignored and the email goes out empty. `from` is
      // optional (the sender resolves from the auth token), and
      // `addToBoard: true` places the new thread on the board's first column,
      // which is what the tool description promises; without it the sent
      // email lives only in the Sent folder.
      const body = args.body as string;
      if (!body || body.trim() === "") {
        throw new Error("body must not be empty");
      }
      return client.post("/v1.18/entityConversation/send-new-email", {
        boardId: args.boardId,
        to: args.to,
        subject: args.subject,
        emailContent: body,
        addToBoard: true,
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
        threads: extractThreads(data).map(shapeSearchResultItem),
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
