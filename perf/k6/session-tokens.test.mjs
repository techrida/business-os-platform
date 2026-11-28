import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionTokens } from './lib/session-tokens.mjs';

test('refreshes expiring staff sessions before the next journey and keeps their replacements', () => {
  const sessions = {
    buyer: { token: 'initial buyer', expiresAt: 60001 },
    receiver: { token: 'initial receiver', expiresAt: 60002 },
  };
  const calls = [];
  const renew = (role) => {
    calls.push(role);
    return { token: 'renewed ' + role, expiresAt: 900001 };
  };
  const expected = { buyer: 'renewed buyer', receiver: 'initial receiver' };
  assert.deepEqual(sessionTokens(sessions, renew, 1), expected);
  assert.deepEqual(sessionTokens(sessions, renew, 1), expected);
  assert.deepEqual(calls, ['buyer']);
});
