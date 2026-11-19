import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { FieldSpec } from './setting-fields';

const buttons = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('@/app/(app)/settings/_components/actions', () => ({
  saveCardAction: vi.fn(),
  resetSettingAction: vi.fn(),
}));
vi.mock('@/components/settings/reset-to-default', () => ({
  ResetToDefaultButton: (props: Record<string, unknown>) => {
    buttons.push(props);
    return null;
  },
}));

const { SettingCard } = await import('./setting-card');

const field = (key: FieldSpec['key'], version: number | null): FieldSpec => ({
  key,
  label: key,
  kind: 'integer',
  current: '1',
  version,
  defaultText: '2',
  isDefault: false,
});

describe('SettingCard reset version', () => {
  it('gives each reset button its own field version, null for a field still at the default', () => {
    buttons.length = 0;
    renderToStaticMarkup(
      <SettingCard
        section="purchasing"
        title="Purchasing"
        fields={[field('procurement.min_quotes', 5), field('procurement.match.qty_pct', null)]}
      />,
    );
    expect(buttons.map((b) => [b.settingKey, b.loadedVersion])).toEqual([
      ['procurement.min_quotes', 5],
      ['procurement.match.qty_pct', null],
    ]);
  });
});
