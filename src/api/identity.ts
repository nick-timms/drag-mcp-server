import { DragApiError, type DragClient } from "./client.js";
import type { OrderedBoardsResponse, V1BoardDetail } from "./types.js";
import { bareAddress, cleanText } from "./addresses.js";

/**
 * WHO AN EMAIL FROM A BOARD IS SENT AS.
 *
 * The same rule Drag's in-app assistant applies before it sends anything:
 *   1. the board's default sender (its "reply as" address), else
 *   2. the board's Google Group address, else
 *   3. the board owner's address.
 *
 * Gmail honours a From header only when the address is a "send mail as"
 * identity of the account sending it; anything else is silently rewritten to
 * the account's own address. So the address is checked against the sending
 * account's send-as list first, and a board whose address can't be sent from
 * is refused with the fix, instead of an email leaving under an address nobody
 * chose.
 *
 * Which account sends (mirrored from the API's own send rules):
 *   - an address that belongs to a DragApp user sends from that user's mailbox;
 *   - otherwise the acting user's mailbox sends, carrying the address as an alias;
 *   - a reply as the board's Google Group goes out from the board owner's
 *     mailbox when that mailbox can send as the group.
 */

export interface BoardSender {
  /** The address the email goes out as. */
  fromEmail: string;
  /** Display name for the From header ("" when none is known). */
  fromName: string;
  /** RFC 5322 From value: "Name <address>", or the bare address when no name is known. */
  fromHeader: string;
  boardId: number;
  /** The board's identity fields the sender was chosen from. */
  identity: BoardIdentity;
}

export interface BoardIdentity {
  boardId: number;
  boardName: string;
  replyAsEmail: string;
  googleGroupEmail: string;
  ownerEmail: string;
}

interface SendAsEntry {
  sendAsEmail?: string;
  displayName?: string;
  verificationStatus?: string;
  isPrimary?: boolean;
}

interface SendAsList {
  sendAs?: SendAsEntry[];
}

interface TeamListResponse {
  Response?: Array<{ Name?: string; Email?: string }>;
}

/** The identity fields of one of the user's boards, or a 404 when the board isn't theirs. */
export async function getBoardIdentity(client: DragClient, boardId: number): Promise<BoardIdentity> {
  const data = await client.get<OrderedBoardsResponse>("/v1.18/teamBoard/boards");
  const boards: V1BoardDetail[] = [data.MainBoard, ...(data.SecondaryBoards ?? [])].filter(Boolean);
  const board = boards.find((b) => Number(b.Id ?? b.BoardId) === Number(boardId));
  if (!board) {
    throw new DragApiError(`Board ${boardId} is not one of your boards. Call list_boards for the boards you can use.`, 404);
  }
  return {
    boardId: Number(boardId),
    boardName: cleanText(board.BoardName),
    replyAsEmail: bareAddress(board.ReplyAsEmail),
    googleGroupEmail: bareAddress(board.GoogleGroupEmail),
    ownerEmail: bareAddress(board.BoardOwnerEmail),
  };
}

/** A user's Gmail send-as list. `userEmail` omitted = the acting user. Null when the address is not a DragApp user. */
async function sendAsListOf(client: DragClient, userEmail?: string): Promise<SendAsEntry[] | null> {
  try {
    const data = await client.get<SendAsList>("/v1.18/aliases", userEmail ? { userEmail } : undefined);
    return Array.isArray(data?.sendAs) ? data.sendAs : [];
  } catch (err) {
    // The API answers 400 when userEmail is not a DragApp user: that address is
    // an alias or a group, sent by another account. Anything else is a real failure.
    if (userEmail && err instanceof DragApiError && err.code === 400) return null;
    throw err;
  }
}

/** The usable entry for `address` in a send-as list: the primary address, or an alias Gmail accepted. */
function usableEntry(list: SendAsEntry[], address: string): SendAsEntry | null {
  const entry = list.find((item) => bareAddress(item.sendAsEmail) === address);
  if (!entry) return null;
  return !entry.verificationStatus || entry.verificationStatus === "accepted" ? entry : null;
}

