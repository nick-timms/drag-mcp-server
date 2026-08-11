import type {
  Board,
  V1Board,
  V1Column,
  Card,
  Column,
  Tag,
  Comment,
  ThreadListItem,
  MessageDetail,
  SendEmailResponse,
  Label,
  Contact,
  ContactConversation,
  Article,
  Automation,
  WhatsAppTemplate,
} from "./types.js";

// ─── Boards (v2) ────────────────────────────────────────────────────

export function shapeBoard(board: Board) {
  let members: string[];
  if (typeof board.Users === "string" && board.Users) {
    members = board.Users.split(",").map((e) => e.trim()).filter(Boolean);
  } else if (Array.isArray(board.Users)) {
    members = board.Users.filter((u): u is string => typeof u === "string");
  } else {
    members = [];
  }
  return {
    id: board.Id,
    name: board.Name,
    owner: board.Owner,
    members,
  };
}

// ─── Boards (v1.18) ─────────────────────────────────────────────────

export function shapeV1Board(board: V1Board) {
  return {
    id: board.Id,
    name: board.BoardName,
    owner: board.BoardOwnerEmail,
    isPrimary: board.IsPrimary === "1",
    isOwner: board.IsOwner === 1,
    unreadCount: board.UnreadEmailsCount,
    contributorCount: board.ContributorCount,
    integrationType: board.IntegrationType ?? null,
    isWhatsapp: board.IntegrationType === "WHATSAPP",
  };
}

// ─── Columns (v2) ───────────────────────────────────────────────────

export function shapeColumn(column: Column) {
  return {
    id: column.Id,
    name: column.Name,
  };
}

// ─── Columns (v1.18) ────────────────────────────────────────────────
// v1.18 column names embed an internal prefix — "Drag-N#ColumnName" or
// "Dteamboard-N-N#ColumnName" — strip it. Deliberately narrower than
// /^[^#]*#/ so a customer column named e.g. "Sprint #3" survives intact.

const COLUMN_NAME_PREFIX = /^D(rag|teamboard)-[\d-]+#/;

export function shapeV1Column(column: V1Column) {
  return {
    id: column.labelId,
    name: column.labelName.replace(COLUMN_NAME_PREFIX, ""),
  };
}

// ─── Cards ──────────────────────────────────────────────────────────

export function shapeCardCompact(card: Card) {
  // The v2 API may return fields under different casing — add fallbacks
  const raw = card as unknown as Record<string, unknown>;
  let customFields: Record<string, unknown> = {};
  try {
    const cfRaw = card.CustomFields ?? raw.customFields ?? "{}";
    const parsed = JSON.parse(cfRaw as string);
    if (typeof parsed === "object" && parsed !== null) {
      customFields = parsed;
    }
  } catch {
    // ignore malformed custom fields
  }

  return {
    id: card.DragTaskId ?? raw.Id ?? raw.id,
    title: card.TaskName ?? raw.Title ?? raw.title,
    isUnread: (card.ReadUnreadStatus ?? raw.readUnreadStatus) === 0,
    columnId: card.ColumnId ?? raw.columnId,
    boardId: card.BoardId ?? raw.boardId,
    dueDate: card.DueDate ?? raw.dueDate ?? null,
    assignees: card.Assignees ?? raw.assignees ?? null,
    owner: card.ThreadOwnerEmail ?? raw.threadOwnerEmail ?? null,
    createdAt: card.CreatedAt ?? raw.createdAt ?? null,
    status: card.Status ?? raw.status ?? null,
    customFields,
  };
}

// ─── Tags (v2) ──────────────────────────────────────────────────────

export function shapeTag(tag: Tag) {
  return {
    id: tag.Id,
    name: tag.Name,
    color: tag.Color,
    boardId: tag.BoardId,
  };
}

// ─── Comments ───────────────────────────────────────────────────────

export function shapeComment(comment: Comment) {
  return {
    id: comment.CommentId,
    body: comment.Comment,
    cardId: comment.EntityId,
    createdAt: comment.CreatedAt,
  };
}

// ─── Email Threads (v1.18) ──────────────────────────────────────────

const PREVIEW_MAX_LENGTH = 200;

