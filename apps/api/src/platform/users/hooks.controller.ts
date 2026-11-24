// POST /v1/hooks/zitadel: the receiving end of the ZITADEL Actions v2 `restAsync` target.
// Serves the NFR "a role change reaches the mirror within seconds" (the 10-minute reconcile is the
// backstop). It is @Public, so the HMAC signature is its authentication: no valid signature, 401.
//
// It trusts nothing in the payload beyond the ids. It records the event id (dedupe), enqueues a
// users.sync for user events and answers 204 at once; the job re-fetches the user from ZITADEL.
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Controller,
  HttpCode,
  Logger,
  Post,
  type RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';

import { Public } from '../auth/public.decorator';
import { AppConfig } from '../config/config';
import { queueCallWithin } from '../queue/nudge-timeout';
import { verifyZitadelSignature } from './signature';
import { USERS_QUEUE, USERS_SYNC_JOB, type UsersSyncData } from './users.constants';
import { UsersStore } from './users.store';

export const SIGNATURE_HEADER = 'zitadel-signature';

/** Only the ids (P1-PLAN §3 field names). `sequence` arrives as a number or a numeric string. */
const EventIds = z.object({
  instanceID: z.string().min(1).max(200),
  aggregateID: z.string().min(1).max(200),
  aggregateType: z.string().min(1).max(100),
  sequence: z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,19}$/)]),
  event_type: z.string().max(200).optional(),
});

type HookRequest = RawBodyRequest<IncomingMessage & { body?: unknown }>;

@Controller('v1/hooks')
export class HooksController {
  private readonly logger = new Logger(HooksController.name);

  constructor(
    private readonly config: AppConfig,
    private readonly store: UsersStore,
    @InjectQueue(USERS_QUEUE) private readonly queue: Queue<UsersSyncData>,
  ) {}

  @Public()
  @Post('zitadel')
  @HttpCode(204)
  async zitadel(@Req() req: HookRequest): Promise<void> {
    const key = this.config.ZITADEL_ACTIONS_SIGNING_KEY;
    const header = req.headers[SIGNATURE_HEADER];
    // Fail closed: no key configured means no request can be authentic.
    if (
      !key ||
      typeof header !== 'string' ||
      !req.rawBody ||
      !verifyZitadelSignature(req.rawBody, header, key, Math.floor(Date.now() / 1000))
    ) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(req.rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Webhook body is not JSON');
    }
    const parsed = EventIds.safeParse(payload);
    if (!parsed.success) throw new BadRequestException('Webhook body lacks the event ids');
    const e = parsed.data;

    const isNew = await this.store.recordEvent({
      instanceId: e.instanceID,
      aggregateId: e.aggregateID,
      sequence: String(e.sequence),
      eventType: e.event_type ?? null,
    });
    if (!isNew || e.aggregateType !== 'user') return;

    // ZITADEL ignores our answer and never retries, so an enqueue failure is logged, not thrown:
    // the reconcile job picks the change up within 10 minutes.
    await queueCallWithin(() =>
      this.queue.add(
        USERS_SYNC_JOB,
        { zitadelUserId: e.aggregateID },
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      ),
    ).catch((error: Error) => this.logger.warn(`users.sync enqueue failed: ${error.message}`));
  }
}
