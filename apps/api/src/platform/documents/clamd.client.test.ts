// ClamdClient against the fake clamd (same wire protocol as the real one).
// EICAR comes from fake-clamd.ts's helper and stays in memory.
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { ClamdClient } from './clamd.client';
import {
  FAKE_CLAMD_SIGNATURE,
  FAKE_CLAMD_VERSION,
  eicarBytes,
  startFakeClamd,
  type FakeClamd,
} from './fake-clamd';

let fake: FakeClamd | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function client(mode?: 'ok' | 'hang' | 'error', timeoutMs = 2_000) {
  fake = await startFakeClamd(mode === undefined ? {} : { mode });
  return new ClamdClient({ host: fake.host, port: fake.port, timeoutMs });
}

describe('ClamdClient', () => {
  it('ping and version', async () => {
    const c = await client();
    expect(await c.ping()).toBe(true);
    expect(await c.version()).toBe(FAKE_CLAMD_VERSION);
  });

  it('says clean for ordinary bytes', async () => {
    const c = await client();
    const result = await c.scan(Readable.from([Buffer.from('just a harmless file')]));
    expect(result).toMatchObject({ verdict: 'clean' });
    expect(fake?.scans[0]?.bytes).toBe(20);
  });

  it('says infected, with the signature, for the EICAR bytes', async () => {
    const c = await client();
    const result = await c.scan(Readable.from([eicarBytes()]));
    expect(result).toMatchObject({ verdict: 'infected', signature: FAKE_CLAMD_SIGNATURE });
  });

  it('still finds EICAR when it is split across chunks', async () => {
    const c = await client();
    const eicar = eicarBytes();
    const cut = 31; // inside the string
    const result = await c.scan(
      Readable.from([
        Buffer.from('prefix-'),
        eicar.subarray(0, cut),
        eicar.subarray(cut),
        Buffer.from('-suffix'),
      ]),
    );
    expect(result).toMatchObject({ verdict: 'infected', signature: FAKE_CLAMD_SIGNATURE });
    // Proof that the split really reached clamd as separate chunks (it is not the client gluing them back).
    expect(fake?.scans[0]?.chunkSizes.length).toBeGreaterThanOrEqual(4);
    expect(fake?.scans[0]?.chunkSizes).toContain(cut);
  });

  it('streams a file bigger than one chunk in order', async () => {
    const c = await client();
    const big = Buffer.alloc(5 * 1024 * 1024, 7);
    const result = await c.scan(Readable.from([big]));
    expect(result.verdict).toBe('clean');
    expect(fake?.scans[0]?.bytes).toBe(big.length);
    expect(Math.max(...(fake?.scans[0]?.chunkSizes ?? []))).toBeLessThanOrEqual(64 * 1024);
  });

  it('turns a hung scanner into an error verdict within the timeout', async () => {
    const c = await client('hang', 300);
    const started = Date.now();
    const result = await c.scan(Readable.from([Buffer.from('x')]));
    expect(result.verdict).toBe('error');
    expect(result.detail).toMatch(/did not answer in time/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('turns a clamd ERROR line into an error verdict (never clean)', async () => {
    const c = await client('error');
    const result = await c.scan(Readable.from([Buffer.from('x')]));
    expect(result.verdict).toBe('error');
    expect(result.detail).toContain('ERROR');
  });

  it('reports the size-limit reply as an error verdict', async () => {
    fake = await startFakeClamd({ streamMaxBytes: 1024 });
    const c = new ClamdClient({ host: fake.host, port: fake.port, timeoutMs: 2_000 });
    const result = await c.scan(Readable.from([Buffer.alloc(200 * 1024)]));
    expect(result.verdict).toBe('error');
    expect(result.detail).toMatch(/size limit/);
  });

  it('turns a refused connection into an error verdict, and ping into false', async () => {
    const dead = await startFakeClamd();
    const { port } = dead;
    await dead.close(); // nobody listens on this port any more
    const c = new ClamdClient({ host: '127.0.0.1', port, timeoutMs: 500 });
    expect((await c.scan(Readable.from([Buffer.from('x')]))).verdict).toBe('error');
    expect(await c.ping()).toBe(false);
  });

  it('turns a source stream that fails into an error verdict', async () => {
    const c = await client();
    async function* broken(): AsyncGenerator<Buffer> {
      yield Buffer.from('start');
      await Promise.resolve();
      throw new Error('disk read failed');
    }
    const result = await c.scan(Readable.from(broken()));
    expect(result.verdict).toBe('error');
    expect(result.detail).toBe('disk read failed');
  });
});
