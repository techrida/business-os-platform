// Unit tests of QuotationSubmitService with the database, pricing and approvals faked: the order of operations and
// what reaches the approvals engine. The SQL (scoped reads, the S2 freeze and snapshot checks, the 404 for another
// entity) runs on Postgres in the integration test.
import { DEFAULT_SALES_SCHEDULE, type RoutePlan } from '@bos/contracts';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '../../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../../platform/db/idempotency';
import type {
  QuotationLineRow,
  QuotationTaxSummaryRow,
  QuotationVersionRow,
} from '../drafting/mapping';
import { priceQuotation } from '../pricing/pricing';
import type { PricedVersion } from '../pricing/pricing.types';
import { planSchedule, ScheduleRuleError, scheduleTemplateOf } from '../../sales-orders/rules';
import {
  buildApprovalSnapshot,
  contentSha256,
  materialFieldsOf,
  snapshotSha256,
} from './quotation-approval-snapshot';
import {
  assertNoZeroInstalment,
  QuotationSubmitService,
  storedPricingInput,
  type SubmitHead,
} from './quotation-submit.service';

const TX = { fake: 'tx' } as unknown as DbTransaction;

vi.mock('../../../platform/db/tx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../platform/db/tx')>()),
  withTx: vi.fn((_db: unknown, _scope: unknown, _actor: unknown, fn: (tx: unknown) => unknown) =>
    fn(TX),
  ),
}));
vi.mock('../../../platform/db/idempotency', () => ({
  withIdempotency: vi.fn(),
  updateVersioned: vi.fn(),
}));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TENANT = id(1);
const ORG = id(2);
const QID = id(10);
const VID = id(11);
const CUSTOMER = id(20);
const TAX_VAT = id(30);
const OWNER = id(50);
const CALLER = id(51);
const REQUEST = id(60);
const NOW = new Date('2026-11-09T06:00:00.000Z');
const T0 = new Date('2026-11-01T08:00:00.000Z');
const SCOPE = { tenantId: TENANT, organizationId: ORG };
const ACTOR = { kind: 'user' as const, id: CALLER };

