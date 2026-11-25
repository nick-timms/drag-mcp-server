// Tests for the sender, recipient, assignment, custom field and file changes.
// Run after `npm run build`: node --test test/
// No network: every API call goes to a fake client, and storage downloads to a fake fetch.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { DragApiError } from "../dist/api/client.js";
import { splitAddressList, addressesIn, bareAddress } from "../dist/api/addresses.js";
import { defaultReplyRecipients } from "../dist/api/recipients.js";
import { resolveBoardSender } from "../dist/api/identity.js";
import { checkAssignee } from "../dist/api/members.js";
import { shapeCustomFields, storedValue } from "../dist/api/customFields.js";
import { noteImageRefs, noteImageAt } from "../dist/files/noteImages.js";
import { encodePng } from "../dist/files/png.js";
import { readFileContent } from "../dist/files/reader.js";
import { isToolContent } from "../dist/utils/toolContent.js";
import { handleEmailTool } from "../dist/tools/email.js";
import { handleCardTool } from "../dist/tools/cards.js";
import { handleCustomFieldTool } from "../dist/tools/customFields.js";
import { handleFileTool } from "../dist/tools/files.js";
import { ALL_TOOLS, SERVER_INSTRUCTIONS } from "../dist/server.js";

// ─── fake API client ──────────────────────────────────────────────────

function apiError(status, body) {
  return new DragApiError(`Drag API error: ${status} — ${typeof body === "string" ? body : JSON.stringify(body)}`, status);
}

/** routes: { "GET /path": (params|body) => result | throws } ; records every call */
function fakeClient(routes) {
  const calls = [];
  const call = async (method, path, payload) => {
    const bare = path.split("?")[0];
    calls.push({ method, path, payload });
    const handler = routes[`${method} ${path}`] ?? routes[`${method} ${bare}`];
    if (!handler) throw apiError(404, `<html>Cannot ${method} ${bare}</html>`);
    return handler(payload, path);
  };
  return {
    calls,
    get: (path, params) => call("GET", path, params),
    post: (path, body) => call("POST", path, body),
    put: (path, body) => call("PUT", path, body),
    delete: (path, body) => call("DELETE", path, body),
  };
}

const BOARDS = (board) => ({
  MainBoard: { Id: 1, BoardName: "Inbox", BoardOwnerEmail: "me@team.com", ReplyAsEmail: null, GoogleGroupEmail: null },
  SecondaryBoards: [board],
  ColumnsByBoard: {},
});

const board = (over = {}) => ({
  Id: 5, BoardId: 5, BoardName: "Support", BoardOwnerEmail: "owner@team.com",
  ReplyAsEmail: "support@team.com", GoogleGroupEmail: null, ...over,
});

const TEAM = { Response: [{ Name: "Me Person", Email: "me@team.com" }, { Name: "Owner Person", Email: "owner@team.com" }] };

// ─── addresses ────────────────────────────────────────────────────────

describe("addresses", () => {
  test("a quoted display name with a comma is one mailbox", () => {
    assert.deepEqual(splitAddressList('"Last, First" <a@x.com>, b@y.com'), ['"Last, First" <a@x.com>', "b@y.com"]);
    assert.deepEqual(addressesIn('"Last, First" <A@X.com>', ["c@z.com"]), ["a@x.com", "c@z.com"]);
    assert.equal(bareAddress("null"), "");
  });
});

// ─── Drag's reply rule ────────────────────────────────────────────────

describe("defaultReplyRecipients", () => {
  const own = ["support@team.com", "me@team.com"];
  test("Reply-To wins", () => {
    const msgs = [{ from: "Forms <forms-noreply@google.com>", to: "support@team.com", replyTo: "Ana <ana@customer.com>" }];
    assert.deepEqual(defaultReplyRecipients(msgs, "support@team.com", own), ["ana@customer.com"]);
  });
  test("From and To without the team's own and no-reply addresses", () => {
    const msgs = [{ from: "Bob <bob@customer.com>", to: "support@team.com, carol@customer.com, noreply@x.com" }];
    assert.deepEqual(defaultReplyRecipients(msgs, "support@team.com", own), ["bob@customer.com", "carol@customer.com"]);
  });
  test("uses the latest message", () => {
    const msgs = [{ from: "old@customer.com", to: "support@team.com" }, { from: "Support <support@team.com>", to: "new@customer.com" }];
    assert.deepEqual(defaultReplyRecipients(msgs, "support@team.com", own), ["new@customer.com"]);
  });
  test("nobody outside the team -> []", () => {
    const msgs = [{ from: "me@team.com", to: "support@team.com" }];
    assert.deepEqual(defaultReplyRecipients(msgs, "support@team.com", own), []);
  });
  test("a NetSuite Reply-To is only a candidate", () => {
    const msgs = [{ from: "dan@customer.com", to: "support@team.com", replyTo: "x@acme.email.netsuite.com" }];
    assert.deepEqual(defaultReplyRecipients(msgs, "support@team.com", own), ["dan@customer.com", "x@acme.email.netsuite.com"]);
  });
});

