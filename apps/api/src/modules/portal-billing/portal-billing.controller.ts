// HTTP routes of the customer portal's invoice reads (P3 unit U13, part 1). Thin on purpose: every rule is in
// PortalBillingService. Each route needs `portal.invoice.read` (route level); the service then refuses any caller
// that is not a customer with a party (403) and answers one identical 404 for anything that is not the caller's
// issued invoice in the default entity. The paths match the portal BFF (`apps/portal/src/lib/api.billing.ts`).
//
// `GET /v1/portal/invoices/:id/document` answers a short-lived signed link to the invoice PDF. It does not use
// DocumentsService.issueLink, which checks `documents.read` (a customer does not hold it).
import type { CustomerInvoiceView, PortalInvoiceListItem, SignedLinkDto } from '@bos/contracts';
import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';

import { Can } from '../../platform/authz/decorators';
import { PortalBillingService, type PortalSettlement } from './portal-billing.service';

@Controller('v1/portal/invoices')
export class PortalBillingController {
  constructor(private readonly billing: PortalBillingService) {}

  /** 200 with the caller's issued invoices, credit notes and debit notes. */
  @Get()
  @Can('portal.invoice.read')
  list(): Promise<PortalInvoiceListItem[]> {
    return this.billing.list();
  }

  /** 200 with the customer view of one issued invoice; 404 for a foreign, unissued or unknown id. */
  @Get(':id')
  @Can('portal.invoice.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<CustomerInvoiceView> {
    return this.billing.get(id);
  }

  /** 200 with the derived open amount and settlement status; the same 404 as `:id`. */
  @Get(':id/settlement')
  @Can('portal.invoice.read')
  settlement(@Param('id', ParseUUIDPipe) id: string): Promise<PortalSettlement> {
    return this.billing.settlement(id);
  }

  /** 200 with a 60 s single-use link to the PDF; 404 unless visible and the PDF scanned clean. */
  @Get(':id/document')
  @Can('portal.invoice.read')
  document(@Param('id', ParseUUIDPipe) id: string): Promise<SignedLinkDto> {
    return this.billing.documentLink(id);
  }
}
