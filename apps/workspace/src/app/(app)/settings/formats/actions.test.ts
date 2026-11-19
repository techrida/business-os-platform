import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IDLE } from '../action-state';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
type Current = { key: string; value: unknown; version: number | null };
const requireSection = vi.fn<(id: string) => Promise<{ accessToken: string }>>();
vi.mock('../guard', () => ({ requireSection: (id: string) => requireSection(id) }));
const getSetting = vi.fn<(session: unknown, key: string) => Promise<Current>>();
const putSetting =
  vi.fn<(session: unknown, key: string, value: unknown) => Promise<{ version: number }>>();
vi.mock('@/lib/api-admin', () => ({
  getSetting: (session: unknown, key: string) => getSetting(session, key),
  putSetting: (session: unknown, key: string, value: unknown) => putSetting(session, key, value),
}));

const { saveNumberSystemAction } = await import('./actions');

const form = (value: string) => {
  const data = new FormData();
  data.set('numberSystem', value);
  return data;
};

beforeEach(() => {
  requireSection.mockReset().mockResolvedValue({ accessToken: 't' });
  getSetting
    .mockReset()
    .mockResolvedValue({ key: 'format.number_system', value: 'south_asian', version: null });
  putSetting.mockReset().mockResolvedValue({ version: 1 });
});

describe('saveNumberSystemAction', () => {
  it('checks the formats section, then writes format.number_system and nothing else', async () => {
    const result = await saveNumberSystemAction(IDLE, form('international'));
    expect(result).toEqual({ status: 'ok', message: 'Number format saved.' });
    expect(requireSection).toHaveBeenCalledWith('formats');
    expect(putSetting).toHaveBeenCalledTimes(1);
    expect(putSetting).toHaveBeenCalledWith(
      { accessToken: 't' },
      'format.number_system',
      'international',
    );
  });

  it('does not append a version when the choice is unchanged', async () => {
    const result = await saveNumberSystemAction(IDLE, form('south_asian'));
    expect(result).toEqual({ status: 'ok', message: 'No changes to save.' });
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('refuses a value that is not a number system, at the field', async () => {
    for (const bad of ['lakh', '', ' south_asian']) {
      const result = await saveNumberSystemAction(IDLE, form(bad));
      expect(result.status).toBe('error');
      expect(result.fieldErrors).toEqual({ numberSystem: 'Choose how amounts are grouped.' });
    }
    expect(getSetting).not.toHaveBeenCalled();
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('is refused before any read or write when the section guard redirects', async () => {
    requireSection.mockRejectedValue(new Error('REDIRECT:/settings/denied'));
    await expect(saveNumberSystemAction(IDLE, form('international'))).rejects.toThrow(
      'REDIRECT:/settings/denied',
    );
    expect(getSetting).not.toHaveBeenCalled();
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('reports an API failure instead of claiming success', async () => {
    putSetting.mockRejectedValue(Object.assign(new Error('boom'), { status: 403 }));
    const result = await saveNumberSystemAction(IDLE, form('international'));
    expect(result.status).toBe('error');
  });
});
