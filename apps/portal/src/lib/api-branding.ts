import 'server-only';

import { type Branding, BrandingSchema } from '@bos/contracts';

import { apiFetch } from './api';
import { getEnv } from './env';
import type { Session } from './session';

/**
 * The company's name and logo for the header (R6Q20), as the API's `GET /v1/branding` gives them. A failed or
 * unreadable answer is null, never an error: the header then shows its text, and a page never fails over a logo.
 */
export async function getBranding(session: Session): Promise<Branding | null> {
  try {
    const res = await apiFetch(session, '/v1/branding');
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      return null;
    }
    const parsed = BrandingSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The same-origin address an `<img>` uses for the logo (the proxy at `/brand/logo/:tenantId`, always the current logo). */
export function logoSrc(branding: Branding | null): string | null {
  return branding?.logo ? `/brand/logo/${encodeURIComponent(branding.logo.tenantId)}` : null;
}

/**
 * The longest the anonymous logo fetch may take. The proxy has no session and no caller who can wait: a slow API must
 * not hold a request open, so a logo not back in this time is a 404 and the header shows the company name.
 */
export const PUBLIC_LOGO_TIMEOUT_MS = 5000;

/**
 * `GET /v1/public/logo/:tenantId` with no token: the API serves the company's current logo and nothing else to
 * anyone. The id is an encoded path segment on a fixed path under API_INTERNAL_URL, so the request cannot leave it.
 */
export async function openPublicLogo(tenantId: string, ifNoneMatch?: string): Promise<Response> {
  const url = new URL(
    `/v1/public/logo/${encodeURIComponent(tenantId)}`,
    getEnv().API_INTERNAL_URL,
  );
  return await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(PUBLIC_LOGO_TIMEOUT_MS),
    ...(ifNoneMatch === undefined ? {} : { headers: { 'if-none-match': ifNoneMatch } }),
  });
}