export function shapeThreadCompact(thread: ThreadListItem) {
  // Parse Gmail labels from JSON string
  let labels: string[] = [];
  try {
    const parsed = JSON.parse(thread.userLabels || "[]");
    if (Array.isArray(parsed)) labels = parsed;
  } catch {
    // ignore malformed labels
  }

  return {
    threadId: thread.threadId,
    subject: thread.msgSubject,
    preview: truncate(thread.threadInfoJson?.messages, PREVIEW_MAX_LENGTH),
    from: thread.threadInfoJson?.msgFrom ?? null,
    to: thread.threadInfoJson?.msgTo ?? [],
    isUnread: thread.readUnreadStatus === "unread-mail",
    date: thread.threadInfoJson?.msgDate ?? null,
    assignees: thread.assignees,
    labels,
    columnId: thread.columnId,
    boardId: thread.boardId,
    starred: thread.starred === 1,
    threadOwnerEmail: thread.threadOwnerEmail,
    dueDate: thread.dueDate,
    note: thread.note,
    checklist: {
      total: thread.checkListTotal,
      completed: thread.checkListCompleted,
    },
    commentCount: thread.comment,
  };
}

/**
 * Search results reuse the thread shape minus `labels`: the search index
 * never populates Gmail labels, so on this path the field is always an
 * empty array and would read as "this thread has no labels".
 */
export function shapeThreadSearchResult(thread: ThreadListItem) {
  const { labels: _labels, ...shaped } = shapeThreadCompact(thread);
  return shaped;
}

export function shapeMessageDetail(msg: MessageDetail) {
  const replyAction = msg.actions?.find((a) => a.action === "reply");
  const firstRecipient = replyAction?.recipients?.[0];

  return {
    body: stripHtml(msg.messageData),
    bodyHtml: msg.messageData,
    sender: msg.senderMail,
    recipients: msg.recipients,
    attachments: msg.attachments,
    starred: msg.starred,
    rfcMessageId: msg.rfcMessageId,
    replyTo: replyAction
      ? {
          subject: replyAction.subject,
          from: firstRecipient?.from ?? null,
          to: firstRecipient?.to ?? [],
        }
      : null,
  };
}

export function shapeSendEmailResponse(msg: SendEmailResponse) {
  const headerMap = new Map(msg.payload.headers.map((h) => [h.name, h.value]));
  return {
    messageId: msg.id,
    threadId: msg.threadId,
    snippet: msg.snippet,
    subject: headerMap.get("Subject") ?? null,
    sentTo: headerMap.get("To") ?? null,
  };
}

// ─── WhatsApp cards & templates (v2) ────────────────────────────────
// WhatsApp boards return cards, not email threads. A WhatsApp card carries
// `whatsappCardId` + `entityType: 3` and flat `msgFrom`/`msgBody`/`msgDate`
// fields — none of which shapeThreadCompact knows how to read, which is why
// WhatsApp cards previously came back with null ids/senders.

/** True when a board-list item is a WhatsApp card rather than an email thread. */
export function isWhatsappCardItem(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const o = item as Record<string, unknown>;
  return (
    o.whatsappCardId !== undefined ||
    o.WhatsappCardId !== undefined ||
    o.entityType === 3 ||
    o.entityType === "3"
  );
}

export function shapeWhatsappCardCompact(item: Record<string, unknown>) {
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (item[k] !== undefined && item[k] !== null) return item[k];
    }
    return null;
  };

  const cardIdRaw = pick("whatsappCardId", "WhatsappCardId", "id", "Id");
  const cardId = cardIdRaw != null ? String(cardIdRaw) : null;

  // The entity ID is "wamid-<phoneNumber>-<userId>-<boardId>"; the phone is
  // what /send-message's `to` field expects (second dash-separated segment).
  const phone = cardId ? (cardId.split("-")[1] ?? null) : null;

  const dueRaw = pick("dueDate", "DueDate");
  const dueDate =
    dueRaw && typeof dueRaw === "object"
      ? ((dueRaw as Record<string, unknown>).date ?? null)
      : (dueRaw ?? null);

  let assignees: string[] = [];
  const assigneesRaw = pick("assignees", "Assignees");
  if (typeof assigneesRaw === "string") {
    try {
      const parsed = JSON.parse(assigneesRaw);
      if (Array.isArray(parsed)) assignees = parsed;
    } catch {
      // ignore malformed assignees
    }
  } else if (Array.isArray(assigneesRaw)) {
    assignees = assigneesRaw as string[];
  }

  const msgBody = pick("msgBody", "MsgBody");
  const readStatus = pick("readStatus", "ReadStatus");

  return {
    cardId,
    entityType: "3" as const,
    contact: pick("msgFrom", "MsgFrom"),
    phone,
    title: pick("title", "Title") ?? pick("msgFrom", "MsgFrom"),
    preview: truncate(typeof msgBody === "string" ? msgBody : "", PREVIEW_MAX_LENGTH),
    isUnread: readStatus === 0 || readStatus === false,
    date: pick("msgDate", "MsgDate"),
    columnId: pick("columnId", "ColumnId"),
    boardId: pick("boardId", "BoardId"),
    owner: pick("threadOwnerEmail", "ThreadOwnerEmail"),
    assignees,
    note: pick("note", "Note"),
    dueDate,
  };
}