// ─── board sender ─────────────────────────────────────────────────────

describe("resolveBoardSender", () => {
  test("default sender that is a DragApp user: that mailbox's send-as entry and name", async () => {
    const client = fakeClient({
      "GET /v1.18/teamBoard/boards": () => BOARDS(board()),
      "GET /v1.18/aliases": (p) => {
        assert.equal(p.userEmail, "support@team.com");
        return { sendAs: [{ sendAsEmail: "support@team.com", displayName: "Team Support", isPrimary: true }] };
      },
    });
    const s = await resolveBoardSender(client, 5, "reply");
    assert.equal(s.fromEmail, "support@team.com");
    assert.equal(s.fromHeader, "Team Support <support@team.com>");
  });

  test("default sender that is an alias of the acting user", async () => {
    const client = fakeClient({
      "GET /v1.18/teamBoard/boards": () => BOARDS(board({ ReplyAsEmail: "sales@team.com" })),
      "GET /v1.18/aliases": (p) => {
        if (p?.userEmail) throw apiError(400, { error: "No User" });
        return { sendAs: [{ sendAsEmail: "me@team.com", isPrimary: true }, { sendAsEmail: "sales@team.com", displayName: "", verificationStatus: "accepted" }] };
      },
      "GET /v1.18/team/list": () => TEAM,
    });
    const s = await resolveBoardSender(client, 5, "new");
    assert.equal(s.fromEmail, "sales@team.com");
    assert.equal(s.fromHeader, "Me Person <sales@team.com>");
  });

  test("an address nobody can send as is refused with the fix, before any send", async () => {
    const client = fakeClient({
      "GET /v1.18/teamBoard/boards": () => BOARDS(board({ ReplyAsEmail: "sales@team.com" })),
      "GET /v1.18/aliases": (p) => {
        if (p?.userEmail) throw apiError(400, { error: "No User" });
        return { sendAs: [{ sendAsEmail: "me@team.com", isPrimary: true }, { sendAsEmail: "sales@team.com", verificationStatus: "pending" }] };
      },
    });
    await assert.rejects(resolveBoardSender(client, 5, "new"), (e) => e.code === 422 && /can't send as that address/.test(e.message) && /Send mail as/.test(e.message));
  });

  test("a reply as the Google Group goes through the owner's mailbox when it can send as the group", async () => {
    const client = fakeClient({
      "GET /v1.18/teamBoard/boards": () => BOARDS(board({ ReplyAsEmail: null, GoogleGroupEmail: "help@team.com" })),
      "GET /v1.18/aliases": (p) => {
        if (p?.userEmail === "help@team.com") throw apiError(400, { error: "No User" });
        if (p?.userEmail === "owner@team.com") return { sendAs: [{ sendAsEmail: "owner@team.com", isPrimary: true }, { sendAsEmail: "help@team.com", displayName: "Help", verificationStatus: "accepted" }] };
        return { sendAs: [{ sendAsEmail: "me@team.com", isPrimary: true }] };
      },
    });
    const s = await resolveBoardSender(client, 5, "reply");
    assert.equal(s.fromHeader, "Help <help@team.com>");
  });

  test("no default sender and no group: the board owner", async () => {
    const client = fakeClient({
      "GET /v1.18/teamBoard/boards": () => BOARDS(board({ ReplyAsEmail: "null", GoogleGroupEmail: null })),
      "GET /v1.18/aliases": () => ({ sendAs: [{ sendAsEmail: "owner@team.com", displayName: "Owner", isPrimary: true }] }),
    });
    assert.equal((await resolveBoardSender(client, 5, "new")).fromEmail, "owner@team.com");
  });

  test("a board that isn't the user's is a 404", async () => {
    const client = fakeClient({ "GET /v1.18/teamBoard/boards": () => BOARDS(board()) });
    await assert.rejects(resolveBoardSender(client, 99, "new"), (e) => e.code === 404);
  });
});

// ─── reply_to_thread / send_new_email / create_draft ─────────────────

const senderRoutes = {
  "GET /v1.18/teamBoard/boards": () => BOARDS(board()),
  "GET /v1.18/aliases": () => ({ sendAs: [{ sendAsEmail: "support@team.com", displayName: "Team Support", isPrimary: true }] }),
  "GET /v1.18/team/list": () => TEAM,
  "GET /v1.18/entityConversation/detail-page": () => ({ Emails: { messages: [{ id: "m1", internalDate: 1 }, { id: "m2", internalDate: 2 }] } }),
};
const SENT = { id: "s1", threadId: "t1", snippet: "", payload: { headers: [{ name: "Subject", value: "Re: x" }, { name: "To", value: "ana@customer.com" }] } };

describe("reply_to_thread", () => {
  test("sends as the board, to Drag's reply rule's recipient, when `to` is left out", async () => {
    let sentBody;
    const client = fakeClient({
      ...senderRoutes,
      "POST /v1.18/entityConversation/thread-messages": () => ({ Response: { messages: [{ from: "Ana <ana@customer.com>", to: "support@team.com" }] } }),
      "POST /v1.18/entityConversation/send-as-email-content": (b) => { sentBody = b; return SENT; },
    });
    const out = await handleEmailTool(client, "reply_to_thread", { threadId: "abcdef0123456789", boardId: 5, body: "<p>hi</p>" });
    assert.equal(sentBody.from, "support@team.com");
    assert.equal(sentBody.fromName, "Team Support <support@team.com>");
    assert.equal(sentBody.to, "ana@customer.com");
    assert.equal(sentBody.messageId, "m2");
    assert.equal(out.sentAs, "Team Support <support@team.com>");
  });

  test("a `to` the caller passes is used as given", async () => {
    let sentBody;
    const client = fakeClient({ ...senderRoutes, "POST /v1.18/entityConversation/send-as-email-content": (b) => { sentBody = b; return SENT; } });
    await handleEmailTool(client, "reply_to_thread", { threadId: "abcdef0123456789", boardId: 5, to: "x@y.com", body: "hi" });
    assert.equal(sentBody.to, "x@y.com");
    assert.ok(!client.calls.some((c) => c.path.includes("thread-messages")));
  });

  test("nobody to reply to: refused, nothing sent", async () => {
    const client = fakeClient({
      ...senderRoutes,
      "POST /v1.18/entityConversation/thread-messages": () => ({ Response: { messages: [{ from: "me@team.com", to: "support@team.com" }] } }),
    });
    await assert.rejects(handleEmailTool(client, "reply_to_thread", { threadId: "abcdef0123456789", boardId: 5, body: "hi" }), (e) => e.code === 422);
    assert.ok(!client.calls.some((c) => c.path.includes("send-as-email-content")));
  });

  test("an unsendable board address: refused, nothing sent", async () => {
    const client = fakeClient({
      ...senderRoutes,
      "GET /v1.18/aliases": () => ({ sendAs: [{ sendAsEmail: "other@team.com", isPrimary: true }] }),
    });
    await assert.rejects(handleEmailTool(client, "reply_to_thread", { threadId: "abcdef0123456789", boardId: 5, to: "x@y.com", body: "hi" }), (e) => e.code === 422);
    assert.ok(!client.calls.some((c) => c.path.includes("send-as-email-content")));
  });
});

describe("send_new_email", () => {
  test("sends with the board's address as `from`", async () => {
    let sentBody;
    const client = fakeClient({ ...senderRoutes, "POST /v1.18/entityConversation/send-new-email": (b) => { sentBody = b; return { threadId: "n1" }; } });
    const out = await handleEmailTool(client, "send_new_email", { boardId: 5, to: "a@b.com", subject: "S", body: "B" });
    assert.equal(sentBody.from, "support@team.com");
    assert.equal(out.threadId, "n1");
    assert.equal(out.sentAs, "Team Support <support@team.com>");
  });
});

describe("create_draft", () => {
  test("posts the draft request and returns the server's answer", async () => {
    let req;
    const client = fakeClient({ "POST /v1.18/mcp/draft": (b) => { req = b; return { ok: true, draftId: "r1" }; } });
    const out = await handleEmailTool(client, "create_draft", { boardId: 5, threadId: "abcdef0123456789", body: "<p>x</p>", cc: "c@d.com" });
    assert.deepEqual(req, { boardId: 5, threadId: "abcdef0123456789", body: "<p>x</p>", replace: false, cc: "c@d.com" });
    assert.equal(out.draftId, "r1");
  });
  test("a server without the endpoint says so", async () => {
    const client = fakeClient({});
    await assert.rejects(handleEmailTool(client, "create_draft", { boardId: 5, threadId: "abcdef0123456789", body: "x" }), (e) => e.code === 501);
  });
  test("no recipient: the people on the thread are named", async () => {
    const client = fakeClient({ "POST /v1.18/mcp/draft": () => { throw apiError(422, { message: "Drag couldn't tell who the reply goes to.", candidates: [{ email: "a@b.com", name: "Ann" }] }); } });
    await assert.rejects(handleEmailTool(client, "create_draft", { boardId: 5, threadId: "abcdef0123456789", body: "x" }), (e) => /Ann <a@b.com>/.test(e.message));
  });
  test("get_draft returns the saved draft", async () => {
    const client = fakeClient({ "GET /v1.18/mcp/draft": (q) => {
      assert.deepEqual(q, { threadId: "abcdef0123456789" });
      return { threadId: "abcdef0123456789", source: "saved_draft", text: "Hi Ana", truncated: false, hasDraft: true };
    } });
    const out = await handleEmailTool(client, "get_draft", { threadId: "abcdef0123456789" });
    assert.equal(out.text, "Hi Ana");
  });
  test("get_draft on a server without the endpoint says so", async () => {
    await assert.rejects(handleEmailTool(fakeClient({}), "get_draft", { threadId: "abcdef0123456789" }), (e) => e.code === 501);
  });
  test("the edit flow is in create_draft's description", () => {
    const tool = ALL_TOOLS.find((t) => t.name === "create_draft");
    assert.match(tool.description, /get_draft/);
    assert.match(tool.description, /replace: true/);
  });
  test("an existing draft surfaces the server's sentence", async () => {
    const client = fakeClient({ "POST /v1.18/mcp/draft": () => { throw apiError(409, { message: "There is already a draft on this thread. Pass replace: true to replace it.", reason: "existing_draft" }); } });
    await assert.rejects(handleEmailTool(client, "create_draft", { boardId: 5, threadId: "abcdef0123456789", body: "x" }), (e) => e.code === 409 && /replace: true/.test(e.message));
  });
});

// ─── assignment ───────────────────────────────────────────────────────

const MEMBERS = [
  { Name: "Ana Lima", InviteEmail: "ana@team.com", UserEmail: "ana@team.com", IsOwner: 1 },
  { Name: "Bo Diaz", InviteEmail: "bo@team.com", UserEmail: "bo@team.com", IsOwner: 0 },
  { Name: "Bo Kim", InviteEmail: "bok@team.com", UserEmail: "bok@team.com", IsOwner: 0 },
  { Name: "Cy New", InviteEmail: "cy@team.com", UserEmail: null, IsOwner: 0 },
  { Name: "Group", InviteEmail: "help@team.com", UserEmail: null, IsGoogleGroupEmail: "1" },
];

describe("checkAssignee", () => {
  test("members by email and by unique name", () => {
    assert.equal(checkAssignee(MEMBERS, "ANA@team.com", 5), "ana@team.com");
    assert.equal(checkAssignee(MEMBERS, "Ana", 5), "ana@team.com");
    assert.equal(checkAssignee(MEMBERS, "bo kim", 5), "bok@team.com");
  });
  test("refusals: not a member, ambiguous name, not joined, group", () => {
    assert.throws(() => checkAssignee(MEMBERS, "x@y.com", 5), /not a member/);
    assert.throws(() => checkAssignee(MEMBERS, "Bo", 5), /More than one member/);
    assert.throws(() => checkAssignee(MEMBERS, "cy@team.com", 5), /hasn't created a DragApp account/);
    assert.throws(() => checkAssignee(MEMBERS, "help@team.com", 5), /Google Group/);
    assert.throws(() => checkAssignee(MEMBERS, "Duda", 5), /No member/);
  });
});

describe("update_card assignee", () => {
  const routes = (put) => ({
    "POST /v1.18/teamBoard/invitation/list": () => MEMBERS,
    "GET /v1.18/checklistComment/GetEmailAssignees": () => ({ Response: { Assignees: '["ana@team.com"]' } }),
    "PUT /v2/card/123": (b) => { put.body = b; return "123"; },
  });
  test("a bad assignee writes nothing", async () => {
    const put = {};
    const client = fakeClient(routes(put));
    await assert.rejects(handleCardTool(client, "update_card", { cardId: "123", boardId: 5, assignee: "Duda" }));
    assert.equal(put.body, undefined);
  });
  test("a name becomes the member's email", async () => {
    const put = {};
    await handleCardTool(fakeClient(routes(put)), "update_card", { cardId: "123", boardId: 5, assignee: "Bo Diaz" });
    assert.deepEqual(put.body.assignee, ["bo@team.com"]);
  });
  test("add keeps the current assignees", async () => {
    const put = {};
    await handleCardTool(fakeClient(routes(put)), "update_card", { cardId: "123", boardId: 5, assignee: "bo@team.com", assignMode: "add" });
    assert.deepEqual(put.body.assignee, ["ana@team.com", "bo@team.com"]);
  });
  test("an empty list still unassigns, unchecked; an empty string changes nothing", async () => {
    const put = {};
    const client = fakeClient(routes(put));
    await handleCardTool(client, "update_card", { cardId: "123", boardId: 5, assignee: [] });
    assert.deepEqual(put.body.assignee, []);
    assert.ok(!client.calls.some((c) => c.path.includes("invitation")));
    const put2 = {};
    await handleCardTool(fakeClient(routes(put2)), "update_card", { cardId: "123", boardId: 5, assignee: "", note: "n" });
    assert.equal("assignee" in put2.body, false);
  });
  test("the board is read from the card when not passed", async () => {
    const put = {};
    const client = fakeClient({ ...routes(put), "GET /v1.18/entityConversation/detail-page": () => ({ BoardId: 5 }) });
    await handleCardTool(client, "update_card", { cardId: "123", assignee: "ana@team.com" });
    assert.deepEqual(put.body.assignee, ["ana@team.com"]);
  });
});

// ─── custom fields ────────────────────────────────────────────────────

describe("custom fields", () => {
  test("a listing's fields are named and readable", () => {
    const raw = JSON.stringify([
      { id: 7, value: '{"selected":"High"}', relationId: 1, field: '{"label":"Priority","fieldType":"dropdown-text","options":["Low","High"]}' },
      {},
    ]);
    assert.deepEqual(shapeCustomFields(raw), [{ fieldId: 7, name: "Priority", type: "dropdown-text", value: "High", options: ["Low", "High"] }]);
  });
  test("text values stay text: an id like 007 is not turned into a number", () => {
    const raw = [{ id: 3, value: "007", field: { label: "Ref", fieldType: "id" } }];
    assert.equal(shapeCustomFields(raw)[0].value, "007");
  });
  test("values are stored in the extension's shapes", () => {
    assert.deepEqual(storedValue({ id: 1, label: "P", fieldType: "dropdown-text", options: ["Low", "High"] }, "high"), { selected: "High" });
    assert.equal(storedValue({ id: 1, label: "N", fieldType: "numeric" }, "1,200.5"), 1200.5);
    assert.deepEqual(storedValue({ id: 1, label: "C", fieldType: "currency", defaultCountry: "gb" }, "12"), { country: "GB", value: "12" });
    assert.throws(() => storedValue({ id: 1, label: "Ph", fieldType: "phone-number" }, "123"), /country/);
    assert.throws(() => storedValue({ id: 1, label: "P", fieldType: "radio-select", options: ["A"] }, "B"), /only accepts/);
    assert.throws(() => storedValue({ id: 1, label: "E", fieldType: "email" }, "nope"), /not an email/);
  });
  test("set_custom_field writes with the existing relation, by field name", async () => {
    let put;
    const client = fakeClient({
      "GET /v1.18/customField/list/5": () => [{ id: 7, label: "Priority", fieldType: "dropdown-text", options: ["Low", "High"] }],
      "GET /v1.18/customField/list/5/123": () => [{ relationId: 44, value: { selected: "Low" }, field: { id: 7, label: "Priority" } }],
      "PUT /v1.18/customField/assign/7/123": (b, path) => { put = { b, path }; return { relationId: 44 }; },
    });
    const out = await handleCustomFieldTool(client, "set_custom_field", { cardId: "123", boardId: 5, field: "priority", value: "High" });
    assert.deepEqual(put.b, { boardId: 5, fieldId: 7, entityId: "123", relationId: 44, value: { selected: "High" } });
    assert.match(put.path, /\?boardId=5$/);
    assert.equal(out.value, "High");
  });
  test("clear unassigns the relation", async () => {
    let put;
    const client = fakeClient({
      "GET /v1.18/customField/list/5": () => [{ id: 7, label: "Notes", fieldType: "short-text" }],
      "GET /v1.18/customField/list/5/123": () => [{ relationId: 44, value: "x", field: { id: 7 } }],
      "PUT /v1.18/customField/unassign/7/123": (b) => { put = b; },
    });
    await handleCustomFieldTool(client, "set_custom_field", { cardId: "123", boardId: 5, field: "7", clear: true });
    assert.deepEqual(put, { boardId: 5, fieldId: 7, entityId: "123", relationId: 44 });
  });
  test("plan without custom fields: a plain sentence", async () => {
    const client = fakeClient({ "GET /v1.18/customField/list/5": () => { throw apiError(402, "Payment Required"); } });
    await assert.rejects(handleCustomFieldTool(client, "list_custom_fields", { boardId: 5 }), (e) => e.code === 402 && /Plus plan/.test(e.message));
  });
});

// ─── note images ──────────────────────────────────────────────────────

describe("note images", () => {
  const ok = "https://drag-files.s3.amazonaws.com/shared-file/0b7e6f2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b.png";
  const note = `<p>see</p><img src="${ok}" alt="receipt"><img src="https://evil.com/x.png"><img src="${ok}?x=1"><img src='data:image/png;base64,AAAA'>`;
  test("only Drag's storage shape is listed, numbered in order", () => {
    assert.deepEqual(noteImageRefs(note), [{ image: 1, name: "receipt" }]);
    assert.equal(noteImageAt(note, 1).url, ok);
    assert.equal(noteImageAt(note, 2), null);
  });
  test("DRAG_FILES_HOST restricts the host", () => {
    process.env.DRAG_FILES_HOST = "other.s3.amazonaws.com";
    try {
      assert.deepEqual(noteImageRefs(note), []);
    } finally {
      delete process.env.DRAG_FILES_HOST;
    }
  });
  test("get_card lists custom fields and note images", async () => {
    const client = fakeClient({
      "GET /v1.18/entityConversation/detail-page": () => ({ BoardId: 5, Title: "T", Note: note }),
      "GET /v1.18/checklistComment/GetEmailAssignees": () => ({ Response: { Assignees: '["ana@team.com"]' } }),
      "GET /v1.18/customField/list/5/123": () => [{ relationId: 1, value: "42", field: { id: 9, label: "Order", fieldType: "id" } }],
    });
    const card = await handleCardTool(client, "get_card", { cardId: "123" });
    assert.deepEqual(card.customFields, [{ fieldId: 9, name: "Order", type: "id", value: "42" }]);
    assert.deepEqual(card.noteImages, [{ image: 1, name: "receipt" }]);
    assert.equal("hasDraft" in card, false); // tasks have no drafts
  });
  test("get_card on an email thread says whether it has a draft; left out when unknown", async () => {
    const routes = {
      "GET /v1.18/entityConversation/detail-page": () => ({ BoardId: 5, Title: "T", Note: "" }),
      "GET /v1.18/checklistComment/GetEmailAssignees": () => ({}),
      "GET /v1.18/customField/list/5/abcdef0123456789": () => [],
    };
    const withDraft = await handleCardTool(fakeClient({ ...routes, "GET /v1.18/mcp/draft": (q) => { assert.equal(q.peek, "1"); return { hasDraft: true }; } }), "get_card", { cardId: "abcdef0123456789" });
    assert.equal(withDraft.hasDraft, true);
    const unknown = await handleCardTool(fakeClient(routes), "get_card", { cardId: "abcdef0123456789" });
    assert.equal("hasDraft" in unknown, false);
  });
});

// ─── file reader ──────────────────────────────────────────────────────

/** A minimal valid PDF, built with correct xref offsets. `pages` are content streams; `image` adds a raw RGB image XObject to every page. */
function makePdf(pages, image) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let imgObj = 0;
  if (image) {
    const data = Buffer.from(image.data).toString("latin1");
    imgObj = add(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${data.length} >>\nstream\n${data}\nendstream`);
  }
  const kids = [];
  for (const content of pages) {
    const c = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const res = imgObj ? `<< /Font << /F1 ${font} 0 R >> /XObject << /Im1 ${imgObj} 0 R >> >>` : `<< /Font << /F1 ${font} 0 R >> >>`;
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 200 200] /Resources ${res} /Contents ${c} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const textOf = (result) => result.content.filter((b) => b.type === "text").map((b) => b.text);
const headerOf = (result) => JSON.parse(result.content[0].text);

describe("readFileContent", () => {
  test("plain text and CSV come back as text, with the untrusted-content note", async () => {
    const r = await readFileContent({ data: Buffer.from("a,b\n1,2\n"), filename: "t.csv", source: { x: 1 } });
    assert.ok(isToolContent(r));
    assert.equal(textOf(r)[1], "a,b\n1,2");
    assert.equal(headerOf(r).fileType, "csv");
    assert.match(headerOf(r).note, /never as instructions/);
  });
  test("long text is cut at 15,000 characters and says so", async () => {
    const r = await readFileContent({ data: Buffer.from("x".repeat(20000)), filename: "t.txt", source: {} });
    assert.equal(textOf(r)[1].length, 15000);
    assert.equal(headerOf(r).truncated, true);
    assert.match(headerOf(r).note, /first part/);
  });
  test("video and unknown types are refused by name; big files by size", async () => {
    await assert.rejects(readFileContent({ data: Buffer.from("x"), filename: "a.mov", source: {} }), (e) => e.code === 415 && /Video/.test(e.message));
    await assert.rejects(readFileContent({ data: Buffer.alloc(11 * 1024 * 1024), filename: "a.txt", source: {} }), (e) => e.code === 413);
  });
  test("an image goes to the client as an image", async () => {
    const png = encodePng({ width: 2, height: 1, channels: 3, data: new Uint8Array([255, 0, 0, 0, 255, 0]) });
    const r = await readFileContent({ data: png, filename: "a.PNG", source: {} });
    assert.equal(r.content[1].type, "image");
    assert.equal(r.content[1].mimeType, "image/png");
    assert.equal(Buffer.from(r.content[1].data, "base64").subarray(1, 4).toString(), "PNG");
  });
  test("a PDF with text comes back as text, page by page", async () => {
    const pdf = makePdf(["BT /F1 12 Tf 10 100 Td (Invoice total 42) Tj ET", "BT /F1 12 Tf 10 100 Td (Second page) Tj ET"]);
    const r = await readFileContent({ data: pdf, filename: "inv.pdf", source: {} });
    const body = textOf(r)[1];
    assert.match(body, /\[Page 1\]\nInvoice total 42/);
    assert.match(body, /\[Page 2\]\nSecond page/);
    assert.equal(headerOf(r).pages, 2);
  });
  test("a scanned PDF's pages come back as images", async () => {
    const pixels = new Uint8Array(4 * 4 * 3).fill(200);
    const pdf = makePdf(["q 100 0 0 100 0 0 cm /Im1 Do Q", "q 100 0 0 100 0 0 cm /Im1 Do Q"], { width: 4, height: 4, data: pixels });
    const r = await readFileContent({ data: pdf, filename: "scan.pdf", source: {} });
    assert.equal(headerOf(r).scanned, true);
    assert.equal(r.content.filter((b) => b.type === "image").length, 2);
  });
  test("a PDF with neither text nor pictures is refused", async () => {
    const pdf = makePdf(["q Q"]);
    await assert.rejects(readFileContent({ data: pdf, filename: "blank.pdf", source: {} }), (e) => e.code === 422);
  });
});

// ─── file tools ───────────────────────────────────────────────────────

describe("file tools", () => {
  const realFetch = globalThis.fetch;
  let fetched;
  beforeEach(() => {
    fetched = [];
    globalThis.fetch = async (url, init) => {
      fetched.push({ url, init });
      return new Response("file body", { status: 200, headers: { "content-type": "text/plain" } });
    };
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  const filesRoute = { "GET /v1.18/files/list/123": () => [
    { fileId: 11, fileName: "notes.txt", url: "https://drag-files.s3.amazonaws.com/card/123/11.txt" },
    { fileId: 12, fileName: "clip.mp4", url: "https://drag-files.s3.amazonaws.com/card/123/12.mp4" },
  ] };

  test("list_card_files", async () => {
    const out = await handleFileTool(fakeClient(filesRoute), "list_card_files", { cardId: "123", boardId: 5 });
    assert.deepEqual(out, [{ fileId: "11", name: "notes.txt", readable: true }, { fileId: "12", name: "clip.mp4", readable: false }]);
  });
  test("read_card_file downloads only the URL the list returned, without redirects", async () => {
    const r = await handleFileTool(fakeClient(filesRoute), "read_card_file", { cardId: "123", boardId: 5, file: "NOTES.txt" });
    assert.equal(textOf(r)[1], "file body");
    assert.equal(fetched[0].url, "https://drag-files.s3.amazonaws.com/card/123/11.txt");
    assert.equal(fetched[0].init.redirect, "error");
  });
  test("read_card_file refuses an unreadable type before downloading, and an unknown file", async () => {
    await assert.rejects(handleFileTool(fakeClient(filesRoute), "read_card_file", { cardId: "123", boardId: 5, file: "12" }), (e) => e.code === 415);
    await assert.rejects(handleFileTool(fakeClient(filesRoute), "read_card_file", { cardId: "123", boardId: 5, file: "nope.pdf" }), (e) => e.code === 404 && /notes.txt/.test(e.message));
    assert.equal(fetched.length, 0);
  });
  test("a non-storage URL is never fetched", async () => {
    const client = fakeClient({ "GET /v1.18/files/list/123": () => [{ fileId: 1, fileName: "a.txt", url: "https://evil.com/a.txt" }] });
    await assert.rejects(handleFileTool(client, "read_card_file", { cardId: "123", boardId: 5, file: "a.txt" }), (e) => e.code === 400);
    assert.equal(fetched.length, 0);
  });
  test("read_note_image fetches the rebuilt storage URL", async () => {
    globalThis.fetch = async (url) => {
      fetched.push({ url });
      return new Response(encodePng({ width: 1, height: 1, channels: 3, data: new Uint8Array([1, 2, 3]) }), { status: 200, headers: { "content-type": "image/png" } });
    };
    const url = "https://drag-files.s3.amazonaws.com/shared-file/0b7e6f2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b.png";
    const client = fakeClient({ "GET /v1.18/entityConversation/detail-page": () => ({ Note: `<img src="${url}">` }) });
    const r = await handleFileTool(client, "read_note_image", { cardId: "123", image: 1 });
    assert.equal(r.content[1].type, "image");
    assert.equal(fetched[0].url, url);
    await assert.rejects(handleFileTool(client, "read_note_image", { cardId: "123", image: 2 }), (e) => e.code === 404);
  });
  test("read_attachment decodes the server's file", async () => {
    const client = fakeClient({ "GET /v1.18/mcp/attachment": (q) => {
      assert.deepEqual(q, { boardId: 5, threadId: "abcdef0123456789", filename: "a.txt" });
      return { boardId: 5, threadId: "abcdef0123456789", messageId: "m1", filename: "a.txt", mimeType: "text/plain", size: 5, data: Buffer.from("hello").toString("base64") };
    } });
    const r = await handleFileTool(client, "read_attachment", { boardId: 5, threadId: "abcdef0123456789", filename: "a.txt" });
    assert.equal(textOf(r)[1], "hello");
    assert.equal(headerOf(r).messageId, "m1");
  });
  test("read_attachment on a server without the endpoint says so", async () => {
    await assert.rejects(handleFileTool(fakeClient({}), "read_attachment", { boardId: 5, threadId: "abcdef0123456789", filename: "a.pdf" }), (e) => e.code === 501);
  });
});

// ─── manifest ─────────────────────────────────────────────────────────

describe("server manifest", () => {
  test("55 uniquely named tools, matching the instructions", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    assert.equal(names.length, 55);
    assert.equal(new Set(names).size, 55);
    assert.match(SERVER_INSTRUCTIONS, /55 tools across 14 categories/);
    for (const name of ["create_draft", "get_draft", "list_custom_fields", "set_custom_field", "list_card_files", "read_card_file", "read_note_image", "read_attachment"]) {
      assert.ok(names.includes(name), name);
    }
  });
  test("required arguments: reply_to_thread no longer requires `to`", () => {
    const reply = ALL_TOOLS.find((t) => t.name === "reply_to_thread");
    assert.deepEqual(reply.inputSchema.required, ["threadId", "boardId", "body"]);
  });
});
