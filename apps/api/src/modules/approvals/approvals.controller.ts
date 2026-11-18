// HTTP routes for approvers and requesters: preview a route, the inbox, read a request, decide it and
// reroute it. Thin on purpose: validation here, every rule in ApprovalsService. Serves the NFR
// "no double decisions": a decision without an Idempotency-Key header is refused with 400 before
// anything is read, so every click the client sends can be safely retried. A decision on a Founder
// step also needs a recent sign-in (K7, step-up), proven by the user's ID token in the
// `x-bos-id-token` header: otherwise 401 `step_up_required`.
import {
  type ApprovalActionBody,
  ApprovalActionBodySchema,
  type ApprovalRequestDto,
  type InboxItemDto,
  type RoutePlan,
} from '@bos/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { z } from 'zod';

import type { AuthenticatedRequest, AuthIdentity } from '../../platform/auth/claims';
import { JwtVerifier } from '../../platform/auth/jwt-verifier';
import {
  assertRecentIdToken,
  DEFAULT_STEP_UP_MAX_AGE_SECONDS,
  ID_TOKEN_HEADER,
  STEP_UP_MAX_AGE_SECONDS,
} from '../../platform/auth/step-up';
import { AnyAuthenticated, Can } from '../../platform/authz/decorators';
import { ApprovalsCaller } from './ports';
import { ApprovalsService } from './requests.service';

/** Parses `input` with `schema`, or throws 400 with every issue in the message. */
export function parseOr400<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new BadRequestException(
      parsed.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; '),
    );
  }
  return parsed.data;
}

const PreviewBodySchema = z.strictObject({
  documentType: z.string().min(1).max(64),
  facts: z.record(z.string(), z.unknown()),
  /** Defaults to the caller: "what if I submitted this?" */
  sodUserIds: z.array(z.uuid()).max(50).optional(),
});

/** Printable ASCII, 1 to 200 characters (a UUID from the client is the expected value). */
const IdempotencyKeySchema = z.string().regex(/^[\x21-\x7e]{1,200}$/);

/**
 * Whether deciding on `request` at `expectedVersion` needs a recent sign-in. True unless we know the
 * step the service will lock is not a Founder role step:
 * - same version: the service only proceeds at this version, so the step at `currentSeq` is the one;
 * - client version newer than ours: no honest client sends it, and the step may move before the lock;
 * - client version older: the service answers 409 (or replays an earlier decision), deciding nothing.
 * A delegate acting for the Founder is checked too: the step, not the person, sets the bar.
 */
export function needsStepUp(request: ApprovalRequestDto, expectedVersion: number): boolean {
  if (expectedVersion > request.version) return true;
  if (expectedVersion < request.version) return false;
  const current = request.steps.find((s) => s.seq === request.currentSeq);
  if (current === undefined) return true;
  return current.kind === 'role' && current.roleKey === 'founder';
}

@Controller('v1/approvals')
export class ApprovalsController {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly caller: ApprovalsCaller,
    private readonly verifier: JwtVerifier,
    @Optional()
    @Inject(STEP_UP_MAX_AGE_SECONDS)
    private readonly stepUpMaxAge: number = DEFAULT_STEP_UP_MAX_AGE_SECONDS,
  ) {}

  @Post('preview')
  @HttpCode(200)
  @Can('approvals.requests.read')
  preview(@Body() body: unknown): Promise<RoutePlan> {
    const b = parseOr400(PreviewBodySchema, body);
    const { scope, principal } = this.caller.current();
    return this.approvals.preview(
      scope,
      b.documentType,
      b.facts,
      b.sodUserIds ?? [principal.userId],
    );
  }

  @Get('inbox')
  @AnyAuthenticated()
  inbox(): Promise<InboxItemDto[]> {
    return this.approvals.inbox();
  }

  @Get('requests/:id')
  @AnyAuthenticated()
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ApprovalRequestDto> {
    return this.approvals.get(id);
  }

  @Post('requests/:id/actions')
  @HttpCode(200)
  @AnyAuthenticated()
  act(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Headers(ID_TOKEN_HEADER) idToken?: string,
  ): Promise<ApprovalRequestDto> {
    if (idempotencyKey === undefined || !IdempotencyKeySchema.safeParse(idempotencyKey).success) {
      throw new BadRequestException(
        'The Idempotency-Key header is required (1-200 printable characters)',
      );
    }
    return this.decide(
      id,
      parseOr400(ApprovalActionBodySchema, body),
      idempotencyKey,
      req.auth,
      idToken,
    );
  }

  /** The step-up check, then the decision. Separate so the 400s above stay synchronous. */
  private async decide(
    id: string,
    action: ApprovalActionBody,
    idempotencyKey: string,
    auth: AuthIdentity | undefined,
    idToken: string | undefined,
  ): Promise<ApprovalRequestDto> {
    // Admit an approver or the named Sales assignee before the step-up check.
    const request = await this.approvals.getForAction(id, action, idempotencyKey);
    if (needsStepUp(request, action.expectedVersion)) {
      // The ID token must belong to the access token's user (`sub`, held in `auth.userId`).
      // Other steps never read the header.
      await assertRecentIdToken(
        this.verifier,
        idToken,
        auth?.userId,
        Math.floor(Date.now() / 1000),
        this.stepUpMaxAge,
      );
    }
    return this.approvals.act(id, action, idempotencyKey);
  }

  @Post('requests/:id/reroute')
  @HttpCode(200)
  @Can('approvals.requests.reroute')
  reroute(@Param('id', ParseUUIDPipe) id: string): Promise<ApprovalRequestDto> {
    return this.approvals.reroute(id);
  }
}
