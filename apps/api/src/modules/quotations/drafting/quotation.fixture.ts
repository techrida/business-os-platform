// Shared seed for the quotation integration tests (Q1b-B drafting, Q1b-C revise and later parts). Keep the
// exports stable: other test files build on them. Writes through the @bos/db fixtures and withTx() (the audit
// trigger refuses a write without bos.actor_id), never through a bare pool query.
//
// Seeds one tenant with two legal entities (A, the default and acting one, and B), one customer (party plus
// customers row), a VAT 13% and an exempt tax code (tenant-level, open-ended from 2020), a staff user of A, and
// one opportunity in each entity for that customer.
import { randomUUID } from 'node:crypto';

import type { CreateQuotationBody, Discount, QuotationLineInput } from '@bos/contracts';
import {
  createParty,
  createStaffUser,
  createTenantWithEntity,
  opportunities,
  taxCodes,
  users,
  type FixturePool,
} from '@bos/db';
import { and, eq, sql } from 'drizzle-orm';

import type { Db } from '../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';

/** A drizzle database made with `drizzle({ client: pool })`: the @bos/db fixtures need the pool behind it. */
export type QuotationFixtureDb = Db & { $client: FixturePool };

export interface QuotationFixture {
  tenantId: string;
  /** Entity A: the tenant's default entity, the acting entity of the tests. */
  entityId: string;
  /** Entity B: another legal entity of the same tenant. */
  otherEntityId: string;
  /** The customer's party id, which is also its customers.id. */
  customerPartyId: string;
  /** An opportunity of entity A for the customer, owned by `ownerUserId`. */
  opportunityId: string;
  /** An opportunity of entity B for the same customer. */
  otherEntityOpportunityId: string;
  /** VAT 13% (rate_bp 1300), in force from 2020-01-01, open-ended. */
  taxCodeVat13Id: string;
  /** Exempt (rate_bp 0), in force from 2020-01-01, open-ended. Line 3 of the golden case uses it. */
  taxCodeExemptId: string;
  /** An active staff user of entity A. */
  ownerUserId: string;
}

/** The issue date of the golden body; every tax code above is in force on it. */
export const GOLDEN_ISSUE_DATE = '2026-11-09';

export async function seedQuotationFixture(db: QuotationFixtureDb): Promise<QuotationFixture> {
  const pool = db.$client;
  const tenant = await createTenantWithEntity(pool);
  const { tenantId } = tenant;
  const scopeA: TxScope = { tenantId, organizationId: tenant.organizationId };
  const actor = systemActor('quotation-fixture');

  const otherEntityId = randomUUID();
  await withTx(db, scopeA, actor, (tx) =>
    tx.execute(
      sql`INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
          VALUES (${otherEntityId}, ${tenantId}, ${otherEntityId}, ${`E-${otherEntityId}`},
                  ${`E-${otherEntityId}`}, ${`E-${otherEntityId}`}, false)`,
    ),
  );
  const scopeB: TxScope = { tenantId, organizationId: otherEntityId };

  const { userId: ownerUserId } = await createStaffUser(pool, {
    ...scopeA,
    idpOrgId: tenant.idpOrgId,
  });

  const { partyId: customerPartyId } = await createParty(pool, { tenantId, kind: 'customer' });
  await withTx(db, scopeA, actor, (tx) =>
    tx.execute(
      sql`INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, country,
                                     address_line, address_city)
          VALUES (${customerPartyId}, ${tenantId}, ${`CUS-${customerPartyId.slice(0, 8)}`},
                  'Acme Pvt. Ltd.', 'acme', 'NP', '1 Durbar Marg', 'Kathmandu')`,
    ),
  );

  const [vat13, exempt] = await withTx(db, scopeA, actor, (tx) =>
    tx
      .insert(taxCodes)
      .values([
        {
          tenantId,
          code: 'VAT13',
          name: 'VAT 13%',
          kind: 'vat',
          rateBp: 1300,
          creditable: true,
          effectiveFrom: '2020-01-01',
        },
        {
          tenantId,
          code: 'EXEMPT',
          name: 'Exempt',
          kind: 'exempt',
          rateBp: 0,
          creditable: false,
          effectiveFrom: '2020-01-01',
        },
      ])
      .returning({ id: taxCodes.id }),
  );

  const seedOpportunity = async (scope: TxScope): Promise<string> => {
    const [row] = await withTx(db, scope, actor, (tx) =>
      tx
        .insert(opportunities)
        .values({
          ...scope,
          number: `DEAL-${randomUUID().slice(0, 8)}`,
          name: 'Acme website',
          customerId: customerPartyId,
          ownerUserId,
          stage: 'qualified',
        })
        .returning({ id: opportunities.id }),
    );
    return row!.id;
  };

  return {
    tenantId,
    entityId: scopeA.organizationId,
    otherEntityId,
    customerPartyId,
    opportunityId: await seedOpportunity(scopeA),
    otherEntityOpportunityId: await seedOpportunity(scopeB),
    taxCodeVat13Id: vat13!.id,
    taxCodeExemptId: exempt!.id,
    ownerUserId,
  };
}