const versionRow = (over: Partial<QuotationVersionRow> = {}): QuotationVersionRow => ({
  id: VID,
  tenantId: TENANT,
  organizationId: ORG,
  quotationId: QID,
  revisionNo: 1,
  status: 'draft',
  rejectionSource: null,
  contactId: null,
  templateId: null,
  currency: 'NPR',
  issueDate: '2026-11-09',
  validUntil: '2026-11-30',
  scope: null,
  assumptions: null,
  exclusions: null,
  termsAndConditions: null,
  deliveryTimeline: null,
  paymentTermId: null,
  paymentSchedule: [],
  discountMode: 'pct',
  discountInput: '8.0000',
  subtotal: '1000.00',
  discountAmount: '80.00',
  taxableAmount: '920.00',
  taxAmount: '119.60',
  total: '1039.60',
  effectiveDiscountPct: '8.0000',
  fxRate: null,
  fxSource: null,
  fxDate: null,
  amountNpr: null,
  nprTaxableAmount: null,
  internalCostTotal: null,
  marginPct: null,
  calcVersion: 1,
  contentSha256: null,
  snapshotSha256: null,
  approvalRequestId: null,
  renderedDocumentId: null,
  renderedSha256: null,
  renderState: 'none',
  documentStyle: null,
  renderAttempts: 0,
  supersedesVersionId: null,
  supersededByVersionId: null,
  revisionReason: null,
  cancelReason: null,
  submittedAt: null,
  approvedAt: null,
  sentAt: null,
  acceptedAt: null,
  rejectedAt: null,
  expiredAt: null,
  cancelledAt: null,
  version: 4,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

const head = (over: Partial<QuotationVersionRow> = {}): SubmitHead => ({
  quotation: {
    id: QID,
    number: 'QT-2082/83-00042',
    tenantId: TENANT,
    organizationId: ORG,
    ownerUserId: OWNER,
    customerPartyId: CUSTOMER,
  },
  version: versionRow(over),
});

/** Rows exactly as Postgres returns them: numeric at full column scale. */
const storedLine = (over: Partial<QuotationLineRow> = {}): QuotationLineRow => ({
  id: id(100),
  tenantId: TENANT,
  organizationId: ORG,
  versionId: VID,
  lineNo: 1,
  catalogItemId: null,
  description: 'Design',
  uom: 'job',
  quantity: '2.0000',
  unitPrice: '500.00',
  unitCost: null,
  taxCodeId: TAX_VAT,
  gross: '1000.00',
  discountAlloc: '80.00',
  taxable: '920.00',
  createdAt: T0,
  updatedAt: T0,
  ...over,
});
const storedTax = (): QuotationTaxSummaryRow => ({
  id: id(200),
  tenantId: TENANT,
  organizationId: ORG,
  versionId: VID,
  taxCodeId: TAX_VAT,
  label: 'VAT 13%',
  rate: '13.0000',
  base: '920.00',
  tax: '119.60',
  createdAt: T0,
});

/** The calculator's in-memory output: the same figures at a shorter scale than the columns store. */
const PRICED: PricedVersion = {
  lines: [
    {
      lineNo: 1,
      catalogItemId: null,
      description: 'Design',
      uom: 'job',
      quantity: '2',
      unitPrice: '500.00',
      unitCost: null,
      taxCodeId: TAX_VAT,
      gross: '1000.00',
      discountAlloc: '80.00',
      taxable: '920.00',
    },
  ],
  taxSummary: [{ taxCodeId: TAX_VAT, label: 'VAT 13%', rate: '13', base: '920.00', tax: '119.60' }],
  columns: {
    subtotal: '1000.00',
    discountAmount: '80.00',
    taxableAmount: '920.00',
    taxAmount: '119.60',
    total: '1039.60',
    effectiveDiscountPct: '8.0000',
    amountNpr: '1039.60',
    nprTaxableAmount: '920.00',
    fxRate: '1.000000',
    fxSource: null,
    fxDate: null,
    calcVersion: 1,
    internalCostTotal: null,
    marginPct: null,
  },
  facts: {
    amountNpr: '1039.60',
    nprDiscountAmount: '80.00',
    effectiveDiscountPct: '8',
    discountApprovalRequired: false,
    marginPct: null,
    marginOutOfRange: false,
    currency: 'NPR',
  },
};

const OPEN_PLAN: RoutePlan = {
  steps: [
    {
      seq: 1,
      kind: 'role',
      roleKey: 'finance',
      reason: 'Finance',
      eligibleUserIds: [],
      blocked: false,
    },
  ],
  blocked: false,
};
const BLOCKED_PLAN: RoutePlan = {
  steps: [
    {
      seq: 1,
      kind: 'role',
      roleKey: 'finance',
      reason: 'Finance',
      eligibleUserIds: [],
      blocked: true,
    },
  ],
  blocked: true,
  blockReason: 'No eligible approver for step 1',
};

/** The caller as the service reads it: a staff principal whose live grants may or may not hold the cost grant. */
const callerPrincipal = (mayReadCost: boolean) => ({
  userId: CALLER,
  orgKind: 'staff',
  status: 'active',
  grants: new Map<string, string>(mayReadCost ? [['quotation.cost.read', 'all']] : []),
});

function setup(h: SubmitHead = head(), mayReadCost = true) {
  const store = {
    load: vi.fn().mockResolvedValue(h),
    customerName: vi.fn().mockResolvedValue('Himal Traders Pvt Ltd'),
    lines: vi.fn().mockResolvedValue([storedLine()]),
    replacePriced: vi.fn().mockResolvedValue({ lines: [storedLine()], taxSummary: [storedTax()] }),
    appendHistory: vi.fn().mockResolvedValue(undefined),
  };
  const authz = { assert: vi.fn() };
  const pricing = { priceVersion: vi.fn().mockResolvedValue(PRICED) };
  const approvals = {
    preview: vi.fn().mockResolvedValue(OPEN_PLAN),
    submit: vi.fn().mockResolvedValue({ requestId: REQUEST, status: 'pending' }),
    // The tenant's live admin.roles.write holders (RoleCache through the engine); the defaults give the Founder.
    blockedNoticeRoles: vi.fn().mockResolvedValue(['founder']),
  };
  const notify = { notifyRole: vi.fn().mockResolvedValue(undefined) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const caller = {
    current: () => ({ scope: SCOPE, actor: ACTOR, principal: callerPrincipal(mayReadCost) }),
  };
  const service = new QuotationSubmitService(
    {} as never,
    authz as never,
    pricing as never,
    approvals as never,
    notify as never,
    audit as never,
    store,
    caller as never,
    { get: vi.fn().mockResolvedValue(DEFAULT_SALES_SCHEDULE) } as never,
    () => NOW,
  );
  return { service, store, authz, pricing, approvals, notify, audit };
}

/** updateVersioned as Postgres answers: the row with the set applied, fx_rate read back at numeric(18,6). */
function fakeUpdateVersioned(start: QuotationVersionRow) {
  let row = start;
  vi.mocked(updateVersioned).mockImplementation(
    (
      _tx: unknown,
      _table: unknown,
      _id: string,
      expected: number,
      set: Partial<QuotationVersionRow>,
    ) => {
      if (expected !== row.version) return Promise.reject(new ConflictException('stale'));
      row = { ...row, ...set, version: row.version + 1 };
      return Promise.resolve(row);
    },
  );
}

beforeEach(() => {
  vi.mocked(updateVersioned).mockReset();
  vi.mocked(withIdempotency).mockReset();
  vi.mocked(withIdempotency).mockImplementation(
    async (
      tx: DbTransaction,
      _input: unknown,
      fn: (tx: DbTransaction) => Promise<{ status: number; response: unknown }>,
    ) => ({ ...(await fn(tx)), replayed: false }),
  );
});

const BODY = { expectedVersion: 4 };

describe('QuotationSubmitService.submit', () => {
  it('previews first and, when a step is blocked, tells the admins and answers 422 with nothing written', async () => {
    const { service, approvals, notify, store, audit } = setup();
    fakeUpdateVersioned(versionRow());
    approvals.preview.mockResolvedValue(BLOCKED_PLAN);

    const error: unknown = await service.submit(QID, VID, BODY, 'key-1').catch((e: unknown) => e);

    expect(error).toMatchObject({
      status: 422,
      response: { code: 'NO_ELIGIBLE_APPROVER' },
    });
    expect(approvals.preview).toHaveBeenCalledWith(
      SCOPE,
      'quotation_version',
      { amountNpr: '1039.60', effectiveDiscountPct: '8', discountApprovalRequired: false },
      [OWNER, CALLER],
    );
    expect(updateVersioned).not.toHaveBeenCalled();
    expect(store.replacePriced).not.toHaveBeenCalled();
    expect(store.appendHistory).not.toHaveBeenCalled();
    expect(approvals.submit).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    // admin.roles.write holders are told, through the inbox (the only area approval.blocked may link to).
    expect(notify.notifyRole).toHaveBeenCalled();
    expect(notify.notifyRole.mock.calls[0]![2]).toMatchObject({
      title: 'Approval blocked: QT-2082/83-00042',
      link: '/inbox/',
      email: {
        template: 'approval.blocked',
        vars: { documentNumber: 'QT-2082/83-00042', documentType: 'quotation_version' },
      },
      dedupeKey: `quotation:${VID}:blocked:4`,
    });
  });

  it('is a 422 too when the engine finds the route blocked inside the submit transaction', async () => {
    const { service, approvals, notify, store, audit } = setup();
    fakeUpdateVersioned(versionRow());
    approvals.submit.mockResolvedValue({ requestId: REQUEST, status: 'blocked' });

    const error: unknown = await service.submit(QID, VID, BODY, 'key-1').catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 422, response: { code: 'NO_ELIGIBLE_APPROVER' } });
    expect(store.appendHistory).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(notify.notifyRole).toHaveBeenCalled();
  });

  it('tells every role the tenant gave admin.roles.write, not a list fixed in code', async () => {
    const { service, approvals, notify } = setup();
    fakeUpdateVersioned(versionRow());
    approvals.preview.mockResolvedValue(BLOCKED_PLAN);
    // A Founder-made admin.roles.write row for management: the engine reads it from the live grants.
    approvals.blockedNoticeRoles.mockResolvedValue(['founder', 'management']);

    const error: unknown = await service.submit(QID, VID, BODY, 'key-1').catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 422, response: { code: 'NO_ELIGIBLE_APPROVER' } });
    expect(approvals.blockedNoticeRoles).toHaveBeenCalledWith(SCOPE.tenantId);
    expect(notify.notifyRole.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      'founder',
      'management',
    ]);
  });

  it('submits with the unrounded facts, the snapshot, [owner, caller] and the quotation number', async () => {
    const { service, approvals, store, audit } = setup();
    fakeUpdateVersioned(versionRow());

    const dto = await service.submit(QID, VID, BODY, 'key-1');

    expect(approvals.submit).toHaveBeenCalledTimes(1);
    const [tx, input] = approvals.submit.mock.calls[0] as [unknown, unknown];
    expect(tx).toBe(TX);
    const snapshot = buildApprovalSnapshot({
      priced: PRICED,
      currency: 'NPR',
      customerName: 'Himal Traders Pvt Ltd',
      quotationNumber: 'QT-2082/83-00042',
      revisionNo: 1,
    });
    expect(input).toEqual({
      documentType: 'quotation_version',
      documentId: VID,
      documentNumber: 'QT-2082/83-00042',
      title: 'Quotation QT-2082/83-00042 revision 1',
      snapshot,
      facts: { amountNpr: '1039.60', effectiveDiscountPct: '8', discountApprovalRequired: false },
      requesterUserId: OWNER,
      submittedByUserId: CALLER,
      sodUserIds: [OWNER, CALLER],
    });

    // The status UPDATE carries both hashes and the FX/NPR snapshot; the snapshot hash is the engine's.
    const submitSet = vi
      .mocked(updateVersioned)
      .mock.calls.map((c) => c[4] as Partial<QuotationVersionRow>)
      .find((set) => set.status === 'submitted')!;
    expect(submitSet).toMatchObject({
      fxRate: '1.000000',
      amountNpr: '1039.60',
      nprTaxableAmount: '920.00',
      submittedAt: NOW,
    });
    expect(submitSet.snapshotSha256!.equals(snapshotSha256(snapshot))).toBe(true);
    expect(submitSet.contentSha256).toHaveLength(32);

    // Then the request is linked, the status history row and the audit event written, and the DTO returned.
    expect(vi.mocked(updateVersioned).mock.calls.at(-1)![4]).toEqual({
      approvalRequestId: REQUEST,
      updatedAt: NOW,
    });
    expect(store.appendHistory).toHaveBeenCalledWith(TX, {
      tenantId: TENANT,
      organizationId: ORG,
      versionId: VID,
      fromStatus: 'draft',
      toStatus: 'submitted',
      actorId: CALLER,
      at: NOW,
    });
    expect(audit.record).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ action: 'quotation.submitted', entityId: QID }),
    );
    expect(dto).toMatchObject({ id: VID, status: 'submitted', number: 'QT-2082/83-00042' });
  });

  describe('cost figures in the answer (D29b)', () => {
    const COSTED: PricedVersion = {
      ...PRICED,
      lines: [{ ...PRICED.lines[0]!, unitCost: '300.00' }],
      columns: { ...PRICED.columns, internalCostTotal: '600.00', marginPct: '34.7826' },
    };
    const costedSetup = (mayReadCost: boolean) => {
      const ctx = setup(head(), mayReadCost);
      ctx.pricing.priceVersion.mockResolvedValue(COSTED);
      ctx.store.replacePriced.mockResolvedValue({
        lines: [storedLine({ unitCost: '300.00' })],
        taxSummary: [storedTax()],
      });
      fakeUpdateVersioned(versionRow());
      return ctx;
    };

    it('includes unitCost, internalCostTotal and marginPct for a caller holding quotation.cost.read', async () => {
      const { service } = costedSetup(true);
      const dto = await service.submit(QID, VID, BODY, 'key-1');
      expect(dto).toMatchObject({ internalCostTotal: '600.00', marginPct: '34.7826' });
      expect(dto.lines[0]).toMatchObject({ unitCost: '300.00' });
    });

    it('omits all three (keys absent) for a caller without it, yet still stores and snapshots them', async () => {
      const { service, store, approvals } = costedSetup(false);
      const dto = await service.submit(QID, VID, BODY, 'key-1');
      expect(dto).toMatchObject({ id: VID, status: 'submitted', number: 'QT-2082/83-00042' });
      expect('internalCostTotal' in dto).toBe(false);
      expect('marginPct' in dto).toBe(false);
      for (const l of dto.lines) expect('unitCost' in l).toBe(false);
      // The write path is untouched: the approval snapshot (the approver's figures) is frozen in full.
      expect(store.replacePriced).toHaveBeenCalledWith(TX, expect.anything(), COSTED);
      expect(approvals.submit).toHaveBeenCalledTimes(1);
    });

    it('filters a replayed answer per caller: the stored first answer stays full', async () => {
      const { service } = costedSetup(false);
      const full = await costedSetup(true).service.submit(QID, VID, BODY, 'key-1');
      vi.mocked(withIdempotency).mockResolvedValueOnce({
        status: 200,
        response: full,
        replayed: true,
      });
      const replay = await service.submit(QID, VID, BODY, 'key-1');
      expect('marginPct' in replay).toBe(false);
      expect(replay.lines.every((l) => !('unitCost' in l))).toBe(true);
      expect(full.marginPct).toBe('34.7826');
    });
  });

  it('hashes the rows as Postgres returns them (full scale), not the in-memory priced strings', async () => {
    const { service } = setup();
    fakeUpdateVersioned(versionRow());

    await service.submit(QID, VID, BODY, 'key-1');

    const calls = vi.mocked(updateVersioned).mock.calls;
    // The re-priced columns are written while still a draft, before the status moves.
    expect(calls[0]![4]).not.toHaveProperty('status');
    expect(calls[0]![4]).toMatchObject({ amountNpr: '1039.60', fxRate: '1.000000' });
    const readBack: QuotationVersionRow = {
      ...versionRow(),
      ...PRICED.columns,
      updatedAt: NOW,
      version: 5,
    };
    const fromRows = contentSha256(materialFieldsOf(readBack, [storedLine()], [storedTax()]));
    const fromMemory = contentSha256(materialFieldsOf(readBack, PRICED.lines, PRICED.taxSummary));
    expect(fromRows.equals(fromMemory)).toBe(false);

    const submitSet = calls.find(
      (c) => (c[4] as { status?: string }).status === 'submitted',
    )![4] as {
      contentSha256: Buffer;
    };
    expect(submitSet.contentSha256.equals(fromRows)).toBe(true);
  });

  it.each(['submitted', 'approved', 'sent', 'rejected', 'cancelled'] as const)(
    'is a 409 for a %s version, before pricing or the approvals engine',
    async (status) => {
      const { service, pricing, approvals } = setup(head({ status }));
      await expect(service.submit(QID, VID, BODY, 'key-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(pricing.priceVersion).not.toHaveBeenCalled();
      expect(approvals.preview).not.toHaveBeenCalled();
      expect(updateVersioned).not.toHaveBeenCalled();
    },
  );

  it('submits a returned version too, and records returned -> submitted', async () => {
    const { service, store } = setup(head({ status: 'returned' }));
    fakeUpdateVersioned(versionRow({ status: 'returned' }));
    await service.submit(QID, VID, BODY, 'key-1');
    expect(store.appendHistory).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ fromStatus: 'returned', toStatus: 'submitted' }),
    );
  });

  it('is a 409 for a stale expectedVersion, before the approvals engine', async () => {
    const { service, approvals } = setup();
    await expect(service.submit(QID, VID, { expectedVersion: 3 }, 'key-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(approvals.preview).not.toHaveBeenCalled();
  });

  it('is a 404 (not a 403) for a quotation outside the caller scope', async () => {
    const { service, authz, approvals } = setup();
    authz.assert.mockImplementation(() => {
      throw new ForbiddenException({ code: 'forbidden', reason: 'out_of_scope' });
    });
    await expect(service.submit(QID, VID, BODY, 'key-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(authz.assert).toHaveBeenCalledWith('quotation.submit', expect.anything());
    expect(approvals.preview).not.toHaveBeenCalled();
  });

  it('runs inside withIdempotency keyed on the ids, so a replay returns the first answer untouched', async () => {
    const { service, store, approvals } = setup();
    vi.mocked(withIdempotency).mockResolvedValueOnce({
      status: 200,
      response: { marker: 'first answer' },
      replayed: true,
    });
    await expect(service.submit(QID, VID, BODY, 'key-1')).resolves.toEqual({
      marker: 'first answer',
    });
    expect(vi.mocked(withIdempotency).mock.calls[0]![1]).toEqual({
      command: 'quotation.submit',
      key: 'key-1',
      body: { quotationId: QID, versionId: VID, expectedVersion: 4 },
    });
    expect(store.load).not.toHaveBeenCalled();
    expect(approvals.preview).not.toHaveBeenCalled();
  });
});

describe('QuotationSubmitService.submit: an instalment that is 0.00 only once converted to NPR (FR-4)', () => {
  // INR 0.04 on the 1.6 peg is NPR 0.064, stored as NPR 0.06. In INR every quarter is 0.01; in NPR the first three
  // quarters round half up to 0.02 each and leave 0.00 for the last, which the order's NPR split refuses.
  const QUARTERS = [
    { label: 'Advance', percent: '25' },
    { label: 'Design', percent: '25' },
    { label: 'Build', percent: '25' },
    { label: 'Handover', percent: '25' },
  ];
  const EXEMPT_ROW = {
    id: TAX_VAT,
    code: 'EXEMPT',
    name: 'Exempt',
    kind: 'exempt' as const,
    rateBp: 0,
    creditable: true,
    effectiveFrom: '2000-01-01',
    effectiveTo: null,
  };
  const pricedInr = (): PricedVersion =>
    priceQuotation(
      {
        currency: 'INR',
        issueDate: '2026-11-09',
        discount: null,
        lines: [
          {
            lineNo: 1,
            description: 'Token item',
            uom: 'job',
            quantity: '1',
            unitPrice: '0.04',
            taxCodeId: TAX_VAT,
          },
        ],
      },
      [EXEMPT_ROW],
      { rate: '1.6', source: 'NRB peg', date: '2020-01-01' },
    );

  it('the real pricing and order split agree: INR quarters are positive, the NPR split has a 0.00 line', () => {
    const priced = pricedInr();
    expect(priced.columns).toMatchObject({ total: '0.04', amountNpr: '0.06' });
    expect(() =>
      planSchedule(
        scheduleTemplateOf(QUARTERS, DEFAULT_SALES_SCHEDULE),
        priced.columns.total,
        priced.columns.amountNpr,
      ),
    ).toThrow(ScheduleRuleError);
  });

  it('refuses the submit with 422 PAYMENT_INSTALMENT_ZERO, naming the milestone, before any write', async () => {
    const { service, pricing, store, approvals } = setup(
      head({ currency: 'INR', paymentSchedule: QUARTERS }),
    );
    fakeUpdateVersioned(versionRow());
    pricing.priceVersion.mockResolvedValue(pricedInr());

    const error: unknown = await service.submit(QID, VID, BODY, 'key-1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'PAYMENT_INSTALMENT_ZERO',
      details: { label: 'Handover', total: '0.04', amountNpr: '0.06', converted: true },
    });
    expect(store.replacePriced).not.toHaveBeenCalled();
    expect(approvals.preview).not.toHaveBeenCalled();
  });

  it('splits the company default schedule in NPR too when the quotation has none', () => {
    const { columns } = pricedInr();
    const fallback = QUARTERS.map((m) => ({ ...m, trigger: 'milestone' as const }));
    let error: unknown;
    try {
      assertNoZeroInstalment(columns, 'INR', [], fallback);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'PAYMENT_INSTALMENT_ZERO',
      details: { label: 'Handover', converted: true },
    });
  });
});

