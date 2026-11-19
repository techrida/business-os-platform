// HTTP routes of the KYB verification cases. Thin on purpose: validation here, every rule in
// VerificationService. The read and decision routes name their permission with @Can (route level); the service
// then checks the record itself (own, all, and 404 outside the caller's scope).
//
// The write routes (open, checklist, submit) carry @AnyAuthenticated, because no single permission fits: a
// customer case is written with customer.write (sales) and a vendor case with vendor.write (procurement). The
// service is the gate and denies by default: a caller holding neither gets 403 before any record is read, and
// one holding the other kind's permission gets 403 on the case. Deny by default: a route with no marker is refused.
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

import { AnyAuthenticated, Can } from '../../platform/authz/decorators';
import { setTotalCount } from '../../platform/list';
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

  /**
   * 200 with a bare array of cases, newest first, limited to what the caller may read; X-Total-Count is the
   * number of cases the caller may read under the same filters, not just this page.
   */
  @Get()
  @Can('verification.read')
  async list(
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VerificationCaseDto[]> {
    const { rows, total } = await this.cases.list(
      parseOr400(ListVerificationCasesQuerySchema, query),
    );
    setTotalCount(res, total);
    return rows;
  }

  /** 200 with the case; 404 for a case of another tenant or outside the caller's scope. */
  @Get(':id')
  @Can('verification.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<VerificationCaseDto> {
    return this.cases.get(id);
  }

  /** 201 with a new draft case, 200 with the existing (or reopened) case of that party. */
  @Post()
  @AnyAuthenticated()
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
  @AnyAuthenticated()
  setChecklist(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<VerificationCaseDto> {
    return this.cases.setChecklistItem(id, parseOr400(SetChecklistBodySchema, body));
  }

  /** 200 with the updated case. The checklist item is emptied and its document is retained. */
  @Post(':id/checklist/remove')
  @HttpCode(200)
  @AnyAuthenticated()
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
  @AnyAuthenticated()
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') retryKey?: string,
  ): Promise<VerificationCaseDto> {
    return this.cases.submit(
      id,
      parseOr400(
        z
          .union([VerificationVersionBodySchema, z.strictObject({}).transform(() => undefined)])
          .optional(),
        body,
      ),
      retryKey === undefined ? undefined : parseOr400(IdempotencyKeySchema, retryKey),
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

  /**
   * Customer cases only, so `customer.write` is the one permission that fits (unlike the write routes above).
   * Only a customer document-review case holds files per checklist item; the service refuses any other case
   * (VerificationService.detachItem), and a vendor case carries no case files at all. @AnyAuthenticated would
   * gain nothing for vendor writers and would let a caller with no grant learn whether a case id exists.
   */
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

  /** Customer cases only, as detachItem: a vendor case has no loose files to remove. */
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
