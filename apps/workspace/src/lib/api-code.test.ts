import { describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import { apiCodeOf } from './api-code';

// lib/api is server-only; the guard module is a no-op under the test runner.
vi.mock('server-only', () => ({}));

const body = (code: string) => ({ error: { code, message: 'm', correlationId: 'c' } });

describe('apiCodeOf', () => {
  it('reads the code of an API error body', () => {
    expect(apiCodeOf(new ApiError(422, 'x', body('contact_email_required')))).toBe(
      'contact_email_required',
    );
  });

  it('is undefined for a body without the contract shape, or for another error', () => {
    expect(apiCodeOf(new ApiError(500, 'x', 'gateway text'))).toBeUndefined();
    expect(apiCodeOf(new Error('network'))).toBeUndefined();
    expect(apiCodeOf(undefined)).toBeUndefined();
  });
});
