// HTTP route of the quotation submit (Q2). Thin on purpose: parsing here, every rule in QuotationSubmitService. The
// route needs quotation.submit (route level); the service then checks the quotation itself (its owner, for the
// `own` scope) and answers 404 for another entity's quotation. An Idempotency-Key is required, so a double click
// or a retry cannot open two approval requests.
import { SubmitQuotationBodySchema, type QuotationVersionDto } from '@bos/contracts';
import { Body, Controller, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { Can } from '../../../platform/authz/decorators';
import { parseOr400 } from '../../approvals/approvals.controller';
import { requireIdempotencyKey } from '../../customers/customers.types';
import { QuotationSubmitService } from './quotation-submit.service';

@Controller('v1/quotations')
export class QuotationSubmitController {
  constructor(private readonly submits: QuotationSubmitService) {}

  /**
   * 200 with the submitted QuotationVersionDto. 400 without an Idempotency-Key or for a body other than
   * `{ expectedVersion }`, 404 for a version outside the caller's entity or scope, 409 unless the version is a
   * draft or returned or when expectedVersion is stale, 409 `fx_rate_stale` for an old USD rate, and 422
   * `NO_ELIGIBLE_APPROVER` when an approval step has nobody who may decide it (nothing is submitted).
   */
  @Post(':id/versions/:vid/submit')
  @HttpCode(200)
  @Can('quotation.submit')
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vid', ParseUUIDPipe) versionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<QuotationVersionDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.submits.submit(id, versionId, parseOr400(SubmitQuotationBodySchema, body), key);
  }
}
