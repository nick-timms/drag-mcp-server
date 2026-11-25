/**
 * IMAGES IN A CARD'S NOTE.
 *
 * A card's note is HTML. A picture pasted into it is uploaded to DragApp's
 * file storage and the note holds an <img> pointing at it, in one exact shape:
 *   https://<storage-host>.s3.amazonaws.com/shared-file/<id>.<ext>
 * Only that shape is ever fetched. Anything else in a note (another host,
 * http, data: or javascript: URLs, query strings, other paths) is ignored, and
 * the URL fetched is rebuilt from the matched host and file, never taken from
 * the note as written, so a note cannot point the server anywhere else.
 *
 * DRAG_FILES_HOST, when set, restricts the storage host to that one name.
 */

export interface NoteImageRef {
  /** 1-based number, in the order the images appear in the note. */
  image: number;
  name: string;
}

const SHAPE = /^https:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\.s3\.amazonaws\.com\/shared-file\/([A-Za-z0-9-]{8,64})\.([A-Za-z0-9]{1,5})$/;

function allowedHost(bucket: string): boolean {
  const only = process.env.DRAG_FILES_HOST?.trim().toLowerCase();
  return !only || only === `${bucket}.s3.amazonaws.com`;
}

interface FoundImage {
  url: string;
  name: string;
}

function decodeEntities(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** Every allowed image in a note, in order, with the URL rebuilt from its parts. */
function findImages(noteHtml: unknown): FoundImage[] {
  if (typeof noteHtml !== "string" || !noteHtml.includes("<img")) return [];
  const out: FoundImage[] = [];
  for (const tag of noteHtml.match(/<img\b[^>]*>/gi) ?? []) {
    const src = tag.match(/\bsrc\s*=\s*("([^"]*)"|'([^']*)')/i);
    const raw = decodeEntities((src?.[2] ?? src?.[3] ?? "").trim());
    const parts = raw.match(SHAPE);
    if (!parts) continue;
    const [, bucket, id, ext] = parts;
    if (!allowedHost(bucket)) continue;
    const alt = tag.match(/\balt\s*=\s*("([^"]*)"|'([^']*)')/i);
    const altText = decodeEntities((alt?.[2] ?? alt?.[3] ?? "").trim());
    out.push({
      url: `https://${bucket}.s3.amazonaws.com/shared-file/${id}.${ext.toLowerCase()}`,
      name: altText || `image-${out.length + 1}.${ext.toLowerCase()}`,
    });
  }
  return out;
}

/** The images a note holds, numbered for read_note_image. */
export function noteImageRefs(noteHtml: unknown): NoteImageRef[] {
  return findImages(noteHtml).map((found, index) => ({ image: index + 1, name: found.name }));
}

/** The image numbered `n` in a note, or null. */
export function noteImageAt(noteHtml: unknown, n: number): FoundImage | null {
  return findImages(noteHtml)[n - 1] ?? null;
}
