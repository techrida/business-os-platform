// Invoice render nudge (round 5, S3): InvoiceIssueService calls it after the issue commits, so the PDF is rendered
// at once by the worker's `invoice.render.one` handler (InvoiceRenderProcessor) instead of on the next sweep. The
// queue name lives here so the API can register the queue without loading the renderer.
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Module } from '@nestjs/common';
import type { Queue } from 'bullmq';

import type { TxScope } from '../../../platform/db/tx';
import { enqueueRenderOne } from '../../quotations/render/render-nudge';

export const INVOICE_RENDER_QUEUE = 'invoice.render';
export const INVOICE_RENDER_ONE_JOB = 'invoice.render.one';

@Injectable()
export class InvoiceRenderNudge {
  private readonly log = new Logger(InvoiceRenderNudge.name);

  constructor(@InjectQueue(INVOICE_RENDER_QUEUE) private readonly queue: Queue) {}

  /** Asks the worker to render this invoice now. Call it after the commit; never throws. */
  async nudge(scope: TxScope, invoiceId: string): Promise<void> {
    await enqueueRenderOne(this.queue, this.log, INVOICE_RENDER_ONE_JOB, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      id: invoiceId,
    });
  }
}

/** The queue registration and the nudge, for the modules whose commands issue invoices. */
@Module({
  imports: [BullModule.registerQueue({ name: INVOICE_RENDER_QUEUE })],
  providers: [InvoiceRenderNudge],
  exports: [InvoiceRenderNudge],
})
export class InvoiceRenderNudgeModule {}
