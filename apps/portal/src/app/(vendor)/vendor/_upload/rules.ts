import { ALLOWED_MIME, MAX_UPLOAD_BYTES } from '@bos/contracts';

/**
 * Which files the vendor portal accepts for KYC documents and bills: the contract's allowed list
 * narrowed to what a scan or a statement is, a PDF or a picture. The API checks the detected type
 * and the size again; this only spares the vendor an upload that would be refused. The same rules
 * run in the browser (before an upload starts) and in the upload route (before anything is sent on).
 */
export const UPLOAD_MIME: readonly string[] = ALLOWED_MIME.filter(
  (m) => m === 'application/pdf' || m.startsWith('image/'),
);

/** The `accept` attribute for the file picker. */
export const UPLOAD_ACCEPT = UPLOAD_MIME.join(',');

const MiB = 1024 * 1024;

/** The reason a file cannot be sent, in words for the vendor, or null when it can. */
export function fileProblem(file: { name: string; type: string; size: number }): string | null {
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (file.name.trim() === '' || /[/\\\u0000-\u001f\u007f]/.test(file.name)) {
    return 'This file has no usable name. Rename it and try again.';
  }
  if (!UPLOAD_MIME.includes(file.type)) {
    return `${file.name} is not a PDF or a picture (PNG, JPEG or WebP).`;
  }
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > MAX_UPLOAD_BYTES) {
    return `${file.name} is larger than ${Math.floor(MAX_UPLOAD_BYTES / MiB)} MB.`;
  }
  return null;
}
