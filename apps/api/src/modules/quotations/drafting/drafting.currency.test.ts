// Unit tests of the D44 currency check in DraftingService (create and updateDraft), with the database, pricing and
// CurrencyEnabledService faked: a currency the company has not switched on is refused with 422
// CURRENCY_NOT_ENABLED before any write, and an update that keeps the saved currency is not checked at all.
// The check itself (saved list, contract default, NPR) is covered by platform/settings/currency-enabled.test.ts.
// Run with: pnpm --filter @bos/api exec vitest run src/modules/quotations/drafting/drafting.currency.test.ts
import {
  type CreateQuotationBody,
  type UpdateQuotationDraftBody,
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type Scope,
} from '@bos/contracts';
import { UnprocessableEntityException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import type { Principal } from '../../../platform/authz/principal';
import type { Db, DbTransaction } from '../../../platform/db/db.module';
import {
  currencyNotEnabled,
  type CurrencyEnabledService,
} from '../../../platform/settings/currency-enabled';
import type { NumberingService } from '../../../platform/settings/numbering.service';
import type { PricingService } from '../pricing/pricing.service';
import { DraftingService } from './drafting.service';
import { goldenLines } from './quotation.fixture';

const fake = vi.hoisted((): { tx: unknown } => ({ tx: undefined }));

vi.mock('../../../platform/db/tx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../platform/db/tx')>()),
  withTx: vi.fn((_db: unknown, _scope: unknown, _actor: unknown, fn: (tx: unknown) => unknown) =>
    fn(fake.tx),
  ),
}));
vi.mock('../../../platform/db/idempotency', () => ({
  withIdempotency: vi.fn((tx: unknown, _input: unknown, fn: (tx: unknown) => unknown) => fn(tx)),
  updateVersioned: vi.fn(() => {
    throw new Error('updateVersioned is a write and must not run in these tests');
  }),
}));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TENANT = id(1);
const ORG = id(2);
const ME = id(3);
const QID = id(10);
const VID = id(11);
const OPPORTUNITY = id(20);
const CUSTOMER = id(21);
const SCOPE = { tenantId: TENANT, organizationId: ORG };
const ACTOR = { kind: 'user' as const, id: ME, correlationId: 'corr-drafting-currency' };

const principal: Principal = {
  userId: ME,
  zitadelUserId: 'z-me',
  tenantId: TENANT,
  organizationId: ORG,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: id(9),
  roles: ['sales'],
  departmentId: null,
  status: 'active',
  grants: new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS.sales)) as Map<Permission, Scope>,
};

/** Past the check: the next step after it threw this, so the normal path ran on. */
const REACHED_NEXT_STEP = new Error('reached the step after the currency check');

/**
 * A transaction whose selects answer `rows` in order (then REACHED_NEXT_STEP) and that records every write.
 * Every builder method returns the same chain; awaiting it runs the query.
 */
function fakeTx(rows: unknown[][]) {
  const writes: string[] = [];
  const chain = (run: () => Promise<unknown>): unknown => {
    const c: unknown = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'then') {
            const p = run();
            return p.then.bind(p);
          }
          return () => c;
        },
      },
    );
    return c;
  };
  const write = (kind: string) => () => {
    writes.push(kind);
    return chain(() => Promise.resolve([]));
  };
  const tx = {
    select: () =>
      chain(() =>
        rows.length > 0 ? Promise.resolve(rows.shift()) : Promise.reject(REACHED_NEXT_STEP),
      ),
    insert: write('insert'),
    update: write('update'),
    delete: write('delete'),
    execute: write('execute'),
  };
  return { tx: tx as unknown as DbTransaction, writes };
}

function build(assertEnabled: CurrencyEnabledService['assertEnabled']) {
  const currencies = { assertEnabled: vi.fn(assertEnabled) };
  const pricing = { priceVersion: vi.fn(() => Promise.reject(REACHED_NEXT_STEP)) };
  const numbering = { issue: vi.fn(() => Promise.reject(new Error('numbering must not run'))) };
  const audit = { record: vi.fn() };
  const caller = { current: () => ({ scope: SCOPE, actor: ACTOR, principal }) };
  const service = new DraftingService(
    {} as Db,
    numbering as unknown as NumberingService,
    pricing as unknown as PricingService,
    { assert: vi.fn() } as unknown as AuthzService,
    audit as unknown as AuditService,
    caller,
    currencies as unknown as CurrencyEnabledService,
  );
  return { service, currencies, pricing, numbering, audit };
}

