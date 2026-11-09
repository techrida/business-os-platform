// Vendor portal reads module (P4 unit PV1): onboarding, purchase orders (newest issued version, clean PDF link) and
// bills; PV3 adds the RFQs the vendor is invited to (own controller, service and store). Imports DocumentsModule (the rendered PDF's scan status and the signed link); the database is global. The
// `purchase_order_version` document owner policy is registered by the PO render unit (P3b), not here.
import { Module } from '@nestjs/common';

import { DocumentsModule } from '../../platform/documents/documents.module';
import { VendorPortalCaller } from '../portal/vendor-portal.caller';
import { VendorPortalRfqController } from './portal-vendor-rfq.controller';
import { VendorPortalRfqService } from './portal-vendor-rfq.service';
import { DrizzleVendorPortalRfqStore, VENDOR_PORTAL_RFQ_STORE } from './portal-vendor-rfq.store';
import { VendorPortalController } from './portal-vendor.controller';
import { VENDOR_PORTAL_CLOCK, VendorPortalService } from './portal-vendor.service';
import { DrizzleVendorPortalStore, VENDOR_PORTAL_STORE } from './portal-vendor.store';

@Module({
  imports: [DocumentsModule],
  controllers: [VendorPortalController, VendorPortalRfqController],
  providers: [
    VendorPortalService,
    VendorPortalRfqService,
    { provide: VENDOR_PORTAL_RFQ_STORE, useClass: DrizzleVendorPortalRfqStore },
    VendorPortalCaller,
    { provide: VENDOR_PORTAL_STORE, useClass: DrizzleVendorPortalStore },
    { provide: VENDOR_PORTAL_CLOCK, useValue: () => new Date() },
  ],
})
export class VendorPortalModule {}
