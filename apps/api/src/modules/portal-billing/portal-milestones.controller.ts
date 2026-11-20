// HTTP routes of the customer portal's milestones (F1-Q34): the billing schedule of the customer's sales orders,
// read only. Thin on purpose: every rule is in PortalMilestonesService. The schedule is billing information, so the
// routes need `portal.invoice.read` (route level), as the invoice reads do; the service then refuses any caller that
// is not a customer with a party (403) and answers one identical 404 for an order that is not the caller's
// confirmed or completed order in the default entity. The paths match the portal BFF (`apps/portal/src/lib/api.billing.ts`).
import type { PortalSalesOrder } from '@bos/contracts';
import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';

import { Can } from '../../platform/authz/decorators';
import { PortalMilestonesService } from './portal-milestones.service';

@Controller('v1/portal/sales-orders')
export class PortalMilestonesController {
  constructor(private readonly milestones: PortalMilestonesService) {}

  /** 200 with the caller's confirmed and completed orders and their milestones. */
  @Get()
  @Can('portal.invoice.read')
  list(): Promise<PortalSalesOrder[]> {
    return this.milestones.list();
  }

  /** 200 with one order and its milestones; 404 for a foreign, draft, cancelled or unknown id. */
  @Get(':id')
  @Can('portal.invoice.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<PortalSalesOrder> {
    return this.milestones.get(id);
  }
}
