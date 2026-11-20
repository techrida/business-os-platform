// HTTP route for promises to pay (F1-Q33), beside the receivables reads (apps/workspace calls /v1/receivables/*).
// Thin on purpose: parsing here, every rule in PaymentPromisesService. `payment.record` is the route permission
// (Finance and the Accountant); the service checks the invoice and answers 404 for another entity's id.
import { type PaymentPromiseDto, RecordPaymentPromiseBodySchema } from '@bos/contracts';
import { Body, Controller, Headers, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { Can } from '../../../platform/authz/decorators';
import { parseOr400 } from '../../approvals/approvals.controller';
import { requireIdempotencyKey } from '../../customers/customers.types';
import { ReceivablesCaller } from '../receivables.controller';
import { PaymentPromisesService } from './payment-promises.service';

@Controller('v1/receivables/invoices')
export class PaymentPromisesController {
  constructor(
    private readonly promises: PaymentPromisesService,
    private readonly caller: ReceivablesCaller,
  ) {}

  /** 201 with the promise. 400 for a past day; 404 outside the entity; 409 invoice_not_open or promise_open. */
  @Post(':id/promises')
  @Can('payment.record')
  record(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<PaymentPromiseDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    const { scope, actor } = this.caller.current();
    return this.promises.record(
      scope,
      actor,
      id,
      parseOr400(RecordPaymentPromiseBodySchema, body),
      key,
    );
  }
}
