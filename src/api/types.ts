// DragApp API response types

// ─── Boards (v2) ────────────────────────────────────────────────────
// Shape: { Id: number, Name: string, Owner: string, Users: unknown[] }

export interface Board {
  Id: number;
  Name: string;
  Owner: string;
  Users: unknown[] | string; // comma-separated string from GROUP_CONCAT or empty array
}

// ─── Boards (v1.18 — POST /teamBoard/list) ──────────────────────────
// Returns raw array of V1Board objects

export interface V1Board {
  Id: number;
  BoardName: string;
  IsContributor: number; // 0 or 1
  ContributorCount: number;
  UnreadEmailsCount: number;
  LastNotification: string; // ISO-8601
  BoardOwnerEmail: string;
  IsPrimary: string; // "0" or "1"
  ContributorEmails: string | null;
  ReplyAsEmail: string | null;
  ReplyToFirstColumn: string; // "0" or "1"
  IsOwner: number; // 0 or 1
  GoogleGroupEmail: string | null;
  IntegrationType?: string | null; // "WHATSAPP" for WhatsApp boards, null/absent for email boards
}

// ─── Ordered boards (v1.18 — GET /teamBoard/boards) ─────────────────
// Shape: { MainBoard: V1BoardDetail, SecondaryBoards: V1BoardDetail[], ColumnsByBoard: Record<string, V1Column[]> }

export interface OrderedBoardsResponse {
  MainBoard: V1BoardDetail;
  SecondaryBoards: V1BoardDetail[];
  ColumnsByBoard: Record<string, V1Column[]>;
  OwnBoardsCount: number;
}

export interface V1BoardDetail {
  BoardId: number;
  Id: number;
  BoardName: string;
  CreatedOn: string;
  UserId: number;
  IsPrimary: string;
  LastNotification: string;
  GoogleGroupEmail: string | null;
  IsGoogleGroups: number;
  ReplyAsEmail: string | null;
  ReplyToFirstColumn: string;
  UnreadCount: number;
  BoardOwnerEmail: string;
  role: string; // "1" etc
  IsContributor: number;
  ExpiredToken: number;
  ContributorCount: number;
  ContributorEmails: string;
  labelId: string;
  labelName: string;
  labelIndex: number;
  IntegrationType?: string | null; // "WHATSAPP" for WhatsApp boards
}

// ─── Columns (v2) ───────────────────────────────────────────────────
// Shape: { Id: number, Name: string } — no ColumnId field

export interface Column {
  Id: number;
  Name: string;
}

// ─── Columns (v1.18 — inside ColumnsByBoard) ────────────────────────
// Shape: { labelId: string, labelName: string, userRole: string }
// Column names have "Drag-N#" prefix that should be stripped for display

export interface V1Column {
  labelId: string; // e.g. "Label_1"
  labelName: string; // e.g. "Drag-1#To Do"
  userRole: string;
}

// ─── Cards (v2) ─────────────────────────────────────────────────────

export interface Card {
  DragTaskId: number;
  TaskName: string;
  ReadUnreadStatus: number; // 1 = read, 0 = unread
  ColumnId: string;
  BoardId: number;
  DueDate: string | null;
  Assignees: string | null;
  ThreadOwnerEmail: string;
  CreatedAt: string; // ISO-8601
  Status: string;
  CustomFields: string; // JSON string — needs deserialisation
}

// ─── Comments (v2) ──────────────────────────────────────────────────

export interface Comment {
  CommentId: number;
  UserId: number;
  Comment: string;
  EntityId: string;
  CreatedAt: string;
}

// ─── Tags (v2) ──────────────────────────────────────────────────────

export interface Tag {
  Id: number;
  Name: string;
  Color: string;
  BoardId: number;
}

// ─── Email Sequences (v2) ───────────────────────────────────────────

export interface EmailSequence {
  EmailTemplateId: number;
  UserId: number;
  Name: string;
  CreatedAt: string;
  Content: string;
  Subject: string;
  EmailFollowupId: number;
  TotalViewCount: number;
  LastSent: string | null;
  OwnerName: string;
  OwnerEmail: string;
}

export interface EmailSequenceDetail {
  Id: string;
  Name: string;
  CreatedAt: string;
  EmailFollowups: EmailFollowup[];
}

