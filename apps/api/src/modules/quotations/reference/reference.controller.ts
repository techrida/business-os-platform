// HTTP routes of the quotation reference lists. Thin on purpose: no input to parse, the rules are in
// ReferenceService. Both are bare arrays. payment-terms is behind quotation.read (the permission of the form that
// uses it). tax-codes serves three forms (quotation, RFQ quotation entry, payables bill entry), and one @Can names
// one permission, so it carries @AnyAuthenticated and ReferenceService checks the any-of grant before reading.
import type { PaymentTerm, TaxCode, WithholdingCode } from '@bos/contracts';
import { Controller, Get } from '@nestjs/common';

import { AnyAuthenticated, Can } from '../../../platform/authz/decorators';
import { ReferenceService } from './reference.service';

@Controller('v1')
export class ReferenceController {
  constructor(private readonly reference: ReferenceService) {}

  /**
   * 200 with a bare array of TaxCode: the tenant's codes in force today in Asia/Kathmandu, by code. 403 unless the
   * caller holds quotation.read, procurement.sourcing, payables.bill.enter or settings.finance.write.
   */
  @Get('tax-codes')
  @AnyAuthenticated()
  taxCodes(): Promise<TaxCode[]> {
    return this.reference.listTaxCodes();
  }

  /**
   * Current payable TDS codes for staff bill entry and the Tax settings page; tenant-level, like VAT codes. One @Can
   * names one permission, so ReferenceService checks the any-of grant before reading.
   */
  @Get('withholding-codes')
  @AnyAuthenticated()
  withholdingCodes(): Promise<WithholdingCode[]> {
    return this.reference.listWithholdingCodes();
  }

  /** 200 with a bare array of PaymentTerm: the tenant's active terms, shortest first. */
  @Get('payment-terms')
  @Can('quotation.read')
  paymentTerms(): Promise<PaymentTerm[]> {
    return this.reference.listPaymentTerms();
  }
}