/**
 * The P2 golden case (architect section 2.6, packages/money-rules/src/golden.test.ts): two VAT 13% lines and
 * one exempt line. With `GOLDEN_DISCOUNT` (8%) it totals 2,690,999.99 NPR to the paisa.
 */
export function goldenLines(
  f: Pick<QuotationFixture, 'taxCodeVat13Id' | 'taxCodeExemptId'>,
): QuotationLineInput[] {
  return [
    {
      description: 'Implementation',
      uom: 'lot',
      quantity: '1',
      unitPrice: '1800000.00',
      taxCodeId: f.taxCodeVat13Id,
    },
    {
      description: 'Licences',
      uom: 'lot',
      quantity: '1',
      unitPrice: '700000.00',
      taxCodeId: f.taxCodeVat13Id,
    },
    {
      description: 'Training',
      uom: 'day',
      quantity: '3',
      unitPrice: '33333.33',
      taxCodeId: f.taxCodeExemptId,
    },
  ];
}

export const GOLDEN_DISCOUNT: Discount = { mode: 'pct', value: '8' };

/** Unit costs of the three golden lines; with the golden quantities (1, 1, 3) they sum to 1,460,000.00. */
export const GOLDEN_UNIT_COSTS = ['1000000.00', '400000.00', '20000.00'] as const;
export const GOLDEN_INTERNAL_COST = '1460000.00';

/** The golden lines, each with its unit cost (D29b: cost figures are shown only to `quotation.cost.read`). */
export function goldenCostedLines(
  f: Pick<QuotationFixture, 'taxCodeVat13Id' | 'taxCodeExemptId'>,
): QuotationLineInput[] {
  return goldenLines(f).map((line, i) => ({ ...line, unitCost: GOLDEN_UNIT_COSTS[i]! }));
}

/** The stored totals of the golden case. */
export const GOLDEN_TOTALS = {
  subtotal: '2599999.99',
  discountAmount: '208000.00',
  taxableAmount: '2391999.99',
  taxAmount: '299000.00',
  total: '2690999.99',
} as const;

/** A create body for the golden case on `opportunityId` (default: the entity-A opportunity), in NPR. */
export function goldenCreateBody(
  f: QuotationFixture,
  overrides: Partial<CreateQuotationBody> = {},
): CreateQuotationBody {
  return {
    opportunityId: f.opportunityId,
    currency: 'NPR',
    issueDate: GOLDEN_ISSUE_DATE,
    validUntil: '2026-12-09',
    lines: goldenLines(f),
    discount: GOLDEN_DISCOUNT,
    ...overrides,
  };
}

/**
 * Another active staff user of entity A (same IdP org as `ownerUserId`), for "another owner" cases under `own`
 * scope. Added for Q1b-B part 2; the seed above stays as it was.
 */
export async function seedOtherStaffUser(
  db: QuotationFixtureDb,
  f: Pick<QuotationFixture, 'tenantId' | 'entityId' | 'ownerUserId'>,
): Promise<string> {
  const [owner] = await db
    .select({ idpOrgId: users.idpOrgId })
    .from(users)
    .where(and(eq(users.tenantId, f.tenantId), eq(users.id, f.ownerUserId)));
  const { userId } = await createStaffUser(db.$client, {
    tenantId: f.tenantId,
    organizationId: f.entityId,
    idpOrgId: owner!.idpOrgId,
  });
  return userId;
}
