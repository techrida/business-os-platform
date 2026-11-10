// ReferenceService: the pick-lists a quotation form needs. Serves the NFRs:
// - "tax is read at the issue date": the tax codes returned are the periods in force today in Asia/Kathmandu
//   (the same query pricing uses, listTaxCodesEffectiveOn), one per code;
// - "tenants never see each other": both lists are filtered on the caller's tenant. They are tenant-level, with
//   no entity, so another legal entity of the same tenant sees the same lists (ADR 0027 section 6);
// - "authorization is deny-by-default": the tax codes are read by the quotation form, RFQ quotation entry and payables
//   bill entry, so the grant is any of the three permissions, checked before the read; a role holding only one of
//   the procurement or payables permissions does not get quotation.read (customer quotations);
// - "retired options stay retired": an inactive payment term is not offered (a saved quote keeps its FK).
import type { PaymentTerm, Permission, TaxCode, WithholdingCode } from '@bos/contracts';
import { paymentTerms, withholdingCodes } from '@bos/db';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';

import { principal } from '../../../platform/authz/principal';
import { AuthzService } from '../../../platform/authz/authz.service';
import { DB, type Db } from '../../../platform/db/db.module';
import { listTaxCodesEffectiveOn } from '../pricing/tax-codes.resolver';
import { ReferenceCaller } from './reference.caller';
import { kathmanduDay, toPaymentTermDto, toTaxCodeDto } from './reference.types';

/** Any one of these lets a caller read the tax codes. */
const TAX_CODE_READERS: readonly Permission[] = [
  'quotation.read',
  'procurement.sourcing',
  'payables.bill.enter',
];

@Injectable()
export class ReferenceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly caller: ReferenceCaller,
    private readonly authz: AuthzService,
  ) {}

  async listTaxCodes(): Promise<TaxCode[]> {
    this.assertAnyOf(TAX_CODE_READERS);
    const rows = await listTaxCodesEffectiveOn(
      this.db,
      this.caller.tenantId(),
      kathmanduDay(new Date()),
    );
    return rows.map(toTaxCodeDto);
  }

  async listWithholdingCodes(): Promise<WithholdingCode[]> {
    const caller = principal();
    if (caller.orgKind !== 'staff') {
      throw new ForbiddenException({ code: 'forbidden', message: 'Forbidden' });
    }
    this.authz.assert('payables.bill.enter');
    const day = kathmanduDay(new Date());
    return this.db
      .select({
        id: withholdingCodes.id,
        code: withholdingCodes.code,
        name: withholdingCodes.name,
        rateBp: withholdingCodes.rateBp,
        effectiveFrom: withholdingCodes.effectiveFrom,
        effectiveTo: withholdingCodes.effectiveTo,
      })
      .from(withholdingCodes)
      .where(
        and(
          eq(withholdingCodes.tenantId, this.caller.tenantId()),
          inArray(withholdingCodes.appliesTo, ['payable', 'both']),
          lte(withholdingCodes.effectiveFrom, day),
          or(isNull(withholdingCodes.effectiveTo), gt(withholdingCodes.effectiveTo, day)),
        ),
      )
      .orderBy(asc(withholdingCodes.code));
  }

  async listPaymentTerms(): Promise<PaymentTerm[]> {
    const rows = await this.db
      .select({ id: paymentTerms.id, name: paymentTerms.name })
      .from(paymentTerms)
      .where(
        and(eq(paymentTerms.tenantId, this.caller.tenantId()), eq(paymentTerms.isActive, true)),
      )
      .orderBy(asc(paymentTerms.netDays), asc(paymentTerms.code));
    return rows.map(toPaymentTermDto);
  }

  /** Returns when the caller holds one of `actions`; else rethrows the refusal of the last one tried (403 forbidden). */
  private assertAnyOf(actions: readonly Permission[]): void {
    let refusal: unknown = new ForbiddenException({
      code: 'forbidden',
      message: 'Forbidden',
      reason: 'no_permission',
    });
    for (const action of actions) {
      try {
        this.authz.assert(action);
        return;
      } catch (error) {
        refusal = error;
      }
    }
    throw refusal;
  }
}
