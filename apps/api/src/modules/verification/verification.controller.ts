// HTTP routes of the KYB verification cases. Thin on purpose: validation here, every rule in
// VerificationService. Each route names its permission with @Can (route level); the service then checks the
// record itself (own, all, and 404 outside the caller's scope). Deny by default: a route without @Can is refused.
import {
  RemoveVerificationDocumentBodySchema,
  ChecklistItemKeySchema,
  ReviewVerificationItemBodySchema,
  VerificationVersionBodySchema,
  type VerificationCaseDto,
} from '@bos/contracts';
import { z } from 'zod';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { Can } from '../../platform/authz/decorators';
import { parseOr400 } from '../approvals/approvals.controller';
import { VerificationService } from './verification.service';
import {
  CreateVerificationCaseBodySchema,
  DecisionBodySchema,
  IdempotencyKeySchema,
  ListVerificationCasesQuerySchema,
  SetChecklistBodySchema,
} from './verification.types';

@Controller('v1/verification-cases')
export class VerificationController {
  constructor(private readonly cases: VerificationService) {}

  /** 200 with a bare array of cases, newest first, limited to what the caller may read. */
  @Get()
  @Can('verification.read')
  list(@Query() query: unknown): Promise<VerificationCaseDto[]> {
    return this.cases.list(parseOr400(ListVerificationCasesQuerySchema, query));
  }

  /** 200 with the case; 404 for a case of another tenant or outside the caller's scope. */
  @Get(':id')
  @Can('verification.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<VerificationCaseDto> {
    return this.cases.get(id);
  }

  /** 201 with a new draft case, 200 with the existing (or reopened) case of that customer. */
  @Post()
  @Can('customer.write')
  async create(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VerificationCaseDto> {
    const result = await this.cases.create(parseOr400(CreateVerificationCaseBodySchema, body));
    res.status(result.created ? 201 : 200);
    return result.case;
  }

  /** 200 with the case. Puts one document of this case on one checklist item. 409 unless draft or rejected. */
  @Patch(':id/checklist')
  @Can('customer.write')
  setChecklist(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<VerificationCaseDto> {
    return this.cases.setChecklistItem(id, parseOr400(SetChecklistBodySchema, body));
  }

  /** 200 with the updated case. The checklist item is emptied and its document is retained. */
  @Post(':id/checklist/remove')
  @HttpCode(200)
  @Can('customer.write')
  removeChecklist(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<VerificationCaseDto> {
    return this.cases.removeChecklistDocument(
      id,
      parseOr400(RemoveVerificationDocumentBodySchema, body),
    );
  }

  /** 200 (nothing is created at this URL). 409 unless draft, or while a required item has no document. */
  @Post(':id/submit')
  @HttpCode(200)
  @Can('customer.write')
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') retryKey?: string,
  ): Promise<VerificationCaseDto> {
    return this.cases.submit(
      id,
      parseOr400(VerificationVersionBodySchema, body),
      parseOr400(IdempotencyKeySchema, retryKey),
    );
  }

  @Post(':id/checklist/:key/decision')
  @HttpCode(200)
  @Can('verification.review')
  reviewItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('key') key: unknown,
    @Body() body: unknown,
    @Headers('idempotency-key') retryKey: unknown,
  ) {
    return this.cases.reviewItem(
      id,
      parseOr400(ChecklistItemKeySchema, key),
      parseOr400(ReviewVerificationItemBodySchema, body),
      parseOr400(IdempotencyKeySchema, retryKey),
    );
  }

  @Delete(':id/checklist/:key')
  @Can('customer.write')
  detachItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('key') key: unknown,
    @Body() body: unknown,
    @Headers('idempotency-key') retryKey: unknown,
  ) {
    return this.cases.detachItem(
      id,
      parseOr400(ChecklistItemKeySchema, key),
      parseOr400(VerificationVersionBodySchema, body),
      parseOr400(IdempotencyKeySchema, retryKey),
    );
  }

  @Delete(':id/loose-documents/:documentId')
  @HttpCode(204)
  @Can('customer.write')
  removeLooseDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    return this.cases.removeLooseDocument(id, documentId);
  }

  @Get(':id/review-history')
  @Can('verification.read')
  history(@Param('id', ParseUUIDPipe) id: string, @Query() query: unknown) {
    return this.cases.reviewHistory(
      id,
      parseOr400(
        z.strictObject({
          limit: z.coerce.number().int().min(1).max(100).default(20),
          before: z
            .string()
            .max(256)
            .transform((value, ctx) => {
              try {
                return z
                  .strictObject({ at: z.iso.datetime(), id: z.guid() })
                  .parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
              } catch {
                ctx.addIssue({ code: 'custom', message: 'Invalid history cursor' });
                return z.NEVER;
              }
            })
            .optional(),
        }),
        query,
      ),
    );
  }

  /**
   * 200 with the decided case. 400 without a comment, 403 for the submitter, 409 for a stale version, a case
   * that is not submitted, or a missing or unclean document. The Idempotency-Key header is optional, but a
   * malformed one is a 400; a retry with the same key and body returns the first answer.
   */
  @Post(':id/decision')
  @HttpCode(200)
  @Can('verification.review')
  decide(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<VerificationCaseDto> {
    if (idempotencyKey !== undefined && !IdempotencyKeySchema.safeParse(idempotencyKey).success) {
      throw new BadRequestException(
        'The Idempotency-Key header must be 1-200 printable characters',
      );
    }
    return this.cases.decide(id, parseOr400(DecisionBodySchema, body), idempotencyKey);
  }
}
