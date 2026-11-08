// ReferenceService: the pick-lists a quotation form needs. Serves the NFRs:
// - "tax is read at the issue date": the tax codes returned are the periods in force today in Asia/Kathmandu
//   (the same query pricing uses, listTaxCodesEffectiveOn), one per code;
// - "tenants never see each other": both lists are filtered on the caller's tenant. They are tenant-level, with
//   no entity, so another legal entity of the same tenant sees the same lists (ADR 0027 section 6);
// - "retired options stay retired": an inactive payment term is not offered (a saved quote keeps its FK).
import type { PaymentTerm, TaxCode } from '@bos/contracts';
import { paymentTerms } from '@bos/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';

import { DB, type Db } from '../../../platform/db/db.module';
import { listTaxCodesEffectiveOn } from '../pricing/tax-codes.resolver';
import { ReferenceCaller } from './reference.caller';
import { kathmanduDay, toPaymentTermDto, toTaxCodeDto } from './reference.types';

@Injectable()
export class ReferenceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly caller: ReferenceCaller,
  ) {}

  async listTaxCodes(): Promise<TaxCode[]> {
    const rows = await listTaxCodesEffectiveOn(
      this.db,
      this.caller.tenantId(),
      kathmanduDay(new Date()),
    );
    return rows.map(toTaxCodeDto);
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
}
