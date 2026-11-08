import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { GotenbergClient, GotenbergError } from './gotenberg.client.js';

interface Seen {
  method: string | undefined;
  url: string | undefined;
  contentType: string | undefined;
  body: string;
}

let server: Server | undefined;

/** Starts a fake Gotenberg on a free local port and returns its base URL and the requests it saw. */
async function fake(
  handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void,
): Promise<{ baseUrl: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry: Seen = {
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(entry);
      handler(req, res, entry);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

afterEach(async () => {
  const s = server;
  server = undefined;
  if (!s) return;
  s.closeAllConnections();
  await new Promise<void>((resolve) => s.close(() => resolve()));
});

const unexpectedSuccess = (): never => {
  throw new Error('expected htmlToPdf to throw');
};

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2000, 7)]);
const limits = { timeoutMs: 2000, maxBytes: 100_000 };

describe('GotenbergClient.htmlToPdf', () => {
  it('posts index.html as multipart to the chromium html route and returns the bytes', async () => {
    const { baseUrl, seen } = await fake((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(PDF);
    });
    const pdf = await new GotenbergClient(baseUrl, limits).htmlToPdf('<p>héllo रू</p>');
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.equals(PDF)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('/forms/chromium/convert/html');
    expect(seen[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen[0]?.body).toContain('name="files"; filename="index.html"');
    expect(seen[0]?.body).toContain('<p>héllo रू</p>');
    // The page's own @page size wins over Gotenberg's Letter default.
    expect(seen[0]?.body).toContain('name="preferCssPageSize"');
  });

  it('tolerates a trailing slash on the base URL', async () => {
    const { baseUrl, seen } = await fake((_req, res) => res.end(PDF));
    await new GotenbergClient(`${baseUrl}/`, limits).htmlToPdf('<p>x</p>');
    expect(seen[0]?.url).toBe('/forms/chromium/convert/html');
  });

  it('throws on a non-2xx answer and names the status', async () => {
    const { baseUrl } = await fake((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('chromium crashed');
    });
    const error = await new GotenbergClient(baseUrl, limits)
      .htmlToPdf('<p>x</p>')
      .then(unexpectedSuccess, (e: unknown) => e as GotenbergError);
    expect(error).toBeInstanceOf(GotenbergError);
    expect(error).toMatchObject({ kind: 'http', status: 500 });
    expect(error.message).toContain('500');
  });

  it('throws when the server does not answer within the timeout', async () => {
    const { baseUrl } = await fake(() => {
      // Never respond.
    });
    const started = Date.now();
    const error = await new GotenbergClient(baseUrl, { timeoutMs: 150, maxBytes: 1000 })
      .htmlToPdf('<p>x</p>')

      .then(unexpectedSuccess, (e: unknown) => e as GotenbergError);
    expect(error).toBeInstanceOf(GotenbergError);
    expect(error).toMatchObject({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('throws when the body stalls after the headers (the timeout covers the whole read)', async () => {
    const { baseUrl } = await fake((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.write(Buffer.alloc(10, 1));
      // Never end.
    });
    const error = await new GotenbergClient(baseUrl, { timeoutMs: 150, maxBytes: 1000 })
      .htmlToPdf('<p>x</p>')

      .then(unexpectedSuccess, (e: unknown) => e as GotenbergError);
    expect(error).toMatchObject({ kind: 'timeout' });
  });

  it('throws when the declared size is over the cap, before reading the body', async () => {
    const { baseUrl } = await fake((_req, res) => {
      res.writeHead(200, { 'content-length': String(5000) });
      res.end(Buffer.alloc(5000, 1));
    });
    const error = await new GotenbergClient(baseUrl, { timeoutMs: 2000, maxBytes: 1000 })
      .htmlToPdf('<p>x</p>')

      .then(unexpectedSuccess, (e: unknown) => e as GotenbergError);
    expect(error).toBeInstanceOf(GotenbergError);
    expect(error).toMatchObject({ kind: 'too_large' });
  });

  it('throws when a chunked body without a length grows past the cap', async () => {
    const { baseUrl } = await fake((_req, res) => {
      res.writeHead(200, { 'transfer-encoding': 'chunked' });
      for (let i = 0; i < 10; i += 1) res.write(Buffer.alloc(400, 1));
      res.end();
    });
    const error = await new GotenbergClient(baseUrl, { timeoutMs: 2000, maxBytes: 1000 })
      .htmlToPdf('<p>x</p>')

      .then(unexpectedSuccess, (e: unknown) => e as GotenbergError);
    expect(error).toMatchObject({ kind: 'too_large' });
  });

  it('accepts a body of exactly the cap', async () => {
    const { baseUrl } = await fake((_req, res) => res.end(Buffer.alloc(1000, 1)));
    const pdf = await new GotenbergClient(baseUrl, { timeoutMs: 2000, maxBytes: 1000 }).htmlToPdf(
      '<p>x</p>',
    );
    expect(pdf.length).toBe(1000);
  });

  it('throws a network error when nothing listens', async () => {
    const { baseUrl } = await fake((_req, res) => res.end());
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const error = await new GotenbergClient(baseUrl, limits)
      .htmlToPdf('<p>x</p>')
      .then(unexpectedSuccess, (e: unknown) => e as GotenbergError);
    expect(error).toBeInstanceOf(GotenbergError);
    expect(error).toMatchObject({ kind: 'network' });
  });

  it('rejects nonsense limits', () => {
    expect(() => new GotenbergClient('http://x', { timeoutMs: 0, maxBytes: 10 })).toThrow();
    expect(() => new GotenbergClient('http://x', { timeoutMs: 10, maxBytes: 0 })).toThrow();
  });
});
