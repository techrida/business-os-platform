// HTTP routes of customer payments (P3 U7), at the paths the workspace calls (apps/workspace/src/lib/
// api-receivables.ts). Thin on purpose: parsing here, every rule in PaymentsService. Each route names its permission
// with @Can (route level); the service checks the record (record level) and answers 404 for another entity's id.
// Every command needs an Idempotency-Key. Allocating is U8's (POST /v1/payments/:id/allocations); this unit only
// reads allocations. Withdraw has no staff route: the customer withdraws through the portal (U13).
import {
  MAX_ROWS,
  multi,
  searchParam,
  type AllocationDto,
  type PaymentDto,
  type PaymentListItem,
  PaymentMethodSchema,
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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import { Can } from '../../platform/authz/decorators';
import { setMoneyTotals, setTotalCount } from '../../platform/list';
import { parseOr400 } from '../approvals/approvals.controller';
import { requireIdempotencyKey } from '../customers/customers.types';
import { PaymentsCaller } from './payments.caller';
import {
  type PaymentReferenceMatches,
  type PaymentsSummary,
  PaymentsService,
} from './payments.service';

/**
 * `GET /v1/payments`. `status` and `method` may repeat; an unknown value or key or a repeated `q` is a 400.
 * No `limit` means every match.
 */
export const ListPaymentsQuerySchema = z.strictObject({
  status: multi(PaymentStatusSchema),
  method: multi(PaymentMethodSchema),
  q: searchParam,
  limit: z.coerce.number().int().min(1).max(MAX_ROWS).optional(),
  offset: z.coerce.number().int().min(0).default(0),
});

/** `GET /v1/payments/summary`: the counts ignore `status`, so the cards can show every status. */
export const PaymentsSummaryQuerySchema = z.strictObject({
  method: multi(PaymentMethodSchema),
  q: searchParam,
});

/** `GET /v1/payments/reference-matches`: the bank reference about to be recorded, as the record form takes it. */
export const PaymentReferenceMatchesQuerySchema = z.strictObject({
  bankReference: z.string().trim().min(1).max(100),
});

@Controller('v1/payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly caller: PaymentsCaller,
  ) {}

  /**
   * 200 with a bare array of the acting entity's payments, newest first; X-Total-Count is all matches and
   * X-Money-Totals their amounts summed per currency.
   */
  @Get()
  @Can('payment.read')
  async list(
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentListItem[]> {
    const { rows, total, totals } = await this.payments.list(
      this.caller.current().scope,
      parseOr400(ListPaymentsQuerySchema, query),
    );
    setTotalCount(res, total);
    setMoneyTotals(res, totals);
    return rows;
  }

  /** 200 with `{ total, byStatus }` for the acting entity. Declared before `:id`. */
  @Get('summary')
  @Can('payment.read')
  summary(@Query() query: unknown): Promise<PaymentsSummary> {
    return this.payments.summary(
      this.caller.current().scope,
      parseOr400(PaymentsSummaryQuerySchema, query),
    );
  }

  /**
   * 200 with `{ matches }`: the acting entity's payments the caller may read whose bank reference is the same once
   * case and spaces are set aside (TR-Q12d). A warning only; recording a payment never checks it. Declared before
   * `:id`.
   */
  @Get('reference-matches')
  @Can('payment.read')
  referenceMatches(@Query() query: unknown): Promise<PaymentReferenceMatches> {
    return this.payments.referenceMatches(
      this.caller.current().scope,
      parseOr400(PaymentReferenceMatchesQuerySchema, query),
    );
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