export interface EmailFollowup {
  EmailFollowupId: number;
  Subject: string;
  Content?: string;
  Days: number;
  Duration: string;
  Hours?: number;
  Minutes?: number;
  Sequence: number;
}

// ─── Email Data (v1.18 — GET /teamBoard/emailData/fetch) ────────────
// Response keys are column label names (e.g. "Label_1").
// Values are OBJECTS keyed by threadId, NOT arrays.

export interface FetchEmailDataResponse {
  Response: Record<string, Record<string, ThreadListItem>>;
  SequenceOrder: unknown[];
  Success: boolean;
  isEmail: boolean;
}

// Thread objects inside FetchEmailDataResponse.Response[labelKey][threadId]

export interface ThreadInfoJson {
  msgTo: string[];
  msgDate: string; // e.g. "1234567890000@01 Jan 2026@9:00"
  msgFrom: string; // e.g. "Jane Doe <jane@example.com>"
  msgSubj: string;
  senders: string[];
  messages: string; // preview/snippet text
  msgToNames: string[];
  SortingMsgDate: string;
}

export interface ThreadListItem {
  id: string; // same as threadId
  threadId: string;
  historyId: string;
  threadOwner: number; // userId
  threadInfoJson: ThreadInfoJson;
  starred: number; // 0 or 1
  showCount: number;
  userLabels: string; // JSON string e.g. '["UNREAD","INBOX"]'
  readUnreadStatus: string; // "unread-mail" or "read-mail"
  columnId: string; // e.g. "Label_1"
  color: string | null;
  boardId: number;
  msgSubject: string;
  dueDate: string | null;
  comment: number;
  checkListTotal: number;
  checkListCompleted: number;
  note: string | null;
  title: string | null;
  cardStatus: string | null;
  assignees: string | null;
  threadOwnerEmail: string;
  customFields: unknown[];
  entityType: number; // 1 = email
  order: number;
}

// ─── Detail Message (v1.18 — POST /entityConversation/detail-message) ─────
// Returns a single message, not a full thread.

export interface DetailMessageResponse {
  Error: boolean;
  Success: boolean;
  Response: MessageDetail;
}

export interface MessageDetail {
  messageData: string; // full HTML body
  recipients: string[];
  attachments: unknown[]; // TODO: verify shape with real attachment data
  rfcMessageId: string; // e.g. "<CAJV0...@mail.gmail.com>"
  senderMail: string;
  starred: boolean;
  actions: MessageAction[];
}

export interface MessageAction {
  action: string; // e.g. "reply"
  subject: string;
  recipients: ActionRecipient[];
}

export interface ActionRecipient {
  from: string;
  to: string[];
}

// ─── Send Email (v1.18 — POST /entityConversation/send-email-content) ─────
// Returns the sent Gmail message object

export interface SendEmailResponse {
  id: string; // new message ID
  threadId: string;
  labelIds: string[];
  snippet: string;
  payload: {
    mimeType: string;
    headers: EmailHeader[];
  };
}

export interface EmailHeader {
  name: string; // "Subject", "From", "To"
  value: string;
}

// ─── Labels (v1.18) ─────────────────────────────────────────────────
// GET /sharedLabel/list returns { list: Label[] }

export interface Label {
  LabelId: number;
  Name: string;
  Color: string;
  BoardId: number;
}

export interface LabelsResponse {
  list: Label[];
}

// ─── Tasks (v1.18) ──────────────────────────────────────────────────
// TODO: verify response shape against live API
export interface Task {
  TaskId: number;
  Title: string;
  Status: string;
  BoardId: number;
  ColumnId: string;
  Assignee: string | null;
  DueDate: string | null;
  CreatedAt: string;
}

// ─── Contacts (v2) ──────────────────────────────────────────────────
// GET /v2/contact/list returns paginated response

export interface Contact {
  Id: number;
  Name: string;
  Email: string;
  Phone: string | null;
  Note: string | null;
  CreatedBy: number;
  Domain: string;
}

export interface ContactsResponse {
  rows: Contact[];
  totalRecords: number;
  currentPage: number;
  totalPages: number;
}

