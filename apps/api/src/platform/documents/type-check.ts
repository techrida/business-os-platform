// Checks that the bytes of an upload really are the type the caller declared.
// Serves NFR Security: a renamed .exe declared as PDF is refused (415) before anything else touches it.
// This is not a virus scan (clamd does that); it stops wrong types and parser-confusion attacks.
import { createReadStream } from 'node:fs';

import { ALLOWED_MIME } from '@bos/contracts';

import { HEAD_BYTES } from './storage.adapter';

export type TypeCheckResult =
  { ok: true; detectedMime: string } | { ok: false; detectedMime: string | null; reason: string };

export function isAllowedMime(mime: string): boolean {
  return (ALLOWED_MIME as readonly string[]).includes(mime);
}

/**
 * Is the detected type acceptable for the declared one? Today only an exact match is. file-type already
 * reports docx, xlsx and pptx as their own types (not as application/zip), so they match exactly. A looser
 * rule would let a spreadsheet pass as a Word file, or a generic zip pass as any of them.
 */
function isCompatible(declared: string, detected: string): boolean {
  return declared === detected;
}

/** True when every byte sequence in the file is valid UTF-8. Streams, so a 25 MiB file costs little memory. */
async function isValidUtf8(path: string): Promise<boolean> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for await (const chunk of createReadStream(path)) {
      decoder.decode(chunk as Buffer, { stream: true });
    }
    decoder.decode(); // flushes: a file that ends in the middle of a character is invalid
    return true;
  } catch (error) {
    if (error instanceof TypeError) return false; // TextDecoder's fatal error for bad bytes
    throw error;
  }
}

/**
 * @param path the quarantined file
 * @param head the first bytes of the file (what StorageAdapter.writeQuarantine returned)
 * @param declaredMime what the client said at create time
 */
export async function checkType(
  path: string,
  head: Buffer,
  declaredMime: string,
): Promise<TypeCheckResult> {
  if (!isAllowedMime(declaredMime)) {
    return { ok: false, detectedMime: null, reason: `type ${declaredMime} is not allowed` };
  }
  // The dynamic import stays inside the function: file-type is ESM-only and this API is CommonJS (ADR 0003).
  const { fileTypeFromFile } = await import('file-type');
  const found = await fileTypeFromFile(path);

  if (declaredMime === 'text/csv') {
    // CSV has no magic number, so the rule is negative: nothing recognisable inside, no NUL byte in the first
    // 64 KB (binary data has them, text does not) and valid UTF-8 throughout.
    if (found !== undefined) {
      return { ok: false, detectedMime: found.mime, reason: `content is ${found.mime}, not CSV` };
    }
    if (head.subarray(0, HEAD_BYTES).includes(0)) {
      return {
        ok: false,
        detectedMime: null,
        reason: 'content has NUL bytes, so it is not CSV text',
      };
    }
    if (!(await isValidUtf8(path))) {
      return {
        ok: false,
        detectedMime: null,
        reason: 'content is not valid UTF-8, so it is not CSV',
      };
    }
    return { ok: true, detectedMime: 'text/csv' };
  }

  if (found === undefined) {
    return {
      ok: false,
      detectedMime: null,
      reason: `content is not recognisable as ${declaredMime}`,
    };
  }
  if (!isCompatible(declaredMime, found.mime)) {
    return {
      ok: false,
      detectedMime: found.mime,
      reason: `content is ${found.mime}, declared ${declaredMime}`,
    };
  }
  return { ok: true, detectedMime: found.mime };
}
