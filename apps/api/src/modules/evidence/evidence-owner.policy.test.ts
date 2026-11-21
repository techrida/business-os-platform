// The `evidence` owner policy decides on a loaded record, so these unit tests need no database: which grant each
// record kind names, when each kind takes evidence, and that nothing outside staff uploads reaches it.
// Run: pnpm --filter @bos/api exec vitest run src/modules/evidence/evidence-owner.policy.test.ts
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { DocumentOwnerPolicy } from '../../platform/documents/documents.ports';
import {
  EvidenceOwnerPolicy,
  evidenceAttachable,
  evidenceUploadGrants,
  type EvidenceRecord,
} from './evidence-owner.policy';

const scope = { tenantId: randomUUID(), organizationId: randomUUID() };
const CONFIRMER = randomUUID();
const QUOTE_OWNER = randomUUID();
const ENTERER = randomUUID();

const order = (over: Partial<Extract<EvidenceRecord, { kind: 'sales_order' }>> = {}) =>
  ({
    kind: 'sales_order',
    status: 'confirmed',
    createdBy: CONFIRMER,
    quotationOwnerUserId: QUOTE_OWNER,
    hasPlannedLine: true,
    ...over,
  }) as const;
const bill = (status: string): EvidenceRecord => ({
  kind: 'vendor_bill',
  status,
  enteredBy: ENTERER,
});
const version = (over: Partial<Extract<EvidenceRecord, { kind: 'quotation_version' }>> = {}) =>
  ({
    kind: 'quotation_version',
    status: 'accepted',
    quotationOwnerUserId: QUOTE_OWNER,
    hasConfirmedOrder: false,
    ...over,
  }) as const;
const rfq = (status: string): EvidenceRecord => ({ kind: 'rfq', status, createdBy: ENTERER });

describe('evidenceUploadGrants', () => {
  it('names only the record kind’s own permission, on that record’s owners', () => {
    expect(evidenceUploadGrants(scope, order())).toEqual([
      { action: 'sales_order.mark_billable', ref: { ...scope, ownerUserId: CONFIRMER } },
      { action: 'sales_order.mark_billable', ref: { ...scope, ownerUserId: QUOTE_OWNER } },
    ]);
    expect(evidenceUploadGrants(scope, version())).toEqual([
      { action: 'sales_order.confirm', ref: { ...scope, ownerUserId: QUOTE_OWNER } },
    ]);
    expect(evidenceUploadGrants(scope, bill('variance'))).toEqual([
      { action: 'payables.bill.enter', ref: { ...scope, ownerUserId: ENTERER } },
    ]);
    expect(evidenceUploadGrants(scope, rfq('open'))).toEqual([
      { action: 'procurement.sourcing', ref: { ...scope, ownerUserId: ENTERER } },
    ]);
  });
});

describe('evidenceAttachable', () => {
  it('takes evidence on a confirmed order with a planned line only', () => {
    expect(evidenceAttachable(order())).toBe(true);
    expect(evidenceAttachable(order({ hasPlannedLine: false }))).toBe(false);
    for (const status of ['draft', 'completed', 'cancelled']) {
      expect(evidenceAttachable(order({ status }))).toBe(false);
    }
  });

  it('takes evidence on an accepted quotation version until its order is confirmed', () => {
    expect(evidenceAttachable(version())).toBe(true);
    expect(evidenceAttachable(version({ hasConfirmedOrder: true }))).toBe(false);
    for (const status of ['draft', 'sent', 'rejected', 'superseded', 'expired']) {
      expect(evidenceAttachable(version({ status }))).toBe(false);
    }
  });

  it('takes evidence on a bill before submit only', () => {
    for (const status of ['draft', 'matching', 'variance', 'exception_pending']) {
      expect(evidenceAttachable(bill(status))).toBe(true);
    }
    for (const status of [
      'pending_approval',
      'approved',
      'partially_paid',
      'paid',
      'voided',
      'rejected',
      'discarded',
    ]) {
      expect(evidenceAttachable(bill(status))).toBe(false);
    }
  });

  it('takes evidence on an open RFQ only', () => {
    expect(evidenceAttachable(rfq('open'))).toBe(true);
    for (const status of ['closed', 'recommended', 'cancelled']) {
      expect(evidenceAttachable(rfq(status))).toBe(false);
    }
  });
});

describe('EvidenceOwnerPolicy', () => {
  const known = randomUUID();
  const taken = randomUUID();
  const policy = new EvidenceOwnerPolicy(
    (_scope, id) => Promise.resolve(id === known ? bill('variance') : undefined),
    (_scope, record, documentId) =>
      Promise.resolve(record.kind === 'vendor_bill' && record.id === known && documentId === taken),
  );

  it('answers null (404) for an id that is no record of the acting entity', async () => {
    expect(await policy.resource(scope, randomUUID())).toBeNull();
    expect(await policy.uploadGrants(scope, randomUUID())).toBeNull();
    expect(await policy.canAttach(scope, randomUUID())).toBe(false);
  });

  it('reads on the record’s primary owner and uploads with its kind’s grant', async () => {
    expect(await policy.resource(scope, known)).toEqual({ ...scope, ownerUserId: ENTERER });
    expect(await policy.uploadGrants(scope, known)).toEqual([
      { action: 'payables.bill.enter', ref: { ...scope, ownerUserId: ENTERER } },
    ]);
    expect(await policy.canAttach(scope, known)).toBe(true);
  });

  it('freezes a file the record already took: no new version, bytes or removal of it', async () => {
    expect(await policy.canAttach(scope, known, undefined, taken)).toBe(false);
    expect(await policy.canAttach(scope, known, undefined, randomUUID())).toBe(true);
    expect(await policy.canAttach(scope, known)).toBe(true);
  });

  it('is staff only: no job and no portal caller uploads evidence', async () => {
    expect(await policy.allowsSystemActor()).toBe(false);
    const asPort: DocumentOwnerPolicy = policy;
    expect(asPort.allowsCounterparty).toBeUndefined();
    // The generic type list: a photographed delivery note is evidence too.
    expect(asPort.allowedMime).toBeUndefined();
    expect(asPort.uploadPermission).toBeUndefined();
  });
});
