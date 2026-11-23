import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/(app)/settings/_components/actions', () => ({
  resetSettingAction: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { ResetToDefaultButton } = await import('./reset-to-default');

const props = {
  section: 'tax',
  settingKey: 'tax.vat_rate',
  label: 'Default VAT rate (%)',
  defaultText: '13',
  loadedVersion: 4,
} as const;

describe('ResetToDefaultButton', () => {
  it('draws nothing while the setting is at its default', () => {
    expect(renderToStaticMarkup(<ResetToDefaultButton {...props} isDefault />)).toBe('');
  });

  it('shows a labelled icon button with the default in its tooltip once the setting differs', () => {
    const html = renderToStaticMarkup(<ResetToDefaultButton {...props} isDefault={false} />);
    const button = html.match(/<button[^>]*>/)?.[0] ?? '';
    expect(button).toContain('type="button"');
    expect(button).toContain('aria-label="Reset Default VAT rate (%) to default"');
    // The default shows in the design-system Tooltip (opens on hover or focus), never as a native title bubble.
    expect(button).not.toContain(' title="');
    expect(button).not.toContain('disabled');
    // The icon is decorative; the button's name is the label above.
    expect(html).toContain('aria-hidden="true"');
  });

  it('keeps the button a button (never a form submit) and passes a placement class through', () => {
    const html = renderToStaticMarkup(
      <ResetToDefaultButton {...props} isDefault={false} className="place" />,
    );
    expect(html).toMatch(/<button[^>]*class="[^"]*\bplace\b/);
    expect(html).not.toContain('type="submit"');
  });

  it('with confirm, the button opens a dialog instead of resetting', () => {
    const html = renderToStaticMarkup(
      <ResetToDefaultButton
        {...props}
        isDefault={false}
        confirm={{
          title: 'Reset the VAT rate?',
          body: 'New documents use the default rate.',
          confirmLabel: 'Reset rate',
        }}
      />,
    );
    const button = html.match(/<button[^>]*>/)?.[0] ?? '';
    expect(button).toContain('aria-haspopup="dialog"');
    expect(button).toContain('aria-label="Reset Default VAT rate (%) to default"');
  });
});
