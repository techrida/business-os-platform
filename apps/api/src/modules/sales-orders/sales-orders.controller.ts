// HTTP routes of sales orders (P3 unit U9). Thin on purpose: parsing here, every rule in SalesOrdersService. Each
// route names its permission with @Can (route level); the service then keeps every read inside the acting entity,
// so an order of another entity is a 404. POSTs need an Idempotency-Key, so a retry changes nothing twice.
import {
  ConfirmSalesOrderBodySchema,
  MarkBillableBodySchema,
  MAX_ROWS,
  multi,
  searchParam,
  SalesOrderStatusSchema,
  type SalesOrderDetail,
  type SalesOrderListItem,
} from '@bos/contracts';
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import { Can } from '../../platform/authz/decorators';
import { setTotalCount } from '../../platform/list';
import { parseOr400 } from '../approvals/approvals.controller';
import { requireIdempotencyKey } from '../customers/customers.types';
import { type SalesOrdersSummary, SalesOrdersService } from './sales-orders.service';

/**
 * `GET /v1/sales-orders`. `status` and `customerId` may repeat; an unknown value, an unknown key or a repeated `q`
 * is a 400. No `limit` means every match (the confirm dialog and the quotation page rely on it).
 */
export const ListSalesOrdersQuerySchema = z.strictObject({
  status: multi(SalesOrderStatusSchema),
  customerId: multi(z.guid()),
  quotationVersionId: z.guid().optional(),
  q: searchParam,
  limit: z.coerce.number().int().min(1).max(MAX_ROWS).optional(),
  offset: z.coerce.number().int().min(0).default(0),
});

/** `GET /v1/sales-orders/summary`: the counts ignore `status`, so the cards can show every status. */
export const SalesOrdersSummaryQuerySchema = z.strictObject({
  customerId: multi(z.guid()),
  q: searchParam,
});

@Controller('v1/sales-orders')
export class SalesOrdersController {
  constructor(private readonly orders: SalesOrdersService) {}

  /** 200 with a bare array of SalesOrderListItem, newest first; X-Total-Count is all matches, not this page. */
  @Get()
  @Can('sales_order.read')
  async list(
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SalesOrderListItem[]> {
    const { rows, total } = await this.orders.list(parseOr400(ListSalesOrdersQuerySchema, query));
    setTotalCount(res, total);
    return rows;
  }

  /** 200 with `{ total, byStatus }` for the same entity and visibility as the list. Declared before `:id`. */
  @Get('summary')
  @Can('sales_order.read')
  summary(@Query() query: unknown): Promise<SalesOrdersSummary> {
    return this.orders.summary(parseOr400(SalesOrdersSummaryQuerySchema, query));
  }

  /** 200 with the SalesOrderDetail. 404 for an order of another entity. */
  @Get(':id')
  @Can('sales_order.read')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<SalesOrderDetail> {
    return this.orders.detail(id);
  }

  /**
   * 201 with the SalesOrderDetail. 400 without an Idempotency-Key or with a bad body; 404 for a version outside
   * the entity; 409 not accepted; 422 evidence the entity's policy does not accept, or a schedule that cannot be
   * split. A second confirm of the same quotation answers the existing order.
   */
  @Post()
  @Can('sales_order.confirm')
  confirm(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<SalesOrderDetail> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.orders.confirmFromQuotation(parseOr400(ConfirmSalesOrderBodySchema, body), key);
  }

  /**
   * 201 with the SalesOrderDetail. 400 without a key or with a bad body; 404 for an order or line outside the
   * entity; 409 for a stale version, a closed order or a line that is not planned; 422 without the evidence a
   * non-advance line needs.
   */
  @Post(':id/schedule-lines/:lineId/mark-billable')
  @Can('sales_order.mark_billable')
  markBillable(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<SalesOrderDetail> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.orders.markBillable(id, lineId, parseOr400(MarkBillableBodySchema, body), key);
  }
}
