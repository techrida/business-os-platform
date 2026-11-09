// HTTP routes of the customer portal's payments (P3 unit U13, part 3). Thin on purpose: parsing here, every rule in
// PortalPaymentsService. The paths match the portal BFF (`apps/portal/src/lib/api.billing.ts`).
//
// Permissions: the list needs `portal.invoice.read` (authz.ts has no separate payment read key, and the customer role
// holds it at `customer_org`); the submit needs `portal.payment.submit`, which PaymentsService asserts again on the
// caller's party. The service refuses any caller that is not a customer with a party (403).
import { PortalSubmitPaymentBodySchema, type PortalPaymentListItem } from '@bos/contracts';
import { Body, Controller, Get, Headers, Post } from '@nestjs/common';

import { Can } from '../../platform/authz/decorators';
import { parseOr400 } from '../approvals/approvals.controller';
import { requireIdempotencyKey } from '../customers/customers.types';
import { PortalPaymentsService } from './portal-payments.service';

@Controller('v1/portal/payments')
export class PortalPaymentsController {
  constructor(private readonly payments: PortalPaymentsService) {}

  /** 200 with the caller's own payments, newest first, as the strict portal whitelist. */
  @Get()
  @Can('portal.invoice.read')
  list(): Promise<PortalPaymentListItem[]> {
    return this.payments.list();
  }

  /**
   * 201 with the submitted payment as the portal whitelist. The customer is the signed-in party: a body that names
   * one is a 400. 422 `invalid_proof` for a proof that is not the caller's, clean and unused.
   */
  @Post()
  @Can('portal.payment.submit')
  submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<PortalPaymentListItem> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.payments.submit(parseOr400(PortalSubmitPaymentBodySchema, body), key);
  }
}
