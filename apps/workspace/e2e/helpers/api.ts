import { readFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';

/**
 * HTTPS calls from the test process (not the browser) to the stack's own hosts: Mailpit and the
 * API. Same TLS rule as the browser: `ignoreHTTPSErrors` stays off and Caddy's local CA
 * (`.dev/caddy-root.crt`, see dev-ca.ts) is the only thing trusted, so a call to a host that is not
 * signed by the dev CA fails instead of passing quietly. Plain `fetch` is not used because Node's
 * `fetch` cannot take a per-call CA without an extra dependency.
 *
 * Why there is no "verify the audit chain" helper here: `GET /v1/audit/verify` needs a bearer
 * token, and the Workspace keeps tokens on the server (the BFF never hands one to the browser), so
 * a browser test has no legitimate token to send. `statusWithoutToken` only proves that route is
 * closed to an anonymous caller.
 */

/** Same default as playwright.config.ts: `apps/workspace` is the working directory. */
export function devCaFile(): string {
  return path.resolve(process.cwd(), process.env.BOS_E2E_CA_FILE ?? '../../.dev/caddy-root.crt');
}

export function apiOrigin(): string {
  return process.env.BOS_E2E_API_ORIGIN ?? 'https://api.localhost';
}

export interface HttpsResult {
  status: number;
  body: string;
}

/** GET `url`, trusting the dev CA. Rejects on a TLS or network error, never on an HTTP status. */
export function httpsGet(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 10_000,
): Promise<HttpsResult> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: 'GET', headers, ca: readFileSync(devCaFile()), agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`GET ${url} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await httpsGet(url, { accept: 'application/json' });
  if (res.status !== 200) {
    throw new Error(`GET ${url} answered ${res.status}: ${res.body.slice(0, 200)}`);
  }
  return JSON.parse(res.body) as T;
}

/** The HTTP status the API gives a request that carries no token. */
export async function statusWithoutToken(pathAndQuery: string): Promise<number> {
  return (await httpsGet(`${apiOrigin()}${pathAndQuery}`)).status;
}
