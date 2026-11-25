import type { DragClient } from "./client.js";

/**
 * SEARCH WITH ARCHIVED CARDS, PAGING AND DATES.
 *
 * The same rules DragApp's in-app assistant searches with:
 *
 * ARCHIVED. In DragApp closing a card archives it, so "closed" and "archived"
 * mean the same. The search endpoint answers includeArchived: 1 with the
 * board's cards AND its archived ones, so the archived set is that answer
 * minus the includeArchived: 0 one, keeping the endpoint's own matching and
 * access checks.
 *   archived: "exclude" (default)  cards on the board; archived matches are
 *                                   counted (archivedMatches), and returned
 *                                   instead, marked archived: true, when
 *                                   nothing on the board matches;
 *   archived: "include"             both, the archived ones marked;
 *   archived: "only"                archived (closed) cards only.
 *
 * PAGING AND DATES, only when asked (limit, page, sinceDays, dateFrom or
 * dateTo). The endpoint pages by offsets and has no date filter, so this
 * walks its pages newest first, filters by each match's latest message date,
 * and answers one page with total and hasMore. Without those arguments the
 * search makes the same two requests and answers the first page, plus hasMore.
 */

export const ARCHIVE_MODES = ["exclude", "include", "only"] as const;
export const SEARCH_MAX_LIMIT = 100;
export const SEARCH_DEFAULT_LIMIT = 50;
export const SEARCH_MAX_DAYS = 366;
/** Endpoint pages read per side (board, and with archived), at most. Past it the total is a floor. */
export const SEARCH_MAX_ENDPOINT_PAGES = 8;
export const SEARCH_TIME_BUDGET_MS = 15_000;
const LEGACY_FULL_PAGE = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const SEARCH_URL = "/v1.18/teamBoard/emailData/search-emails";
const PAGING_KEYS = ["limit", "page", "sinceDays", "dateFrom", "dateTo"] as const;

type Item = Record<string, unknown>;

export interface SearchShaping {
  extractThreads: (data: any) => unknown[];
  shapeSearchResultItem: (entry: unknown) => unknown;
}

const idOf = (item: Item | null | undefined): string | null => {
  const id = item?.threadId ?? item?.cardId ?? item?.id;
  return id == null ? null : String(id);
};

/**
 * A time in ms from epoch seconds, epoch ms, a date string, or the list
 * format "1795447521000@23 Nov 2026@15:25" (epoch ms before the first "@").
 */
export function toMs(value: unknown): number | null {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  const lead = text.match(/^(\d{9,13})@/);
  const n = Number(lead ? lead[1] : text);
  if (Number.isFinite(n)) return n > 0 ? (n < 1e12 ? n * 1000 : n) : null;
  const t = Date.parse(text);
  return Number.isFinite(t) ? t : null;
}

const entryTime = (entry: any) =>
  toMs(entry?.threadInfoJson?.msgDate ?? entry?.msgDate ?? entry?.MsgDate ?? entry?.lastMessageDate ?? entry?.LastMessageDate ?? entry?.createdAt ?? entry?.CreatedAt);

export const itemTime = (item: Item | null | undefined) => toMs(item?.date);

const parseDay = (value: unknown, end: boolean): number | null => {
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return Date.parse(`${text}T${end ? "23:59:59.999" : "00:00:00.000"}Z`);
  const t = Date.parse(text);
  return Number.isFinite(t) ? t : null;
};

/** The period asked for, in ms. Throws a sentence the model can act on. */
export function searchRange(args: Record<string, unknown>, now = Date.now()): { from: number | null; to: number | null } {
  let from: number | null = null;
  let to: number | null = null;
  if (args.sinceDays != null) {
    const days = Number(args.sinceDays);
    if (!Number.isFinite(days) || days < 1 || days > SEARCH_MAX_DAYS) throw new Error(`sinceDays must be a number of days from 1 to ${SEARCH_MAX_DAYS}.`);
    from = now - days * DAY_MS;
  }
  if (args.dateFrom != null) {
    const t = parseDay(args.dateFrom, false);
    if (t == null || !Number.isFinite(t)) throw new Error(`dateFrom "${String(args.dateFrom)}" is not a date. Use ISO-8601, e.g. "2026-10-01".`);
    from = from == null ? t : Math.max(from, t);
  }
  if (args.dateTo != null) {
    const t = parseDay(args.dateTo, true);
    if (t == null || !Number.isFinite(t)) throw new Error(`dateTo "${String(args.dateTo)}" is not a date. Use ISO-8601, e.g. "2026-10-31".`);
    to = t;
  }
  if (from != null && to != null && from > to) throw new Error("dateFrom is after dateTo.");
  return { from, to };
}