// ─── Task cards in a board listing ──────────────────────────────────
// teamBoard/emailData/fetch mixes emails, tasks and WhatsApp cards in one
// response. A task entity carries a `taskId` field + `entityType: 0` (the
// raw board-object convention — note it is inverted from the request-side
// convention where task is "1"). It has no `threadInfoJson` envelope, so
// shapeThreadCompact would null out its id/title.

/** True when a board-list item is a task card rather than an email thread. */
export function isTaskCardItem(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const o = item as Record<string, unknown>;
  return (
    o.taskId !== undefined ||
    o.TaskId !== undefined ||
    o.entityType === 0 ||
    o.entityType === "0"
  );
}

export function shapeTaskCardCompact(item: Record<string, unknown>) {
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (item[k] !== undefined && item[k] !== null) return item[k];
    }
    return null;
  };

  const cardIdRaw = pick("taskId", "TaskId", "DragTaskId", "id", "Id");
  const cardId = cardIdRaw != null ? String(cardIdRaw) : null;

  // Task titles are stored base64-encoded. Board listings return a
  // pre-decoded `dragTaskName` alongside; the search path returns only the
  // encoded `taskName`, and `title` (a separate per-card record) is only
  // present when a note or comment was ever attached. Prefer the decoded
  // form, then the card title, then decode the raw name ourselves.
  const rawTaskName = pick("taskName", "TaskName");
  const title =
    pick("dragTaskName", "DragTaskName") ??
    pick("title", "Title") ??
    decodeBase64Text(rawTaskName) ??
    rawTaskName;

  let assignees: string[] = [];
  const assigneesRaw = pick("assignees", "Assignees");
  if (typeof assigneesRaw === "string") {
    try {
      const parsed = JSON.parse(assigneesRaw);
      if (Array.isArray(parsed)) assignees = parsed;
    } catch {
      // ignore malformed assignees
    }
  } else if (Array.isArray(assigneesRaw)) {
    assignees = assigneesRaw as string[];
  }

  let customFields: unknown = pick("customFields", "CustomFields");
  if (typeof customFields === "string") {
    try {
      customFields = JSON.parse(customFields);
    } catch {
      customFields = {};
    }
  }

  const readStatus = pick("readUnreadStatus", "readStatus", "ReadUnreadStatus");

  return {
    cardId,
    entityType: "1" as const, // request/tool convention: task = "1"
    title,
    isUnread: readStatus === "unread-mail" || readStatus === 0 || readStatus === false,
    status: pick("cardStatus", "CardStatus", "status", "Status"),
    columnId: pick("columnId", "ColumnId"),
    boardId: pick("boardId", "BoardId"),
    assignees,
    owner: pick("threadOwnerEmail", "ThreadOwnerEmail"),
    dueDate: pick("dueDate", "DueDate"),
    note: pick("note", "Note"),
    starred: pick("starred", "Starred") === 1,
    color: pick("color", "Color"),
    checklist: {
      total: pick("checkListTotal", "CheckListTotal") ?? 0,
      completed: pick("checkListCompleted", "CheckListCompleted") ?? 0,
    },
    commentCount: pick("comment", "Comment") ?? 0,
    customFields: customFields ?? {},
  };
}