export interface ContactConversation {
  ReferenceId: string;
  MessageType: string;
  BoardId: number;
  BoardName: string;
  ReadStatus: boolean;
  ShowCount: number;
  StarredStatus: boolean;
  MsgDate: string;
  Message: string;
  MsgBody: string;
  MsgFrom: string;
  HasMessageAccess?: boolean;
}

export interface ContactConversationsResponse {
  contact: Contact;
  rows: ContactConversation[];
  totalRecords: number;
  currentPage: number;
  totalPages: number;
}

// ─── Knowledge Base (v1.18) ─────────────────────────────────────────
export interface Article {
  id: number;
  teamId: number;
  categoryId: number | null;
  authorId: number;
  title: string;
  slug: string;
  content: unknown;
  contentHtml: string | null;
  contentPlain: string | null;
  excerpt: string | null;
  status: string;
  aiEnabled: boolean;
  publishedAt: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  category: { id: number; name: string; slug: string; icon: string | null; iconBg: string | null } | null;
}

export interface Category {
  id: number;
  name: string;
  slug: string;
  articleCount?: number;
}

// ─── Analytics (v1.18) ──────────────────────────────────────────────
// TODO: verify response shapes — live testing returned empty error objects,
// likely because the test account has no activity data. Param format may
// also need adjustment (PascalCase vs camelCase). Test with active account.

export interface ResponseTimeMetrics {
  BoardId: number;
  AverageResponseTime: number;
  MedianResponseTime: number;
  Count: number;
  Period: string;
}

export interface DailyActivity {
  Date: string;
  Count: number;
  Type: string;
}

export interface ClosedActivity {
  Date: string;
  ClosedCount: number;
  BoardId: number;
}

// ─── WhatsApp (v2 — /whatsapp/*) ────────────────────────────────────
// WhatsApp boards have IntegrationType "WHATSAPP". Their cards are NOT
// email threads: they carry `whatsappCardId` + `entityType: 3` and use
// flat `msgFrom`/`msgBody`/`msgDate` fields instead of a `threadInfoJson`
// envelope. The entity ID is formatted "<id>-<phoneNumber>".

/**
 * A WhatsApp card as it appears inside a board's emailData/fetch response,
 * alongside email ThreadListItems. Field casing varies, so the shaper reads
 * each key defensively — this interface documents the known names.
 */
export interface WhatsAppCardItem {
  whatsappCardId: string;
  entityType: 3;
  msgFrom?: string; // contact name / number the message is from
  msgBody?: string; // last message preview
  msgDate?: string;
  title?: string | null;
  readStatus?: number; // 1 = read, 0 = unread
  threadOwnerEmail?: string;
  color?: string | null;
  note?: string | null;
  assignees?: string | null; // JSON string array
  columnId?: string;
  boardId?: number;
  dueDate?: string | { date: string } | null;
  customLabel?: unknown;
}

export interface WhatsAppTemplate {
  name: string;
  language: string; // language code, e.g. "fr", "en_US"
  status: "APPROVED" | "PENDING" | "PAUSED" | "REJECTED" | string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION" | string;
  components: WhatsAppTemplateComponent[];
}

export interface WhatsAppTemplateComponent {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
  format?: string;
  text?: string;
  buttons?: unknown[];
  example?: unknown;
}

/** /whatsapp/fetch-whatsapp-templates returns this inside the v2 `data` envelope */
export interface WhatsAppTemplatesResponse {
  data: WhatsAppTemplate[];
  paging?: { cursors?: { before?: string; after?: string }; next?: string; previous?: string };
}

/** A single message inside a WhatsApp conversation */
export interface WhatsAppMessage {
  messageId?: string;
  type?: string; // "text" | "image" | "template" | "reaction" | ...
  body?: string;
  htmlMessage?: string;
  direction?: string; // "inbound" | "outbound"
  status?: string; // "sent" | "delivered" | "read" | ...
  date?: string;
  from?: string;
  to?: string;
}

// ─── Automations (v1.18) ────────────────────────────────────────────
// Note: returns literal false when no automations exist, otherwise an array.

export interface Automation {
  Id: number;
  UserId: number;
  BoardId: number;
  AutomationName: string;
  Description: string;
  Active: number;
  conditional: string;
  action: string;
  version: number;
  delay: number | null;
  ifNoReply: number;
  useBusinessHours: number;
  ifMatchCriteria: string | null;
  aiCategory: string | null;
}

