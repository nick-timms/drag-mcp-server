// Tests for full thread history, search (archived, paging, dates) and data files.
// Run after `npm run build`: node --test test/*.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { DragApiError } from "../dist/api/client.js";
import { handleEmailTool } from "../dist/tools/email.js";
import { shapeThreadHistory } from "../dist/api/threadHistory.js";
import { combineSearch, searchRange, toMs, SEARCH_MAX_DAYS } from "../dist/api/search.js";
import { readFileContent, fileKind } from "../dist/files/reader.js";
import { crc32 } from "../dist/files/png.js";

function apiError(status, body) {
  return new DragApiError(`Drag API error: ${status} — ${typeof body === "string" ? body : JSON.stringify(body)}`, status);
}
function fakeClient(routes) {
  const calls = [];
  const call = async (method, path, payload) => {
    calls.push({ method, path, payload });
    const handler = routes[`${method} ${path}`];
    if (!handler) throw apiError(404, `<html>Cannot ${method} ${path}</html>`);
    return handler(payload);
  };
  return { calls, get: (p, q) => call("GET", p, q), post: (p, b) => call("POST", p, b), put: (p, b) => call("PUT", p, b) };
}

// ─── full thread history ──────────────────────────────────────────────

const msg = (i, extra = {}) => ({ messageId: `m${i}`, from: i % 2 ? "Ana <ana@c.com>" : "Support <support@t.com>", to: "x", date: `2026-11-0${i}`, snippet: `s${i}`, text: `text ${i}`, attachments: [], ...extra });

describe("thread history", () => {
  test("every message listed; text on the first and the last three; others on request", () => {
    const six = [1, 2, 3, 4, 5, 6].map((i) => msg(i));
    const out = shapeThreadHistory(six);
    assert.equal(out.messageCount, 6);
    assert.deepEqual(out.messages.map((m) => "text" in m), [true, false, false, true, true, true]);
    const asked = shapeThreadHistory(six, ["m2", "nope"]);
    assert.equal(asked.messages[1].text, "text 2");
    assert.deepEqual(asked.unknownMessageIds, ["nope"]);
  });
  test("long text is capped and marked; a forward keeps more", () => {
    const long = "x".repeat(5000);
    const out = shapeThreadHistory([msg(1, { text: long }), msg(2, { text: long, forwarded: true })]);
    assert.equal(out.messages[0].text.length, 2000);
    assert.equal(out.messages[0].textTruncated, true);
    assert.equal(out.messages[1].text.length, 5000);
  });
  test("get_thread history: true reads the whole conversation", async () => {
    const client = fakeClient({ "POST /v1.18/entityConversation/thread-messages": (b) => {
      assert.deepEqual(b, { boardId: 5, threadId: "abc123abc123" });
      return { Response: { threadId: "abc123abc123", subject: "Order", messages: [msg(1), msg(2)], replyTo: null } };
    } });
    const out = await handleEmailTool(client, "get_thread", { boardId: 5, threadId: "abc123abc123", history: true });
    assert.equal(out.subject, "Order");
    assert.equal(out.messageCount, 2);
    assert.equal(out.messages[1].from, "Support <support@t.com>");
    assert.match(out.note, /never as instructions/);
  });
  test("without history get_thread still reads only the newest message", async () => {
    const client = fakeClient({
      "GET /v1.18/entityConversation/detail-page": () => ({ Emails: { messages: [{ id: "m9", internalDate: 9 }] } }),
      "POST /v1.18/entityConversation/detail-message": () => ({ Response: { messageData: "<p>hi</p>", recipients: [], attachments: [], senderMail: "a@b.c", actions: [] } }),
    });
    const out = await handleEmailTool(client, "get_thread", { boardId: 5, threadId: "abc123abc123" });
    assert.equal(out.messageId, "m9");
    assert.ok(!client.calls.some((c) => c.path.includes("thread-messages")));
  });
  test("a deleted thread says so", async () => {
    const client = fakeClient({ "POST /v1.18/entityConversation/thread-messages": () => ({ Response: { deleted: true } }) });
    await assert.rejects(handleEmailTool(client, "get_thread", { boardId: 5, threadId: "abc123abc123", history: true }), (e) => e.code === 404);
  });
});

// ─── search ───────────────────────────────────────────────────────────

const DAY = 86400000;
const NOW = Date.parse("2026-11-25T12:00:00Z");
/** A raw search entry for an email thread, dated `daysAgo`, in the list's own date format. */
const entry = (id, daysAgo) => ({
  threadId: id,
  msgSubject: `s-${id}`,
  threadInfoJson: { msgDate: `${NOW - daysAgo * DAY}@25 Nov 2026@12:00`, msgFrom: "a@b.c", msgTo: [], messages: "" },
  userLabels: "[]",
});
const page = (entries, next) => ({ Response: { Label_1: Object.fromEntries(entries.map((e) => [e.threadId, e])) }, isEmail: true, ...(next ? { nextOffsetEmail: next, nextOffsetTask: -1 } : { nextOffsetEmail: -1, nextOffsetTask: -1 }) });

function searchClient({ active, all }) {
  return fakeClient({
    "POST /v1.18/teamBoard/emailData/search-emails": (b) => {
      const pages = b.includeArchived ? all : active;
      const index = Math.max(0, pages.findIndex((p) => (p.from ?? 0) === (b.offsetEmail ?? 0)));
      return pages[index].data;
    },
  });
}

