// Unit test for the optional documentNumber on submit (P3 U0-C). A document numbered only at issue has
// no number when it is submitted, so the request carries a draft reference instead. The transaction,
// audit, notify and directory are fakes; the full submit runs on Postgres in approvals.integration.test.ts.
import 'reflect-metadata';

import { WorkflowSpecSchema } from '@bos/contracts';
import {
  approvalActions,
  approvalRequests,
  approvalSteps,
  delegations,
  workflowDefinitions,
} from '@bos/db';
import { describe, expect, it } from 'vitest';

import type { UserDirectory } from '../../platform/authz/user-directory';
import type { DbTransaction } from '../../platform/db/db.module';
import { ApprovalsService } from './requests.service';
import type { ApprovalsAudit, ApprovalsCaller, ApprovalsNotify, UserNotice } from './ports';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const DOCUMENT_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const REQUESTER = '44444444-4444-4444-8444-444444444444';
const APPROVER = '55555555-5555-4555-8555-555555555555';

const spec = WorkflowSpecSchema.parse({
  documentType: 'quotation',
  steps: [{ id: 'finance', kind: 'role', role: 'finance', reason: 'Finance approves' }],
  rules: [],
});

/** A transaction that answers each table's select with a canned row and records every insert. */
function fakeTx() {
  const inserts: { table: unknown; values: unknown }[] = [];
  const rowsFor = (table: unknown): unknown[] => {
    if (table === workflowDefinitions) {
      return [{ definitionId: 'def-1', versionId: 'ver-1', spec, status: 'published' }];
    }
    if (table === delegations) return [];
    if (table === approvalRequests) {
      return [{ documentType: 'quotation', requesterUserId: REQUESTER }];
    }
    throw new Error('unexpected select');
  };
  const tx = {
    execute: async () => ({ rows: [{ tenant_id: TENANT, organization_id: ORG }] }),
    select: () => {
      let table: unknown;
      const chain = {
        from: (t: unknown) => {
          table = t;
          return chain;
        },
        innerJoin: () => chain,
        where: () => chain,
        then: (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(rowsFor(table)).then(resolve, reject),
      };
      return chain;
    },
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        inserts.push({ table, values });
        return Object.assign(Promise.resolve(), {
          returning: async () => [{ id: REQUEST_ID }],
        });
      },
    }),
  };
  return { tx: tx as unknown as DbTransaction, inserts };
}

function setup() {
  const notices: UserNotice[] = [];
  const notify = {
    notifyUser: async (_tx: DbTransaction, n: UserNotice) => {
      notices.push(n);
    },
  };
  const audit = { record: async () => undefined };
  const users = {
    userIdsWithRole: async () => [APPROVER],
    emailOf: async () => 'sita.sharma@example.com',
  };
  const service = new ApprovalsService(
    {} as never,
    audit as unknown as ApprovalsAudit,
    notify as unknown as ApprovalsNotify,
    users as unknown as UserDirectory,
    {} as ApprovalsCaller,
    () => new Date('2026-11-09T06:00:00Z'),
  );
  service.registerSubject({ documentType: 'quotation', onDecided: async () => undefined });
  return { service, notices, ...fakeTx() };
}

const base = {
  documentType: 'quotation',
  documentId: DOCUMENT_ID,
  title: 'Quotation for Himal Traders',
  snapshot: { total: '1000.00' },
  facts: {},
  requesterUserId: REQUESTER,
  sodUserIds: [REQUESTER],
};

const requestInsert = (inserts: { table: unknown; values: unknown }[]) =>
  inserts.find((i) => i.table === approvalRequests)?.values as { documentNumber: string };

describe('submit without a documentNumber', () => {
  it('stores the draft reference and shows it in the approver notice', async () => {
    const { service, tx, inserts, notices } = setup();
    const result = await service.submit(tx, base);

    expect(result).toEqual({ requestId: REQUEST_ID, status: 'pending' });
    expect(requestInsert(inserts).documentNumber).toBe('Draft quotation a1b2c3d4');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.userId).toBe(APPROVER);
    expect(notices[0]?.title).toBe('Approval needed: Draft quotation a1b2c3d4');
    expect(notices[0]?.email?.vars.documentNumber).toBe('Draft quotation a1b2c3d4');
    // The other tables are written as before.
    expect(inserts.some((i) => i.table === approvalSteps)).toBe(true);
    expect(inserts.some((i) => i.table === approvalActions)).toBe(true);
  });
});

describe('submit with a documentNumber', () => {
  it('is unchanged: the number is stored and shown as given', async () => {
    const { service, tx, inserts, notices } = setup();
    await service.submit(tx, { ...base, documentNumber: 'QT-2026-0042' });

    expect(requestInsert(inserts).documentNumber).toBe('QT-2026-0042');
    expect(notices[0]?.title).toBe('Approval needed: QT-2026-0042');
    expect(notices[0]?.email?.vars.documentNumber).toBe('QT-2026-0042');
  });
});
