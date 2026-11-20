// Playwright as a library: resolve the workspace's pinned copy, trust only the stack's dev CA,
// and open one recorded browser context per workflow.
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { onCleanup } from './cleanup.mjs';
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
// *.localhost resolves to loopback in Chromium but not always in Node: connect there with the right SNI.
const s = tls.connect({ host: /(^|\\.)localhost$/.test(host) ? '127.0.0.1' : host, port: Number(port), servername: host, ca: fs.readFileSync(caFile), rejectUnauthorized: true }, () => {
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
    let out;
    try {
      out = execFileSync(process.execPath, ['-e', PROBE, u.hostname, u.port || '443', caFile], {
        encoding: 'utf8',
        timeout: 20_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const why = String(error.stderr ?? '').trim() || error.message.split('\n')[0];
      throw new Error(`TLS check of ${origin} against ${caFile} failed: ${why}`);
    }
    for (const h of out.trim().split(',').filter(Boolean)) hashes.add(h);
  }
  return [`--ignore-certificate-errors-spki-list=${[...hashes].join(',')}`, '--disable-quic'];
}

/**
 * @param {string[]} probeOrigins the origins this run uses: their certificates are checked
 *   against the stack CA before launch (a stack's portal being down must not stop a staff run)
 * @param {string[]} allOrigins every configured origin: network isolation forwards their ports
 */
export async function launch(cfg, probeOrigins, allOrigins = probeOrigins) {
  const { chromium } = loadPlaywright();
  const options = {
    headless: cfg.headless,
    slowMo: cfg.slowMo || undefined,
    args: tlsLaunchArgs(probeOrigins, cfg.caFile),
  };
  let net = null;
  if (netnsWanted(allOrigins)) {
    net = prepareNetns(
      path.join(cfg.outDir, '.net'),
      allOrigins,
      process.env.CHROMIUM_PATH || chromium.executablePath(),
    );
    options.executablePath = net.executablePath;
  }
  let browser;
  try {
    browser = await chromium.launch(options);
  } catch (error) {
    net?.stop(); // the forwarders were started for this browser only
    throw error;
  }
  // Ctrl-C or a kill mid-run still closes this browser (and its forwarders).
  const unregister = onCleanup((sync) => (sync ? undefined : browser.close()));
  browser.on('disconnected', () => {
    unregister();
    net?.stop();
  });
  return browser;
}

/** One recorded context: the video is the context's first page, at exactly the viewport size. */
export async function newRecordedContext(browser, cfg, videoDir) {
  const context = await browser.newContext({
    viewport: cfg.viewport,
    recordVideo: { dir: videoDir, size: cfg.viewport },
    ignoreHTTPSErrors: false,
    // A service worker's fetches bypass context.route; the app does not need one for the run.
    serviceWorkers: 'block',
    acceptDownloads: true,
    locale: 'en-GB',
    timezoneId: process.env.BROWSER_TZ || undefined,
  });
  context.setDefaultTimeout(cfg.actionTimeout);
  context.setDefaultNavigationTimeout(cfg.navTimeout);
  return context;
}
