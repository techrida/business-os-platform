// HTTP route of the lead conversion: POST /v1/leads/:id/convert. Thin on purpose: parsing here, every rule in
// LeadConvertService. It is its own controller (same `v1/leads` prefix) so LeadsController keeps its constructor.
// The route names crm.lead.write; the service then checks the lead record, and the customer permission the chosen
// customer mode needs.
import { ConvertLeadBodySchema } from '@bos/contracts';
import { Body, Controller, Headers, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { Can } from '../../../platform/authz/decorators';
import { parseOr400 } from '../../approvals/approvals.controller';
import { requireIdempotencyKey } from '../../customers/customers.types';
import { LeadConvertService, type ConvertLeadResult } from './lead-convert.service';

@Controller('v1/leads')
export class LeadConvertController {
  constructor(private readonly convertService: LeadConvertService) {}

  /**
   * 201 with `{ opportunityId, customerId }`. The Idempotency-Key is required (400 without it). 404 for a lead of
   * another entity or outside the caller's scope; 409 for a stale version, a lead that is not qualified, or a
   * possible duplicate (`duplicate_found` with `error.duplicates`; `duplicate_pan_vat` can never be overridden).
   */
  @Post(':id/convert')
  @Can('crm.lead.write')
  convert(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<ConvertLeadResult> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.convertService.convert(id, parseOr400(ConvertLeadBodySchema, body), key);
  }
}
