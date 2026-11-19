// Purchase order render worker module (P4 unit P3b): the render sweeper, its processor and its one-minute schedule.
// Imported only by WorkerModule, so the API process never renders. Same shape as QuotationRenderWorkerModule, which
// explains the DocumentsService wiring (generated-file path only, no download links, authz that refuses everything).
//
// Differences: a PO is drawn from its immutable version snapshot, so only the buying entity's PAN comes from settings
// (SettingsModule, as in the quotation worker). This instance registers PurchaseOrderVersionOwnerPolicy as
// PurchaseOrderRenderModule does on the API's instance. Without it every render is refused (no policy means no
// generated files). DocumentLogoModule gives the sweeper the entity logo's clean bytes, so the render freezes the logo
// itself (U12).
import { BullModule } from '@nestjs/bullmq';
import { ForbiddenException, Inject, Module, type OnModuleInit } from '@nestjs/common';

import { AuditModule } from '../../../../platform/audit/audit.module';
import { AuditService } from '../../../../platform/audit/audit.service';
import { CoreConfig } from '../../../../platform/config/config';
import { DB, type Db } from '../../../../platform/db/db.module';
import { withTx } from '../../../../platform/db/tx';
import {
  AUDIT_PORT,
  AUTHZ_PORT,
  DOCS_SCAN_QUEUE,
} from '../../../../platform/documents/documents.ports';
import { DocumentsService } from '../../../../platform/documents/documents.service';
import { SignedLinks } from '../../../../platform/documents/signed-link';
import {
  DiskStorageAdapter,
  STORAGE_ADAPTER,
} from '../../../../platform/documents/storage.adapter';
import { SettingsModule } from '../../../../platform/settings/settings.module';
import { SettingsService } from '../../../../platform/settings/settings.service';
import {
  DocumentLogoModule,
  DocumentLogoResolverFactory,
} from '../../../images/document-logo.resolver';
import { GotenbergClient } from '../../../quotations/render/gotenberg.client';
import type { RunInTx } from '../../../quotations/render/quotation-render.sweeper';
import {
  drizzlePurchaseOrderRenderStore,
  PO_RENDER_CLOCK,
  PO_RENDER_DOCUMENTS,
  PO_RENDER_LOGOS,
  PO_RENDER_PDF,
  PO_RENDER_QUEUE,
  PO_RENDER_SETTINGS,
  PO_RENDER_STORE,
  PO_RENDER_TX,
  PurchaseOrderRenderProcessor,
  PurchaseOrderRenderScheduler,
  PurchaseOrderRenderSweeper,
} from './purchase-order-render.sweeper';
import {
  drizzlePoVersionHeadLoader,
  PurchaseOrderVersionOwnerPolicy,
} from './purchase-order-version-owner.policy';

@Module({
  imports: [
    AuditModule,
    SettingsModule,
    DocumentLogoModule,
    BullModule.registerQueue({ name: DOCS_SCAN_QUEUE }, { name: PO_RENDER_QUEUE }),
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
    { provide: PO_RENDER_DOCUMENTS, useExisting: DocumentsService },
    { provide: PO_RENDER_SETTINGS, useExisting: SettingsService },
    {
      provide: PO_RENDER_STORE,
      inject: [DB],
      useFactory: (db: Db) => drizzlePurchaseOrderRenderStore(db),
    },
    {
      provide: PO_RENDER_TX,
      inject: [DB],
      useFactory:
        (db: Db): RunInTx =>
        (scope, actor, fn) =>
          withTx(db, scope, actor, fn),
    },
    {
      provide: PO_RENDER_PDF,
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
    { provide: PO_RENDER_CLOCK, useValue: () => new Date() },
    { provide: PO_RENDER_LOGOS, useExisting: DocumentLogoResolverFactory },
    PurchaseOrderRenderSweeper,
    PurchaseOrderRenderProcessor,
    PurchaseOrderRenderScheduler,
  ],
})
export class PurchaseOrderRenderWorkerModule implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
  ) {}

  /** registerOwner throws on a duplicate, so this runs once, when the module starts. */
  onModuleInit(): void {
    this.documents.registerOwner(
      new PurchaseOrderVersionOwnerPolicy(drizzlePoVersionHeadLoader(this.db)),
    );
  }
}
