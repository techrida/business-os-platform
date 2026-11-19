import 'server-only';

import { DateFormatSchema, NumberSystemsSchema } from '@bos/contracts';
import { DEFAULT_NUMBER_SYSTEMS, type NumberSystems } from '@bos/locale';
import { cache } from 'react';
import { z } from 'zod';

import { call } from './api-procurement';
import { getSession, type Session } from './session';

// The tenant's display settings (`format.number_systems`, one per currency): how digits are grouped wherever the
// workspace shows money. `GET /v1/settings/display` is open to any signed-in staff user, so every
// screen can read it; it is not an admin read.

const DisplaySettings = z.object({
  numberSystems: NumberSystemsSchema,
  dateFormat: DateFormatSchema,
});

/**
 * The tenant's number system. Never throws: a display preference must not take a page down, so a
 * failed or malformed read, or a missing session, shows the default grouping instead.
 */
export async function loadNumberSystems(session: Session | null): Promise<NumberSystems> {
  if (session === null) return DEFAULT_NUMBER_SYSTEMS;
  try {
    return (await call(session, '/v1/settings/display', DisplaySettings)).numberSystems;
  } catch {
    return DEFAULT_NUMBER_SYSTEMS;
  }
}

/**
 * Server-side read for the current request, shared by the (app) layout and every page under it
 * (React `cache()` runs it once per request). Pass the result to `money(amount, currency, ns)`.
 */
export const getNumberSystems = cache(async (): Promise<NumberSystems> => {
  try {
    return await loadNumberSystems(await getSession());
  } catch {
    return DEFAULT_NUMBER_SYSTEMS;
  }
});
