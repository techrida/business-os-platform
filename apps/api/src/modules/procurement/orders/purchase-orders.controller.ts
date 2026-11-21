// HTTP routes of purchase orders (P4 unit P3). Thin on purpose: parsing here (the bodies are the contracts of
// procurement.ts), every rule in PurchaseOrdersService. Every write needs an Idempotency-Key and procurement.po.issue
// at route level. The reads (list, detail, versions) are also open read-only to whoever enters or reads vendor bills or
// receives goods (F1-Q52): they carry @AnyAuthenticated and the service decides (po-read-access.ts), 403 without any
// of those grants, except the detail, which an approver of an approval about the order also opens (R4f Q1 b) and
// which is a 404 for other active staff. Another entity's PO is a 404. Shares the `v1/procurement/purchase-orders` prefix with
// the receipts unit's PurchaseOrderProgressController (GET :id/progress), which this class does not touch.
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

import { AnyAuthenticated, Can } from '../../../platform/authz/decorators';
import { setTotalCount } from '../../../platform/list';
import { parseOr400 } from '../../approvals/approvals.controller';
import { requireIdempotencyKey } from '../../customers/customers.types';
import {
  AmendPurchaseOrderBodySchema,
  CancelAndRecreatePurchaseOrderBodySchema,
  CancelPurchaseOrderBodySchema,
  ChangePurchaseOrderVendorBodySchema,
  IssuePurchaseOrderBodySchema,
  ListPurchaseOrdersQuerySchema,
  ShortClosePurchaseOrderBodySchema,
} from './purchase-order.rules';
import {
  PurchaseOrdersService,
  type AmendResultDto,
  type PurchaseOrderDto,
  type PurchaseOrderVersionDto,
} from './purchase-orders.service';

@Controller('v1/procurement/purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly orders: PurchaseOrdersService) {}

  /**
   * The entity's purchase orders, newest first. Query: `status` (repeatable), `q`, `limit` (default 25, at most
   * 100), `offset`; X-Total-Count is the number of all matches.
   */
  @Get()
  @AnyAuthenticated()
  list(
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Omit<PurchaseOrderDto, 'lines'>[]> {
    const parsed = parseOr400(ListPurchaseOrdersQuerySchema, query);
    return this.orders.list(parsed).then(({ rows, total }) => {
      setTotalCount(res, total);
      return rows;
    });
  }

  /** 404 outside the acting entity. Also open, read-only, to an approver of an approval about the order. */
  @Get(':id')
  @AnyAuthenticated()
  get(@Param('id', ParseUUIDPipe) id: string): Promise<PurchaseOrderDto> {
    return this.orders.get(id);
  }

  /** Every issued version, oldest first (immutable). */
  @Get(':id/versions')
  @AnyAuthenticated()
  versions(@Param('id', ParseUUIDPipe) id: string): Promise<PurchaseOrderVersionDto[]> {
    return this.orders.versions(id);
  }

  /**
   * 200 with the issued PO (version 1). 409 unless a draft, or for a vendor that is not approved or not active here.
   * Optional body `{ expectedVersion }`: 409 PO_CHANGED when the order changed since the page read that version. No
   * body issues as before.
   */
  @Post(':id/issue')
  @HttpCode(200)
  @Can('procurement.po.issue')
  issue(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<PurchaseOrderDto> {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.orders.issue(
      id,
      idempotencyKey,
      parseOr400(IssuePurchaseOrderBodySchema, body ?? {}),
    );
  }

  /**
   * 200 with the draft under its new vendor (F1-Q40 a). 409 PO_VENDOR_CHANGE_NOT_DRAFT unless a draft, and for a
   * vendor that is the same, not approved, not active here or without a verified bank account.
   */
  @Post(':id/change-vendor')
  @HttpCode(200)
  @Can('procurement.po.issue')
  changeVendor(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<PurchaseOrderDto> {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.orders.changeVendor(
      id,
      parseOr400(ChangePurchaseOrderVendorBodySchema, body),
      idempotencyKey,
    );
  }

  /** 200: `applied` (version N+1) or `pending_approval` (po_amendment route). 400 for a vendor field. */
  @Post(':id/amend')
  @HttpCode(200)
  @Can('procurement.po.issue')
  amend(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<AmendResultDto> {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.orders.amend(id, parseOr400(AmendPurchaseOrderBodySchema, body), idempotencyKey);
  }

  /** 200 with the short-closed PO. 409 unless partially received. */
  @Post(':id/short-close')
  @HttpCode(200)
  @Can('procurement.po.issue')
  shortClose(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<PurchaseOrderDto> {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.orders.shortClose(
      id,
      parseOr400(ShortClosePurchaseOrderBodySchema, body),
      idempotencyKey,
    );
  }

  /** 200 with the cancelled PO. 409 unless issued, 409 PO_HAS_RECEIPTS once anything was received. */
  @Post(':id/cancel')
  @HttpCode(200)
  @Can('procurement.po.issue')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<PurchaseOrderDto> {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.orders.cancel(id, parseOr400(CancelPurchaseOrderBodySchema, body), idempotencyKey);
  }

  /**
   * 200 with the NEW draft PO: the order is cancelled (cancel's rules and audit) and a draft cloned from it is raised
   * in the same transaction. 409 unless issued, 409 PO_HAS_RECEIPTS once anything was received.
   */
  @Post(':id/cancel-and-recreate')
  @HttpCode(200)
  @Can('procurement.po.issue')
  cancelAndRecreate(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<PurchaseOrderDto> {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.orders.cancelAndRecreate(
      id,
      parseOr400(CancelAndRecreatePurchaseOrderBodySchema, body),
      idempotencyKey,
    );
  }
}
