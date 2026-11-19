// Optional network isolation for the browser (Linux). Chromium aborts in-flight requests with
// net::ERR_NETWORK_CHANGED whenever the host's interfaces change (Docker networks of other stacks,
// DHCP renewals), which shows up as random "This page did not open" screens. Running Chromium in its
// own user+network namespace hides those events. The app is reached through a Unix socket:
//   Chromium -> 127.0.0.1:<port> (inside the namespace) -> socat -> <sock> -> socat -> 127.0.0.1:<port> (host)
// TLS still terminates at the stack's Caddy with its real certificate; nothing is decrypted here.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { onCleanup } from './cleanup.mjs';

function has(cmd) {
  try {
    execFileSync('sh', ['-c', 'command -v "$1"', 'sh', cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Paths written into the launcher scripts and socat addresses. Letters, digits and `/._-` only:
// no spaces, quotes, `$`, `,` or `:` (socat's address separators), so nothing in VIDEO_DIR or
// CHROMIUM_PATH can turn into shell syntax. The scripts also single-quote every path.
const SAFE_PATH = /^\/[A-Za-z0-9/._-]+$/;

export function assertShellSafePath(p, what) {
  if (typeof p !== 'string' || !SAFE_PATH.test(p))
    throw new Error(
      `${what} must be an absolute path of letters, digits and / . _ - only (got ${JSON.stringify(p)})`,
    );
  return p;
}

/** POSIX single quoting; paths are validated first, so this is a second line of defence. */
export const shq = (p) => `'${String(p).replace(/'/g, `'\\''`)}'`;

const loopback = (host) =>
  host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1';

/**
 * Only for stacks whose every origin is on this machine's loopback (e.g. *.testrun.localhost).
 * A non-loopback origin (a *.bos.test host, or a target allowed by ALLOW_NON_LOCAL_TARGET) is an
 * error unless NETNS=0 says to run without isolation: isolation is never turned off silently.
 */
export function netnsWanted(origins, value = process.env.NETNS ?? 'auto') {
  if (/^(0|false|no|off)$/i.test(value)) return false;
  const remote = origins.map((o) => new URL(o).hostname).filter((h) => !loopback(h));
  if (remote.length)
    throw new Error(
      `Network isolation (NETNS=${value}) needs every origin on loopback; ${remote.join(', ')} ` +
        'is not. Set NETNS=0 to run that stack without isolation.',
    );
  const ok = process.platform === 'linux' && has('unshare') && has('socat') && has('ip');
  if (!ok && value !== 'auto') throw new Error('NETNS=1 needs Linux with unshare, socat and ip');
  if (!ok)
    console.warn(
      'note: unshare, socat or ip is missing, so the browser runs without network isolation (NETNS=auto).',
    );
  return ok;
}

/**
 * Starts the host-side forwarders and writes a launcher script; returns { executablePath, stop }.
 * Playwright talks to the browser over inherited pipes, which pass through unshare unchanged.
 */
export function prepareNetns(dir, origins, realExecutable) {
  assertShellSafePath(dir, 'The network launcher folder (from VIDEO_DIR)');
  assertShellSafePath(realExecutable, "CHROMIUM_PATH (or Playwright's Chromium path)");
  mkdirSync(dir, { recursive: true });
  const ports = [
    ...new Set(
      origins
        .map((o) => new URL(o))
        .filter((u) => loopback(u.hostname))
        .map((u) => Number(u.port || (u.protocol === 'https:' ? 443 : 80))),
    ),
  ];
  const sock = (port) => path.join(dir, `app-${port}.sock`);
  // A Unix socket path longer than ~107 bytes cannot be bound; socat would fail silently and every
  // page load would end in ERR_CONNECTION_CLOSED.
  for (const port of ports)
    if (Buffer.byteLength(sock(port)) > 100)
      throw new Error(
        `The network socket path ${sock(port)} is too long for a Unix socket; use a shorter VIDEO_DIR or NETNS=0.`,
      );
  const inner = ports.map(
    (port) =>
      `socat TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr ${shq(`UNIX-CONNECT:${sock(port)}`)} & PIDS="$PIDS $!"`,
  );
  const innerScript = path.join(dir, 'inner.sh');
  writeFileSync(
    innerScript,
    [
      '#!/bin/bash',
      'ip link set lo up',
      // A default route makes Chromium treat the network as online.
      'ip link add dummy0 type dummy 2>/dev/null; ip addr add 10.99.0.2/24 dev dummy0; ip link set dummy0 up; ip route add default via 10.99.0.1 dev dummy0',
      'PIDS=""',
      ...inner,
      `${shq(realExecutable)} "$@"`,
      'rc=$?',
      'kill $PIDS 2>/dev/null',
      'exit $rc',
      '',
    ].join('\n'),
  );
  const launcher = path.join(dir, 'chromium-netns');
  writeFileSync(launcher, `#!/bin/bash\nexec unshare -Urn ${shq(innerScript)} "$@"\n`);
  chmodSync(innerScript, 0o755);
  chmodSync(launcher, 0o755);

  // The forwarders start last, so a failure above leaves nothing running. They do not keep the
  // process alive (unref), and stop() runs on browser close, launch failure, a signal or exit.
  const forwarders = [];
  let unregister = () => {};
  const stop = () => {
    unregister();
    for (const f of forwarders.splice(0)) if (f.exitCode === null) f.kill();
  };
  unregister = onCleanup(stop);
  try {
    for (const port of ports) {
      rmSync(sock(port), { force: true });
      const fwd = spawn(
        'socat',
        [`UNIX-LISTEN:${sock(port)},fork,mode=0600`, `TCP:127.0.0.1:${port}`],
        { stdio: 'ignore' },
      );
      fwd.on('error', () => {}); // reported by the browser failing to connect
      fwd.unref();
      forwarders.push(fwd);
    }
  } catch (error) {
    stop();
    throw error;
  }
  return { executablePath: launcher, stop };
}
