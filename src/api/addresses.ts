/**
 * Email address helpers shared by the sender and recipient rules.
 *
 * A header such as To or Reply-To is an RFC 5322 address list: quoted display
 * names may contain commas ("Last, First" <a@b.com>), so a list is parsed, never
 * split on commas.
 */

/** A value read from the API that may be null, empty or the literal string "null". */
export function cleanText(value: unknown): string {
  const text = value == null ? "" : String(value).trim();
  return text && text.toLowerCase() !== "null" ? text : "";
}

/** A bare, lower-cased address, or "" when the value holds none. */
export function bareAddress(value: unknown): string {
  const text = cleanText(value);
  const angle = text.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  if (angle) return angle[1].toLowerCase();
  const plain = text.match(/[^\s<>",;]+@[^\s<>",;]+/);
  return plain ? plain[0].toLowerCase() : "";
}

/**
 * Every mailbox in an address-list header, as written ("Name <a@b.com>" or
 * "a@b.com"). Commas inside quotes or angle brackets do not split.
 */
export function splitAddressList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const raw of values) {
    const text = cleanText(raw);
    if (!text) continue;
    let current = "";
    let quoted = false;
    let angle = 0;
    for (const ch of text) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === "<") angle += 1;
      else if (!quoted && ch === ">") angle = Math.max(0, angle - 1);
      if ((ch === "," || ch === ";") && !quoted && angle === 0) {
        if (current.trim()) out.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.trim()) out.push(current.trim());
  }
  return out.filter((entry) => bareAddress(entry) !== "");
}

/** Every bare, lower-cased address in one or more address-list values. */
export function addressesIn(...values: unknown[]): string[] {
  return values.flatMap((value) => splitAddressList(value).map(bareAddress)).filter(Boolean);
}

const NO_REPLY_MARKERS = [
  "donotreply@",
  "do-not-reply@",
  "noreply@",
  "no-reply@",
  "mailer-daemon@",
  "postmaster@outlook.com",
  "mail delivery subsystem",
];

/** An address no reply should ever go to. */
export function isNoReplyAddress(value: unknown): boolean {
  const text = cleanText(value).toLowerCase();
  return NO_REPLY_MARKERS.some((marker) => text.includes(marker));
}