export function searchPaging(args: Record<string, unknown>): { page: number; limit: number } {
  const limit = Number(args.limit);
  const page = Number(args.page);
  return {
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    limit: Number.isFinite(limit) && limit >= 1 ? Math.min(Math.floor(limit), SEARCH_MAX_LIMIT) : SEARCH_DEFAULT_LIMIT,
  };
}

export const isPagedSearch = (args: Record<string, unknown>) => PAGING_KEYS.some((key) => args[key] != null);

/** Combine the on-board and with-archived answers by the archived mode. */
export function combineSearch({ active, all, mode = "exclude" }: { active: Item[]; all: Item[]; mode?: unknown }) {
  const onBoard = new Set(active.map(idOf).filter(Boolean));
  const archived = all.filter((item) => idOf(item) && !onBoard.has(idOf(item))).map((item) => ({ ...item, archived: true }));
  const board = active.map((item) => ({ ...item, archived: false }));
  const resolved = (ARCHIVE_MODES as readonly string[]).includes(String(mode)) ? String(mode) : "exclude";

  if (resolved === "only") {
    return { threads: archived, onBoardMatches: board.length, archivedMatches: archived.length, searched: "archived" };
  }
  if (resolved === "include") {
    return { threads: [...board, ...archived], onBoardMatches: board.length, archivedMatches: archived.length, searched: "board and archived" };
  }
  if (!board.length && archived.length) {
    return {
      threads: archived,
      onBoardMatches: 0,
      archivedMatches: archived.length,
      searched: "board, then archived",
      note: "Nothing on the board matches; these are ARCHIVED (closed) cards. Say so in the answer.",
    };
  }
  return {
    threads: board,
    onBoardMatches: board.length,
    archivedMatches: archived.length,
    searched: "board",
    ...(archived.length
      ? { note: `${archived.length} archived (closed) card${archived.length === 1 ? "" : "s"} also match. Say so in one line and offer to include them.` }
      : {}),
  };
}

const offsetOf = (value: unknown) => (value === undefined || value === null || value === "" ? NaN : Number(value));

/** The endpoint's next page offsets, or null when it says there is none. */
export function nextOffsets(data: any): { offsetEmail: number; offsetTask: number; offsetWhatsapp: number } | null {
  const email = offsetOf(data?.nextOffsetEmail);
  const task = offsetOf(data?.nextOffsetTask);
  const whatsapp = offsetOf(data?.nextOffsetWhatsappCard ?? data?.nextOffsetWhatsapp);
  const open = (n: number) => Number.isFinite(n) && n >= 0;
  if (!open(email) && !open(task) && !open(whatsapp)) return null;
  return { offsetEmail: open(email) ? email : -1, offsetTask: open(task) ? task : -1, offsetWhatsapp: open(whatsapp) ? whatsapp : -1 };
}

type Offsets = { offsetEmail: number; offsetTask: number; offsetWhatsapp: number };
const sameOffsets = (a: Offsets, b: Offsets) =>
  a.offsetEmail === b.offsetEmail && a.offsetTask === b.offsetTask && a.offsetWhatsapp === b.offsetWhatsapp;

async function walkSearch(
  client: DragClient,
  body: Record<string, unknown>,
  shape: (data: any) => Item[],
  opts: { stopBefore: number | null; maxPages: number; deadline: number; clock: () => number },
) {
  const items: Item[] = [];
  const seen = new Set<string>();
  let offsets: Offsets = { offsetEmail: 0, offsetTask: 0, offsetWhatsapp: 0 };
  let complete = false;
  let isEmail: unknown;
  let reads = 0;
  while (reads < opts.maxPages && (reads === 0 || opts.clock() < opts.deadline)) {
    const data = await client.post<any>(SEARCH_URL, { ...body, ...offsets });
    reads += 1;
    if (reads === 1) isEmail = data?.isEmail;
    const page = shape(data);
    let fresh = 0;
    for (const item of page) {
      const id = idOf(item);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      items.push(item);
      fresh += 1;
    }
    const next = nextOffsets(data);
    if (!page.length || !next) {
      complete = true;
      break;
    }
    if (opts.stopBefore != null && page.every((item) => {
      const t = itemTime(item);
      return t != null && t < (opts.stopBefore as number);
    })) {
      complete = true;
      break;
    }
    if (!fresh || sameOffsets(next, offsets)) break;
    offsets = next;
  }
  return { items, complete, isEmail };
}

