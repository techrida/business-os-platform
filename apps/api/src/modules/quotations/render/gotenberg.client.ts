// A small client for Gotenberg's Chromium HTML-to-PDF route. Serves the NFR "a render can never hang or
// exhaust memory": one timeout covers the request and the whole body read, and the body is read as a stream
// that stops at `maxBytes`. It uses Node's global fetch and FormData, so it adds no dependency.
import type { ReadableStreamDefaultReader } from 'node:stream/web';

export interface GotenbergOptions {
  /** One deadline for the request and the full response body. */
  timeoutMs: number;
  /** The most response bytes accepted; a bigger PDF is an error, not a truncated file. */
  maxBytes: number;
}

export type GotenbergErrorKind = 'http' | 'timeout' | 'too_large' | 'network';

export class GotenbergError extends Error {
  constructor(
    message: string,
    readonly kind: GotenbergErrorKind,
    /** The HTTP status, for kind 'http'. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GotenbergError';
  }
}

const HTML_ROUTE = '/forms/chromium/convert/html';

export class GotenbergClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly options: GotenbergOptions,
  ) {
    if (!(options.timeoutMs > 0)) throw new RangeError('timeoutMs must be above zero');
    if (!(options.maxBytes > 0)) throw new RangeError('maxBytes must be above zero');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Converts one self-contained HTML page to a PDF. Throws GotenbergError; never returns a partial file. */
  async htmlToPdf(html: string): Promise<Buffer> {
    const { timeoutMs, maxBytes } = this.options;
    const form = new FormData();
    form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
    // Gotenberg prints on Letter unless told to follow the page's own `@page { size: A4 }`.
    form.append('preferCssPageSize', 'true');
    form.append('printBackground', 'true');

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${HTML_ROUTE}`, {
          method: 'POST',
          body: form,
          signal: controller.signal,
        });
      } catch (error) {
        throw this.asNetworkOrTimeout(error, timedOut);
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new GotenbergError(
          `Gotenberg answered ${response.status} ${response.statusText}`.trim(),
          'http',
          response.status,
        );
      }

      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new GotenbergError(
          `Gotenberg response of ${declared} bytes is over the ${maxBytes} byte cap`,
          'too_large',
        );
      }

      return await this.readCapped(response, maxBytes, () => timedOut);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readCapped(
    response: Response,
    maxBytes: number,
    wasTimeout: () => boolean,
  ): Promise<Buffer> {
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new GotenbergError(
            `Gotenberg response is over the ${maxBytes} byte cap`,
            'too_large',
          );
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    } catch (error) {
      if (error instanceof GotenbergError) throw error;
      throw this.asNetworkOrTimeout(error, wasTimeout());
    }
    return Buffer.concat(chunks, total);
  }

  private asNetworkOrTimeout(error: unknown, timedOut: boolean): GotenbergError {
    if (timedOut) {
      return new GotenbergError(
        `Gotenberg did not finish within ${this.options.timeoutMs} ms`,
        'timeout',
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    return new GotenbergError(`Gotenberg request failed: ${reason}`, 'network');
  }
}
