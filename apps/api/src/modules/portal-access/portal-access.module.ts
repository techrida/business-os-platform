// Portal access module (K8): grants a KYB-verified customer a portal admin in ZITADEL and mirrors it. It
// imports UsersCoreModule for the ZITADEL admin client and the users store (UsersModule does not export them),
// and AuditModule for the step audit rows. AuthzModule and the database are global. Only AppModule imports it.
import { Module } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { UsersCoreModule } from '../../platform/users/users.core.module';
import { PortalAccessCaller } from './portal-access.caller';
import { PortalAccessController } from './portal-access.controller';
import { PortalAccessService, VendorPortalAccessService } from './portal-access.service';
import { SqlPortalAccessStore } from './portal-access.store';
import { PortalAccessStore, VendorPortalAccessStore } from './portal-access.types';
import { VendorPortalAccessController } from './vendor-portal-access.controller';

@Module({
  imports: [UsersCoreModule, AuditModule],
  controllers: [PortalAccessController, VendorPortalAccessController],
  providers: [
    PortalAccessService,
    VendorPortalAccessService,
    PortalAccessCaller,
    { provide: PortalAccessStore, useClass: SqlPortalAccessStore },
    { provide: VendorPortalAccessStore, useExisting: PortalAccessStore },
  ],
})
export class PortalAccessModule {}
