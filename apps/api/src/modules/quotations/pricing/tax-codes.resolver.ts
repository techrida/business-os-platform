// Tenant-level tax codes (ADR 0027 section 6) read for pricing. A line names a tax_codes row id; pricing needs
// every effective-dated period of that code so @bos/money-rules can pick the one in force on the issue date
// (C-8: [effectiveFrom, effectiveTo), effectiveTo exclusive). Filtered on the tenant only: tax codes have no entity.
import { taxCodes } from '@bos/db';
import { BadRequestException } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';

import type { Db } from '../../../platform/db/db.module';

/** A tax_codes period as pricing needs it. */
export type TaxCodeRow = Pick<
  typeof taxCodes.$inferSelect,
  'id' | 'code' | 'name' | 'kind' | 'rateBp' | 'creditable' | 'effectiveFrom' | 'effectiveTo'
>;

type Executor = Pick<Db, 'select'>;

const columns = {
  id: taxCodes.id,
  code: taxCodes.code,
  name: taxCodes.name,
  kind: taxCodes.kind,
  rateBp: taxCodes.rateBp,
  creditable: taxCodes.creditable,
  effectiveFrom: taxCodes.effectiveFrom,
  effectiveTo: taxCodes.effectiveTo,
};

/**
 * Every period of the codes the given tax_codes ids belong to, in this tenant. 400 `bad_request` when an id is
 * unknown here (another tenant's id included), so a typo never prices at a guessed rate.
 */
export async function loadTaxCodePeriods(
  executor: Executor,
  tenantId: string,
  taxCodeIds: readonly string[],
): Promise<TaxCodeRow[]> {
  const wanted = [...new Set(taxCodeIds)];
  if (wanted.length === 0) return [];
  const named = await executor
    .select({ id: taxCodes.id, code: taxCodes.code })
    .from(taxCodes)
    .where(and(eq(taxCodes.tenantId, tenantId), inArray(taxCodes.id, wanted)));
  const found = new Set(named.filter((row) => wanted.includes(row.id)).map((row) => row.id));
  const missing = wanted.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new BadRequestException({
      code: 'bad_request',
      message: `Unknown tax code: ${missing.join(', ')}`,
    });
  }
  const codes = [...new Set(named.map((row) => row.code))];
  const periods = await executor
    .select(columns)
    .from(taxCodes)
    .where(and(eq(taxCodes.tenantId, tenantId), inArray(taxCodes.code, codes)))
    .orderBy(asc(taxCodes.code), asc(taxCodes.effectiveFrom));
  return periods.filter((row) => codes.includes(row.code));
}

/** The tenant's tax code periods in force on `day` (YYYY-MM-DD), one per code: the list a quote can pick from. */
export async function listTaxCodesEffectiveOn(
  executor: Executor,
  tenantId: string,
  day: string,
): Promise<TaxCodeRow[]> {
  return executor
    .select(columns)
    .from(taxCodes)
    .where(
      and(
        eq(taxCodes.tenantId, tenantId),
        lte(taxCodes.effectiveFrom, day),
        or(isNull(taxCodes.effectiveTo), gt(taxCodes.effectiveTo, day)),
      ),
    )
    .orderBy(asc(taxCodes.code));
}
