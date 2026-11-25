import type { DragClient } from "./client.js";
import { addressesIn, bareAddress, cleanText, isNoReplyAddress } from "./addresses.js";

/**
 * WHO A REPLY GOES TO, BY DRAG'S OWN RULE.
 *
 * The rule Drag's follow-up emails, AI drafts and in-app assistant all use:
 *   1. the latest message's Reply-To, when it names someone other than the
 *      sender (except a NetSuite-generated Reply-To, which is only added to
 *      the candidates);
 *   2. otherwise the latest message's From and To, without the team's own
 *      addresses (the mailbox owner, the sending address, the board's
 *      addresses, the user's aliases) and without no-reply addresses;
 *   3. otherwise the latest message's From.
 * The team's own addresses and no-reply addresses are then removed, so a
 * reply is never addressed to the team itself.
 */

export interface ThreadMessage {
  from?: string;
  to?: string | string[];
  cc?: string | string[];
  replyTo?: string;
}

interface ThreadMessagesResponse {
  Response?: { messages?: ThreadMessage[]; deleted?: boolean; expired?: boolean };
}

/** Every message of a thread (oldest first) with its address headers. */
export async function readThreadMessages(
  client: DragClient,
  boardId: number,
  threadId: string,
): Promise<ThreadMessage[]> {
  const data = await client.post<ThreadMessagesResponse>("/v1.18/entityConversation/thread-messages", {
    boardId,
    threadId,
  });
  const thread = data?.Response;
  if (!thread || thread.deleted || thread.expired || !Array.isArray(thread.messages)) return [];
  return thread.messages;
}

const isNetSuiteGenerated = (address: string) => address.endsWith(".email.netsuite.com");

/**
 * Drag's reply rule applied to a thread's messages. `senderEmail` is the
 * address the reply goes out as; `own` is every address of the team.
 * Returns bare, lower-cased addresses; [] when the rule names nobody outside the team.
 */
export function defaultReplyRecipients(
  messages: ThreadMessage[],
  senderEmail: string,
  own: string[],
): string[] {
  const last = messages[messages.length - 1];
  if (!last) return [];

  const sender = bareAddress(senderEmail);
  const self = new Set([sender, ...own.map(bareAddress)].filter(Boolean));
  const keep = (address: string) => address && !self.has(address) && !isNoReplyAddress(address);

  const replyTo = addressesIn(last.replyTo);
  const to = addressesIn(last.to);
  const from = addressesIn(last.from);

  let chosen: string[] = [];
  const directReplyTo = replyTo.filter((address) => address !== sender && !isNetSuiteGenerated(address));
  if (directReplyTo.length) {
    chosen = directReplyTo;
  } else {
    const candidates = [...from, ...to, ...replyTo.filter(isNetSuiteGenerated)];
    chosen = [...new Set(candidates)].filter(keep);
    if (!chosen.length) chosen = from;
  }
  return [...new Set(chosen)].filter(keep);
}

/** True when a `to` / `cc` argument names at least one address. */
export function hasRecipients(value: unknown): boolean {
  return cleanText(Array.isArray(value) ? value.join(",") : value) !== "";
}
