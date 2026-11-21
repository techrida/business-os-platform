import 'server-only';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import { devToolsEnabled } from '@/dev/enabled';
import { beginLogin } from '@/lib/oidc';

// BOS_DEV_ACCOUNT_SERVICE: privileged local test entry, never imported by production routes.
// Only operator-configured exact HTTPS origins extend the local development boundary.
// This is not a wildcard trust of a tailnet or of all *.ts.net hosts.
function trustedDevelopmentOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid development origin');
  const local =
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.localhost') ||
    url.hostname.endsWith('.bos.test');
  const configured = (process.env.BOS_DEV_TRUSTED_ORIGINS ?? '').split(',').map((v) => v.trim());
  if (!local && !configured.includes(url.origin)) throw new Error('Untrusted development origin');
  return url;
}

export function localDevelopmentRequest(req: Request, mutation = false): boolean {
  if (!devToolsEnabled()) return false;
  try {
    const configured = trustedDevelopmentOrigin(process.env.WORKSPACE_PUBLIC_URL ?? '');
    trustedDevelopmentOrigin(process.env.OIDC_ISSUER ?? '');
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
    if (host !== configured.host) return false;
    if (mutation && req.headers.get('origin') !== configured.origin) return false;
    const site = req.headers.get('sec-fetch-site');
    return !site || site === 'same-origin' || site === 'none';
  } catch {
    return false;
  }
}

async function api(path: string, body?: unknown): Promise<unknown> {
  if (!devToolsEnabled()) throw new Error('Development only');
  // Privileged login-client calls stay on the private identity API even when browser OIDC
  // is exposed through a restricted HTTPS bridge. No credentials go to the public bridge.
  const base = trustedDevelopmentOrigin(
    process.env.BOS_DEV_IDENTITY_API_URL ?? process.env.OIDC_ISSUER ?? '',
  );
  const token = (await readFile(process.env.BOS_DEV_LOGIN_CLIENT_TOKEN_FILE ?? '', 'utf8')).trim();
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'Connect-Protocol-Version': '1',
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Development identity request failed');
  return response.json();
}

export async function developmentAccounts(): Promise<
  { id: string; label: string; login: string }[]
> {
  const accounts: { id: string; label: string; login: string }[] = [];
  for (let offset = 0; ; offset += 100) {
    const result = z
      .object({
        result: z
          .array(
            z.object({
              userId: z.string(),
              state: z.string(),
              username: z.string(),
              preferredLoginName: z.string(),
              human: z
                .object({ profile: z.object({ displayName: z.string().optional() }).optional() })
                .optional(),
            }),
          )
          .default([]),
      })
      .parse(
        await api('/zitadel.user.v2.UserService/ListUsers', {
          query: { offset: String(offset), limit: 100 },
        }),
      );
    const users = result.result ?? [];
    for (const user of users) {
      if (user.human && user.state === 'USER_STATE_ACTIVE')
        accounts.push({
          id: user.userId,
          label: user.human.profile?.displayName || user.username,
          login: user.preferredLoginName,
        });
    }
    if (users.length < 100) break;
    if (offset >= 10000) throw new Error('Development account limit exceeded');
  }
  return accounts;
}

export async function switchDevelopmentAccount(
  id: string,
): Promise<{ callback: URL; binding: string }> {
  if (!(await developmentAccounts()).some((account) => account.id === id))
    throw new Error('Unavailable account');
  const { url, binding } = await beginLogin({ prompt: 'login', returnTo: '/' });
  let target = url;
  let requestId: string | null = null;
  for (let hop = 0; hop < 6; hop++) {
    if (target.origin !== new URL(process.env.OIDC_ISSUER!).origin)
      throw new Error('Unexpected login origin');
    requestId = target.searchParams.get('authRequest') ?? target.searchParams.get('authRequestID');
    if (requestId) break;
    const response = await fetch(target, {
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    const location = response.headers.get('location');
    if (!location) throw new Error('Missing authorization redirect');
    target = new URL(location, target);
  }
  if (!requestId) throw new Error('Missing authorization request');
  // The dedicated local login client is the authentication authority for this test-only flow.
  // No password changes, MFA seeds, fabricated tokens, or project-role overrides.
  const session = z
    .object({ sessionId: z.string(), sessionToken: z.string() })
    .parse(await api('/v2/sessions', { checks: { user: { userId: id } }, lifetime: '600s' }));
  const result = z.object({ callbackUrl: z.string() }).parse(
    await api(`/v2/oidc/auth_requests/${encodeURIComponent(requestId)}`, {
      session: { sessionId: session.sessionId, sessionToken: session.sessionToken },
    }),
  );
  const callback = new URL(result.callbackUrl);
  const expected = new URL(process.env.OIDC_REDIRECT_URI!);
  if (
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.searchParams.has('error')
  )
    throw new Error('Authorization failed');
  return { callback, binding };
}
