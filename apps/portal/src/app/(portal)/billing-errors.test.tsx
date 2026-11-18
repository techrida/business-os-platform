import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { SessionUnavailableError } from '@/lib/session-unavailable';

import PortalError from './error';

it.each([
  [PortalError, 'We could not load this page'],
] as const)('preserves the %s fallback and retries a digest-only session outage', (Boundary, title) => {
  const callbacks = { retry: vi.fn(), reset: vi.fn() };
  const { digest } = new SessionUnavailableError();
  const outage = Boundary({ error: { digest }, ...callbacks });
  expect(renderToStaticMarkup(outage)).toContain('Session check temporarily unavailable');
  expect(outage.props.retry).toBe(callbacks.retry);
  const generic = renderToStaticMarkup(<Boundary error={new Error('private')} {...callbacks} />);
  expect(generic).toContain(title);
  expect(generic).not.toContain('private');
});
