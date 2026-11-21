// Invoice render worker module (P3 unit U11): the render sweeper, its processor and its one-minute schedule. Imported
// only by WorkerModule, so the API process never renders. Same shape as QuotationRenderWorkerModule, which explains
// the DocumentsService wiring (generated-file path only, no download links, authz that refuses everything).
//
// Differences: an invoice is drawn from its frozen row, so only the tenant's number system (`format.number_system`)
// comes from settings (SettingsModule, as in the quotation worker). This instance
// registers InvoiceOwnerPolicy as InvoicesModule does on the API's instance. Without it every render is refused
// (no policy means no generated files). DocumentLogoModule gives the sweeper the entity logo's clean bytes, so print 1
// freezes the logo itself (U12).
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
import { GotenbergClient } from '../../quotations/render/gotenberg.client';
import type { RunInTx } from '../../quotations/render/quotation-render.sweeper';
import { drizzleInvoiceHeadLoader, InvoiceOwnerPolicy } from '../invoice-owner.policy';
import {
  drizzleInvoiceRenderStore,
  INVOICE_RENDER_AUDIT,
  INVOICE_RENDER_CLOCK,
  INVOICE_RENDER_DOCUMENTS,
  INVOICE_RENDER_LOGOS,
  INVOICE_RENDER_PDF,
  INVOICE_RENDER_SETTINGS,
  INVOICE_RENDER_QUEUE,
  INVOICE_RENDER_STORE,
  INVOICE_RENDER_TX,
  InvoiceRenderProcessor,
  InvoiceRenderScheduler,
  InvoiceRenderSweeper,
} from './invoice-render.sweeper';

@Module({
  imports: [
    AuditModule,
    SettingsModule,
    DocumentLogoModule,
    BullModule.registerQueue({ name: DOCS_SCAN_QUEUE }, { name: INVOICE_RENDER_QUEUE }),
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
    { provide: INVOICE_RENDER_DOCUMENTS, useExisting: DocumentsService },
    { provide: INVOICE_RENDER_SETTINGS, useExisting: SettingsService },
    {
      provide: INVOICE_RENDER_STORE,
      inject: [DB],
      useFactory: (db: Db) => drizzleInvoiceRenderStore(db),
    },
    {
      provide: INVOICE_RENDER_TX,
      inject: [DB],
      useFactory:
        (db: Db): RunInTx =>
        (scope, actor, fn, options) =>
          withTx(db, scope, actor, fn, options),
    },
    {
      provide: INVOICE_RENDER_PDF,
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
    { provide: INVOICE_RENDER_CLOCK, useValue: () => new Date() },
    { provide: INVOICE_RENDER_LOGOS, useExisting: DocumentLogoResolverFactory },
    { provide: INVOICE_RENDER_AUDIT, useExisting: AuditService },
    InvoiceRenderSweeper,
    InvoiceRenderProcessor,
    InvoiceRenderScheduler,
  ],
})
export class InvoiceRenderWorkerModule implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
  ) {}

  /** registerOwner throws on a duplicate, so this runs once, when the module starts. */
  onModuleInit(): void {
    this.documents.registerOwner(new InvoiceOwnerPolicy(drizzleInvoiceHeadLoader(this.db)));
  }
}
