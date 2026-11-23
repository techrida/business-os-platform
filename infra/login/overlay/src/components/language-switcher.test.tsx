import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { refresh, setLanguageCookie } = vi.hoisted(() => ({
  refresh: vi.fn(),
  setLanguageCookie: vi.fn(async (_code: string) => undefined),
}));

vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/lib/cookies', () => ({ setLanguageCookie }));

import { LanguageSwitcher } from './language-switcher';

const languages = [
  { code: 'en', name: 'English' },
  { code: 'de', name: 'Deutsch' },
];

// jsdom has no ResizeObserver; Headless UI's anchored list measures with it.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('language switcher', () => {
  it('is a styled listbox trigger with a drawn chevron, never a native select', () => {
    const { container } = render(<LanguageSwitcher languages={languages} />);

    expect(container.querySelector('select')).toBeNull();
    const trigger = screen.getByRole('button', { name: /language/i });
    expect(trigger.className).toContain('bos-lang__trigger');
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger.textContent).toContain('English');
    expect(trigger.querySelector('svg.bos-lang__chevron')).not.toBeNull();
  });

  it('opens a listbox with the chosen language ticked and changes the locale on pick', async () => {
    render(<LanguageSwitcher languages={languages} />);
    fireEvent.click(screen.getByRole('button', { name: /language/i }));

    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['English', 'Deutsch']);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');

    fireEvent.click(options[1]!);
    await vi.waitFor(() => expect(setLanguageCookie).toHaveBeenCalledWith('de'));
    expect(refresh).toHaveBeenCalled();
  });

  it('keeps the chosen language ticked after a refresh hands it fresh objects', async () => {
    const { rerender } = render(<LanguageSwitcher languages={languages} />);
    fireEvent.click(screen.getByRole('button', { name: /language/i }));
    fireEvent.click((await screen.findAllByRole('option'))[1]!);
    await vi.waitFor(() => expect(setLanguageCookie).toHaveBeenCalledWith('de'));

    rerender(<LanguageSwitcher languages={languages.map((l) => ({ ...l }))} />);
    const trigger = screen.getByRole('button', { name: /language/i });
    expect(trigger.getAttribute('aria-label')).toContain('Deutsch');
    if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true']);
  });
});
