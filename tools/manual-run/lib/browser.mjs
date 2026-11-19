// Playwright as a library: resolve the workspace's pinned copy, trust only the stack's dev CA,
// and open one recorded browser context per workflow.
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { netnsWanted, prepareNetns } from './netns.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

/** The repository already depends on @playwright/test (apps/workspace); reuse that exact version. */
export function loadPlaywright() {
  const from = process.env.PLAYWRIGHT_FROM || path.join(repoRoot, 'apps/workspace/package.json');
  const require = createRequire(from);
  try {
    return require('@playwright/test');
  } catch (error) {
    throw new Error(
      `Cannot load @playwright/test from ${from} (${error.message.split('\n')[0]}). ` +
        'Run `pnpm install --frozen-lockfile` at the repository root, or set PLAYWRIGHT_FROM to a package.json that depends on it.',
    );
  }
}

// TLS: ignoreHTTPSErrors stays false. Chromium does not read NODE_EXTRA_CA_CERTS, so (as in
// apps/workspace/e2e/helpers/dev-ca.ts) Node first verifies each origin's chain against the CA file,
// then Chromium is told to accept exactly those public keys and nothing else.
const PROBE = `
const tls = require('node:tls'); const fs = require('node:fs');
const { X509Certificate, createHash } = require('node:crypto');
const [host, port, caFile] = process.argv.slice(1);
const s = tls.connect({ host: '127.0.0.1', port: Number(port), servername: host, ca: fs.readFileSync(caFile), rejectUnauthorized: true }, () => {
  const out = []; const seen = new Set(); let c = s.getPeerCertificate(true);
  while (c && c.raw && !seen.has(c.fingerprint256)) { seen.add(c.fingerprint256);
    out.push(createHash('sha256').update(new X509Certificate(c.raw).publicKey.export({ type: 'spki', format: 'der' })).digest('base64'));
    c = c.issuerCertificate; }
  console.log(out.join(',')); s.end(); });
s.setTimeout(8000, () => { console.error('timed out'); process.exit(1); });
s.on('error', (e) => { console.error(e.message); process.exit(1); });`;

function spki(cert) {
  return createHash('sha256')
    .update(cert.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
}

export function tlsLaunchArgs(origins, caFile) {
  const hashes = new Set();
  const pems =
    readFileSync(caFile, 'utf8').match(
      /-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g,
    ) ?? [];
  for (const pem of pems) hashes.add(spki(new X509Certificate(pem)));
  for (const origin of new Set(origins.filter((o) => o.startsWith('https:')))) {
    const u = new URL(origin);
    // *.localhost names resolve to loopback in Chromium; probe loopback with the right SNI.
    const out = execFileSync(process.execPath, ['-e', PROBE, u.hostname, u.port || '443', caFile], {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const h of out.trim().split(',').filter(Boolean)) hashes.add(h);
  }
  return [`--ignore-certificate-errors-spki-list=${[...hashes].join(',')}`, '--disable-quic'];
}

export async function launch(cfg, origins) {
  const { chromium } = loadPlaywright();
  const options = {
    headless: cfg.headless,
    slowMo: cfg.slowMo || undefined,
    args: tlsLaunchArgs(origins, cfg.caFile),
  };
  let net = null;
  if (netnsWanted()) {
    net = prepareNetns(
      path.join(cfg.outDir, '.net'),
      origins,
      process.env.CHROMIUM_PATH || chromium.executablePath(),
    );
    options.executablePath = net.executablePath;
  }
  const browser = await chromium.launch(options);
  if (net) browser.on('disconnected', () => net.stop());
  return browser;
}

/** One recorded context: the video is the context's first page, at exactly the viewport size. */
export async function newRecordedContext(browser, cfg, videoDir) {
  const context = await browser.newContext({
    viewport: cfg.viewport,
    recordVideo: { dir: videoDir, size: cfg.viewport },
    ignoreHTTPSErrors: false,
    acceptDownloads: true,
    locale: 'en-GB',
    timezoneId: process.env.BROWSER_TZ || undefined,
  });
  context.setDefaultTimeout(cfg.actionTimeout);
  context.setDefaultNavigationTimeout(cfg.navTimeout);
  return context;
}
