// HTTP routes of quotation drafting. Thin on purpose: parsing here, every rule in DraftingService. Each route
// names its permission with @Can (route level: does the role hold it at all); the service then checks the
// record itself (entity, own scope), so a salesperson cannot read a colleague's quotation by guessing its id.
// POST needs an Idempotency-Key, so a double click or a retry cannot create two quotations.
import {
  CreateQuotationBodySchema,
  ListQuotationsQuerySchema,
  UpdateQuotationDraftBodySchema,
  type QuotationDetail,
  type QuotationDto,
  type QuotationListItem,
  type QuotationVersionDto,
} from '@bos/contracts';
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import { Can } from '../../../platform/authz/decorators';
import { parseOr400 } from '../../approvals/approvals.controller';
import { requireIdempotencyKey } from '../../customers/customers.types';
import { DraftingService } from './drafting.service';

@Controller('v1/quotations')
export class DraftingController {
  constructor(private readonly drafting: DraftingService) {}

  /** 201 with the new QuotationDto (Draft, revision 1). 400 without an Idempotency-Key header. */
  @Post()
  @Can('quotation.draft')
  create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<QuotationDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.drafting.create(parseOr400(CreateQuotationBodySchema, body), key);
  }

  /**
   * 200 with a bare array of QuotationListItem, optionally only the given `status` and/or one
   * `opportunityId`. 400 for an unknown status or an opportunityId that is not a UUID.
   */
  @Get()
  @Can('quotation.read')
  list(
    @Query('status') status?: unknown,
    @Query('opportunityId') opportunityId?: unknown,
  ): Promise<QuotationListItem[]> {
    return this.drafting.list(parseOr400(ListQuotationsQuerySchema, { status, opportunityId }));
  }

  /** 200 with the QuotationDetail. 404 for a record of another entity or outside the caller's scope. */
  @Get(':id')
  @Can('quotation.read')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<QuotationDetail> {
    return this.drafting.detail(id);
  }

  /** 200 with one version of the quotation, its lines and totals included. */
  @Get(':id/versions/:vid')
  @Can('quotation.read')
  getVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vid', ParseUUIDPipe) versionId: string,
  ): Promise<QuotationVersionDto> {
    return this.drafting.getVersion(id, versionId);
  }

  /** 200 with `{ version }`, the new row version. 409 for a stale expectedVersion or a version that is not a draft. */
  @Put(':id/versions/:vid')
  @Can('quotation.draft')
  updateDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vid', ParseUUIDPipe) versionId: string,
    @Body() body: unknown,
  ): Promise<{ version: number }> {
    return this.drafting.updateDraft(
      id,
      versionId,
      parseOr400(UpdateQuotationDraftBodySchema, body),
    );
  }
}
