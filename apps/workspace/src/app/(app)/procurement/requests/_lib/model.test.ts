import { PR_STATUSES } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { canCancelPr, isPrEditable, PR_STATUS_LABEL, prGrants } from './model';

describe('prGrants', () => {
  it('procurement creates and reads every request', () => {
    expect(prGrants(['procurement'])).toEqual({ read: true, readAll: true, create: true });
  });
  it('an operations officer creates and reads only their own', () => {
    expect(prGrants(['operations_officer'])).toEqual({ read: true, readAll: false, create: true });
  });
  it('finance has no purchase request grant (deny by default)', () => {
    expect(prGrants(['finance'])).toEqual({ read: false, readAll: false, create: false });
    expect(prGrants([])).toEqual({ read: false, readAll: false, create: false });
    expect(prGrants(['not-a-role'])).toEqual({ read: false, readAll: false, create: false });
  });
});

describe('what a status allows', () => {
  it('only a draft or returned request can be edited or submitted', () => {
    expect(PR_STATUSES.filter((s) => isPrEditable(s))).toEqual(['draft', 'returned']);
  });
  it('only a draft can be cancelled', () => {
    expect(PR_STATUSES.filter((s) => canCancelPr(s))).toEqual(['draft']);
  });
  it('every status has a label', () => {
    for (const s of PR_STATUSES) expect(PR_STATUS_LABEL[s].text.length).toBeGreaterThan(0);
  });
});
