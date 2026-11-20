import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { ApiError } = await import('./api');
const { INFECTED_FILE, infectedFileMessage } = await import('./infected-file');

const refusal = (status: number, code: string, message: string) =>
  new ApiError(status, 'x', { error: { code, message, correlationId: 'corr-12345678' } });

describe('infectedFileMessage (TR-Q12e)', () => {
  it('shows the API words for a 409 document_infected', () => {
    const message =
      'A virus was found in this file. Remove it or upload a clean copy, then try again.';
    expect(infectedFileMessage(refusal(409, 'document_infected', message))).toBe(message);
  });

  it('falls back to a fixed sentence when the refusal has no words', () => {
    expect(infectedFileMessage(refusal(409, 'document_infected', ' '))).toBe(INFECTED_FILE);
  });

  it('ignores every other error', () => {
    expect(infectedFileMessage(refusal(409, 'conflict', 'm'))).toBeUndefined();
    expect(infectedFileMessage(refusal(422, 'document_infected', 'm'))).toBeUndefined();
    expect(infectedFileMessage(new Error('network'))).toBeUndefined();
    expect(infectedFileMessage(null)).toBeUndefined();
  });
});