describe('assertNoZeroInstalment (FR-4)', () => {
  /** An NPR quotation: its NPR total is its total. */
  const npr = (total: string) => ({ total, amountNpr: total });
  const schedule = [
    { label: 'Advance', percent: '50' },
    { label: 'On delivery', percent: '50' },
  ];

  it('refuses a total whose split leaves a 0.00 instalment, naming the milestone', () => {
    let error: unknown;
    try {
      assertNoZeroInstalment(npr('0.01'), 'NPR', schedule);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'PAYMENT_INSTALMENT_ZERO',
      details: { label: 'On delivery', total: '0.01' },
    });
  });

  it('refuses a 0% milestone, and passes every instalment above 0.00 or no schedule at all', () => {
    expect(() =>
      assertNoZeroInstalment({ total: '1000.00', amountNpr: '133000.00' }, 'USD', [
        { label: 'Deposit', percent: '0' },
        { label: 'Balance', percent: '100' },
      ]),
    ).toThrow(UnprocessableEntityException);
    expect(() => assertNoZeroInstalment(npr('0.02'), 'NPR', schedule)).not.toThrow();
    expect(() => assertNoZeroInstalment(npr('0.00'), 'NPR', [])).not.toThrow();
  });

  it('splits the company default schedule when the quotation has none (the order bills on it)', () => {
    // 20% of 0.02 is 0.004, so the default Final 20% line would be 0.00 on the order.
    let error: unknown;
    try {
      assertNoZeroInstalment(npr('0.02'), 'NPR', [], DEFAULT_SALES_SCHEDULE);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'PAYMENT_INSTALMENT_ZERO',
    });
    expect(() => assertNoZeroInstalment(npr('100.00'), 'NPR', [], DEFAULT_SALES_SCHEDULE)).not.toThrow();
  });
});

describe('storedPricingInput', () => {
  it('reads the stored discount at contract scale and the lines in order', () => {
    const input = storedPricingInput(
      versionRow({ discountMode: 'amount', discountInput: '50.0000' }),
      [storedLine({ lineNo: 2, description: 'Second' }), storedLine()],
    );
    expect(input.discount).toEqual({ mode: 'amount', value: '50.00' });
    expect(input.lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(storedPricingInput(versionRow(), []).discount).toEqual({ mode: 'pct', value: '8' });
    expect(storedPricingInput(versionRow({ discountMode: null }), []).discount).toBeNull();
  });
});
