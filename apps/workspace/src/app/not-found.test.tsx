import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { default: NotFound } = await import('./not-found');

// Next's built-in 404 follows prefers-color-scheme and renders black. This page must exist so the
// light-only root layout serves the 404.
describe('not-found page', () => {
  it('renders a notice with a way back instead of the bare framework page', () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).toContain('Page not found');
    expect(html).toContain('href="/"');
  });
});
