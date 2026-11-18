import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SessionUnavailableError } from '@/lib/session-unavailable';

import BuilderError from './error';

describe('new quotation boundary', () => {
  it('offers Retry for a session failure with only its production digest', () => {
    const retry = vi.fn();
    const { digest } = new SessionUnavailableError();
    const html = renderToStaticMarkup(<BuilderError error={{ digest }} retry={retry} />);
    expect(html).toContain('Session check temporarily unavailable');
    expect(html).toContain('>Retry</button>');
    expect(retry).not.toHaveBeenCalled();
  });

  it('shows a generic retry for unrelated failures', () => {
    const html = renderToStaticMarkup(<BuilderError error={new Error('private')} retry={vi.fn()} />);
    expect(html).toContain('The quotation builder did not open');
    expect(html).not.toContain('private');
  });
});
