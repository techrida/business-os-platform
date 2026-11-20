import { PR_STATUSES } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { grantsFrom } from '@/components/p2/customers/permissions';
import type { Grants } from '@/lib/grants';

import {
  approvalSummary,
  canCancelPr,
  countStatuses,
  isPrEditable,
  PR_COUNT_GROUPS,
  PR_STATUS_LABEL,
  prGrants,
} from './model';

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

// The live saved grants decide, not the role defaults: an admin can widen or narrow them in Settings > Access.
describe('prGrants with live grants', () => {
  it('reads every request when the saved grant is widened to all (operations officer defaults to own)', () => {
    const live: Grants = new Map([
      ['procurement.pr.read', 'all'],
      ['procurement.pr.create', 'own'],
    ]);
    expect(prGrants(live)).toEqual({ read: true, readAll: true, create: true });
  });

  it('reads only their own when the saved grant is narrowed (procurement defaults to all)', () => {
    const live: Grants = new Map([['procurement.pr.read', 'own']]);
    expect(prGrants(live)).toEqual({ read: true, readAll: false, create: false });
    const department: Grants = new Map([['procurement.pr.read', 'department']]);
    expect(prGrants(department).readAll).toBe(false);
  });

  it('grants nothing once the grants are removed, whatever the role defaults say', () => {
    expect(prGrants(new Map())).toEqual({ read: false, readAll: false, create: false });
  });

  it('finance gains the list when an admin grants it, though no default carries it', () => {
    const live = grantsFrom(
      { permissions: [{ permission: 'procurement.pr.read', scope: 'all' }] },
      ['finance'],
    );
    expect(prGrants(live)).toEqual({ read: true, readAll: true, create: false });
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

describe('count cards', () => {
  it('counts the whole group when no status is picked', () => {
    expect(countStatuses(PR_COUNT_GROUPS.sourcing, [])).toEqual([
      'dept_approved',
      'sourcing',
      'commitment_pending',
    ]);
  });
  it('counts only the picked statuses inside a group, and nothing outside it', () => {
    expect(countStatuses(PR_COUNT_GROUPS.approved, ['po_issued', 'draft'])).toEqual(['po_issued']);
    expect(countStatuses(PR_COUNT_GROUPS.awaiting, ['draft'])).toEqual([]);
  });
  it('no status sits in two groups', () => {
    const all = Object.values(PR_COUNT_GROUPS).flat();
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('approvalSummary', () => {
  it('names the decision and its time in plain words', () => {
    expect(approvalSummary('approved', '20 Nov 2026')).toBe('Approved on 20 Nov 2026.');
    expect(approvalSummary('pending', null)).toBe('Waiting for a decision.');
    expect(approvalSummary('rejected', null)).toBe('Rejected.');
  });
  it('never repeats the word approval', () => {
    for (const s of [
      'pending',
      'approved',
      'returned',
      'rejected',
      'blocked',
      'cancelled',
    ] as const)
      expect(approvalSummary(s, 'today')).not.toMatch(/^Approval /);
  });
});
