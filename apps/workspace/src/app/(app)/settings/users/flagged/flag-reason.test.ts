import { expect, it } from 'vitest';

import { describeFlagReason } from './flag-reason';

it('names the action and the cause in plain words', () => {
  expect(describeFlagReason('users.deactivate:phase_b_failed')).toBe(
    'Deactivating this person failed or timed out in the identity provider, so BOS cannot tell what it now holds.',
  );
  expect(describeFlagReason('users.set_roles:phase_c_failed')).toContain('Changing this person');
  expect(describeFlagReason('users.lock:lease_taken_over')).toContain('earlier request');
});

it('never hides an unknown or missing reason', () => {
  expect(describeFlagReason(null)).toBe('The reason was not recorded.');
  expect(describeFlagReason('something.new:odd')).toBe('Flagged by something.new:odd.');
});
