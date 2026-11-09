// HTTP routes of customer payments (P3 U7), at the paths the workspace calls (apps/workspace/src/lib/
// api-receivables.ts). Thin on purpose: parsing here, every rule in PaymentsService. Each route names its permission
// with @Can (route level); the service checks the record (record level) and answers 404 for another entity's id.
// Every command needs an Idempotency-Key. Allocating is U8's (POST /v1/payments/:id/allocations); this unit only
// reads allocations. Withdraw has no staff route: the customer withdraws through the portal (U13).
import {
  type AllocationDto,
  type PaymentDto,
  type PaymentListItem,
  PaymentStatusSchema,
  RejectPaymentBodySchema,
  ReversePaymentBodySchema,
  SubmitPaymentBodySchema,
  VerifyPaymentBodySchema,
} from '@bos/contracts';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';

import { Can } from '../../platform/authz/decorators';
import { parseOr400 } from '../approvals/approvals.controller';
import { requireIdempotencyKey } from '../customers/customers.types';
import { PaymentsCaller } from './payments.caller';
import { PaymentsService } from './payments.service';

@Controller('v1/payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly caller: PaymentsCaller,
  ) {}

  /** 200 with the acting entity's payments, newest first; `?status=` narrows to one status (400 if unknown). */
  @Get()
  @Can('payment.read')
  list(@Query('status') status: unknown): Promise<PaymentListItem[]> {
    const parsed = parseOr400(PaymentStatusSchema.optional(), status);
    return this.payments.list(this.caller.current().scope, parsed);
  }

  /** 200 with the PaymentDto; 404 outside the acting entity. */
  @Get(':id')
  @Can('payment.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<PaymentDto> {
    return this.payments.get(this.caller.current().scope, id);
  }

  /** 200 with every allocation row of the payment against invoices, reversals included. */
  @Get(':id/allocations')
  @Can('payment.read')
  allocations(@Param('id', ParseUUIDPipe) id: string): Promise<AllocationDto[]> {
    return this.payments.allocations(this.caller.current().scope, id);
  }

  /** 201 with the submitted PaymentDto. 422 for an unknown customer, withholding code or proof. */
  @Post()
  @Can('payment.record')
  record(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<PaymentDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    const { scope, actor } = this.caller.current();
    return this.payments.submit(
      scope,
      actor,
      parseOr400(SubmitPaymentBodySchema, body),
      'staff',
      key,
    );
  }

  /** 200 with the verified PaymentDto. 403 for the submitter; 409 when not submitted, stale, or the rate is old. */
  @Post(':id/verify')
  @HttpCode(200)
  @Can('payment.verify')
  verify(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<PaymentDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    const { scope, actor } = this.caller.current();
    return this.payments.verify(scope, actor, id, parseOr400(VerifyPaymentBodySchema, body), key);
  }

  /** 200 with the rejected PaymentDto. 400 without a reason; 409 when not submitted or stale. */
  @Post(':id/reject')
  @HttpCode(200)
  @Can('payment.verify')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<PaymentDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    const { scope, actor } = this.caller.current();
    return this.payments.reject(scope, actor, id, parseOr400(RejectPaymentBodySchema, body), key);
  }

  /** 200 with the reversed PaymentDto; its allocations are reversed first. 409 when not verified or stale. */
  @Post(':id/reverse')
  @HttpCode(200)
  @Can('payment.verify')
  reverse(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<PaymentDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    const { scope, actor } = this.caller.current();
    return this.payments.reverseVerified(
      scope,
      actor,
      id,
      parseOr400(ReversePaymentBodySchema, body),
      key,
    );
  }
}
