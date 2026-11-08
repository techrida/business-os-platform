// A small clamd client over a raw TCP socket (INSTREAM), about 100 lines instead of the unmaintained
// `clamscan` package. Serves NFR Security (every upload is scanned before anyone can download it) and
// Availability (a hung or crashed scanner turns into a verdict, never into a stuck request).
//
// Protocol (clamd man page): a command is "z<NAME>\0". INSTREAM is followed by chunks of
// <uint32 big-endian length><bytes> and ended by a zero-length chunk. clamd answers with one
// NUL-terminated line: "stream: OK", "stream: <Signature> FOUND" or "<message> ERROR".
import { connect, type Socket } from 'node:net';
import type { Readable } from 'node:stream';

export interface ClamdOptions {
  host: string;
  port: number;
  /** Silence limit in ms: no byte sent or received for this long ends the call. Default 60 s. */
  timeoutMs?: number;
}

export interface ScanResult {
  verdict: 'clean' | 'infected' | 'error';
  signature?: string;
  /** Why the verdict is `error` (a clamd message or a socket error). Never contains file content. */
  detail?: string;
  ms: number;
}

/** Slice size for INSTREAM chunks. clamd has no per-chunk limit, only StreamMaxLength for the total. */
const CHUNK_BYTES = 64 * 1024;
const OK = /^stream: OK$/;
const FOUND = /^stream: (.+) FOUND$/;

export class ClamdClient {
  private readonly timeoutMs: number;

  constructor(private readonly options: ClamdOptions) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.command('PING')) === 'PONG';
    } catch {
      return false;
    }
  }

  async version(): Promise<string> {
    return this.command('VERSION');
  }

  async scan(src: Readable): Promise<ScanResult> {
    const started = Date.now();
    const ms = () => Date.now() - started;
    try {
      const reply = await this.exchange(async (socket) => {
        await write(socket, Buffer.from('zINSTREAM\0'));
        for await (const piece of src) {
          const chunk = typeof piece === 'string' ? Buffer.from(piece) : (piece as Buffer);
          for (let at = 0; at < chunk.length; at += CHUNK_BYTES) {
            const slice = chunk.subarray(at, at + CHUNK_BYTES);
            const header = Buffer.alloc(4);
            header.writeUInt32BE(slice.length);
            await write(socket, Buffer.concat([header, slice]));
          }
        }
        await write(socket, Buffer.alloc(4)); // zero-length chunk: end of stream
      });
      if (OK.test(reply)) return { verdict: 'clean', ms: ms() };
      const found = FOUND.exec(reply);
      if (found?.[1] !== undefined) return { verdict: 'infected', signature: found[1], ms: ms() };
      // Anything else (an ERROR line, "INSTREAM size limit exceeded", an empty reply) is not a verdict on the file.
      return {
        verdict: 'error',
        detail: reply.slice(0, 200) || 'empty reply from clamd',
        ms: ms(),
      };
    } catch (error) {
      return { verdict: 'error', detail: describe(error), ms: ms() };
    }
  }

  private command(name: 'PING' | 'VERSION'): Promise<string> {
    return this.exchange((socket) => write(socket, Buffer.from(`z${name}\0`)));
  }

  /** Opens a connection, runs `send`, returns clamd's one-line reply. Always closes the socket. */
  private async exchange(send: (socket: Socket) => Promise<void>): Promise<string> {
    const socket = await this.open();
    try {
      const reply = readReply(socket);
      reply.catch(() => undefined); // read below; this only stops an early rejection being "unhandled"
      let sendError: unknown;
      try {
        await send(socket);
      } catch (error) {
        sendError = error;
      }
      if (sendError === undefined) return await reply;
      // The send failed. clamd may have answered first (for example "size limit exceeded" and then closed),
      // so give a reply that is already on the way a short moment before reporting the send error.
      const early = await Promise.race([reply.catch(() => ''), delay(300)]);
      if (typeof early === 'string' && early !== '') return early;
      throw sendError instanceof Error ? sendError : new Error(describe(sendError));
    } finally {
      socket.destroy();
    }
  }

  private open(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.options.host, port: this.options.port });
      socket.setTimeout(this.timeoutMs);
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once('error', fail);
      socket.once('timeout', () => fail(new Error('clamd connection timed out')));
      socket.once('connect', () => {
        socket.removeListener('error', fail);
        resolve(socket);
      });
    });
  }
}

function write(socket: Socket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    // The callback fires when the bytes are flushed, which is also the backpressure for a big file.
    socket.write(data, (error) => (error ? reject(error) : resolve()));
  });
}

/** Resolves with the reply text when clamd sends its NUL terminator or closes. Rejects on silence or a socket error. */
function readReply(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let settled = false;
    const text = () => Buffer.concat(parts).toString('utf8').split('\0')[0]?.trim() ?? '';
    const finish = (action: () => void) => {
      if (!settled) {
        settled = true;
        action();
      }
    };
    socket.on('data', (data: Buffer) => {
      parts.push(data);
      if (data.includes(0)) finish(() => resolve(text()));
    });
    socket.on('end', () => finish(() => resolve(text())));
    socket.on('close', () => finish(() => resolve(text())));
    socket.on('timeout', () => {
      finish(() => reject(new Error('clamd did not answer in time')));
      socket.destroy();
    });
    socket.on('error', (error) =>
      finish(() => (parts.length > 0 ? resolve(text()) : reject(error))),
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
