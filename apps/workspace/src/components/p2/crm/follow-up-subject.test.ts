import { describe, expect, it } from 'vitest';

import { followUpActionsFor, hasFollowUpActions } from './follow-up-subject';

const NONE = { complete: false, reschedule: false, cancel: false };

describe("followUpActionsFor (the row's can flags)", () => {
  it('passes each flag through on its own', () => {
    expect(
      followUpActionsFor({ can: { complete: true, reschedule: false, cancel: false } }),
    ).toEqual({ complete: true, reschedule: false, cancel: false });
    expect(
      followUpActionsFor({ can: { complete: false, reschedule: true, cancel: false } }),
    ).toEqual({ complete: false, reschedule: true, cancel: false });
    expect(
      followUpActionsFor({ can: { complete: false, reschedule: false, cancel: true } }),
    ).toEqual({ complete: false, reschedule: false, cancel: true });
  });

  it('offers nothing on a row without flags, with no guess from roles', () => {
    expect(followUpActionsFor({})).toEqual(NONE);
    expect(hasFollowUpActions(followUpActionsFor({}))).toBe(false);
  });

  it('offers nothing when every flag is false', () => {
    expect(hasFollowUpActions(followUpActionsFor({ can: NONE }))).toBe(false);
    expect(hasFollowUpActions({ ...NONE, cancel: true })).toBe(true);
  });
});
