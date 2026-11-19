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
// wherever the workspace shows money), `format.date` (the pattern dates are written in) and the
// seller's contact lines (phones, email, signatory) that invoice documents show.
// `GET /v1/settings/display` is open to any signed-in staff user, so every screen can read it; it
// is not an admin read.

/** How to reach the selling company, from the saved company profile as it is now (what a printed document shows). */
const SellerContactSchema = z.object({
  phones: z.array(z.string()),
  email: z.string().nullable(),
  signatoryName: z.string().nullable(),
  signatoryTitle: z.string().nullable(),
});
export type SellerContact = z.infer<typeof SellerContactSchema>;

const DisplaySettingsSchema = z.object({
  numberSystems: NumberSystemsSchema,
  dateFormat: DateFormatSchema,
  // Missing (an older API) or malformed: null, without throwing away the number and date settings beside it.
  sellerContact: SellerContactSchema.nullable().catch(null),
});

export interface DisplaySettings {
  numberSystems: NumberSystems;
  dateFormat: DateFormatSetting;
  /** Null when the API did not send it or it did not parse. */
  sellerContact: SellerContact | null;
}

function defaults(): DisplaySettings {
  return {
    numberSystems: DEFAULT_NUMBER_SYSTEMS,
    dateFormat: DEFAULT_DATE_FORMAT,
    sellerContact: null,
  };
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
