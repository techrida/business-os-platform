import 'server-only';

import type { PortalDisplay } from '@bos/contracts';
import { cache } from 'react';

import { fetchPortalDisplay } from './api';
import { DEFAULT_PORTAL_DISPLAY } from './display';
import type { Session } from './session';

// Keyed on the token string, so two calls in one request share one API read.
const load = cache(async (accessToken: string): Promise<PortalDisplay> => {
  try {
    return await fetchPortalDisplay({ accessToken });
  } catch {
    // A formatting preference must never take a page down: draw with the defaults instead.
    return DEFAULT_PORTAL_DISPLAY;
  }
});

/**
 * The company's number and date setting for this request (`GET /v1/portal/display`). Cached per
 * request and never throws: if the API is down or answers something unexpected, the defaults apply.
 * Start it early and await it where the page renders, so it overlaps the page's own reads.
 */
export function getPortalDisplay(session: Pick<Session, 'accessToken'>): Promise<PortalDisplay> {
  return load(session.accessToken);
}