const refuse = (_scope: unknown, currency: string | null | undefined) =>
  Promise.reject(currencyNotEnabled(currency ?? ''));
const allow = () => Promise.resolve();

const createBody = (currency: CreateQuotationBody['currency']): CreateQuotationBody => ({
  opportunityId: OPPORTUNITY,
  currency,
  issueDate: '2026-11-19',
  validUntil: '2026-12-19',
  lines: goldenLines({ taxCodeVat13Id: id(30), taxCodeExemptId: id(31) }),
});

/** The reads create makes before the check: the opportunity, then its customers row. */
const createReads = () => [[{ id: OPPORTUNITY, customerId: CUSTOMER }], [{ id: CUSTOMER }]];

/** The reads updateDraft makes before the check: the quotation, then the version (a Draft saved in `saved`). */
const updateReads = (saved = 'NPR') => [
  [{ id: QID, tenantId: TENANT, organizationId: ORG, ownerUserId: ME, customerPartyId: CUSTOMER }],
  [{ id: VID, quotationId: QID, status: 'draft', currency: saved, version: 3 }],
];

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

function expectNotEnabled(error: unknown, currency: string): void {
  expect(error).toBeInstanceOf(UnprocessableEntityException);
  expect((error as UnprocessableEntityException).getStatus()).toBe(422);
  expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
    code: 'CURRENCY_NOT_ENABLED',
    details: { currency },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DraftingService.create checks the currency is enabled (D44)', () => {
  it('refuses a currency the company has not switched on with 422 and writes nothing', async () => {
    const { tx, writes } = fakeTx(createReads());
    fake.tx = tx;
    const { service, currencies, pricing, numbering, audit } = build(refuse);

    expectNotEnabled(await caught(() => service.create(createBody('INR'), 'key-1')), 'INR');

    expect(currencies.assertEnabled).toHaveBeenCalledWith(SCOPE, 'INR');
    expect(writes).toEqual([]);
    expect(pricing.priceVersion).not.toHaveBeenCalled();
    expect(numbering.issue).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('goes on to price the quotation when the currency is enabled', async () => {
    const { tx, writes } = fakeTx(createReads());
    fake.tx = tx;
    const { service, currencies, pricing } = build(allow);

    expect(await caught(() => service.create(createBody('USD'), 'key-2'))).toBe(REACHED_NEXT_STEP);

    expect(currencies.assertEnabled).toHaveBeenCalledWith(SCOPE, 'USD');
    expect(pricing.priceVersion).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });
});

describe('DraftingService.updateDraft checks a changed currency is enabled (D44)', () => {
  it('refuses a change to a currency the company has not switched on with 422 and writes nothing', async () => {
    const { tx, writes } = fakeTx(updateReads());
    fake.tx = tx;
    const { service, currencies, pricing, audit } = build(refuse);

    expectNotEnabled(
      await caught(() => service.updateDraft(QID, VID, { expectedVersion: 3, currency: 'INR' })),
      'INR',
    );

    expect(currencies.assertEnabled).toHaveBeenCalledWith(SCOPE, 'INR');
    expect(writes).toEqual([]);
    expect(pricing.priceVersion).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('goes on when the changed currency is enabled', async () => {
    const { tx } = fakeTx(updateReads());
    fake.tx = tx;
    const { service, currencies } = build(allow);

    expect(
      await caught(() => service.updateDraft(QID, VID, { expectedVersion: 3, currency: 'USD' })),
    ).toBe(REACHED_NEXT_STEP);
    expect(currencies.assertEnabled).toHaveBeenCalledWith(SCOPE, 'USD');
  });

  it('does not check the currency when the body repeats the saved one or leaves it out', async () => {
    // A USD draft stays editable after the company switches USD off: only a change is checked.
    const cases: [saved: string, body: UpdateQuotationDraftBody][] = [
      ['NPR', { expectedVersion: 3, currency: 'NPR' }],
      ['USD', { expectedVersion: 3, currency: 'USD' }],
      ['USD', { expectedVersion: 3, scope: 'Phase 1' }],
    ];
    for (const [saved, body] of cases) {
      const { tx } = fakeTx(updateReads(saved));
      fake.tx = tx;
      // A refusing check proves it is never asked: asking would throw 422 instead of reaching the next step.
      const { service, currencies } = build(refuse);

      expect(await caught(() => service.updateDraft(QID, VID, body))).toBe(REACHED_NEXT_STEP);
      expect(currencies.assertEnabled).not.toHaveBeenCalled();
    }
  });
});
