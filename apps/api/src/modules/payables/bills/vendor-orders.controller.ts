// The purchase order pickers of the payables screens (U18 #12, #13). Their own class with no class-level marker, so
// each route's grant alone decides: the bill entry picker needs payables.bill.enter, the payment request picker
// payables.payment.request. Neither needs a procurement grant.
import { Controller, Get, Query } from '@nestjs/common';

import { Can } from '../../../platform/authz/decorators';
import { parseOr400 } from '../../approvals/approvals.controller';
import {
  ListVendorOrdersQuerySchema,
  VendorOrdersService,
  type VendorOrderOptionDto,
} from './vendor-orders.service';

@Controller('v1/payables')
export class VendorOrdersController {
  constructor(private readonly orders: VendorOrdersService) {}

  /** POs a bill can be entered against, newest issued first. Query: `vendorId`, `limit` (default 100, max 200). */
  @Get('billable-orders')
  @Can('payables.bill.enter')
  billable(@Query() query: unknown): Promise<VendorOrderOptionDto[]> {
    return this.orders.billable(parseOr400(ListVendorOrdersQuerySchema, query));
  }

  /** POs a payment request can name, newest issued first. Same query as billable-orders. */
  @Get('payment-request-orders')
  @Can('payables.payment.request')
  forPaymentRequest(@Query() query: unknown): Promise<VendorOrderOptionDto[]> {
    return this.orders.forPaymentRequest(parseOr400(ListVendorOrdersQuerySchema, query));
  }
}