function primaryOf(list: SendAsEntry[]): string {
  return bareAddress((list.find((item) => item.isPrimary) ?? list[0])?.sendAsEmail);
}

async function teamNameFor(client: DragClient, address: string): Promise<string> {
  try {
    const data = await client.get<TeamListResponse>("/v1.18/team/list");
    const member = (data.Response ?? []).find((m) => bareAddress(m.Email) === address);
    return cleanText(member?.Name);
  } catch {
    return "";
  }
}

/**
 * Resolve and check the sender for an email from `boardId`. `purpose` is
 * "reply" for a reply on a thread, "new" for a brand-new email; only a reply
 * may go out from the board owner's mailbox as the Google Group.
 */
export async function resolveBoardSender(
  client: DragClient,
  boardId: number,
  purpose: "reply" | "new",
): Promise<BoardSender> {
  const identity = await getBoardIdentity(client, boardId);
  const fromEmail = identity.replyAsEmail || identity.googleGroupEmail || identity.ownerEmail;
  if (!fromEmail) {
    throw new DragApiError(
      `Couldn't work out which address board ${boardId} sends from, so nothing was sent. Try again in a moment.`,
      422,
    );
  }

  let entry: SendAsEntry | null = null;
  let senderEmail = "";
  try {
    // 1. The address is a DragApp user's own mailbox: that mailbox sends.
    const own = await sendAsListOf(client, fromEmail);
    if (own) {
      senderEmail = primaryOf(own) || fromEmail;
      entry = usableEntry(own, fromEmail);
    } else {
      // 2. A reply as the Google Group: the board owner's mailbox, when it can send as the group.
      if (purpose === "reply" && fromEmail === identity.googleGroupEmail && identity.ownerEmail) {
        const ownerList = await sendAsListOf(client, identity.ownerEmail);
        if (ownerList) {
          entry = usableEntry(ownerList, fromEmail);
          if (entry) senderEmail = primaryOf(ownerList) || identity.ownerEmail;
        }
      }
      // 3. Otherwise the acting user's mailbox, carrying the address as an alias.
      if (!entry) {
        const mine = (await sendAsListOf(client)) ?? [];
        senderEmail = primaryOf(mine) || senderEmail;
        entry = usableEntry(mine, fromEmail);
      }
    }
  } catch (err) {
    if (err instanceof DragApiError && err.code === 403) throw err; // AI turned off for the team, or no permission
    throw new DragApiError(
      `Couldn't check which address board ${boardId} sends from, so nothing was sent. Try again in a moment.`,
      503,
    );
  }

  if (!entry) {
    throw new DragApiError(
      `Board "${identity.boardName || boardId}" sends as ${fromEmail}, but ${senderEmail || "your Gmail account"} can't send as that address (it isn't one of its Gmail "Send mail as" addresses), so nothing was sent. Add it in Gmail under Settings > Accounts > "Send mail as", or send from a different board.`,
      422,
    );
  }

  const fromName = cleanText(entry.displayName) || (await teamNameFor(client, senderEmail || fromEmail));
  return {
    fromEmail,
    fromName,
    fromHeader: fromName ? `${fromName.replace(/[<>"]/g, "")} <${fromEmail}>` : fromEmail,
    boardId: Number(boardId),
    identity,
  };
}

/**
 * The team's own addresses, never the recipient of a reply: the board's
 * addresses, the acting user's send-as addresses and every teammate.
 */
export async function teamAddresses(client: DragClient, identity: BoardIdentity): Promise<string[]> {
  const out = new Set<string>([identity.replyAsEmail, identity.googleGroupEmail, identity.ownerEmail].filter(Boolean));
  const [mine, team] = await Promise.all([
    sendAsListOf(client).catch(() => []),
    client.get<TeamListResponse>("/v1.18/team/list").catch(() => ({ Response: [] }) as TeamListResponse),
  ]);
  for (const item of mine ?? []) {
    const address = bareAddress(item.sendAsEmail);
    if (address) out.add(address);
  }
  for (const member of team.Response ?? []) {
    const address = bareAddress(member.Email);
    if (address) out.add(address);
  }
  return [...out];
}
