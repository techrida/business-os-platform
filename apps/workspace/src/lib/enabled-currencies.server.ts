import 'server-only';

import { CurrencySchema, type Currency } from '@bos/contracts';
import { z } from 'zod';

import { call } from './api-procurement';
import { normalizeEnabled } from './enabled-currencies';
import type { Session } from './session';

// `GET /v1/admin/settings/currency.enabled` needs admin.settings.write (the Founder only), so the
// pickers read the list from `GET /v1/settings/display`, which any signed-in staff user may call
// (the same read as `display-settings.ts`). Until the API adds the field there, everyone gets the
// default list.

/** Field name of the enabled currencies in the display settings response. */
export const DISPLAY_ENABLED_FIELD = 'enabledCurrencies';

const Display = z.object({ [DISPLAY_ENABLED_FIELD]: z.array(CurrencySchema).optional() });

/**
 * The tenant's enabled currencies in the order NPR, INR, USD, with NPR always present. Never throws:
 * a failed or malformed read, a missing field or no session gives the default list.
 */
export async function loadEnabledCurrencies(session: Session | null): Promise<Currency[]> {
  if (session === null) return normalizeEnabled(null);
  try {
    const body = await call(session, '/v1/settings/display', Display);
    return normalizeEnabled(body[DISPLAY_ENABLED_FIELD]);
  } catch {
    return normalizeEnabled(null);
  }
}
