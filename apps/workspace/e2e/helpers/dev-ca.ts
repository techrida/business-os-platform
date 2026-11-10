import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Makes Chromium trust Caddy's local CA without `ignoreHTTPSErrors`.
 *
 * Why not just pin the root: Caddy sends its leaf and intermediate certificate but NOT the root,
 * and Chromium only compares `--ignore-certificate-errors-spki-list` against certificates in the
 * chain it could build. The root is not in that chain, so a root-only pin does nothing.
 *
 * What this does instead:
 *  1. A child Node process connects to each origin with `ca` set to `.dev/caddy-root.crt` and
 *     `rejectUnauthorized: true`. Node finishes the chain from the root file, so the handshake only
 *     succeeds if the server's chain really leads to the dev CA.
 *  2. It prints the SPKI hash of every certificate the server presented (leaf, intermediate).
 *  3. Chromium gets those hashes. A server that is not signed by the dev CA never reaches step 3.
 *
 * Caddy renews its intermediate about every week, so the hashes are computed on every run, not
 * stored. They are cached in `BOS_E2E_SPKI_LIST` so Playwright's worker processes (which load the
 * config again) do not reconnect. Set that variable yourself to skip the lookup entirely.
 */

const SPKI_ENV = 'BOS_E2E_SPKI_LIST';

/** SHA-256 of the DER SubjectPublicKeyInfo, base64: the format Chromium's flag expects. */
export function spkiHash(certificate: X509Certificate): string {
  const der = certificate.publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64');
}

/** Hashes of every certificate in a PEM file. Harmless extras; the live chain is what matters. */
function hashesFromPemFile(file: string): string[] {
  const pems = readFileSync(file, 'utf8').match(
    /-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g,
  );
  return (pems ?? []).map((pem) => spkiHash(new X509Certificate(pem)));
}

// Runs in a child `node -e`. argv: host, port, caFile. Prints comma-separated hashes.
const PROBE = `
const tls = require('node:tls');
const fs = require('node:fs');
const { X509Certificate, createHash } = require('node:crypto');
const [host, port, caFile] = process.argv.slice(1);
const socket = tls.connect(
  { host, port: Number(port), servername: host, ca: fs.readFileSync(caFile), rejectUnauthorized: true },
  () => {
    const out = [];
    const seen = new Set();
    let cert = socket.getPeerCertificate(true);
    while (cert && cert.raw && !seen.has(cert.fingerprint256)) {
      seen.add(cert.fingerprint256);
      const der = new X509Certificate(cert.raw).publicKey.export({ type: 'spki', format: 'der' });
      out.push(createHash('sha256').update(der).digest('base64'));
      cert = cert.issuerCertificate;
    }
    console.log(out.join(','));
    socket.end();
  },
);
socket.setTimeout(8000, () => { console.error('timed out'); process.exit(1); });
socket.on('error', (e) => { console.error(e.message); process.exit(1); });
`;

/** SPKI hashes for the live chains of the given https origins, verified against the dev CA. */
function liveHashes(origin: string, caFile: string): string[] {
  const url = new URL(origin);
  const out = execFileSync(
    process.execPath,
    ['-e', PROBE, url.hostname, url.port === '' ? '443' : url.port, caFile],
    { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return out.trim().split(',').filter(Boolean);
}

/**
 * Chromium launch args that trust the dev CA for the given origins (empty for plain http).
 * Throws when an https origin cannot be verified against the CA, with the reason, instead of
 * quietly falling back to "ignore all certificate errors".
 */
export function devCaLaunchArgs(origins: string[], caFile: string): string[] {
  const https = origins.filter((origin) => origin.startsWith('https:'));
  if (https.length === 0) return [];

  let list = process.env[SPKI_ENV];
  if (list === undefined || list === '') {
    const hashes = new Set(hashesFromPemFile(caFile));
    for (const origin of https) {
      try {
        for (const hash of liveHashes(origin, caFile)) hashes.add(hash);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Cannot verify ${origin} against ${caFile}: ${reason.split('\n').slice(-2).join(' ').trim()}. ` +
            'Is the stack up and is .dev/caddy-root.crt current? ' +
            `(Or set ${SPKI_ENV} to a comma-separated list of base64 SPKI hashes.)`,
        );
      }
    }
    list = [...hashes].join(',');
    process.env[SPKI_ENV] = list;
  }
  // QUIC: Caddy offers HTTP/3 and Chromium would switch to it, where the flag is not applied.
  return [`--ignore-certificate-errors-spki-list=${list}`, '--disable-quic'];
}
