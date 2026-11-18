import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SessionUnavailableError } from '@/lib/session-unavailable';

import RootError from './error';

describe('root error boundary', () => {
  it('offers Retry for a session failure with only its production digest', () => {
    const retry = vi.fn();
    const { digest } = new SessionUnavailableError();
    const html = renderToStaticMarkup(<RootError error={{ digest }} retry={retry} />);
    expect(html).toContain('Session check temporarily unavailable');
    expect(html).toContain('>Retry</button>');
    expect(retry).not.toHaveBeenCalled();
  });

  it('shows a generic retry for unrelated failures', () => {
    const html = renderToStaticMarkup(<RootError error={new Error('private')} retry={vi.fn()} />);
    expect(html).toContain('This page did not open');
    expect(html).not.toContain('private');
  });
});
