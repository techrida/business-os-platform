import { describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '../../../platform/db/db.module';
import type { Actor, TxScope } from '../../../platform/db/tx';
import {
  collectionAssignee,
  collectionCallText,
  PAYMENT_PROMISE_JOB_PREFIX,
  PaymentPromiseProcessor,
  PaymentPromiseSweeper,
  type CollectionCall,
  type DuePromise,
  type PromiseCandidate,
  type PromiseStore,
  type RunInTx,
} from './payment-promise.sweeper';

const TX = { marker: 'tx' } as unknown as DbTransaction;
/** 2026-11-20 12:00 in Kathmandu is 06:15 UTC. */
const NOW = new Date('2026-11-20T06:15:00.000Z');

const RECORDER = 'u-accountant';
const FINANCE_B = 'u-finance-b';
const FINANCE_A = 'u-finance-a';

const candidate: PromiseCandidate = {
  tenantId: 'tenant-1',
  organizationId: 'org-1',
  promiseId: 'p-1',
};

const due = (over: Partial<DuePromise> = {}): DuePromise => ({
  invoiceId: 'inv-1',
  invoiceNumber: 'INV-2083/84-00007',
  customerPartyId: 'cust-1',
  promisedDate: '2026-11-18',
  note: 'Will pay after the board meets',
  recordedByUserId: RECORDER,
  invoiceOpen: true,
  ...over,
});

const staff = [
  { userId: RECORDER, roleKeys: ['accountant' as const], displayName: 'Asha' },
  { userId: FINANCE_B, roleKeys: ['finance' as const], displayName: 'Bina' },
  { userId: FINANCE_A, roleKeys: ['finance' as const], displayName: 'Anil' },
];

/** A store that keeps the promise in memory, so a second run sees what the first one wrote. */
function memoryStore(start: DuePromise | undefined) {
  let state: 'open' | 'missed' | 'kept' = 'open';
  const calls: CollectionCall[] = [];
  const store: PromiseStore = {
    candidates: vi.fn(() => Promise.resolve(state === 'open' ? [candidate] : [])),
    lockDue: vi.fn(() => Promise.resolve(state === 'open' ? start : undefined)),
    staff: vi.fn(() =>
      Promise.resolve(
        staff.map((s) => ({
          ...s,
          departmentId: null,
          level: 'staff' as const,
          email: null,
          avatarDocumentId: null,
        })),
      ),
    ),
    planCall: vi.fn((_tx, _c, call: CollectionCall) => {
      calls.push(call);
      return Promise.resolve(`activity-${calls.length}`);
    }),
    markMissed: vi.fn(() => {
      state = 'missed';
      return Promise.resolve();
    }),
    markKept: vi.fn(() => {
      state = 'kept';
      return Promise.resolve();
    }),
  };
  return { store, calls, state: () => state };
}

function sweeperWith(store: PromiseStore) {
  const audit = { record: vi.fn(() => Promise.resolve()) };
  const scopes: { scope: TxScope; actor: Actor }[] = [];
  const runTx: RunInTx = (scope, actor, fn) => {
    scopes.push({ scope, actor });
    return fn(TX);
  };
  const notify = { notifyUser: vi.fn(() => Promise.resolve()) };
  return {
    sweeper: new PaymentPromiseSweeper(store, runTx, audit, () => NOW, notify),
    audit,
    scopes,
    notify,
  };
}

describe('collectionAssignee', () => {
  it('keeps the call with the recorder when they hold Finance', () => {
    const withFinanceRecorder = staff.map((s) =>
      s.userId === RECORDER ? { ...s, roleKeys: ['finance' as const] } : s,
    );
    expect(collectionAssignee(withFinanceRecorder, RECORDER)).toBe(RECORDER);
  });

  it('gives it to the first active Finance member by name when the recorder is an Accountant', () => {
    expect(collectionAssignee(staff, RECORDER)).toBe(FINANCE_A);
  });

  it('falls back to the recorder, then to nobody, when the entity has no Finance member', () => {
    const accountantOnly = staff.filter((s) => s.userId === RECORDER);
    expect(collectionAssignee(accountantOnly, RECORDER)).toBe(RECORDER);
    expect(collectionAssignee([], RECORDER)).toBeNull();
  });
});

describe('collectionCallText', () => {
  it('names the invoice and the promised day, and leaves the recorder note on the promise', () => {
    expect(collectionCallText(due())).toEqual({
      subject: 'Collect payment for INV-2083/84-00007',
      body: 'The customer promised to pay INV-2083/84-00007 by 2026-11-18, and it is still open.',
    });
    expect(collectionCallText(due({ note: null })).body).toBe(collectionCallText(due()).body);
  });
});

describe('PaymentPromiseSweeper', () => {
  it('marks a missed promise and plans one collection call for Finance, as the system actor', async () => {
    const mem = memoryStore(due());
    const { sweeper, audit, scopes } = sweeperWith(mem.store);

    await expect(sweeper.sweep()).resolves.toEqual({ missed: 1, kept: 0, skipped: 0, failed: 0 });

    expect(mem.store.candidates).toHaveBeenCalledWith('2026-11-20', 500);
    expect(mem.calls).toEqual([
      {
        customerPartyId: 'cust-1',
        subject: 'Collect payment for INV-2083/84-00007',
        body: expect.stringContaining('by 2026-11-18') as string,
        dueAt: NOW,
        assigneeUserId: FINANCE_A,
      },
    ]);
    expect(mem.store.markMissed).toHaveBeenCalledWith(TX, candidate, 'activity-1', NOW);
    expect(scopes[0]?.scope).toEqual({ tenantId: 'tenant-1', organizationId: 'org-1' });
    expect(scopes[0]?.actor.id).toBe(`system:${PAYMENT_PROMISE_JOB_PREFIX}`);
    expect(audit.record.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      // Its own kind (0154), so the call follows the receivables permissions, not the customer's activity reach.
      expect.objectContaining({
        action: 'activity.scheduled',
        entityId: 'activity-1',
        after: expect.objectContaining({ kind: 'collection_call' }) as unknown,
      }),
      expect.objectContaining({ action: 'payment_promise.missed', entityId: 'p-1' }),
    ]);
  });

  it('rings the bell of the call assignee in the transaction that plans it, keyed by the call', async () => {
    const mem = memoryStore(due());
    const { sweeper, notify } = sweeperWith(mem.store);
    await sweeper.sweep();
    expect(notify.notifyUser).toHaveBeenCalledTimes(1);
    expect(notify.notifyUser).toHaveBeenCalledWith(TX, {
      userId: FINANCE_A,
      title: 'Collect payment for INV-2083/84-00007',
      body: expect.stringContaining('by 2026-11-18') as string,
      link: '/activities/',
      dedupeKey: 'collection_call.planned:activity-1',
    });
  });

  it('rings nobody when the call has no assignee, and nobody for a kept promise', async () => {
    const orphan = memoryStore(due());
    vi.mocked(orphan.store.staff).mockResolvedValueOnce([]);
    const a = sweeperWith(orphan.store);
    await a.sweeper.sweep();
    expect(orphan.calls[0]?.assigneeUserId).toBeNull();
    expect(a.notify.notifyUser).not.toHaveBeenCalled();

    const kept = memoryStore(due({ invoiceOpen: false }));
    const b = sweeperWith(kept.store);
    await b.sweeper.sweep();
    expect(b.notify.notifyUser).not.toHaveBeenCalled();
  });

  it('plans no second call when it runs again', async () => {
    const mem = memoryStore(due());
    const { sweeper } = sweeperWith(mem.store);
    await sweeper.sweep();
    await expect(sweeper.sweep()).resolves.toEqual({ missed: 0, kept: 0, skipped: 0, failed: 0 });
    // A worker that read the candidate before the first one committed finds it settled under the lock.
    await expect(sweeper.settleOne(candidate, '2026-11-20')).resolves.toBe('skipped');
    expect(mem.calls).toHaveLength(1);
  });

  it('closes the promise as kept, with no call, when the invoice was settled', async () => {
    const mem = memoryStore(due({ invoiceOpen: false }));
    const { sweeper, audit } = sweeperWith(mem.store);
    await expect(sweeper.sweep()).resolves.toEqual({ missed: 0, kept: 1, skipped: 0, failed: 0 });
    expect(mem.calls).toEqual([]);
    expect(mem.state()).toBe('kept');
    expect(audit.record).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ action: 'payment_promise.kept' }),
    );
  });

  it('counts a failed promise and carries on', async () => {
    const mem = memoryStore(due());
    vi.mocked(mem.store.planCall).mockRejectedValueOnce(new Error('Acme owes NPR 5,00,000'));
    const { sweeper } = sweeperWith(mem.store);
    await expect(sweeper.sweep()).resolves.toEqual({ missed: 0, kept: 0, skipped: 0, failed: 1 });
  });
});

describe('PaymentPromiseProcessor', () => {
  it('runs the sweep for its job and refuses an unknown one', async () => {
    const sweep = vi.fn(() => Promise.resolve({ missed: 0, kept: 0, skipped: 0, failed: 0 }));
    const processor = new PaymentPromiseProcessor({ sweep } as unknown as PaymentPromiseSweeper);
    await processor.process({ name: 'payment-promise.sweep' } as never);
    expect(sweep).toHaveBeenCalledTimes(1);
    await expect(processor.process({ name: 'other' } as never)).rejects.toThrow(/Unknown/);
  });
});
