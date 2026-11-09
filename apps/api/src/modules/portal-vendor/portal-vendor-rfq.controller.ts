// HTTP routes of the vendor portal's RFQ reads (P4 unit PV3), under /v1/portal/vendor. A separate controller from
// PV1's so that unit's routes stay as they were. Thin on purpose: every rule is in VendorPortalRfqService. Each route
// needs `portal.vendor.read` (route level); the service then refuses any caller that is not a vendor with the full
// capability (403) and answers one 404 body for any RFQ that is not open and the caller's.
import type { VendorPortalRfqListItem, VendorPortalRfqView } from '@bos/contracts';
import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';

import { Can } from '../../platform/authz/decorators';
import { VendorPortalRfqService } from './portal-vendor-rfq.service';

@Controller('v1/portal/vendor')
export class VendorPortalRfqController {
  constructor(private readonly rfqs: VendorPortalRfqService) {}

  /** 200 with the open RFQs the vendor is invited to in the acting entity; an empty list when there are none. */
  @Get('rfqs')
  @Can('portal.vendor.read')
  listRfqs(): Promise<VendorPortalRfqListItem[]> {
    return this.rfqs.listRfqs();
  }

  /** 200 with one open RFQ and its lines; 404 for an uninvited, closed, cancelled or unknown id. */
  @Get('rfqs/:id')
  @Can('portal.vendor.read')
  getRfq(@Param('id', ParseUUIDPipe) id: string): Promise<VendorPortalRfqView> {
    return this.rfqs.getRfq(id);
  }
}
