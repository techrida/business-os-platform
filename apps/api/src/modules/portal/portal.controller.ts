// HTTP routes of the customer portal's quotation reads (P2 unit PA-2). Thin on purpose: every rule is in
// PortalService. Each route needs `portal.quotation.read` (route level); the service then refuses any caller that
// is not a customer with a party (403) and answers 404 for anything that is not the caller's and customer-visible.
// The `:id` is a quotation version id (the `id` of CustomerQuotationView).
//
// `GET /v1/portal/quotations/:id/document` is deliberately not routed yet: DocumentsService.issueLink checks
// `documents.read`, which `customer_user` does not hold, so it would refuse every customer. Until the documents
// module can issue a link for an owner the calling module has authorized, the route answers Nest's 404.
import type { CustomerQuotationView, PortalQuotationListItem } from '@bos/contracts';
import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';

import { Can } from '../../platform/authz/decorators';
import { PortalService } from './portal.service';

@Controller('v1/portal/quotations')
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  /** 200 with the caller's quotations: the newest customer-visible version of each. */
  @Get()
  @Can('portal.quotation.read')
  list(): Promise<PortalQuotationListItem[]> {
    return this.portal.list();
  }

  /** 200 with the customer view of one version; 404 for a foreign, hidden or unknown id. */
  @Get(':id')
  @Can('portal.quotation.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<CustomerQuotationView> {
    return this.portal.get(id);
  }
}
