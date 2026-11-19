import 'server-only';

import {
  DateFormatSchema,
  DEFAULT_DATE_FORMAT,
  NumberSystemsSchema,
  type DateFormatSetting,
} from '@bos/contracts';
import { DEFAULT_NUMBER_SYSTEMS, type NumberSystems } from '@bos/locale';
import { cache } from 'react';
import { z } from 'zod';

import { call } from './api-procurement';
import { getSession, type Session } from './session';

// The tenant's display settings: `format.number_systems` (one per currency: how digits are grouped
// wherever the workspace shows money) and `format.date` (the pattern dates are written in).
// `GET /v1/settings/display` is open to any signed-in staff user, so every screen can read it; it
// is not an admin read.

const DisplaySettingsSchema = z.object({
  numberSystems: NumberSystemsSchema,
  dateFormat: DateFormatSchema,
});

export interface DisplaySettings {
  numberSystems: NumberSystems;
  dateFormat: DateFormatSetting;
}

function defaults(): DisplaySettings {
  return { numberSystems: DEFAULT_NUMBER_SYSTEMS, dateFormat: DEFAULT_DATE_FORMAT };
}

/**
 * The tenant's display settings. Never throws: a display preference must not take a page down, so
 * a failed or malformed read, or a missing session, shows the defaults instead.
 */
export async function loadDisplaySettings(session: Session | null): Promise<DisplaySettings> {
  if (session === null) return defaults();
  try {
    return await call(session, '/v1/settings/display', DisplaySettingsSchema);
  } catch {
    return defaults();
  }
}

/** The tenant's number system (see `loadDisplaySettings`). Never throws. */
export async function loadNumberSystems(session: Session | null): Promise<NumberSystems> {
  return (await loadDisplaySettings(session)).numberSystems;
}

/**
 * Server-side read for the current request, shared by the (app) layout and every page under it
 * (React `cache()` runs it once per request, so the number systems and the date format come from
 * one API call). Never throws.
 */
export const getDisplaySettings = cache(async (): Promise<DisplaySettings> => {
  try {
    return await loadDisplaySettings(await getSession());
  } catch {
    return defaults();
  }
});

/** The tenant's number systems for this request. Pass the result to `money(amount, currency, ns)`. */
export async function getNumberSystems(): Promise<NumberSystems> {
  return (await getDisplaySettings()).numberSystems;
}

/** The tenant's date pattern for this request. Pass the result to `when(iso, style, pattern)`. */
export async function getDateFormat(): Promise<DateFormatSetting> {
  return (await getDisplaySettings()).dateFormat;
}
