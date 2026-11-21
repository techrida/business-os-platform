// Quotation render nudge (round 5, S3): a quotation version's commit point is its approval, so
// QuotationVersionSubject.afterDecided calls it once the approval commits, and the worker's `quotation.render.one`
// handler (QuotationRenderProcessor) renders the version's PDF at once instead of on the next sweep. The queue name
// lives here so the API can register the queue without loading the renderer.
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Module } from '@nestjs/common';
import type { Queue } from 'bullmq';

import type { TxScope } from '../../../platform/db/tx';
import { enqueueRenderOne } from './render-nudge';

export const QUOTATION_RENDER_QUEUE = 'quotation.render';
export const QUOTATION_RENDER_ONE_JOB = 'quotation.render.one';

@Injectable()
export class QuotationRenderNudge {
  private readonly log = new Logger(QuotationRenderNudge.name);

  constructor(@InjectQueue(QUOTATION_RENDER_QUEUE) private readonly queue: Queue) {}

  /** Asks the worker to render this quotation version now. Call it after the commit; never throws. */
  async nudge(scope: TxScope, versionId: string): Promise<void> {
    await enqueueRenderOne(this.queue, this.log, QUOTATION_RENDER_ONE_JOB, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      id: versionId,
    });
  }
}

/** The queue registration and the nudge, for the module whose approval subject approves quotation versions. */
@Module({
  imports: [BullModule.registerQueue({ name: QUOTATION_RENDER_QUEUE })],
  providers: [QuotationRenderNudge],
  exports: [QuotationRenderNudge],
})
export class QuotationRenderNudgeModule {}