/**
 * Shape a board-list item, dispatching on type. emailData/fetch mixes email
 * threads, task cards and WhatsApp cards into one response, and the three
 * share no common id/title field — each needs its own shaper.
 */
export function shapeBoardItem(item: unknown) {
  if (isWhatsappCardItem(item)) {
    return shapeWhatsappCardCompact(item as Record<string, unknown>);
  }
  if (isTaskCardItem(item)) {
    return shapeTaskCardCompact(item as Record<string, unknown>);
  }
  return shapeThreadCompact(item as ThreadListItem);
}

/** shapeBoardItem for search responses — threads drop the dead `labels` field. */
export function shapeSearchResultItem(item: unknown) {
  if (isWhatsappCardItem(item)) {
    return shapeWhatsappCardCompact(item as Record<string, unknown>);
  }
  if (isTaskCardItem(item)) {
    return shapeTaskCardCompact(item as Record<string, unknown>);
  }
  return shapeThreadSearchResult(item as ThreadListItem);
}

// ─── WhatsApp conversation messages (v2) ────────────────────────────
// The conversation endpoint returns raw ~850-byte rows with 21 columns,
// most of which are never populated (MsgBody, Attachments, UpdatedAt) —
// the message text itself only lives inside the stringified platform
// payload in `Message`. Extract the useful subset.

export function shapeWhatsappMessage(row: Record<string, unknown>) {
  let payload: Record<string, unknown> | null = null;
  const rawMessage = row.Message ?? row.message;
  if (typeof rawMessage === "string") {
    try {
      payload = JSON.parse(rawMessage);
    } catch {
      // ignore malformed payloads
    }
  } else if (rawMessage && typeof rawMessage === "object") {
    payload = rawMessage as Record<string, unknown>;
  }

  const textObj = payload?.text as Record<string, unknown> | undefined;
  const text =
    (typeof textObj?.body === "string" ? textObj.body : null) ??
    (typeof row.MsgBody === "string" ? row.MsgBody : null);

  // MsgDate is an epoch-milliseconds value stored as a string.
  let timestamp: string | null = null;
  const msgDate = row.MsgDate ?? row.msgDate;
  if (msgDate != null) {
    const n = Number(msgDate);
    timestamp =
      Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : String(msgDate);
  } else if (row.CreatedAt != null) {
    timestamp = String(row.CreatedAt);
  }

  const isSent = row.IsSent ?? row.isSent;
  return {
    direction: isSent === 1 || isSent === true ? ("outbound" as const) : ("inbound" as const),
    from: row.MsgFrom ?? null,
    text,
    type: row.MsgType ?? null,
    timestamp,
    sentBy: row.SenderEmail ?? row.SenderName ?? null,
  };
}

export function shapeWhatsappTemplate(template: WhatsAppTemplate) {
  const components = Array.isArray(template.components) ? template.components : [];
  const body = components.find((c) => c.type === "BODY");
  const header = components.find((c) => c.type === "HEADER");
  // BODY variables are {{1}}, {{2}}… placeholders the caller must fill on send.
  const variableCount = body?.text
    ? (body.text.match(/\{\{\s*\d+\s*\}\}/g) ?? []).length
    : 0;

  return {
    name: template.name,
    language: template.language,
    status: template.status,
    category: template.category,
    headerFormat: header?.format ?? (header?.text ? "TEXT" : null),
    bodyText: body?.text ?? null,
    variableCount,
    components,
  };
}

// ─── Labels (v1.18) ─────────────────────────────────────────────────

export function shapeLabel(label: Label) {
  return {
    id: label.LabelId,
    name: label.Name,
    color: label.Color,
    boardId: label.BoardId,
  };
}

// ─── Contacts (v2) ──────────────────────────────────────────────────

export function shapeContact(contact: Contact) {
  return {
    id: contact.Id,
    name: contact.Name,
    email: contact.Email,
    phone: contact.Phone,
    note: contact.Note,
    domain: contact.Domain,
  };
}

export function shapeContactConversation(convo: ContactConversation) {
  return {
    threadId: convo.ReferenceId,
    messageType: convo.MessageType,
    boardId: convo.BoardId,
    boardName: convo.BoardName,
    date: convo.MsgDate,
    subject: convo.Message,
    preview: truncate(stripHtml(convo.MsgBody), PREVIEW_MAX_LENGTH),
    from: convo.MsgFrom,
    isRead: convo.ReadStatus,
    starred: convo.StarredStatus,
  };
}

