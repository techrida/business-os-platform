// HTTP routes of the customer portal's quotation reads (P2 unit PA-2). Thin on purpose: every rule is in
// PortalService. Each route needs `portal.quotation.read` (route level); the service then refuses any caller that
// is not a customer with a party (403) and answers 404 for anything that is not the caller's and customer-visible.
// The `:id` is a quotation version id (the `id` of CustomerQuotationView).
//
// `GET /v1/portal/quotations/:id/document` answers a short-lived signed link to the frozen PDF (the portal's
// `getPortalQuotationLink`). It does not use DocumentsService.issueLink, which checks `documents.read` (a customer
// does not hold it): PortalService authorizes the caller and the version, then asks for a link by owner.
//
// `GET /v1/portal/display` answers how the caller's company writes numbers and dates ({ numberSystems, dateFormat })
// and which currencies it has switched on ({ enabledCurrencies }, NPR first; D44).
// Customers and vendors hold different portal permissions, so the route is open to any active principal and
// PortalService.display refuses everyone but a customer or vendor portal caller with a party (403).
import type {
  CustomerQuotationView,
  PortalDisplay,
  PortalQuotationListItem,
  SignedLinkDto,
} from '@bos/contracts';
import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';

import { AnyAuthenticated, Can } from '../../platform/authz/decorators';
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

  /** 200 with a 60 s single-use link to the PDF; 404 unless the version is the caller's, visible and scanned clean. */
  @Get(':id/document')
  @Can('portal.quotation.read')
  document(@Param('id', ParseUUIDPipe) id: string): Promise<SignedLinkDto> {
    return this.portal.quotationPdfLink(id);
  }
}

@Controller('v1/portal')
export class PortalDisplayController {
  constructor(private readonly portal: PortalService) {}

  /** 200 with the company's live number grouping, date pattern and enabled currencies; 403 for anyone but a portal caller. */
  @Get('display')
  @AnyAuthenticated()
  display(): Promise<PortalDisplay> {
    return this.portal.display();
  }
}
