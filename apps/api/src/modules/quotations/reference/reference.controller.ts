// HTTP routes of the quotation reference lists. Thin on purpose: no input to parse, the rules are in
// ReferenceService. Both are bare arrays behind quotation.read (the permission of the form that uses them).
import type { PaymentTerm, TaxCode } from '@bos/contracts';
import { Controller, Get } from '@nestjs/common';

import { Can } from '../../../platform/authz/decorators';
import { ReferenceService } from './reference.service';

@Controller('v1')
export class ReferenceController {
  constructor(private readonly reference: ReferenceService) {}

  /** 200 with a bare array of TaxCode: the tenant's codes in force today in Asia/Kathmandu, by code. */
  @Get('tax-codes')
  @Can('quotation.read')
  taxCodes(): Promise<TaxCode[]> {
    return this.reference.listTaxCodes();
  }

  /** 200 with a bare array of PaymentTerm: the tenant's active terms, shortest first. */
  @Get('payment-terms')
  @Can('quotation.read')
  paymentTerms(): Promise<PaymentTerm[]> {
    return this.reference.listPaymentTerms();
  }
}
