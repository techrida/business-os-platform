// Purchase order render nudge (round 5, S3): called after a command that creates an order version commits (the issue,
// an amendment applied at once, an amendment approved), so the worker's `purchase-order.render.one` handler
// (PurchaseOrderRenderProcessor) renders the new version's PDF at once instead of on the next sweep. The job carries
// the order's id; the worker renders whichever of its versions are due. The queue name lives here so the API can
// register the queue without loading the renderer.
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Module } from '@nestjs/common';
import type { Queue } from 'bullmq';

import type { TxScope } from '../../../../platform/db/tx';
import { enqueueRenderOne } from '../../../quotations/render/render-nudge';

export const PO_RENDER_QUEUE = 'purchase-order.render';
export const PO_RENDER_ONE_JOB = 'purchase-order.render.one';

@Injectable()
export class PurchaseOrderRenderNudge {
  private readonly log = new Logger(PurchaseOrderRenderNudge.name);

  constructor(@InjectQueue(PO_RENDER_QUEUE) private readonly queue: Queue) {}

  /**
   * Asks the worker to render the order's new version now. Call it after the commit; never throws. Keyed by the
   * version too, so an amendment's job is not swallowed by the previous version's job still running.
   */
  async nudge(scope: TxScope, purchaseOrderId: string, version: number): Promise<void> {
    await enqueueRenderOne(
      this.queue,
      this.log,
      PO_RENDER_ONE_JOB,
      { tenantId: scope.tenantId, organizationId: scope.organizationId, id: purchaseOrderId },
      `${purchaseOrderId}-v${version}`,
    );
  }
}

/** The queue registration and the nudge, for the modules whose commands create order versions. */
@Module({
  imports: [BullModule.registerQueue({ name: PO_RENDER_QUEUE })],
  providers: [PurchaseOrderRenderNudge],
  exports: [PurchaseOrderRenderNudge],
})
export class PurchaseOrderRenderNudgeModule {}
