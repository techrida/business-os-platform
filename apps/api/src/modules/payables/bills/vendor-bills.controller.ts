// REST routes of vendor bills (P4 units A1 and A1c) under /v1/payables/bills, and the purchase VAT register at
// /v1/payables/vat-register (one controller, so the module needs no new registration). Entering, matching,
// exceptions, submit and void need payables.bill.enter (accountants); reading needs payables.bill.read; the register
// needs payables.vat_register.read. Every write takes an Idempotency-Key. Approval is through the approvals inbox
// (routes vendor_bill and match_exception).
import {
  CreateVendorBillBodySchema,
  RequestMatchExceptionBodySchema,
  VoidVendorBillBodySchema,
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

import { Can } from '../../../platform/authz/decorators';
import { setTotalCount } from '../../../platform/list';
import { parseOr400 } from '../../approvals/approvals.controller';
import { requireIdempotencyKey } from '../../customers/customers.types';
import { ListBillsQuerySchema } from './vendor-bill.rules';
import {
  VendorBillsService,
  type MatchExceptionDto,
  type VatRegisterDto,
  type VendorBillDto,
} from './vendor-bills.service';

const VatRegisterQuerySchema = z
  .strictObject({ from: z.iso.date(), to: z.iso.date() })
  .refine((q) => q.from <= q.to, { message: 'from must not be after to', path: ['to'] });

@Controller('v1/payables')
export class VendorBillsController {
  constructor(private readonly bills: VendorBillsService) {}

  /**
   * The entity's bills, newest first. Query: `status` (repeatable), `q`, `limit` (default 25, at most 100),
   * `offset`; X-Total-Count is the number of all matches.
   */
  @Get('bills')
  @Can('payables.bill.read')
  list(
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Omit<VendorBillDto, 'lines'>[]> {
    return this.bills.list(parseOr400(ListBillsQuerySchema, query)).then(({ rows, total }) => {
      setTotalCount(res, total);
      return rows;
    });
  }

  /** 404 outside the acting entity. */
  @Get('bills/:id')
  @Can('payables.bill.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<VendorBillDto> {
    return this.bills.get(id);
  }

  /** 201 with the bill, matched when it names a PO. 409 DUPLICATE_BILL for an invoice number already billed. */
  @Post('bills')
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
  @Post('bills/:id/match')
  @HttpCode(200)
  @Can('payables.bill.enter')
  match(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<VendorBillDto> {
    return this.bills.match(id, requireIdempotencyKey(key));
  }

  /** 201 with the pending exception (Finance decides). 409 unless the bill is in variance. */
  @Post('bills/:id/exceptions')
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
  @Post('bills/:id/submit')
  @HttpCode(200)
  @Can('payables.bill.enter')
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<VendorBillDto> {
    return this.bills.submit(id, requireIdempotencyKey(key));
  }

  /** 200 with the discarded draft. 409 invalid_transition after the draft stage. */
  @Post('bills/:id/discard')
  @HttpCode(200)
  @Can('payables.bill.enter')
  discard(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<VendorBillDto> {
    return this.bills.discard(id, requireIdempotencyKey(key));
  }

  /**
   * 200 with the voided bill (a vendor debit note allocated against it). 409 invalid_transition unless approved,
   * BILL_NOT_POSTED, BILL_HAS_ALLOCATIONS.
   */
  @Post('bills/:id/void')
  @HttpCode(200)
  @Can('payables.bill.enter')
  void(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<VendorBillDto> {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.bills.void(id, parseOr400(VoidVendorBillBodySchema, body), idempotencyKey);
  }

  /** The purchase VAT register by invoice date. Query: `from`, `to` (YYYY-MM-DD, inclusive). */
  @Get('vat-register')
  @Can('payables.vat_register.read')
  vatRegister(@Query() query: unknown): Promise<VatRegisterDto> {
    const { from, to } = parseOr400(VatRegisterQuerySchema, query);
    return this.bills.vatRegister(from, to);
  }
}
