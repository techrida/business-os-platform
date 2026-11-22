// @vitest-environment jsdom
import { EMPTY_COMPANY_PROFILE } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, mountForm, typeKeys } from '@/test/form-interactions';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { CompanyEditor } = await import('./company-editor');

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
  document.body.innerHTML = '';
});

async function mountEditor(settings: {
  phones: string[];
  panVatNo: string | null;
  profilePan?: string | null;
}) {
  mounted = await mountForm(
    <CompanyEditor
      organisationId="22222222-2222-4222-8222-222222222222"
      settings={{
        profile: { ...EMPTY_COMPANY_PROFILE, displayName: 'Acme', phones: settings.phones },
        address: null,
        panVatNo: settings.panVatNo,
      }}
      versions={{ 'entity.profile': 3, 'entity.address': null, 'entity.pan_vat_no': 5 }}
      action={() => Promise.resolve({ status: 'idle' } as never)}
      resetCard={() => Promise.resolve({ status: 'idle' } as never)}
    />,
  );
  const { container } = mounted;
  const hidden = (name: string) =>
    Array.from(
      container.querySelectorAll<HTMLInputElement>(`input[type="hidden"][name="${name}"]`),
    );
  const box = (label: string) =>
    container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  return { container, hidden, box };
}

describe('CompanyEditor contact boxes (FX8)', () => {
  it('shows the company PAN in a nine-digit box that posts the digits', async () => {
    const editor = await mountEditor({ phones: [], panVatNo: '301234567' });
    expect(editor.hidden('panVatNo').map((i) => i.value)).toEqual(['301234567']);
    expect(editor.container.textContent).toContain('9 of 9');
  });

  it('shows each phone in a Nepal box and posts it as E.164', async () => {
    const editor = await mountEditor({
      phones: ['+9779812345678', '+97714123456'],
      panVatNo: null,
    });
    expect(editor.hidden('phone').map((i) => i.value)).toEqual(['+9779812345678', '+97714123456']);
    expect(editor.box('Phone number 1').value).toBe('9812345678');
    expect(editor.box('Phone number 2').value).toBe('14123456');
  });

  it('opens a stored free-text phone as stored, flagged, instead of rewriting it', async () => {
    const editor = await mountEditor({ phones: ['01-4000000'], panVatNo: '12-34567' });
    expect(editor.hidden('phone').map((i) => i.value)).toEqual(['01-4000000']);
    expect(editor.hidden('panVatNo').map((i) => i.value)).toEqual(['12-34567']);
  });

  it('prints the letterhead numbers in the Nepal form, and a free-text one as saved', async () => {
    const editor = await mountEditor({
      phones: ['+9779812345678', '+97714123456', '01-4000000'],
      panVatNo: null,
    });
    const preview = editor.container.querySelector('aside')?.textContent ?? '';
    expect(preview).toContain('+977 9812345678 · +977 1-4123456 · 01-4000000');
  });

  it('posts an unprefixed stored number as stored, never as +digits', async () => {
    const editor = await mountEditor({ phones: ['4123456'], panVatNo: null });
    expect(editor.hidden('phone').map((i) => i.value)).toEqual(['4123456']);
  });

  it('keeps the other rows edit state when a row is removed', async () => {
    const editor = await mountEditor({ phones: ['+97714123456', ''], panVatNo: null });
    await typeKeys(editor.box('Phone number 2'), '981234567');
    await click(editor.container.querySelector('[aria-label="Remove phone number 1"]'));
    const box = editor.box('Phone number 1');
    expect(box.value).toBe('981234567');
    await act(() => Promise.resolve(box.blur()));
    expect(box.getAttribute('aria-invalid')).toBe('true');
  });

  it('keeps the remaining numbers when the first is removed', async () => {
    const editor = await mountEditor({
      phones: ['+9779812345678', '+97714123456'],
      panVatNo: null,
    });
    await click(editor.container.querySelector('[aria-label="Remove phone number 1"]'));
    expect(editor.hidden('phone').map((i) => i.value)).toEqual(['+97714123456']);
    expect(editor.box('Phone number 1').value).toBe('14123456');
  });

  it('adds a phone row and refuses letters in it', async () => {
    const editor = await mountEditor({ phones: [], panVatNo: null });
    await typeKeys(editor.box('Phone number 1'), '98a12345678');
    expect(editor.box('Phone number 1').value).toBe('9812345678');
  });
});
