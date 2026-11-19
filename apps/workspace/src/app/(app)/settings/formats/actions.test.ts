import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STALE_SETTING_MESSAGE } from '@/components/settings/stale-setting';

import { IDLE } from '../action-state';

vi.mock('server-only', () => ({}));
const revalidatePath = vi.fn<(path: string, type?: string) => void>();
vi.mock('next/cache', () => ({
  revalidatePath: (path: string, type?: string) => revalidatePath(path, type),
}));
type Current = { key: string; value: unknown; version: number | null };
const requireSection = vi.fn<(id: string) => Promise<{ accessToken: string }>>();
vi.mock('../guard', () => ({ requireSection: (id: string) => requireSection(id) }));
const getSetting = vi.fn<(session: unknown, key: string) => Promise<Current>>();
const putSetting =
  vi.fn<
    (
      session: unknown,
      key: string,
      value: unknown,
      expectedVersion?: number | null,
    ) => Promise<{ version: number }>
  >();
vi.mock('@/lib/api-admin', () => ({
  getSetting: (session: unknown, key: string) => getSetting(session, key),
  putSetting: (session: unknown, key: string, value: unknown, expectedVersion?: number | null) =>
    putSetting(session, key, value, expectedVersion),
}));

const {
  saveNumberSystemsAction,
  resetNumberSystemAction,
  saveDateFormatAction,
  resetDateFormatAction,
} = await import('./actions');

const NUMBERS = 'format.number_systems';
const DATE = 'format.date';
const DEFAULTS = { NPR: 'south_asian', INR: 'south_asian', USD: 'international' };
const session = { accessToken: 't' };

const numbersForm = (
  values: Partial<Record<'NPR' | 'INR' | 'USD', string>>,
  version: string | null = '',
) => {
  const data = new FormData();
  for (const [currency, value] of Object.entries(values)) {
    if (value !== undefined) data.set(`numberSystem:${currency}`, value);
  }
  if (version !== null) data.set('version', version);
  return data;
};

const dateForm = (value: string, version: string | null = '') => {
  const data = new FormData();
  data.set('dateFormat', value);
  if (version !== null) data.set('version', version);
  return data;
};

// A real 409 from the API: the same envelope `isStaleSettingError` reads.
const staleError = () =>
  Object.assign(new Error('stale'), {
    status: 409,
    body: {
      error: {
        code: 'stale_setting',
        message: 'This setting changed.',
        correlationId: 'req-12345678',
      },
    },
  });

beforeEach(() => {
  revalidatePath.mockReset();
  requireSection.mockReset().mockResolvedValue(session);
  getSetting.mockReset().mockResolvedValue({ key: NUMBERS, value: DEFAULTS, version: null });
  putSetting.mockReset().mockResolvedValue({ version: 1 });
});

