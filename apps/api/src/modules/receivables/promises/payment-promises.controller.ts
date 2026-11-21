// HTTP route for promises to pay (F1-Q33), beside the receivables reads (apps/workspace calls /v1/receivables/*).
// Thin on purpose: parsing here, every rule in PaymentPromisesService. Recording needs `payment.record` (Finance and
// the Accountant), listing `ar.read` like the other receivables reads; the service checks the invoice and answers 404
// for another entity's id.
import {
  type PaymentPromiseDto,
  type PaymentPromiseList,
  RecordPaymentPromiseBodySchema,
} from '@bos/contracts';
import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post } from '@nestjs/common';

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

  /** 200 with the invoice's promises, newest first, and `can.record`. 404 outside the entity. */
  @Get(':id/promises')
  @Can('ar.read')
  list(@Param('id', ParseUUIDPipe) id: string): Promise<PaymentPromiseList> {
    const { scope, actor } = this.caller.current();
    return this.promises.list(scope, actor, id);
  }

  /**
   * 201 with the promise; an open one on the invoice becomes `replaced`. 400 for a past day; 404 outside the entity;
   * 409 invoice_not_open, or promise_open when another promise was recorded at the same moment.
   */
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
