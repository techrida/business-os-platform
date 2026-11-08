// Documents module (owner: U4): upload, virus scan hand-off, signed download links (the HTTP side).
// The scan itself runs in the worker (documents.worker.module.ts), so the API never consumes jobs.
// Serves NFR Security: ClamAV is deliberately NOT part of /health/ready (the API must stay up for
// everything except uploads when the scanner is down), so nothing here registers a readiness check.
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import { AuthzModule } from '../authz/authz.module';
import { AuthzService } from '../authz/authz.service';
import { AppConfig } from '../config/config';
import { DocumentsController } from './documents.controller';
import { AUDIT_PORT, AUTHZ_PORT, DOCS_SCAN_QUEUE } from './documents.ports';
import { DocumentsService } from './documents.service';
import { FilesController } from './files.controller';
import { SignedLinks } from './signed-link';
import { DiskStorageAdapter, STORAGE_ADAPTER } from './storage.adapter';
import { ValkeyLinkStore } from './valkey-link-store';

@Module({
  imports: [AuthzModule, AuditModule, BullModule.registerQueue({ name: DOCS_SCAN_QUEUE })],
  controllers: [DocumentsController, FilesController],
  providers: [
    {
      provide: STORAGE_ADAPTER,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => new DiskStorageAdapter(config.FILES_ROOT),
    },
    {
      provide: ValkeyLinkStore,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => new ValkeyLinkStore(config.VALKEY_URL),
    },
    {
      provide: SignedLinks,
      inject: [AppConfig, ValkeyLinkStore],
      // DOCS_LINK_SECRET may be undefined outside production: SignedLinks then refuses to issue or accept.
      useFactory: (config: AppConfig, store: ValkeyLinkStore) =>
        new SignedLinks(config.DOCS_LINK_SECRET, store),
    },
    { provide: AUTHZ_PORT, useExisting: AuthzService },
    { provide: AUDIT_PORT, useExisting: AuditService },
    DocumentsService,
  ],
  // Other modules (U8) inject DocumentsService to register their owner policy and to call allClean().
  exports: [DocumentsService],
})
export class DocumentsModule {}
