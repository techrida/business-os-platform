// DiskStorageAdapter on a real temp dir: hashing, the byte cap, promote, and the path guard.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  HEAD_BYTES,
  DiskStorageAdapter,
  PayloadTooLargeError,
  StoredFileNotFoundError,
} from './storage.adapter';

const MAX = 26_214_400; // 25 MiB, MAX_UPLOAD_BYTES

let root: string;
let storage: DiskStorageAdapter;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bos-storage-'));
  storage = new DiskStorageAdapter(root);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const newKey = () => `${randomUUID()}/${randomUUID()}`;
/** `count` bytes of one value, in 1 MiB chunks, without ever holding the whole thing. */
function repeat(count: number, value = 1): Readable {
  return Readable.from(
    (function* () {
      let left = count;
      while (left > 0) {
        const size = Math.min(left, 1024 * 1024);
        yield Buffer.alloc(size, value);
        left -= size;
      }
    })(),
  );
}

describe('DiskStorageAdapter', () => {
  it('stores the bytes, and the returned SHA-256, byte count and head match', async () => {
    const data = randomBytes(300 * 1024);
    const key = newKey();
    const written = await storage.writeQuarantine(
      key,
      Readable.from([data.subarray(0, 100_000), data.subarray(100_000)]),
      MAX,
    );
    expect(written.bytes).toBe(data.length);
    expect(written.sha256.toString('hex')).toBe(createHash('sha256').update(data).digest('hex'));
    expect(written.head.equals(data.subarray(0, HEAD_BYTES))).toBe(true);
    expect((await readFile(storage.quarantinePath(key))).equals(data)).toBe(true);
  });

  it('accepts exactly 25 MiB and refuses 25 MiB + 1 byte, leaving no file behind', async () => {
    const okKey = newKey();
    expect((await storage.writeQuarantine(okKey, repeat(MAX), MAX)).bytes).toBe(MAX);

    const badKey = newKey();
    await expect(storage.writeQuarantine(badKey, repeat(MAX + 1), MAX)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
    await expect(stat(storage.quarantinePath(badKey))).rejects.toMatchObject({ code: 'ENOENT' });
    const left = await readdir(join(root, 'quarantine', badKey.split('/')[0] ?? ''));
    expect(left.filter((f) => f.startsWith(badKey.split('/')[1] ?? '#'))).toEqual([]); // no .part either
  });

  it('removes the partial file when the source stream breaks', async () => {
    const key = newKey();
    const src = new Readable({
      read() {
        this.push(Buffer.from('some bytes'));
        this.destroy(new Error('connection reset'));
      },
    });
    await expect(storage.writeQuarantine(key, src, MAX)).rejects.toThrow('connection reset');
    await expect(stat(storage.quarantinePath(key))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('promote moves quarantine to clean; openClean reads it; promote can be repeated', async () => {
    const key = newKey();
    await storage.writeQuarantine(key, Readable.from([Buffer.from('hello')]), MAX);
    await storage.promote(key);
    await expect(stat(storage.quarantinePath(key))).rejects.toMatchObject({ code: 'ENOENT' });
    const chunks: Buffer[] = [];
    for await (const c of await storage.openClean(key)) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello');
    await expect(storage.promote(key)).resolves.toBeUndefined(); // a retried job after a crash
  });

  it('promote fails when the file is in neither folder; openClean says not found for quarantined files', async () => {
    await expect(storage.promote(newKey())).rejects.toMatchObject({ code: 'ENOENT' });
    const key = newKey();
    await storage.writeQuarantine(key, Readable.from([Buffer.from('x')]), MAX);
    await expect(storage.openClean(key)).rejects.toBeInstanceOf(StoredFileNotFoundError); // not clean yet
  });

  it('removeQuarantine deletes, and is fine on a missing file', async () => {
    const key = newKey();
    await storage.writeQuarantine(key, Readable.from([Buffer.from('x')]), MAX);
    await storage.removeQuarantine(key);
    await storage.removeQuarantine(key);
    await expect(stat(storage.quarantinePath(key))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removeClean deletes a promoted file, and is fine on a missing file', async () => {
    const key = newKey();
    await storage.writeQuarantine(key, Readable.from([Buffer.from('x')]), MAX);
    await storage.promote(key);
    await storage.removeClean(key);
    await storage.removeClean(key);
    await expect(storage.openClean(key)).rejects.toBeInstanceOf(StoredFileNotFoundError);
  });

  it('refuses keys that are not <uuid>/<uuid> (path traversal guard)', () => {
    for (const key of [
      '../../etc/passwd',
      `${randomUUID()}/../x`,
      `${randomUUID()}`,
      '',
      `${randomUUID()}/${randomUUID()}/extra`,
    ]) {
      expect(() => storage.quarantinePath(key)).toThrow('invalid storage key');
    }
  });
});
