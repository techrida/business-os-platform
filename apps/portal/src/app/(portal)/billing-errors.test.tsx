import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { SessionUnavailableError } from '@/lib/session-unavailable';

import PortalError from './error';

it('preserves the portal fallback and retries a digest-only session outage', () => {
  const callbacks = { retry: vi.fn(), reset: vi.fn() };
  const { digest } = new SessionUnavailableError();
  const outage: ReactElement<{ retry: () => void }> = PortalError({
    error: { digest },
    ...callbacks,
  });
  expect(renderToStaticMarkup(outage)).toContain('Session check temporarily unavailable');
  expect(outage.props.retry).toBe(callbacks.retry);
  const generic = renderToStaticMarkup(<PortalError error={new Error('private')} {...callbacks} />);
  expect(generic).toContain('We could not load this page');
  expect(generic).not.toContain('private');
});
