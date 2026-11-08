// HTTP routes for approvers and requesters: preview a route, the inbox, read a request, decide it and
// reroute it. Thin on purpose: validation here, every rule in ApprovalsService. Serves the NFR
// "no double decisions": a decision without an Idempotency-Key header is refused with 400 before
// anything is read, so every click the client sends can be safely retried.
import {
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
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { z } from 'zod';

import { Can } from '../../platform/authz/decorators';
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

@Controller('v1/approvals')
export class ApprovalsController {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly caller: ApprovalsCaller,
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
  @Can('approvals.requests.act')
  inbox(): Promise<InboxItemDto[]> {
    return this.approvals.inbox();
  }

  @Get('requests/:id')
  @Can('approvals.requests.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ApprovalRequestDto> {
    return this.approvals.get(id);
  }

  @Post('requests/:id/actions')
  @HttpCode(200)
  @Can('approvals.requests.act')
  act(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<ApprovalRequestDto> {
    if (idempotencyKey === undefined || !IdempotencyKeySchema.safeParse(idempotencyKey).success) {
      throw new BadRequestException(
        'The Idempotency-Key header is required (1-200 printable characters)',
      );
    }
    return this.approvals.act(id, parseOr400(ApprovalActionBodySchema, body), idempotencyKey);
  }

  @Post('requests/:id/reroute')
  @HttpCode(200)
  @Can('approvals.requests.reroute')
  reroute(@Param('id', ParseUUIDPipe) id: string): Promise<ApprovalRequestDto> {
    return this.approvals.reroute(id);
  }
}
