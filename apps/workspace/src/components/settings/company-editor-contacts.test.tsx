// @vitest-environment jsdom
import { EMPTY_COMPANY_PROFILE, type CompanyPhone, type PrintAddress } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionState } from '@/app/(app)/settings/action-state';
import { click, mountForm, typeKeys } from '@/test/form-interactions';

import { planCard } from './company-profile';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { CompanyEditor } = await import('./company-editor');

const NP_MOBILE: CompanyPhone = { country: 'NP', e164: '+9779812345678', label: null };
const NP_LANDLINE: CompanyPhone = { country: 'NP', e164: '+97714123456', label: 'work' };
const US_PHONE: CompanyPhone = { country: 'US', e164: '+14155552671', label: null };

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
  document.body.innerHTML = '';
});

async function mountEditor(settings: {
  phones: CompanyPhone[];
  panVatNo?: string | null;
  address?: PrintAddress | null;
  reply?: ActionState;
}) {
  const sent: FormData[] = [];
  const action = vi.fn((_: ActionState, formData: FormData): Promise<ActionState> => {
    sent.push(formData);
    return Promise.resolve(settings.reply ?? { status: 'idle', message: '' });
  });
  mounted = await mountForm(
    <CompanyEditor
      organisationId="22222222-2222-4222-8222-222222222222"
      settings={{
        profile: { ...EMPTY_COMPANY_PROFILE, displayName: 'Acme', phones: settings.phones },
        address: settings.address ?? null,
        panVatNo: settings.panVatNo ?? null,
      }}
      versions={{ 'entity.profile': 3, 'entity.address': null, 'entity.pan_vat_no': 5 }}
      action={action}
      resetCard={() => Promise.resolve({ status: 'idle', message: '' })}
    />,
  );
  const { container } = mounted;
  const q = <T extends Element>(selector: string) => container.querySelector<T>(selector);
  const hidden = (name: string) =>
    Array.from(
      container.querySelectorAll<HTMLInputElement>(`input[type="hidden"][name="${name}"]`),
    );
  const posted = (name: string) => q<HTMLInputElement>(`input[name="${name}"]`)?.value;
  const box = (label: string) => q<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const cardForm = (card: string) =>
    q<HTMLInputElement>(`input[name="card"][value="${card}"]`)!.closest('form')!;
  const save = (card: string) =>
    cardForm(card).querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const preview = () => q('aside')?.textContent ?? '';
  return { container, hidden, posted, box, cardForm, save, preview, sent };
}

describe('CompanyEditor contact boxes', () => {
  it('shows the company PAN in a nine-digit box that posts the digits', async () => {
    const editor = await mountEditor({ phones: [], panVatNo: '301234567' });
    expect(editor.hidden('panVatNo').map((i) => i.value)).toEqual(['301234567']);
    expect(editor.container.textContent).not.toContain('9 of 9');
  });

  it('opens each saved phone in its own country box and posts its number and country', async () => {
    const editor = await mountEditor({ phones: [NP_LANDLINE, US_PHONE] });
    expect(editor.box('Phone 1 number').value).toBe('14123456');
    expect(editor.box('Phone 2 number').value).toBe('4155552671');
    expect(editor.posted('phones.0.number')).toBe('+97714123456');
    expect(editor.posted('phones.0.country')).toBe('NP');
    expect(editor.posted('phones.1.number')).toBe('+14155552671');
    expect(editor.posted('phones.1.country')).toBe('US');
    expect(editor.container.querySelector('[aria-label="Phone 1 country"]')).not.toBeNull();
    // Nothing changed yet: Save waits for an edit.
    expect(editor.save('contact').disabled).toBe(true);
  });

  it('posts two numbers in different countries: +1 typed into a Nepal row saves +14155552671', async () => {
    const editor = await mountEditor({ phones: [NP_MOBILE] });
    await click(editor.container.querySelector('[data-action="add"]'));
    await typeKeys(editor.box('Phone 2 number'), '+');
    await typeKeys(editor.box('Phone 2 number'), '1 4155552671');
    expect(editor.posted('phones.1.country')).toBe('US');
    expect(editor.save('contact').disabled).toBe(false);
    await click(editor.save('contact'));
    expect(editor.sent).toHaveLength(1);
    expect(planCard('contact', editor.sent[0]!)).toEqual({
      ok: true,
      value: { profile: { phones: [NP_MOBILE, US_PHONE], email: null, website: null } },
    });
  });

  it('keeps a typed number when the save is refused', async () => {
    const editor = await mountEditor({
      phones: [NP_MOBILE],
      reply: { status: 'error', message: 'Could not save.' },
    });
    await click(editor.container.querySelector('[data-action="add"]'));
    await typeKeys(editor.box('Phone 2 number'), '+');
    await typeKeys(editor.box('Phone 2 number'), '1 4155552671');
    await click(editor.save('contact'));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(editor.sent).toHaveLength(1);
    expect(editor.posted('phones.1.number')).toBe('+14155552671');
    expect(editor.posted('phones.1.country')).toBe('US');
  });

  it('holds Save while a typed number is not valid for its country', async () => {
    const editor = await mountEditor({ phones: [NP_MOBILE, NP_LANDLINE] });
    // Row 2 becomes an incomplete mobile; row 1 stays valid, so the list still reports a change.
    const second = editor.box('Phone 2 number');
    await typeKeys(second, '{Backspace}'.repeat(8) + '98123');
    await act(() => Promise.resolve(second.blur()));
    expect(editor.save('contact').disabled).toBe(true);
  });

  it('prints the letterhead numbers in print form: Nepal in its own format, others international', async () => {
    const editor = await mountEditor({ phones: [NP_MOBILE, NP_LANDLINE, US_PHONE] });
    expect(editor.preview()).toContain('+977 9812345678 · +977 1-4123456 · +1 415 555 2671');
  });
});

describe('CompanyEditor address card', () => {
  it('has Address, City and Country fields that post line, city and country', async () => {
    const editor = await mountEditor({
      phones: [],
      address: { line: 'Durbar Marg', city: 'Kathmandu', country: 'NP' },
    });
    const form = editor.cardForm('address');
    expect(form.querySelector('textarea[name="address.line"]')).not.toBeNull();
    expect(form.querySelector<HTMLInputElement>('input[name="address.city"]')?.value).toBe(
      'Kathmandu',
    );
    expect(editor.posted('address.country')).toBe('NP');
    const labels = Array.from(form.querySelectorAll('label')).map((l) => l.textContent?.trim());
    expect(labels).toEqual(expect.arrayContaining(['Address', 'City', 'Country']));
  });

  it("leaves the company's own country off the letterhead, as the PDFs do", async () => {
    const editor = await mountEditor({
      phones: [],
      address: { line: 'Durbar Marg', city: 'Kathmandu', country: 'NP' },
    });
    expect(editor.preview()).toContain('Durbar Marg');
    expect(editor.preview()).toContain('Kathmandu');
    expect(editor.preview()).not.toContain('Nepal');
  });
});