// ─── Knowledge Base (v1.18) ─────────────────────────────────────────

export function shapeArticle(article: Article) {
  return {
    id: article.id,
    title: article.title,
    body: article.contentHtml ?? article.contentPlain ?? "",
    categoryId: article.categoryId,
    categoryName: article.category?.name ?? null,
    status: article.status,
    slug: article.slug,
    excerpt: article.excerpt,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
  };
}

export function shapeArticleCompact(article: Article) {
  return {
    id: article.id,
    title: article.title,
    preview: article.excerpt ?? truncate(article.contentPlain ?? "", PREVIEW_MAX_LENGTH),
    categoryName: article.category?.name ?? null,
    isPublished: article.status === "published",
    updatedAt: article.updatedAt,
  };
}

// The public Help Center search endpoint returns neither `status` nor
// `category`, so deriving isPublished/categoryName here would report every
// hit as unpublished and uncategorised — everything a public search can
// return is by definition published. Omit both fields instead.
export function shapeArticleSearchResult(article: Article) {
  return {
    id: article.id,
    title: article.title,
    preview: article.excerpt ?? truncate(article.contentPlain ?? "", PREVIEW_MAX_LENGTH),
    updatedAt: article.updatedAt,
  };
}

// ─── Analytics events (v1.18) ───────────────────────────────────────
// The analytics endpoints return raw per-event records carrying many
// fields that are rarely or never populated; keep only the ones with
// signal so a board-week of events stays well under context limits.

type AnalyticsEvent = Record<string, unknown>;

/** get_daily_activity: one record per email received. */
export function shapeActivityEvent(event: AnalyticsEvent) {
  return {
    entityId: event.entityId ?? null,
    entityType: event.entityType ?? null,
    cardName: event.cardName ?? null,
    creationDate: event.creationDate ?? null,
    tagNames: event.tagNames ?? null,
    assignees: event.assignees ?? null,
    msgFrom: event.msgFrom ?? null,
  };
}

/** get_response_times / get_avg_response_time: one record per reply. */
export function shapeResponseTimeEvent(event: AnalyticsEvent) {
  return {
    entityId: event.entityId ?? null,
    cardName: event.cardName ?? null,
    intervalTime: event.intervalTime ?? null,
    // The raw key is absent (not false) on follow-up replies — normalise
    // so the field is always present as a boolean.
    firstResponse: Boolean(event.firstResponse),
    userReply: event.userReply ?? null,
    responseDate: event.responseDate ?? null,
    creationDate: event.creationDate ?? null,
  };
}

/** get_closed_activity: one record per thread-close event. */
export function shapeClosedEvent(event: AnalyticsEvent) {
  return {
    entityId: event.entityId ?? null,
    cardName: event.cardName ?? null,
    openedAt: event.openedAt ?? null,
    closedAt: event.closedAt ?? null,
    intervalTime: event.intervalTime ?? null,
    userEmail: event.userEmail ?? null,
    assignees: event.assignees ?? null,
  };
}

// ─── Automations (v1.18) ────────────────────────────────────────────

export function shapeAutomation(automation: Automation) {
  let conditional: unknown = null;
  let action: unknown = null;
  try { conditional = JSON.parse(automation.conditional); } catch { /* ignore */ }
  try { action = JSON.parse(automation.action); } catch { /* ignore */ }
  return {
    id: automation.Id,
    name: automation.AutomationName,
    boardId: automation.BoardId,
    isActive: automation.Active === 1,
    description: automation.Description,
    conditional,
    action,
  };
}

// ─── Utilities ──────────────────────────────────────────────────────

function truncate(text: string | null | undefined, maxLength: number): string {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...";
}

function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").trim();
}

/**
 * Decode a base64-encoded text value, returning null unless the input is
 * genuine base64 that decodes to clean text. Ordinary words can be valid
 * base64 by accident ("Test"), so reject decodes containing control or
 * replacement characters rather than trusting every syntactic match.
 */
function decodeBase64Text(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) {
    return null;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64").toString("utf-8");
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/u.test(decoded)) return null;
  return decoded;
}
