// HTTP routes of the vendor portal's reads (P4 unit PV1), under /v1/portal/vendor. Thin on purpose: every rule is in
// VendorPortalService. Each route needs `portal.vendor.read` (route level); the service then refuses any caller that
// is not a vendor with a party (403), checks the vendor's status live (pending_kyc: onboarding only, 403 on orders and
// bills) and answers one 404 body for anything that is not the caller's and visible.
import type {
  SignedLinkDto,
  VendorPortalBillView,
  VendorPortalOnboardingView,
  VendorPortalPurchaseOrderListItem,
  VendorPortalPurchaseOrderView,
} from '@bos/contracts';
import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';

import { Can } from '../../platform/authz/decorators';
import { VendorPortalService } from './portal-vendor.service';

@Controller('v1/portal/vendor')
export class VendorPortalController {
  constructor(private readonly portal: VendorPortalService) {}

  /** 200 with the vendor's status, capability and KYB checklist state. */
  @Get('onboarding')
  @Can('portal.vendor.read')
  onboarding(): Promise<VendorPortalOnboardingView> {
    return this.portal.onboarding();
  }

  /** 200 with the vendor's purchase orders in the acting entity, each at its newest issued version. */
  @Get('purchase-orders')
  @Can('portal.vendor.read')
  listPurchaseOrders(): Promise<VendorPortalPurchaseOrderListItem[]> {
    return this.portal.listPurchaseOrders();
  }

  /** 200 with one purchase order; 404 for a foreign, draft or unknown id. */
  @Get('purchase-orders/:id')
  @Can('portal.vendor.read')
  getPurchaseOrder(@Param('id', ParseUUIDPipe) id: string): Promise<VendorPortalPurchaseOrderView> {
    return this.portal.getPurchaseOrder(id);
  }

  /** 200 with a short-lived link to the version's clean PDF; 404 when foreign, unknown or not rendered clean. */
  @Get('purchase-orders/:id/pdf')
  @Can('portal.vendor.read')
  purchaseOrderPdf(@Param('id', ParseUUIDPipe) id: string): Promise<SignedLinkDto> {
    return this.portal.purchaseOrderPdfLink(id);
  }

  /** 200 with the vendor's bills in the acting entity, with the coarse status. */
  @Get('bills')
  @Can('portal.vendor.read')
  listBills(): Promise<VendorPortalBillView[]> {
    return this.portal.listBills();
  }

  /** 200 with one bill; 404 for a foreign, hidden or unknown id. */
  @Get('bills/:id')
  @Can('portal.vendor.read')
  getBill(@Param('id', ParseUUIDPipe) id: string): Promise<VendorPortalBillView> {
    return this.portal.getBill(id);
  }
}
