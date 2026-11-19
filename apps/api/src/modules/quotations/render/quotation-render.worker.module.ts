// Quotation render worker module (P2 unit R2): the render sweeper, its processor and its one-minute schedule.
// Imported only by WorkerModule, so the API process never renders. Serves the NFR "a render can never block a
// decision": rendering runs here, after the approval has committed.
//
// DocumentsService is provided here and not imported through DocumentsModule. That module is the HTTP side: it
// carries two controllers and builds its storage and link secret from AppConfig, which the worker does not have
// (the worker's ConfigModule provides CoreConfig only). The worker needs just the generated-file path
// (createGenerated, receiveGenerated), so it gets a DocumentsService wired for that and nothing more:
// - storage: the same disk adapter on FILES_ROOT, so receiveGenerated writes where the scan worker reads;
// - scan queue: registered as a producer, because receiving a file queues its virus scan;
// - audit: the real AuditService;
// - links: no secret and a store that refuses, so this instance can neither issue nor redeem a download link;
// - authz: refuses everything. The system path asks the owner policy and never the principal's authz, so a
//   call that reaches it is a bug, and it fails closed.
// This instance registers the same QuotationOwnerPolicy as QuotationsModule does on the API's instance. Without
// it every render is refused with 403 (no policy means no generated files).
// DocumentLogoModule gives the sweeper the entity logo's clean bytes, so the frozen style holds the logo itself.
import { BullModule } from '@nestjs/bullmq';
import { ForbiddenException, Inject, Module, type OnModuleInit } from '@nestjs/common';

import { AuditModule } from '../../../platform/audit/audit.module';
import { AuditService } from '../../../platform/audit/audit.service';
import { CoreConfig } from '../../../platform/config/config';
import { DB, type Db } from '../../../platform/db/db.module';
import { withTx } from '../../../platform/db/tx';
import {
  AUDIT_PORT,
  AUTHZ_PORT,
  DOCS_SCAN_QUEUE,
} from '../../../platform/documents/documents.ports';
import { DocumentsService } from '../../../platform/documents/documents.service';
import { SignedLinks } from '../../../platform/documents/signed-link';
import { DiskStorageAdapter, STORAGE_ADAPTER } from '../../../platform/documents/storage.adapter';
import { SettingsModule } from '../../../platform/settings/settings.module';
import { SettingsService } from '../../../platform/settings/settings.service';
import {
  DocumentLogoModule,
  DocumentLogoResolverFactory,
} from '../../images/document-logo.resolver';
import { drizzleHeadLoader, QuotationOwnerPolicy } from '../quotation-owner.policy';
import { GotenbergClient } from './gotenberg.client';
import {
  drizzleRenderStore,
  QUOTATION_RENDER_QUEUE,
  QuotationRenderProcessor,
  QuotationRenderScheduler,
  QuotationRenderSweeper,
  RENDER_CLOCK,
  RENDER_DOCUMENTS,
  RENDER_LOGOS,
  RENDER_PDF,
  RENDER_SETTINGS,
  RENDER_STORE,
  RENDER_TX,
  type RunInTx,
} from './quotation-render.sweeper';

@Module({
  imports: [
    AuditModule,
    SettingsModule,
    DocumentLogoModule,
    BullModule.registerQueue({ name: DOCS_SCAN_QUEUE }, { name: QUOTATION_RENDER_QUEUE }),
  ],
  providers: [
    {
      provide: STORAGE_ADAPTER,
      inject: [CoreConfig],
      useFactory: (config: CoreConfig) => new DiskStorageAdapter(config.FILES_ROOT),
    },
    {
      provide: SignedLinks,
      useFactory: () =>
        new SignedLinks(undefined, {
          claim: () => Promise.reject(new Error('download links are not available in the worker')),
        }),
    },
    {
      provide: AUTHZ_PORT,
      useValue: {
        assert: (): never => {
          throw new ForbiddenException({ code: 'forbidden', reason: 'no_permission' });
        },
      },
    },
    { provide: AUDIT_PORT, useExisting: AuditService },
    DocumentsService,
    { provide: RENDER_DOCUMENTS, useExisting: DocumentsService },
    { provide: RENDER_SETTINGS, useExisting: SettingsService },
    {
      provide: RENDER_STORE,
      inject: [DB],
      useFactory: (db: Db) => drizzleRenderStore(db),
    },
    {
      provide: RENDER_TX,
      inject: [DB],
      useFactory:
        (db: Db): RunInTx =>
        (scope, actor, fn) =>
          withTx(db, scope, actor, fn),
    },
    {
      provide: RENDER_PDF,
      inject: [CoreConfig],
      useFactory: (config: CoreConfig) => {
        // Required in the worker's production config and defaulted elsewhere, so this is a guard, not a path.
        if (config.GOTENBERG_URL === undefined) throw new Error('GOTENBERG_URL is not set');
        return new GotenbergClient(config.GOTENBERG_URL, {
          timeoutMs: config.GOTENBERG_TIMEOUT_MS,
          maxBytes: config.GOTENBERG_MAX_BYTES,
        });
      },
    },
    { provide: RENDER_CLOCK, useValue: () => new Date() },
    { provide: RENDER_LOGOS, useExisting: DocumentLogoResolverFactory },
    QuotationRenderSweeper,
    QuotationRenderProcessor,
    QuotationRenderScheduler,
  ],
})
export class QuotationRenderWorkerModule implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
  ) {}

  /** registerOwner throws on a duplicate, so this runs once, when the module starts. */
  onModuleInit(): void {
    this.documents.registerOwner(new QuotationOwnerPolicy(drizzleHeadLoader(this.db)));
  }
}
