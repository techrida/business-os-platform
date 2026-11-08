// HTTP route of the quotation send (Q3a). Thin on purpose: parsing here, every rule in QuotationSendService. The
// route needs quotation.send (route level); the service then checks the quotation itself (its owner, for the
// `own` scope) and answers 404 for another entity's quotation. An Idempotency-Key is required, so a double click
// or a retry cannot email the customer twice.
import { SendQuotationBodySchema, type QuotationVersionDto } from '@bos/contracts';
import { Body, Controller, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { Can } from '../../../platform/authz/decorators';
import { parseOr400 } from '../../approvals/approvals.controller';
import { requireIdempotencyKey } from '../../customers/customers.types';
import { QuotationSendService } from './quotation-send.service';

@Controller('v1/quotations')
export class QuotationSendController {
  constructor(private readonly sends: QuotationSendService) {}

  /**
   * 200 with the sent QuotationVersionDto. 400 without an Idempotency-Key, for a body other than
   * `{ recipientContactId, message?, expectedVersion }`, or for a recipient that is not one of the customer's
   * contacts or has no email; 404 for a version outside the caller's entity or scope; 409 when the version is not
   * approved, its PDF is not rendered or not scanned clean, it is past valid_until, or expectedVersion is stale.
   */
  @Post(':id/versions/:vid/send')
  @HttpCode(200)
  @Can('quotation.send')
  send(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vid', ParseUUIDPipe) versionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<QuotationVersionDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.sends.send(id, versionId, parseOr400(SendQuotationBodySchema, body), key);
  }
}
