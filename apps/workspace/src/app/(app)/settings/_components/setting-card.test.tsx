import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { FieldSpec } from './setting-fields';

vi.mock('@/app/(app)/settings/_components/actions', () => ({
  saveSettingsPageAction: vi.fn(),
  saveCardAction: vi.fn(),
  resetSettingAction: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { SettingCard } = await import('./setting-card');

const vat = (isDefault: boolean): FieldSpec => ({
  key: 'tax.vat_rate',
  label: 'Default VAT rate (%)',
  kind: 'percent',
  current: { kind: 'text', value: isDefault ? '13' : '10' },
  defaultValue: { kind: 'text', value: '13' },
  version: isDefault ? null : 4,
  defaultText: '13',
  isDefault,
  numberBounds: { min: 0, max: 100, step: '0.01' },
});

const prefix = (isDefault: boolean): FieldSpec => ({
  key: 'numbering.memo_prefix',
  label: 'Memo number prefix',
  kind: 'prefix',
  current: { kind: 'text', value: isDefault ? 'MEMO' : 'DOC' },
  defaultValue: { kind: 'text', value: 'MEMO' },
  version: isDefault ? null : 2,
  defaultText: 'MEMO',
  isDefault,
});

const sla: FieldSpec = {
  key: 'approvals.sla_defaults',
  label: 'Default reminder and escalation times',
  kind: 'sla',
  current: {
    kind: 'sla',
    value: { remindAfterHours: '24', escalateAfterHours: '72', escalateToRole: 'founder' },
  },
  defaultValue: {
    kind: 'sla',
    value: { remindAfterHours: '24', escalateAfterHours: '72', escalateToRole: 'founder' },
  },
  version: null,
  defaultText: 'remind after 24 h, escalate after 72 h to founder',
  isDefault: true,
};

const schedule: FieldSpec = {
  key: 'sales.default_schedule',
  label: 'Default billing schedule',
  kind: 'schedule',
  current: {
    kind: 'schedule',
    rows: [
      { label: 'Advance 60%', percent: '60', trigger: 'advance' },
      { label: 'Final 40%', percent: '40', trigger: 'uat' },
    ],
  },
  defaultValue: {
    kind: 'schedule',
    rows: [
      { label: 'Advance 60%', percent: '60', trigger: 'advance' },
      { label: 'Milestone 20%', percent: '20', trigger: 'milestone' },
      { label: 'Final 20%', percent: '20', trigger: 'uat' },
    ],
  },
  version: 2,
  defaultText: 'Advance 60%, Milestone 20%, Final 20%',
  isDefault: false,
};

const render = (fields: FieldSpec[], section: 'tax' | 'workflows' | 'sales' = 'tax') =>
  renderToStaticMarkup(<SettingCard section={section} title="Settings" fields={fields} />);

describe('SettingCard markup and typed controls', () => {
  it('draws neither undo nor reset icon when clean and at default', () => {
    const html = render([vat(true), prefix(true)]);
    expect(html).not.toContain('Undo change to');
    expect(html).not.toContain('Reset ');
    expect(html).not.toContain('Back to default');
  });

  it('draws a reset-to-default icon with "Back to default" tooltip only for non-default settings, outside <label>', () => {
    const html = render([vat(true), prefix(false)]);
    expect(html.match(/aria-label="Reset [^"]+ to default"/g)).toEqual([
      'aria-label="Reset Memo number prefix to default"',
    ]);
    expect(html).toContain('title="Back to default (MEMO)"');
    expect(html).not.toContain('Undo change to');
    // Never inside the field's label, so the input keeps its own name.
    expect(html).not.toMatch(/<label[^>]*>[^<]*<button/);
  });

  it('keeps reset buttons as type="button" and keeps Save disabled when clean', () => {
    const html = render([vat(false)]);
    const button = html.match(/<button[^>]*aria-label="Reset[^>]*>/)?.[0] ?? '';
    expect(button).toContain('type="button"');
    const save = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? '';
    expect(save).toContain('disabled');
  });

  it('renders numeric inputs with contract min/max/step attributes', () => {
    const html = render([vat(true)]);
    expect(html).toContain('type="number"');
    expect(html).toContain('min="0"');
    expect(html).toContain('max="100"');
    expect(html).toContain('step="0.01"');
  });

  it('renders SLA as flat labelled typed controls with no JSON and no fieldset nesting', () => {
    const html = render([sla], 'workflows');
    expect(html).toContain('Remind after (hours)');
    expect(html).toContain('Escalate after (hours)');
    expect(html).toContain('Escalate to');
    expect(html).not.toContain('<fieldset');
    expect(html).not.toContain('remindAfterHours');
    expect(html).not.toContain('escalateAfterHours');
  });

  it('renders billing schedule rows as typed controls with running total and no JSON', () => {
    const html = render([schedule], 'sales');
    expect(html).toContain('Advance 60%');
    expect(html).toContain('Final 40%');
    expect(html).toContain('Total 100% of 100%');
    expect(html).not.toContain('<fieldset');
    expect(html).not.toContain('&quot;trigger&quot;');
  });
});
