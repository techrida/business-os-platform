// HTTP route of the quotation cancel (F1-Q27). Thin on purpose: parsing here, every rule in CancelService. @Can
// names the permission at route level (does the role hold quotation.draft at all); the service then checks the
// quotation itself (entity, own scope). POST needs an Idempotency-Key, so a retry cancels once.
import { CancelQuotationBodySchema, type QuotationVersionDto } from '@bos/contracts';
import { Body, Controller, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { Can } from '../../../platform/authz/decorators';
import { parseOr400 } from '../../approvals/approvals.controller';
import { requireIdempotencyKey } from '../../customers/customers.types';
import { CancelService } from './cancel.service';

@Controller('v1/quotations')
export class CancelController {
  constructor(private readonly cancellations: CancelService) {}

  /**
   * 200 with the cancelled QuotationVersionDto. 400 without an Idempotency-Key or with a bad body (a reason is
   * required); 404 for a quotation of another entity or outside the caller's scope; 409 for a stale
   * expectedVersion or a current version that is not Draft, Returned or Submitted.
   */
  @Post(':id/cancel')
  @HttpCode(200)
  @Can('quotation.draft')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<QuotationVersionDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.cancellations.cancel(id, parseOr400(CancelQuotationBodySchema, body), key);
  }
}