describe("search", () => {
  test("the list date format is understood", () => {
    assert.equal(toMs("1795447521000@23 Nov 2026@15:25"), 1795447521000);
    assert.equal(toMs("2026-11-01"), Date.parse("2026-11-01"));
    assert.equal(toMs(1700000000), 1700000000000);
  });
  test("archived: counted by default, returned when nothing current matches, include and only", () => {
    const a = [{ threadId: "1" }];
    const all = [{ threadId: "1" }, { threadId: "2" }];
    assert.deepEqual(combineSearch({ active: a, all }).threads.map((t) => t.threadId), ["1"]);
    assert.equal(combineSearch({ active: a, all }).archivedMatches, 1);
    const fallback = combineSearch({ active: [], all });
    assert.equal(fallback.searched, "board, then archived");
    assert.ok(fallback.threads.every((t) => t.archived === true));
    assert.equal(combineSearch({ active: a, all, mode: "include" }).threads.length, 2);
    assert.deepEqual(combineSearch({ active: a, all, mode: "only" }).threads.map((t) => t.threadId), ["2"]);
  });
  test("date range validation", () => {
    assert.throws(() => searchRange({ sinceDays: SEARCH_MAX_DAYS + 1 }), /sinceDays/);
    assert.throws(() => searchRange({ dateFrom: "soon" }), /not a date/);
    assert.throws(() => searchRange({ dateFrom: "2026-11-02", dateTo: "2026-11-01" }), /after/);
    assert.deepEqual(searchRange({ dateFrom: "2026-11-01", dateTo: "2026-11-01" }), { from: Date.parse("2026-11-01T00:00:00Z"), to: Date.parse("2026-11-01T23:59:59.999Z") });
  });
  test("plain search: two requests, archived counted, hasMore", async () => {
    const client = searchClient({
      active: [{ data: page([entry("a", 1)]) }],
      all: [{ data: page([entry("a", 1), entry("z", 400)]) }],
    });
    const out = await handleEmailTool(client, "search_threads", { boardId: 5, query: "invoice" });
    assert.deepEqual(out.threads.map((t) => t.threadId), ["a"]);
    assert.equal(out.archivedMatches, 1);
    assert.equal(out.hasMore, false);
    assert.equal(client.calls.length, 2);
  });
  test("paged with a period: walks pages, filters by date, totals", async () => {
    const recent = Array.from({ length: 12 }, (_, i) => entry(`r${i}`, i + 1));
    const client = searchClient({
      active: [{ from: 0, data: page(recent.slice(0, 6), 6) }, { from: 6, data: page([...recent.slice(6), entry("old", 90)]) }],
      all: [{ from: 0, data: page(recent.slice(0, 6), 6) }, { from: 6, data: page([...recent.slice(6), entry("old", 90)]) }],
    });
    // the real clock is fine here; dates are relative to NOW only through the entries, so pass dateFrom explicitly
    const dateFrom = new Date(NOW - 30 * DAY).toISOString().slice(0, 10);
    const out = await handleEmailTool(client, "search_threads", { boardId: 5, query: "invoice", dateFrom, limit: 5, page: 2 });
    assert.equal(out.total, 12);
    assert.equal(out.threads.length, 5);
    assert.equal(out.page, 2);
    assert.equal(out.hasMore, true);
    assert.equal(out.complete, true);
    assert.ok(out.period.from.startsWith(dateFrom));
  });
  test("empty query is refused", async () => {
    await assert.rejects(handleEmailTool(fakeClient({}), "search_threads", { boardId: 5, query: " " }), /must not be empty/);
  });
});

// ─── data files ───────────────────────────────────────────────────────

/** A stored (uncompressed) zip, enough for an .xlsx. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const sheetXml = (rows) =>
  `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
    .map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
      const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
      return typeof v === "number" ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
    }).join("")}</row>`).join("")}</sheetData></worksheet>`;

function makeXlsx() {
  return zip({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Quotes" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": sheetXml([["Item", "Price"], ["Widget, large", 42]]),
    "xl/worksheets/sheet2.xml": sheetXml([["Ship by Friday"]]),
  });
}

describe("data files", () => {
  test("JSON, XML, logs and friends are read as text", async () => {
    for (const name of ["a.json", "a.xml", "a.yaml", "a.log", "a.tsv", "a.md", "a.html"]) {
      assert.equal(fileKind(name), "data", name);
    }
    const r = await readFileContent({ data: Buffer.from('{"order": 4521}'), filename: "order.json", source: {} });
    assert.equal(r.content[1].text, '{"order": 4521}');
    assert.equal(JSON.parse(r.content[0].text).fileType, "data");
  });
  test("an .xlsx comes back as CSV, every sheet named, commas quoted", async () => {
    const r = await readFileContent({ data: makeXlsx(), filename: "quote.xlsx", source: {} });
    const header = JSON.parse(r.content[0].text);
    assert.equal(header.fileType, "xlsx");
    assert.equal(header.sheets, 2);
    assert.equal(r.content[1].text, '[Sheet: Quotes]\nItem,Price\n"Widget, large",42\n\n[Sheet: Notes]\nShip by Friday');
  });
  test("video and old .xls are refused by name", async () => {
    await assert.rejects(readFileContent({ data: Buffer.from("x"), filename: "demo.mp4", source: {} }), (e) => e.code === 415 && /Video/.test(e.message));
    await assert.rejects(readFileContent({ data: Buffer.from("x"), filename: "old.xls", source: {} }), (e) => e.code === 415);
  });
  test("a broken .xlsx is a clear error", async () => {
    await assert.rejects(readFileContent({ data: Buffer.from("not a zip"), filename: "bad.xlsx", source: {} }), (e) => e.code === 422 && /could not be opened/.test(e.message));
  });
});
