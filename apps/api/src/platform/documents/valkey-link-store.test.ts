// The signed-link claim against a Valkey that stalls or is not there. A tiny RESP server stands in for Valkey (none is
// installed on the dev machines): it applies SET and DEL, and can hold an answer back past the store's timeout.
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { LINK_STORE_TIMEOUT_MS, ValkeyLinkStore } from './valkey-link-store';

interface Fake {
  server: Server;
  port: number;
  keys: Map<string, string>;
  commands: string[];
  stallSets: boolean;
  sockets: Set<Socket>;
}

/** Parses RESP arrays out of a buffer; returns the commands and what is left. */
function parse(buffer: string): { commands: string[][]; rest: string } {
  const commands: string[][] = [];
  let rest = buffer;
  for (;;) {
    const m = /^\*(\d+)\r\n/.exec(rest);
    if (m === null) break;
    const count = Number(m[1]);
    let pos = m[0].length;
    const args: string[] = [];
    let complete = true;
    for (let i = 0; i < count; i += 1) {
      const h = /^\$(\d+)\r\n/.exec(rest.slice(pos));
      if (h === null) {
        complete = false;
        break;
      }
      const len = Number(h[1]);
      const start = pos + h[0].length;
      if (rest.length < start + len + 2) {
        complete = false;
        break;
      }
      args.push(rest.slice(start, start + len));
      pos = start + len + 2;
    }
    if (!complete) break;
    commands.push(args);
    rest = rest.slice(pos);
  }
  return { commands, rest };
}

async function startFake(port = 0): Promise<Fake> {
  const fake: Fake = {
    server: createServer(),
    port: 0,
    keys: new Map(),
    commands: [],
    stallSets: false,
    sockets: new Set(),
  };
  fake.server.on('connection', (socket) => {
    fake.sockets.add(socket);
    socket.on('close', () => fake.sockets.delete(socket));
    socket.on('error', () => undefined);
    let pending = '';
    socket.on('data', (chunk) => {
      const out = parse(pending + chunk.toString('utf8'));
      pending = out.rest;
      for (const args of out.commands) {
        const name = (args[0] ?? '').toUpperCase();
        fake.commands.push(name);
        if (name === 'SET') {
          const key = args[1] ?? '';
          const fresh = !fake.keys.has(key);
          if (fresh) fake.keys.set(key, args[2] ?? '');
          const reply = fresh ? '+OK\r\n' : '$-1\r\n';
          // Applied now, answered late: the case where the client times out on a command the server ran.
          if (fake.stallSets) setTimeout(() => socket.write(reply), LINK_STORE_TIMEOUT_MS + 700);
          else socket.write(reply);
        } else if (name === 'EVAL') {
          // The release script: delete args[3] only when it holds args[4].
          const held = fake.keys.get(args[3] ?? '');
          const mine = held !== undefined && held === args[4];
          if (mine) fake.keys.delete(args[3] ?? '');
          socket.write(`:${mine ? 1 : 0}\r\n`);
        } else if (name === 'DEL') {
          socket.write(`:${fake.keys.delete(args[1] ?? '') ? 1 : 0}\r\n`);
        } else if (name === 'INFO' || name === 'CLIENT') {
          socket.write(name === 'INFO' ? '$0\r\n\r\n' : '+OK\r\n');
        } else socket.write('+OK\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => fake.server.listen(port, '127.0.0.1', resolve));
  fake.port = (fake.server.address() as AddressInfo).port;
  return fake;
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function fakeAndStore(port = 0): Promise<{ fake: Fake; store: ValkeyLinkStore }> {
  const fake = await startFake(port);
  const store = new ValkeyLinkStore(`redis://127.0.0.1:${fake.port}`);
  open.push(async () => {
    store.onApplicationShutdown();
    for (const s of fake.sockets) s.destroy();
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });
  return { fake, store };
}

describe('ValkeyLinkStore.claim', () => {
  it('claims once and refuses the second claim', async () => {
    const { store } = await fakeAndStore();
    await expect(store.claim('dl:a', 60)).resolves.toBe(true);
    await expect(store.claim('dl:a', 60)).resolves.toBe(false);
  });

  it('gives the link back when the SET ran but its answer came too late', async () => {
    const { fake, store } = await fakeAndStore();
    await expect(store.claim('dl:warm', 60)).resolves.toBe(true);
    fake.stallSets = true;
    await expect(store.claim('dl:slow', 60)).rejects.toThrow();
    expect(fake.keys.has('dl:slow')).toBe(false);
    fake.stallSets = false;
    await expect(store.claim('dl:slow', 60)).resolves.toBe(true);
  }, 15_000);

  it("keeps an earlier request's claim when a later claim on the same link times out", async () => {
    const { fake, store } = await fakeAndStore();
    await expect(store.claim('dl:used', 60)).resolves.toBe(true);
    fake.stallSets = true;
    await expect(store.claim('dl:used', 60)).rejects.toThrow();
    fake.stallSets = false;
    expect(fake.keys.has('dl:used')).toBe(true);
    await expect(store.claim('dl:used', 60)).resolves.toBe(false);
  }, 15_000);

  it('applies no SET after the fact when Valkey was unreachable at claim time', async () => {
    const down = await startFake();
    const { port } = down;
    await new Promise<void>((resolve) => down.server.close(() => resolve()));
    const store = new ValkeyLinkStore(`redis://127.0.0.1:${port}`);
    open.push(() => Promise.resolve(store.onApplicationShutdown()));

    await expect(store.claim('dl:gone', 60)).rejects.toThrow();

    // Valkey comes back on the same port: nothing queued while it was away may reach it.
    const back = await startFake(port);
    open.push(async () => {
      for (const s of back.sockets) s.destroy();
      await new Promise<void>((resolve) => back.server.close(() => resolve()));
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(back.keys.has('dl:gone')).toBe(false);
    expect(back.commands).not.toContain('SET');
  }, 15_000);
});