function requestBody(args: Record<string, unknown>, query: string, includeArchived: 0 | 1) {
  // Backend reads these fields with JSON.parse(): they are sent as JSON strings.
  const searchKey = args.searchBy === "sender" ? "MsgFrom" : "ThreadInfo";
  return {
    boardIds: JSON.stringify([args.boardId]),
    searchParams: JSON.stringify({ key: searchKey, value: `%${query}%` }),
    filterParams: JSON.stringify({ readStatus: [1, 0], labelColor: [] }),
    assignees: JSON.stringify([]),
    tagList: JSON.stringify([]),
    includeArchived,
  };
}

async function searchPaged(client: DragClient, args: Record<string, unknown>, query: string, shaping: SearchShaping, now: number, clock: () => number) {
  const range = searchRange(args, now);
  const { page, limit } = searchPaging(args);
  // Items with no date of their own (tasks, WhatsApp cards) take the entry's, so a period applies to them too.
  const shape = (data: any): Item[] =>
    shaping.extractThreads(data).map((entry) => {
      const item = shaping.shapeSearchResultItem(entry) as Item;
      if (!item || typeof item !== "object") return item;
      if (itemTime(item) != null) return item;
      const t = entryTime(entry);
      return t != null ? { ...item, date: new Date(t).toISOString() } : item;
    });
  const options = { stopBefore: range.from, maxPages: SEARCH_MAX_ENDPOINT_PAGES, deadline: clock() + SEARCH_TIME_BUDGET_MS, clock };
  const [active, all] = await Promise.all([
    walkSearch(client, requestBody(args, query, 0), shape, options),
    walkSearch(client, requestBody(args, query, 1), shape, options),
  ]);

  const dated = range.from != null || range.to != null;
  const inRange = (item: Item) => {
    if (!dated) return true;
    const t = itemTime(item);
    if (t == null) return false;
    return (range.from == null || t >= range.from) && (range.to == null || t <= range.to);
  };
  const undated = dated ? new Set([...active.items, ...all.items].filter((item) => itemTime(item) == null).map(idOf)).size : 0;
  const { threads: matches, ...combined } = combineSearch({ active: active.items.filter(inRange), all: all.items.filter(inRange), mode: args.archived });
  const complete = active.complete && (combined.searched === "board" || all.complete);

  const start = (page - 1) * limit;
  const threads = matches.slice(start, start + limit);
  return {
    ...combined,
    threads,
    total: matches.length,
    page,
    limit,
    hasMore: start + threads.length < matches.length,
    complete,
    ...(dated
      ? { period: { from: range.from != null ? new Date(range.from).toISOString() : null, to: range.to != null ? new Date(range.to).toISOString() : null } }
      : {}),
    ...(undated ? { undatedLeftOut: undated } : {}),
    ...(!complete
      ? { totalNote: `There may be more matches than one search reads: total counts the ${matches.length} found. Say "at least ${matches.length}", or narrow the words or the period to get them all.` }
      : {}),
    isEmail: active.isEmail,
  };
}

/** search_threads: archived handled by mode; paging and dates when asked. */
export async function searchThreads(
  client: DragClient,
  args: Record<string, unknown>,
  shaping: SearchShaping,
  { now = Date.now(), clock = Date.now }: { now?: number; clock?: () => number } = {},
) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("query must not be empty");
  if (isPagedSearch(args)) return searchPaged(client, args, query, shaping, now, clock);

  const [activeData, allData] = await Promise.all([
    client.post<any>(SEARCH_URL, { ...requestBody(args, query, 0), offsetTask: 0, offsetEmail: 0 }),
    client.post<any>(SEARCH_URL, { ...requestBody(args, query, 1), offsetTask: 0, offsetEmail: 0 }),
  ]);
  const shape = (data: any) => shaping.extractThreads(data).map((entry) => shaping.shapeSearchResultItem(entry) as Item);
  const active = shape(activeData);
  const all = shape(allData);
  const combined = combineSearch({ active, all, mode: args.archived });
  const fullWithNext = (items: Item[], data: any) => items.length >= LEGACY_FULL_PAGE && nextOffsets(data) != null;
  const hasMore = combined.searched === "board" ? fullWithNext(active, activeData) : fullWithNext(all, allData);
  return {
    ...combined,
    isEmail: activeData?.isEmail,
    hasMore,
    ...(hasMore
      ? { paging: "This is only the first page of matches. To count them, read them all or act on all of them, search again with limit (up to 100) and page, and sinceDays for a period: that answer has total and hasMore." }
      : {}),
  };
}
