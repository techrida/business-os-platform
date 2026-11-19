// Optional network isolation for the browser (Linux). Chromium aborts in-flight requests with
// net::ERR_NETWORK_CHANGED whenever the host's interfaces change (Docker networks of other stacks,
// DHCP renewals), which shows up as random "This page did not open" screens. Running Chromium in its
// own user+network namespace hides those events. The app is reached through a Unix socket:
//   Chromium -> 127.0.0.1:<port> (inside the namespace) -> socat -> <sock> -> socat -> 127.0.0.1:<port> (host)
// TLS still terminates at the stack's Caddy with its real certificate; nothing is decrypted here.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function has(cmd) {
  try {
    execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function netnsWanted() {
  const v = process.env.NETNS ?? 'auto';
  if (/^(0|false|no|off)$/i.test(v)) return false;
  const ok = process.platform === 'linux' && has('unshare') && has('socat') && has('ip');
  if (!ok && v !== 'auto') throw new Error('NETNS=1 needs Linux with unshare, socat and ip');
  return ok;
}

/**
 * Starts the host-side forwarders and writes a launcher script; returns { executablePath, stop }.
 * Playwright talks to the browser over inherited pipes, which pass through unshare unchanged.
 */
export function prepareNetns(dir, origins, realExecutable) {
  mkdirSync(dir, { recursive: true });
  const ports = [
    ...new Set(
      origins
        .map((o) => new URL(o))
        .filter((u) => /localhost$/.test(u.hostname))
        .map((u) => Number(u.port || (u.protocol === 'https:' ? 443 : 80))),
    ),
  ];
  const forwarders = [];
  const inner = [];
  for (const port of ports) {
    const sock = path.join(dir, `app-${port}.sock`);
    rmSync(sock, { force: true });
    const fwd = spawn('socat', [`UNIX-LISTEN:${sock},fork,mode=0600`, `TCP:127.0.0.1:${port}`], {
      stdio: 'ignore',
      detached: false,
    });
    forwarders.push(fwd);
    inner.push(
      `socat TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${sock} & PIDS="$PIDS $!"`,
    );
  }
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
      `"${realExecutable}" "$@"`,
      'rc=$?',
      'kill $PIDS 2>/dev/null',
      'exit $rc',
      '',
    ].join('\n'),
  );
  const launcher = path.join(dir, 'chromium-netns');
  writeFileSync(launcher, `#!/bin/bash\nexec unshare -Urn "${innerScript}" "$@"\n`);
  chmodSync(innerScript, 0o755);
  chmodSync(launcher, 0o755);
  return {
    executablePath: launcher,
    stop() {
      for (const f of forwarders) f.kill();
    },
  };
}
