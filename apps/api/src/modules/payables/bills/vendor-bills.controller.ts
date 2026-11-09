// REST routes of vendor bills (P4 unit A1) under /v1/payables/bills. Entering, matching, exceptions and submit need
// payables.bill.enter (accountants); reading needs payables.bill.read. Every write takes an Idempotency-Key.
// Approval is through the approvals inbox (routes vendor_bill and match_exception).
import {
  BillStatusSchema,
  CreateVendorBillBodySchema,
  RequestMatchExceptionBodySchema,
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
import { z } from 'zod';

import { Can } from '../../../platform/authz/decorators';
import { parseOr400 } from '../../approvals/approvals.controller';
import { requireIdempotencyKey } from '../../customers/customers.types';
import {
  VendorBillsService,
  type MatchExceptionDto,
  type VendorBillDto,
} from './vendor-bills.service';

const ListBillsQuerySchema = z.strictObject({ status: BillStatusSchema.optional() });

@Controller('v1/payables/bills')
export class VendorBillsController {
  constructor(private readonly bills: VendorBillsService) {}

  /** The entity's bills, newest first. Query: `status` (optional). */
  @Get()
  @Can('payables.bill.read')
  list(@Query() query: unknown): Promise<Omit<VendorBillDto, 'lines'>[]> {
    return this.bills.list(parseOr400(ListBillsQuerySchema, query).status);
  }

  /** 404 outside the acting entity. */
  @Get(':id')
  @Can('payables.bill.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<VendorBillDto> {
    return this.bills.get(id);
  }

  /** 201 with the bill, matched when it names a PO. 409 DUPLICATE_BILL for an invoice number already billed. */
  @Post()
  @HttpCode(201)
  @Can('payables.bill.enter')
  create(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<VendorBillDto> {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.bills.create(parseOr400(CreateVendorBillBodySchema, body), idempotencyKey);
  }

  /** 200 with the bill after a new match run. 409 for a bill without a PO or past matching. */
  @Post(':id/match')
  @HttpCode(200)
  @Can('payables.bill.enter')
  match(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<VendorBillDto> {
    return this.bills.match(id, requireIdempotencyKey(key));
  }

  /** 201 with the pending exception (Finance decides). 409 unless the bill is in variance. */
  @Post(':id/exceptions')
  @HttpCode(201)
  @Can('payables.bill.enter')
  requestException(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<MatchExceptionDto> {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.bills.requestException(
      id,
      parseOr400(RequestMatchExceptionBodySchema, body),
      idempotencyKey,
    );
  }

  /** 200 with the bill in pending_approval. 409 BILL_NOT_MATCHED; 422 NO_ELIGIBLE_APPROVER. */
  @Post(':id/submit')
  @HttpCode(200)
  @Can('payables.bill.enter')
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<VendorBillDto> {
    return this.bills.submit(id, requireIdempotencyKey(key));
  }
}
