// HTTP routes of allocations and receivables (P3 U8), at the paths the workspace calls (apps/workspace/src/lib/
// api-receivables.ts). Thin on purpose: parsing here, every rule in AllocationsService / ReceivablesService. Each
// route names its permission with @Can (route level); the services check the record and answer 404 for another
// entity's id. Allocation commands need an Idempotency-Key. The allocation routes sit on the payments resource in
// their own controller class, so U7's PaymentsController stays untouched.
import {
  AllocatePaymentBodySchema,
  type AllocationDto,
  type ArAgingReport,
  CurrencySchema,
  type CustomerAdvance,
  DeallocateBodySchema,
  type InvoiceSettlement,
} from '@bos/contracts';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';

import { Can } from '../../platform/authz/decorators';
import { requestTx, type Actor, type TxScope } from '../../platform/db/tx';
import { parseOr400 } from '../approvals/approvals.controller';
import { requireIdempotencyKey } from '../customers/customers.types';
import { AllocationsService } from './allocations.service';
import { ReceivablesService } from './receivables.service';

/** Who is calling, read from the request store (a class so tests can stand in a scope and actor). */
@Injectable()
export class ReceivablesCaller {
  current(): { scope: TxScope; actor: Actor } {
    return requestTx();
  }
}

const OpenFlagSchema = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');

@Controller('v1/payments')
export class PaymentAllocationsController {
  constructor(
    private readonly allocations: AllocationsService,
    private readonly caller: ReceivablesCaller,
  ) {}

  /** 201 with the new allocation rows. 404 outside the entity; 409 OVER_ALLOCATION, MISMATCHED_ITEMS, not verified. */
  @Post(':id/allocations')
  @Can('payment.allocate')
  allocate(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<AllocationDto[]> {
    const key = requireIdempotencyKey(idempotencyKey);
    const { scope, actor } = this.caller.current();
    return this.allocations.allocate(
      scope,
      actor,
      id,
      parseOr400(AllocatePaymentBodySchema, body),
      key,
    );
  }

  /** 200 with the reversal row (negative amount). 400 without a reason; 404 unless it is this payment's. */
  @Post(':id/allocations/:allocationId/reverse')
  @HttpCode(200)
  @Can('payment.allocate')
  reverse(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('allocationId', ParseUUIDPipe) allocationId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<AllocationDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    const { scope, actor } = this.caller.current();
    return this.allocations.reverse(
      scope,
      actor,
      id,
      allocationId,
      parseOr400(DeallocateBodySchema, body),
      key,
    );
  }
}

@Controller('v1/receivables')
export class ReceivablesController {
  constructor(
    private readonly receivables: ReceivablesService,
    private readonly caller: ReceivablesCaller,
  ) {}

  /** 200 with the aging report of the acting entity as of Kathmandu today. */
  @Get('aging')
  @Can('ar.read')
  aging(): Promise<ArAgingReport> {
    return this.receivables.aging(this.caller.current().scope);
  }

  /** 200 with the customer's issued invoices and debit notes; `?open=true` and `?currency=` narrow it (400 if bad). */
  @Get('customers/:id/statement')
  @Can('ar.read')
  statement(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('open') open: unknown,
    @Query('currency') currency: unknown,
  ): Promise<InvoiceSettlement[]> {
    const parsedCurrency = parseOr400(CurrencySchema.optional(), currency);
    return this.receivables.statement(this.caller.current().scope, id, {
      open: parseOr400(OpenFlagSchema, open),
      ...(parsedCurrency === undefined ? {} : { currency: parsedCurrency }),
    });
  }

  /** 200 with the customer's unallocated credit per currency. */
  @Get('customers/:id/advance')
  @Can('ar.read')
  advance(@Param('id', ParseUUIDPipe) id: string): Promise<CustomerAdvance[]> {
    return this.receivables.advance(this.caller.current().scope, id);
  }
}
