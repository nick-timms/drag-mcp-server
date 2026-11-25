import { DragApiError, type DragClient } from "./client.js";
import { bareAddress, cleanText } from "./addresses.js";

/**
 * WHO A CARD CAN BE ASSIGNED TO.
 *
 * Being invited to a board is not having a DragApp account, and an assignment
 * is stored against an account: assigning someone who was invited but never
 * signed in, or a name, or the board's Google Group address, used to fail on
 * the server AFTER the bad value had been written onto the card. So every
 * assignee is checked here first, against the board's member list (the same
 * list the app's member settings show and DragApp's in-app assistant checks):
 *   - the owner and invitees with an account can be assigned;
 *   - an invitee with no account yet is refused, with what to do;
 *   - the board's Google Group address is refused: it is not a person.
 * A name (no "@") is matched to one member's full name or first name; a name
 * that matches several members is refused with their addresses.
 */

interface InvitationRow {
  Name?: string | null;
  InviteEmail?: string | null;
  UserEmail?: string | null;
  IsGoogleGroupEmail?: string | number | boolean | null;
  IsOwner?: string | number | boolean | null;
}

const truthy = (value: unknown) => value === true || Number(value) === 1 || String(value).toLowerCase() === "true";

/** The board's member rows, or null when they can't be read (the assignment then goes ahead unchecked, as before). */
export async function boardMemberRows(client: DragClient, boardId: number): Promise<InvitationRow[] | null> {
  try {
    const rows = await client.post<InvitationRow[]>("/v1.18/teamBoard/invitation/list", { boardId });
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

const emailOf = (row: InvitationRow) => bareAddress(row.UserEmail) || bareAddress(row.InviteEmail);

function describe(rows: InvitationRow[]): string {
  return rows
    .filter((row) => !truthy(row.IsGoogleGroupEmail))
    .map((row) => (cleanText(row.Name) ? `${cleanText(row.Name)} <${emailOf(row)}>` : emailOf(row)))
    .filter(Boolean)
    .join(", ");
}

/** The member a value (email or name) means, or an error saying why it can't be assigned. */
export function checkAssignee(rows: InvitationRow[], value: string, boardId: number): string {
  const wanted = cleanText(value);
  let member: InvitationRow | undefined;

  if (wanted.includes("@")) {
    const key = bareAddress(wanted);
    member = rows.find((row) => bareAddress(row.UserEmail) === key || bareAddress(row.InviteEmail) === key);
    if (!member) {
      throw new DragApiError(
        `${key} is not a member of board ${boardId}, so nothing was changed. Members: ${describe(rows) || "none listed"}.`,
        400,
      );
    }
  } else {
    const name = wanted.toLowerCase();
    const people = rows.filter((row) => !truthy(row.IsGoogleGroupEmail) && cleanText(row.Name));
    const full = people.filter((row) => cleanText(row.Name).toLowerCase() === name);
    const first = people.filter((row) => cleanText(row.Name).toLowerCase().split(/\s+/)[0] === name);
    const matches = full.length ? full : first;
    if (matches.length === 0) {
      throw new DragApiError(
        `No member of board ${boardId} is called "${wanted}", so nothing was changed. Assign by email address. Members: ${describe(rows) || "none listed"}.`,
        400,
      );
    }
    if (matches.length > 1) {
      throw new DragApiError(
        `More than one member of board ${boardId} is called "${wanted}", so nothing was changed. Ask the user which one: ${describe(matches)}.`,
        400,
      );
    }
    member = matches[0];
  }

  const email = emailOf(member);
  if (truthy(member.IsGoogleGroupEmail)) {
    throw new DragApiError(
      `${email} is this board's Google Group address, not a person, so cards can't be assigned to it. Nothing was changed; ask the user which person should take it.`,
      400,
    );
  }
  const hasAccount = truthy(member.IsOwner) || bareAddress(member.UserEmail) !== "";
  if (!hasAccount) {
    throw new DragApiError(
      `${email} has been invited to this board but hasn't created a DragApp account yet, so cards can't be assigned to them. Nothing was changed. Ask them to sign in to DragApp with that address, then try again, or assign someone else.`,
      400,
    );
  }
  return email;
}

/**
 * Check and resolve a list of assignees for a board. An empty list (unassign)
 * is not checked. When the member list can't be read, the values go ahead as
 * given, as before.
 */
export async function resolveAssignees(client: DragClient, boardId: number | undefined, values: string[]): Promise<string[]> {
  const wanted = values.map((v) => cleanText(v)).filter(Boolean);
  if (!wanted.length || boardId === undefined || !Number.isInteger(Number(boardId))) return wanted;
  const rows = await boardMemberRows(client, Number(boardId));
  if (!rows || !rows.length) return wanted;
  return [...new Set(wanted.map((value) => checkAssignee(rows, value, Number(boardId))))];
}
