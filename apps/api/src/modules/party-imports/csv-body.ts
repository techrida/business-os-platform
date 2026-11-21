// Reads the raw `text/csv` body of an import upload. The API's body parsers cap JSON at 16 KB and ignore other types, so
// the upload is read here, with its own 2 MB cap, and never touches a file or a bucket. The size is checked against the
// Content-Length first and again while reading, so a client that lies is cut off. A body that is not valid UTF-8 (an
// Excel "CSV" saved in a Windows code page) is refused with a message that says how to save it.
import { PARTY_IMPORT_MAX_BYTES } from '@bos/contracts';
import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Request } from 'express';

export async function readCsvBody(
  req: Pick<Request, 'headers'> & AsyncIterable<Buffer | string>,
  maxBytes: number = PARTY_IMPORT_MAX_BYTES,
): Promise<string> {
  const type = String(req.headers['content-type'] ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (type !== 'text/csv')
    throw new UnsupportedMediaTypeException({
      code: 'unsupported_media_type',
      message: 'Send the file as text/csv',
    });
  const tooLarge = () =>
    new PayloadTooLargeException({
      code: 'payload_too_large',
      message: 'The file is larger than 2 MB',
    });
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > maxBytes) throw tooLarge();
    chunks.push(buf);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new BadRequestException({
      code: 'bad_request',
      reason: 'import_file_invalid',
      message: 'The file is not UTF-8. Save it as "CSV UTF-8" and upload it again.',
    });
  }
}
