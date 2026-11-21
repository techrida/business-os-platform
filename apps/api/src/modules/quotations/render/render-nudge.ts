// Render on commit (round 5, S3): the one job a command enqueues after its transaction commits, so a document's PDF
// is rendered within seconds instead of waiting for the next one-minute sweep. Shared by the quotation, invoice and
// purchase order render queues; each kind has its own thin nudge service (`*RenderNudge`) and its processor's
// `*.render.one` handler. The sweep stays the safety net: a nudge that fails to enqueue, or a job that fails, is
// picked up by the next sweep, so neither is retried here.
import type { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { z } from 'zod';

import { NUDGE_TIMEOUT_MS, nudgeWithin } from '../../../platform/queue/nudge-timeout';

/** What a `*.render.one` job carries: the document's tenant, its acting entity and its id. */
export const RenderOneJobSchema = z.strictObject({
  tenantId: z.guid(),
  organizationId: z.guid(),
  id: z.guid(),
});
export type RenderOneJob = z.infer<typeof RenderOneJobSchema>;

/**
 * Enqueues one render of `data.id` under `jobName`. Never throws: the request's business change already committed, and
 * the sweep renders the document anyway. The job id is `key` (the document's id unless the caller narrows it), so
 * several commits for one document before the worker runs share one job (bullmq ignores an add whose id it still
 * holds); it is removed when it ends, so a later commit can enqueue again. Bullmq refuses a `:` in a custom id, hence
 * the `-`. It also gives up waiting after NUDGE_TIMEOUT_MS (a Valkey that is down holds `queue.add` on its offline
 * queue), logs that, and returns, so the request that committed never hangs on it.
 */
export async function enqueueRenderOne(
  queue: Queue,
  log: Logger,
  jobName: string,
  data: RenderOneJob,
  key: string = data.id,
  timeoutMs: number = NUDGE_TIMEOUT_MS,
): Promise<void> {
  const what = `render nudge: job=${jobName} id=${data.id}`;
  await nudgeWithin(
    log,
    what,
    () =>
      queue.add(jobName, data, {
        jobId: `${jobName}-${key}`,
        removeOnComplete: true,
        removeOnFail: true,
      }),
    (error) =>
      log.warn(
        `render nudge failed, the sweep will render it: job=${jobName} id=${data.id} ${error instanceof Error ? error.message : String(error)}`,
      ),
    timeoutMs,
  );
}
