// Where uploaded bytes live: FILES_ROOT/{quarantine,clean}/<tenantId>/<versionId> on the files volume.
// Serves NFR Security (an unscanned file sits in a folder nothing serves from) and Reliability (a file is
// moved into clean/ with one atomic rename, so a reader never sees a half-written clean file).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const STORAGE_ADAPTER = Symbol('STORAGE_ADAPTER');

/** How much of the file's start is kept for the type check (CSV rule: no NUL byte in the first 64 KB). */
export const HEAD_BYTES = 64 * 1024;

/** The stream carried more bytes than the cap. Thrown while streaming, so the rest is never written. */
export class PayloadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`upload is larger than ${maxBytes} bytes`);
    this.name = 'PayloadTooLargeError';
  }
}

export class StoredFileNotFoundError extends Error {
  constructor() {
    super('stored file not found');
    this.name = 'StoredFileNotFoundError';
  }
}

export interface StorageAdapter {
  /** Streams `src` into quarantine, counting bytes and hashing as it goes. Throws PayloadTooLargeError over the cap. */
  writeQuarantine(
    key: string,
    src: Readable,
    maxBytes: number,
  ): Promise<{ bytes: number; sha256: Buffer; head: Buffer }>;
  commitQuarantine(stageKey: string, versionKey: string): Promise<void>;
  /** Moves quarantine/<key> to clean/<key>. Safe to repeat (a retried job finds it already moved). */
  promote(key: string): Promise<void>;
  openClean(key: string): Promise<Readable>;
  quarantinePath(key: string): string;
  removeQuarantine(key: string): Promise<void>;
  /** Deletes clean/<key>; fine on a missing file. Only for bytes that were never served (a generated file refused). */
  removeClean(key: string): Promise<void>;
}

// "<uuid>/<uuid>" and nothing else: the key becomes a path, so this is also the path-traversal guard.
const KEY = /^[0-9a-f]{8}-[0-9a-f-]{27}\/[0-9a-f]{8}-[0-9a-f-]{27}$/i;

function safeKey(key: string): string {
  if (!KEY.test(key)) throw new Error('invalid storage key');
  return key;
}

export class DiskStorageAdapter implements StorageAdapter {
  constructor(private readonly root: string) {}

  quarantinePath(key: string): string {
    return join(this.root, 'quarantine', safeKey(key));
  }

  private cleanPath(key: string): string {
    return join(this.root, 'clean', safeKey(key));
  }

  async writeQuarantine(
    key: string,
    src: Readable,
    maxBytes: number,
  ): Promise<{ bytes: number; sha256: Buffer; head: Buffer }> {
    const finalPath = this.quarantinePath(key);
    // Written under a temporary name and renamed at the end, so quarantinePath() only ever exists whole.
    const partPath = `${finalPath}.part`;
    await mkdir(dirname(finalPath), { recursive: true });

    const hash = createHash('sha256');
    const head: Buffer[] = [];
    let headLength = 0;
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          // Fail before the chunk is written: a hostile sender cannot fill the disk past the cap.
          callback(new PayloadTooLargeError(maxBytes));
          return;
        }
        hash.update(chunk);
        if (headLength < HEAD_BYTES) {
          const slice = chunk.subarray(0, HEAD_BYTES - headLength);
          head.push(slice);
          headLength += slice.length;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(src, counter, createWriteStream(partPath, { flags: 'w', mode: 0o640 }));
      await rename(partPath, finalPath);
    } catch (error) {
      await rm(partPath, { force: true });
      throw error;
    }
    return { bytes, sha256: hash.digest(), head: Buffer.concat(head) };
  }

  commitQuarantine(stageKey: string, versionKey: string): Promise<void> {
    return rename(this.quarantinePath(stageKey), this.quarantinePath(versionKey));
  }

  async promote(key: string): Promise<void> {
    const from = this.quarantinePath(key);
    const to = this.cleanPath(key);
    await mkdir(dirname(to), { recursive: true });
    try {
      await rename(from, to);
    } catch (error) {
      // A retried job after a crash between the rename and the database update: already moved is fine.
      if (isNotFound(error) && (await exists(to))) return;
      throw error;
    }
  }

  async openClean(key: string): Promise<Readable> {
    const path = this.cleanPath(key);
    if (!(await exists(path))) throw new StoredFileNotFoundError();
    return createReadStream(path);
  }

  async removeQuarantine(key: string): Promise<void> {
    await rm(this.quarantinePath(key), { force: true });
  }

  async removeClean(key: string): Promise<void> {
    await rm(this.cleanPath(key), { force: true });
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