describe('saveNumberSystemsAction', () => {
  const changed = { NPR: 'international', INR: 'south_asian', USD: 'south_asian' };

  it('checks the section, then writes the whole map with the loaded version', async () => {
    getSetting.mockResolvedValue({ key: NUMBERS, value: DEFAULTS, version: 3 });
    const result = await saveNumberSystemsAction(IDLE, numbersForm(changed, '3'));
    expect(result).toEqual({ status: 'ok', message: 'Number format saved.' });
    expect(requireSection).toHaveBeenCalledWith('formats');
    expect(putSetting).toHaveBeenCalledTimes(1);
    expect(putSetting).toHaveBeenCalledWith(session, NUMBERS, changed, 3);
    expect(revalidatePath).toHaveBeenCalledWith('/settings/formats', undefined);
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('sends null as the version when the page loaded the default', async () => {
    await saveNumberSystemsAction(IDLE, numbersForm(changed, ''));
    expect(putSetting).toHaveBeenCalledWith(session, NUMBERS, changed, null);
  });

  it('does not append a version when nothing changed', async () => {
    const result = await saveNumberSystemsAction(IDLE, numbersForm(DEFAULTS, ''));
    expect(result).toEqual({ status: 'ok', message: 'No changes to save.' });
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('refuses a missing or unknown choice, at the field', async () => {
    for (const bad of [
      { NPR: 'international', INR: 'south_asian' },
      { ...changed, USD: 'lakh' },
      { ...changed, INR: '' },
    ]) {
      const result = await saveNumberSystemsAction(IDLE, numbersForm(bad));
      expect(result.status).toBe('error');
      expect(result.fieldErrors).toEqual({
        numberSystems: 'Choose how amounts are grouped for each currency.',
      });
    }
    expect(getSetting).not.toHaveBeenCalled();
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('refuses a form without the loaded version instead of saving unguarded', async () => {
    for (const version of [null, 'abc', '-1']) {
      const result = await saveNumberSystemsAction(IDLE, numbersForm(changed, version));
      expect(result.status).toBe('error');
    }
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('is refused before any read or write when the section guard redirects', async () => {
    requireSection.mockRejectedValue(new Error('REDIRECT:/settings/denied'));
    await expect(saveNumberSystemsAction(IDLE, numbersForm(changed))).rejects.toThrow(
      'REDIRECT:/settings/denied',
    );
    expect(getSetting).not.toHaveBeenCalled();
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('answers a stale save with the reload message and does not revalidate', async () => {
    putSetting.mockRejectedValue(staleError());
    const result = await saveNumberSystemsAction(IDLE, numbersForm(changed, '2'));
    expect(result).toEqual({ status: 'error', message: STALE_SETTING_MESSAGE });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('reports an API failure instead of claiming success', async () => {
    putSetting.mockRejectedValue(Object.assign(new Error('boom'), { status: 403 }));
    const result = await saveNumberSystemsAction(IDLE, numbersForm(changed));
    expect(result.status).toBe('error');
    expect(result.message).not.toBe(STALE_SETTING_MESSAGE);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('resetNumberSystemAction', () => {
  const saved = { NPR: 'international', INR: 'international', USD: 'south_asian' };

  beforeEach(() => {
    getSetting.mockResolvedValue({ key: NUMBERS, value: saved, version: 4 });
  });

  it('writes the whole map with only that currency back at its default, with the loaded version', async () => {
    const result = await resetNumberSystemAction('INR', 4);
    expect(result).toEqual({ status: 'ok', message: 'Reset to default.' });
    expect(requireSection).toHaveBeenCalledWith('formats');
    expect(putSetting).toHaveBeenCalledTimes(1);
    expect(putSetting).toHaveBeenCalledWith(
      session,
      NUMBERS,
      { NPR: 'international', INR: 'south_asian', USD: 'south_asian' },
      4,
    );
    expect(revalidatePath).toHaveBeenCalledWith('/settings/formats', undefined);
  });

  it('sends the version the page loaded, not the one it just read', async () => {
    getSetting.mockResolvedValue({ key: NUMBERS, value: saved, version: 6 });
    await resetNumberSystemAction('USD', 4);
    expect(putSetting).toHaveBeenCalledWith(
      session,
      NUMBERS,
      { NPR: 'international', INR: 'international', USD: 'international' },
      4,
    );
  });

  it('writes nothing when that currency is already at its default', async () => {
    getSetting.mockResolvedValue({ key: NUMBERS, value: DEFAULTS, version: 4 });
    const again = await resetNumberSystemAction('NPR', 4);
    expect(again).toEqual({ status: 'ok', message: 'Already at the default.' });
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('does not hide a stale page behind "already at the default"', async () => {
    getSetting.mockResolvedValue({ key: NUMBERS, value: DEFAULTS, version: 6 });
    putSetting.mockRejectedValue(staleError());
    const result = await resetNumberSystemAction('NPR', 4);
    expect(result).toEqual({ status: 'error', message: STALE_SETTING_MESSAGE });
    expect(putSetting).toHaveBeenCalledWith(session, NUMBERS, DEFAULTS, 4);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('refuses an unknown currency and a version that is not a whole number', async () => {
    expect((await resetNumberSystemAction('EUR', 4)).status).toBe('error');
    expect((await resetNumberSystemAction('NPR', -1)).status).toBe('error');
    expect((await resetNumberSystemAction('NPR', undefined as unknown as null)).status).toBe(
      'error',
    );
    expect(getSetting).not.toHaveBeenCalled();
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('is refused before any read or write without the section', async () => {
    requireSection.mockRejectedValue(new Error('REDIRECT:/settings/denied'));
    await expect(resetNumberSystemAction('NPR', 4)).rejects.toThrow('REDIRECT:/settings/denied');
    expect(getSetting).not.toHaveBeenCalled();
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('answers a stale reset with the reload message and does not revalidate', async () => {
    putSetting.mockRejectedValue(staleError());
    const result = await resetNumberSystemAction('NPR', 3);
    expect(result).toEqual({ status: 'error', message: STALE_SETTING_MESSAGE });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('saveDateFormatAction', () => {
  beforeEach(() => {
    getSetting.mockResolvedValue({ key: DATE, value: 'dd MMM yyyy', version: null });
  });

  it('checks the section, then writes format.date alone with the loaded version', async () => {
    const result = await saveDateFormatAction(IDLE, dateForm('yyyy-MM-dd', ''));
    expect(result).toEqual({ status: 'ok', message: 'Date format saved.' });
    expect(requireSection).toHaveBeenCalledWith('formats');
    expect(putSetting).toHaveBeenCalledTimes(1);
    expect(putSetting).toHaveBeenCalledWith(session, DATE, 'yyyy-MM-dd', null);
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('does not append a version when the choice is unchanged', async () => {
    const result = await saveDateFormatAction(IDLE, dateForm('dd MMM yyyy'));
    expect(result).toEqual({ status: 'ok', message: 'No changes to save.' });
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('refuses a value that is not a date format, at the field', async () => {
    for (const bad of ['dd-MM-yyyy', '', ' yyyy-MM-dd']) {
      const result = await saveDateFormatAction(IDLE, dateForm(bad));
      expect(result.status).toBe('error');
      expect(result.fieldErrors).toEqual({ dateFormat: 'Choose how dates are written.' });
    }
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('answers a stale save with the reload message and does not revalidate', async () => {
    putSetting.mockRejectedValue(staleError());
    const result = await saveDateFormatAction(IDLE, dateForm('yyyy-MM-dd', '2'));
    expect(result).toEqual({ status: 'error', message: STALE_SETTING_MESSAGE });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('is refused before any read or write when the section guard redirects', async () => {
    requireSection.mockRejectedValue(new Error('REDIRECT:/settings/denied'));
    await expect(saveDateFormatAction(IDLE, dateForm('yyyy-MM-dd'))).rejects.toThrow(
      'REDIRECT:/settings/denied',
    );
    expect(putSetting).not.toHaveBeenCalled();
  });
});

describe('resetDateFormatAction', () => {
  it('writes the default with the loaded version', async () => {
    getSetting.mockResolvedValue({ key: DATE, value: 'yyyy-MM-dd', version: 5 });
    const result = await resetDateFormatAction(5);
    expect(result).toEqual({ status: 'ok', message: 'Reset to default.' });
    expect(putSetting).toHaveBeenCalledWith(session, DATE, 'dd MMM yyyy', 5);
  });

  it('is stale-safe and guarded', async () => {
    getSetting.mockResolvedValue({ key: DATE, value: 'yyyy-MM-dd', version: 5 });
    putSetting.mockRejectedValue(staleError());
    expect(await resetDateFormatAction(4)).toEqual({
      status: 'error',
      message: STALE_SETTING_MESSAGE,
    });
    expect(revalidatePath).not.toHaveBeenCalled();

    requireSection.mockRejectedValue(new Error('REDIRECT:/settings/denied'));
    await expect(resetDateFormatAction(5)).rejects.toThrow('REDIRECT:/settings/denied');
  });
});
