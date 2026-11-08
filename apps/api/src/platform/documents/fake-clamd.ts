// A fake clamd for tests (U4 and U8 use it): speaks the real INSTREAM protocol over TCP, so the real
// ClamdClient is exercised end to end without a 1.2 GiB ClamAV. NOT imported by production code.
//
// It answers FOUND when the EICAR test bytes appear anywhere in the stream, even when the sender split them
// across chunks (it joins the chunks first, like clamd does), and has a "hang" mode for the timeout test.
//
// The EICAR string is never written out in this repository: Windows Defender quarantines any file on F:
// that contains it. These are the bytes, reversed and base64-encoded, so no scanner sees the text.
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

const EICAR_REVERSED_B64 =
  '=oCSrgEJhUETJZULUNVRU1yUVJVSWlEVOFULEJVQE5UQUNVLSF0QJVEJ9dTKDN0Np4FUoQTNYpFUcRzWQFEQlAVIPVDW';

/** The 68 EICAR test bytes. Write them only to memory or to a WSL tmp dir, never to the Windows tree. */
export const eicarBytes = (): Buffer =>
  Buffer.from(EICAR_REVERSED_B64.split('').reverse().join(''), 'base64');

export type FakeClamdMode =
  /** Normal: OK, or FOUND when the stream holds the EICAR bytes. */
  | 'ok'
  /** Reads the whole stream and then never answers (for the timeout test). */
  | 'hang'
  /** Answers with an ERROR line instead of a verdict. */
  | 'error';

export interface FakeScanRecord {
  bytes: number;
  /** Size of each INSTREAM chunk as it arrived, to prove a split-chunk test really split. */
  chunkSizes: number[];
}

export interface FakeClamd {
  host: string;
  port: number;
  mode: FakeClamdMode;
  scans: FakeScanRecord[];
  close(): Promise<void>;
}

export const FAKE_CLAMD_SIGNATURE = 'Eicar-Test-Signature';
export const FAKE_CLAMD_VERSION = 'ClamAV 1.5.4-fake/27000/Mon Nov  8 00:00:00 2026';

export async function startFakeClamd(
  options: { mode?: FakeClamdMode; streamMaxBytes?: number } = {},
): Promise<FakeClamd> {
  const sockets = new Set<Socket>();
  const fake: FakeClamd = {
    host: '127.0.0.1',
    port: 0,
    mode: options.mode ?? 'ok',
    scans: [],
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
  const maxBytes = options.streamMaxBytes ?? 30 * 1024 * 1024;

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);

    let pending = Buffer.alloc(0);
    let phase: 'command' | 'stream' = 'command';
    const chunks: Buffer[] = [];
    const record: FakeScanRecord = { bytes: 0, chunkSizes: [] };

    const reply = (line: string) => socket.end(`${line}\0`);

    const finishStream = () => {
      fake.scans.push(record);
      if (fake.mode === 'hang') return;
      if (fake.mode === 'error') return reply('lookup failed ERROR');
      const found = Buffer.concat(chunks).includes(eicarBytes());
      reply(found ? `stream: ${FAKE_CLAMD_SIGNATURE} FOUND` : 'stream: OK');
    };

    const pump = () => {
      for (;;) {
        if (phase === 'command') {
          const end = pending.indexOf(0);
          if (end === -1) return;
          const name = pending.subarray(0, end).toString('utf8').replace(/^[zn]/, '');
          pending = pending.subarray(end + 1);
          if (name === 'PING') return reply('PONG');
          if (name === 'VERSION') return reply(FAKE_CLAMD_VERSION);
          if (name === 'INSTREAM') {
            phase = 'stream';
            continue;
          }
          return reply('UNKNOWN COMMAND');
        }
        if (pending.length < 4) return;
        const length = pending.readUInt32BE(0);
        if (length === 0) return finishStream();
        if (pending.length < 4 + length) return;
        chunks.push(pending.subarray(4, 4 + length));
        record.bytes += length;
        record.chunkSizes.push(length);
        pending = pending.subarray(4 + length);
        if (record.bytes > maxBytes) return reply('INSTREAM size limit exceeded. ERROR');
      }
    };

    socket.on('data', (data: Buffer) => {
      pending = Buffer.concat([pending, data]);
      pump();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = (server.address() as AddressInfo).port;
  return fake;
}
