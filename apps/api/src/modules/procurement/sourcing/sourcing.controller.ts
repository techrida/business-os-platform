// HTTP routes of sourcing (P4 unit P2). Thin on purpose: parsing here, every rule in SourcingService. Every write
// needs an Idempotency-Key. The route-level grant is procurement.sourcing; another entity's RFQ is a 404.
import {
  ListRfqsQuerySchema,
  RecommendQuotationBodySchema,
  type RfqListItem,
  type RfqSubmissionItem,
} from '@bos/contracts';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { Can } from '../../../platform/authz/decorators';
import { setTotalCount } from '../../../platform/list';
import { parseOr400 } from '../../approvals/approvals.controller';
import { requireIdempotencyKey } from '../../customers/customers.types';
import {
  ConvertSubmissionBodySchema,
  CreateRfqBodySchema,
  RecordQuotationBodySchema,
  ScoreQuotationBodySchema,
} from './sourcing.rules';
import {
  SourcingService,
  type ComparisonRow,
  type QuotationDto,
  type RfqDto,
} from './sourcing.service';

@Controller('v1/procurement/rfqs')
export class SourcingController {
  constructor(private readonly sourcing: SourcingService) {}

  /** 201. 404 for another entity's request; 409 unless dept_approved, or for an unapproved or foreign vendor. */
  @Post()
  @Can('procurement.sourcing')
  create(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<RfqDto> {
    return this.sourcing.createRfq(
      parseOr400(CreateRfqBodySchema, body),
      requireIdempotencyKey(key),
    );
  }

  /**
   * The entity's RFQs, newest first. Query: `status` (repeatable), `q`, `limit` (default 50, at most 200), `offset`;
   * X-Total-Count is the number of all matches. Parsed before the call so a bad query throws at once.
   */
  @Get()
  @Can('procurement.sourcing')
  list(@Query() query: unknown, @Res({ passthrough: true }) res: Response): Promise<RfqListItem[]> {
    const parsed = parseOr400(ListRfqsQuerySchema, query);
    return this.sourcing.listRfqs(parsed).then(({ rows, total }) => {
      setTotalCount(res, total);
      return rows;
    });
  }

  @Get(':id')
  @Can('procurement.sourcing')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<RfqDto> {
    return this.sourcing.getRfq(id);
  }

  /** The comparison: quotations cheapest first, with their scores. */
  @Get(':id/quotations')
  @Can('procurement.sourcing')
  quotations(@Param('id', ParseUUIDPipe) id: string): Promise<ComparisonRow[]> {
    return this.sourcing.comparison(id);
  }

  /** The RFQ's `received` vendor uploads for the convert screen. 404 for another entity's RFQ. */
  @Get(':id/submissions')
  @Can('procurement.sourcing')
  submissions(@Param('id', ParseUUIDPipe) id: string): Promise<RfqSubmissionItem[]> {
    return this.sourcing.listSubmissions(id);
  }

  /** 201. Records a quotation of an invited vendor; 409 when not invited, already quoted or the RFQ is not open. */
  @Post(':id/quotations')
  @Can('procurement.sourcing')
  record(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<QuotationDto> {
    return this.sourcing.recordQuotation(
      id,
      parseOr400(RecordQuotationBodySchema, body),
      requireIdempotencyKey(key),
    );
  }

  /** 201. Converts a clean `received` inbox submission into a quotation. */
  @Post(':id/quotations/convert')
  @Can('procurement.sourcing')
  convert(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<QuotationDto> {
    return this.sourcing.convertSubmission(
      id,
      parseOr400(ConvertSubmissionBodySchema, body),
      requireIdempotencyKey(key),
    );
  }

  @Post(':id/quotations/:quotationId/scores')
  @HttpCode(200)
  @Can('procurement.sourcing')
  score(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('quotationId', ParseUUIDPipe) quotationId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<ComparisonRow[]> {
    return this.sourcing.scoreQuotation(
      id,
      quotationId,
      parseOr400(ScoreQuotationBodySchema, body),
      requireIdempotencyKey(key),
    );
  }

  /** 200. 409 FEWER_THAN_MIN_QUOTES without a reason (AD13); body is RecommendQuotationBody. */
  @Post(':id/recommendation')
  @HttpCode(200)
  @Can('procurement.sourcing')
  recommend(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<RfqDto> {
    return this.sourcing.recommend(
      id,
      parseOr400(RecommendQuotationBodySchema, body),
      requireIdempotencyKey(key),
    );
  }

  /** 200. Submits the recommended quote to the pr_commitment route; 422 NO_ELIGIBLE_APPROVER when unroutable. */
  @Post(':id/commitment')
  @HttpCode(200)
  @Can('procurement.sourcing')
  commit(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<RfqDto> {
    return this.sourcing.submitCommitment(id, requireIdempotencyKey(key));
  }
}
