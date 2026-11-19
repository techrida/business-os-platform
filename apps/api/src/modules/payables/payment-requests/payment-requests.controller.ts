// REST routes of payment requests (P4 unit A2) under /v1/payables/payment-requests. Every route needs
// payables.payment.request (Finance); there is no separate read key, so reading is held to the same people. Every
// write takes an Idempotency-Key. Approval is through the approvals inbox (route payment_request); nothing here
// pays out (AD1).
import { PaymentRequestStatusSchema, RequestPaymentBodySchema } from '@bos/contracts';
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
import { z } from 'zod';

import { Can } from '../../../platform/authz/decorators';
import { parseOr400 } from '../../approvals/approvals.controller';
import { requireIdempotencyKey } from '../../customers/customers.types';
import { CancelPaymentRequestBodySchema } from './payment-request.rules';
import {
  PaymentRequestsService,
  type PaymentRequestDetailDto,
  type PaymentRequestDto,
  type PaymentRequestItemDto,
} from './payment-requests.service';

const ListPaymentRequestsQuerySchema = z.strictObject({
  status: PaymentRequestStatusSchema.optional(),
});

@Controller('v1/payables/payment-requests')
export class PaymentRequestsController {
  constructor(private readonly requests: PaymentRequestsService) {}

  /** The entity's payment requests, newest first. Query: `status` (optional). */
  @Get()
  @Can('payables.payment.request')
  list(@Query() query: unknown): Promise<Omit<PaymentRequestDto, 'lines'>[]> {
    return this.requests.list(parseOr400(ListPaymentRequestsQuerySchema, query).status);
  }

  /** Available approved-bill balances for the payment request entry screen. */
  @Get('items')
  @Can('payables.payment.request')
  items(): Promise<PaymentRequestItemDto[]> {
    return this.requests.listItems();
  }

  /** 404 outside the acting entity. */
  @Get(':id')
  @Can('payables.payment.request')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<PaymentRequestDetailDto> {
    return this.requests.get(id);
  }

  /** 201 with the draft. 409 no_verified_bank_account or OVER_ALLOCATION. */
  @Post()
  @HttpCode(201)
  @Can('payables.payment.request')
  create(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<PaymentRequestDto> {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.requests.create(parseOr400(RequestPaymentBodySchema, body), idempotencyKey);
  }

  /** 200 with the request in pending_approval. 422 NO_ELIGIBLE_APPROVER when nobody may approve it. */
  @Post(':id/submit')
  @HttpCode(200)
  @Can('payables.payment.request')
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<PaymentRequestDto> {
    return this.requests.submit(id, requireIdempotencyKey(key));
  }

  /** 200 with the cancelled draft. 409 for anything but a draft (approved is terminal). */
  @Post(':id/cancel')
  @HttpCode(200)
  @Can('payables.payment.request')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<PaymentRequestDto> {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.requests.cancel(
      id,
      parseOr400(CancelPaymentRequestBodySchema, body),
      idempotencyKey,
    );
  }
}
