// HTTP routes of the KYB verification cases. Thin on purpose: validation here, every rule in
// VerificationService. The read and decision routes name their permission with @Can (route level); the service
// then checks the record itself (own, all, and 404 outside the caller's scope).
//
// The write routes (open, checklist, submit) carry @AnyAuthenticated, because no single permission fits: a
// customer case is written with customer.write (sales) and a vendor case with vendor.write (procurement). The
// service is the gate and denies by default: a caller holding neither gets 403 before any record is read, and
// one holding the other kind's permission gets 403 on the case. Deny by default: a route with no marker is refused.
import { RemoveVerificationDocumentBodySchema, type VerificationCaseDto } from '@bos/contracts';
import {
  BadRequestException,
  Body,
  Controller,
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
  submit(@Param('id', ParseUUIDPipe) id: string): Promise<VerificationCaseDto> {
    return this.cases.submit(id);
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
