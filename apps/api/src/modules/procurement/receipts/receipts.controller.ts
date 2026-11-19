// HTTP routes of goods and service receipts (P4 unit P4r). Thin on purpose: parsing here (the bodies are the
// contracts of procurement.ts, plus the exception id of receipt.rules.ts), every rule in ReceiptsService. Every
// write needs an Idempotency-Key, so a double click or a retry cannot open two receipts or reverse one twice.
//
// Route-level grant: @AnyAuthenticated on every route, because no single permission fits the callers: the warehouse
// holds procurement.receipt.confirm, a purchase request's requester (who holds nothing in common with the
// warehouse) may confirm a service receipt. The service is the gate and denies by default: staff only, and a
// grant or the requester's identity for each action. An outsider gets 403, another entity's id gets 404.
import { ReverseReceiptBodySchema } from '@bos/contracts';
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

import { AnyAuthenticated, Can } from '../../../platform/authz/decorators';
import { parseOr400 } from '../../approvals/approvals.controller';
import { requireIdempotencyKey } from '../../customers/customers.types';
import {
  CreateReceiptBodySchema,
  ListReceiptsQuerySchema,
  type PoProgress,
  type ReceiptDto,
} from './receipt.rules';
import {
  ListReceivableOrdersQuerySchema,
  ReceivableOrdersService,
  type ReceivableOrderDto,
} from './receivable-orders.service';
import { ReceiptsService } from './receipts.service';
import {
  ListRequestedOrdersQuerySchema,
  RequestedOrdersService,
  type RequestedOrderDto,
} from './requested-orders.service';

@Controller('v1/procurement/receipts')
@AnyAuthenticated()
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  /** The receipts of one purchase order, newest first. Query: `purchaseOrderId` (required). */
  @Get()
  list(@Query() query: unknown): Promise<ReceiptDto[]> {
    return this.receipts.list(parseOr400(ListReceiptsQuerySchema, query).purchaseOrderId);
  }

  /**
   * 201 with the draft receipt (GRN number taken). 404 for another entity's PO, 403 without the right to
   * receive this kind, 409 unless the PO is issued or partially received, 422 for an over-receipt, a line of
   * another PO, a kind mismatch, a wrong serial count or a duplicate serial.
   */
  @Post()
  create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<ReceiptDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.receipts.create(parseOr400(CreateReceiptBodySchema, body), key);
  }

  /** 404 outside the caller's entity or reach. */
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ReceiptDto> {
    return this.receipts.get(id);
  }

  /** 200 with the discarded draft; reserved quantity is released. 409 after confirmation. */
  @Post(':id/discard')
  @HttpCode(200)
  discard(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<ReceiptDto> {
    return this.receipts.discard(id, requireIdempotencyKey(idempotencyKey));
  }

  /** 200 with the confirmed receipt; the PO moves to partially or fully received. 409 unless a draft. */
  @Post(':id/confirm')
  @HttpCode(200)
  confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<ReceiptDto> {
    return this.receipts.confirm(id, requireIdempotencyKey(idempotencyKey));
  }

  /**
   * 200 with the reversal: a new confirmed receipt of the same lines with negative quantities (AD16). The
   * original becomes `reversed` and the PO status is recomputed. 409 unless the original is confirmed.
   */
  @Post(':id/reverse')
  @HttpCode(200)
  reverse(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<ReceiptDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.receipts.reverse(id, parseOr400(ReverseReceiptBodySchema, body), key);
  }
}

/** Shares the `v1/procurement/purchase-orders` prefix with the purchase order unit's own controller (P3). */
@Controller('v1/procurement/purchase-orders')
@AnyAuthenticated()
export class PurchaseOrderProgressController {
  constructor(private readonly receipts: ReceiptsService) {}

  /** Ordered, received, still open and billed per line (billed is 0 until bills exist). 404 outside the entity. */
  @Get(':id/progress')
  progress(@Param('id', ParseUUIDPipe) id: string): Promise<PoProgress> {
    return this.receipts.progress(id);
  }
}

/**
 * The POs a warehouse can receive against. Its own class, not a route of ReceiptsController: that class carries
 * @AnyAuthenticated, which would let any signed-in staff user read the list; here the grant alone decides.
 */
@Controller('v1/procurement/receivable-orders')
export class ReceivableOrdersController {
  constructor(private readonly orders: ReceivableOrdersService) {}

  /**
   * The acting entity's issued and partially received POs, newest issued first, each with its vendor name, kind
   * and open quantity. Query: `limit` (default 50, at most 200).
   */
  @Get()
  @Can('procurement.receipt.confirm')
  list(@Query() query: unknown): Promise<ReceivableOrderDto[]> {
    return this.orders.list(parseOr400(ListReceivableOrdersQuerySchema, query));
  }
}

/**
 * The purchase orders raised from the caller's own purchase requests (U18 #4): the receipts page's picker for a
 * requester, who may receive a service on them but holds no purchase order read. Its own class for the same reason
 * as ReceivableOrdersController: the grant alone decides, and the service keeps the list to the caller's requests.
 */
@Controller('v1/procurement/requested-orders')
export class RequestedOrdersController {
  constructor(private readonly orders: RequestedOrdersService) {}

  /** Query: `limit` (default 100, at most 200). */
  @Get()
  @Can('procurement.pr.read')
  list(@Query() query: unknown): Promise<RequestedOrderDto[]> {
    return this.orders.list(parseOr400(ListRequestedOrdersQuerySchema, query));
  }
}
