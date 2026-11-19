import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { FieldSpec } from './setting-fields';

vi.mock('@/app/(app)/settings/_components/actions', () => ({
  saveCardAction: vi.fn(),
  resetSettingAction: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { SettingCard } = await import('./setting-card');

const vat = (isDefault: boolean): FieldSpec => ({
  key: 'tax.vat_rate',
  label: 'Default VAT rate (%)',
  kind: 'percent',
  current: isDefault ? '13' : '10',
  version: isDefault ? null : 4,
  defaultText: '13',
  isDefault,
});

const prefix = (isDefault: boolean): FieldSpec => ({
  key: 'numbering.memo_prefix',
  label: 'Memo number prefix',
  kind: 'prefix',
  current: isDefault ? 'MEMO' : 'DOC',
  version: isDefault ? null : 2,
  defaultText: 'MEMO',
  isDefault,
});

const render = (fields: FieldSpec[]) =>
  renderToStaticMarkup(<SettingCard section="tax" title="Tax" fields={fields} />);

describe('SettingCard reset to default', () => {
  it('draws no undo icon when every setting is at its default', () => {
    const html = render([vat(true), prefix(true)]);
    expect(html).not.toContain('Reset ');
    expect(html).not.toContain('title="Reset to default');
  });

  it('draws one undo icon, for the changed setting only, beside its field', () => {
    const html = render([vat(true), prefix(false)]);
    expect(html.match(/aria-label="Reset [^"]+ to default"/g)).toEqual([
      'aria-label="Reset Memo number prefix to default"',
    ]);
    expect(html).toContain('title="Reset to default (MEMO)"');
    // Never inside the field's label, so the input keeps its own name.
    expect(html).not.toMatch(/<label[^>]*>[^<]*<button/);
  });

  it('is a button that cannot submit the card form', () => {
    const html = render([vat(false)]);
    const button = html.match(/<button[^>]*aria-label="Reset[^>]*>/)?.[0] ?? '';
    expect(button).toContain('type="button"');
  });

  it('keeps Save disabled: a reset is not an edit of the card', () => {
    const html = render([vat(false)]);
    const save = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? '';
    expect(save).toContain('disabled');
  });
});
