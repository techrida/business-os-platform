// HTTP routes of the purchase requests (P4 unit P1). Thin on purpose: parsing here (the bodies are the contracts of
// procurement.ts), every rule in PurchaseRequestsService. Every write needs an Idempotency-Key, so a double click
// or a retry cannot open two requests or two approval requests. Route-level grants are procurement.pr.create
// (writes) and procurement.pr.read (reads); the service then checks the record (the requester, for `own` scope)
// and answers 404 for another entity's or another requester's request.
import { CreatePurchaseRequestBodySchema, type CreatePurchaseRequestBody } from '@bos/contracts';
import {
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

import { Can } from '../../../platform/authz/decorators';
import { setTotalCount } from '../../../platform/list';
import { parseOr400 } from '../../approvals/approvals.controller';
import { requireIdempotencyKey } from '../../customers/customers.types';
import {
  ExpectedVersionEnvelopeSchema,
  ListPurchaseRequestsQuerySchema,
  PurchaseRequestCommandBodySchema,
  type PurchaseRequestDto,
  type PurchaseRequestListItem,
} from './purchase-request.rules';
import { PurchaseRequestsService } from './purchase-requests.service';

/** The contract body of a create or full-replace update, with the optional `expectedVersion` split off first. */
function parseContentBody(raw: unknown): {
  body: CreatePurchaseRequestBody;
  expectedVersion: number | undefined;
} {
  const { expectedVersion, ...rest } = parseOr400(ExpectedVersionEnvelopeSchema, raw);
  return { body: parseOr400(CreatePurchaseRequestBodySchema, rest), expectedVersion };
}

@Controller('v1/procurement/purchase-requests')
export class PurchaseRequestsController {
  constructor(private readonly requests: PurchaseRequestsService) {}

  /**
   * The requests the caller may read, newest first. Query: `status` (repeatable), `q`, `limit` (default 50, at most
   * 200) and `offset`; X-Total-Count is the number of all matches. Parsed before the call so a bad query throws at once.
   */
  @Get()
  @Can('procurement.pr.read')
  list(
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PurchaseRequestListItem[]> {
    const parsed = parseOr400(ListPurchaseRequestsQuerySchema, query);
    return this.requests.list(parsed).then(({ rows, total }) => {
      setTotalCount(res, total);
      return rows;
    });
  }

  /** 201 with the draft. 400 without an Idempotency-Key, for a body that fails the contract or an unknown department. */
  @Post()
  @Can('procurement.pr.create')
  create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<PurchaseRequestDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.requests.create(parseOr400(CreatePurchaseRequestBodySchema, body), key);
  }

  /** 404 outside the caller's entity or scope. */
  @Get(':id')
  @Can('procurement.pr.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<PurchaseRequestDto> {
    return this.requests.get(id);
  }

  /**
   * Replaces a draft or returned request: the body is the create body, plus an optional `expectedVersion`. 404
   * outside scope, 409 once submitted or when expectedVersion is stale.
   */
  @Patch(':id')
  @Can('procurement.pr.create')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() raw: unknown,
  ): Promise<PurchaseRequestDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    const { body, expectedVersion } = parseContentBody(raw);
    return this.requests.update(id, body, expectedVersion, key);
  }

  /**
   * 200 with the submitted request. 404 outside scope, 409 unless draft or returned or when expectedVersion is
   * stale, 422 `NO_ELIGIBLE_APPROVER` when a step has nobody who may decide it (nothing is submitted).
   */
  @Post(':id/submit')
  @HttpCode(200)
  @Can('procurement.pr.create')
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() raw: unknown,
  ): Promise<PurchaseRequestDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    const { expectedVersion } = parseOr400(PurchaseRequestCommandBodySchema, raw ?? {});
    return this.requests.submit(id, expectedVersion, key);
  }

  /** 200 with the cancelled request. Only a draft can be cancelled; 409 otherwise. */
  @Post(':id/cancel')
  @HttpCode(200)
  @Can('procurement.pr.create')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() raw: unknown,
  ): Promise<PurchaseRequestDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    const { expectedVersion } = parseOr400(PurchaseRequestCommandBodySchema, raw ?? {});
    return this.requests.cancel(id, expectedVersion, key);
  }
}
