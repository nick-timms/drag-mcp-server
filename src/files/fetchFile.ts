import { DragApiError } from "../api/client.js";

/**
 * Download one file from DragApp's file storage: HTTPS only, storage hosts
 * only, no redirects, and cut off at `maxBytes` so a large file can't run away
 * with memory.
 */

const STORAGE_HOST = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;

export function isStorageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && STORAGE_HOST.test(parsed.hostname) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export async function fetchStorageFile(
  url: string,
  maxBytes: number,
): Promise<{ data: Buffer; contentType: string | null }> {
  if (!isStorageUrl(url)) throw new DragApiError("That file is not stored in DragApp's file storage, so it wasn't opened.", 400);

  let response: Response;
  try {
    response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new DragApiError(`The file could not be downloaded (${(err as Error)?.message ?? "network error"}).`, 502);
  }
  if (!response.ok) throw new DragApiError(`The file could not be downloaded (storage answered ${response.status}).`, 502);

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DragApiError(`The file is too large to read (${Math.round(declared / 1048576)} MB; the limit is ${maxBytes / 1048576} MB).`, 413);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new DragApiError("The file could not be downloaded (empty response).", 502);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DragApiError(`The file is too large to read (the limit is ${maxBytes / 1048576} MB).`, 413);
    }
    chunks.push(value);
  }
  return { data: Buffer.concat(chunks.map((c) => Buffer.from(c))), contentType: response.headers.get("content-type") };
}
