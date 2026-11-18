import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import { INBOX_DENIED, inboxDenialMessage } from './denial';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const refused = (error: Record<string, unknown>) =>
  new ApiError(403, 'Forbidden', { error: { code: 'forbidden', correlationId: 'c', ...error } });

describe('inboxDenialMessage', () => {
  it("shows the API's own reason when it gives one", () => {
    expect(
      inboxDenialMessage(
        refused({ message: 'You have no approval assignment', reason: 'out_of_scope' }),
      ),
    ).toBe('You have no approval assignment.');
  });

  it('describes a known reason when the message is the bare "Forbidden"', () => {
    expect(inboxDenialMessage(refused({ message: 'Forbidden', reason: 'inactive_user' }))).toMatch(
      /not active/,
    );
  });

  it('claims no cause it does not know', () => {
    expect(inboxDenialMessage(refused({ message: 'Forbidden' }))).toBe(INBOX_DENIED);
    expect(inboxDenialMessage(new ApiError(403, 'x', 'not json'))).toBe(INBOX_DENIED);
    expect(inboxDenialMessage(new Error('network'))).toBe(INBOX_DENIED);
    expect(INBOX_DENIED).not.toMatch(/role/i);
  });
});
