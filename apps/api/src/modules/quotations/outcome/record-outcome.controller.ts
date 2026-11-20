// HTTP route of the staff outcome record (P2 unit Q3b). Thin on purpose: parsing here, every rule in
// RecordOutcomeService and QuotationOutcomeService. @Can names the permission at route level; the service then
// checks the quotation itself (entity, own scope). POST needs an Idempotency-Key, so a retry records once.
import {
  ConfirmEvidenceBodySchema,
  RecordOutcomeBodySchema,
  type AcceptanceDto,
  type QuotationEvidenceDto,
} from '@bos/contracts';
import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { Can } from '../../../platform/authz/decorators';
import { parseOr400 } from '../../approvals/approvals.controller';
import { requireIdempotencyKey } from '../../customers/customers.types';
import { RecordOutcomeService } from './record-outcome.service';

@Controller('v1/quotations')
export class RecordOutcomeController {
  constructor(private readonly outcomes: RecordOutcomeService) {}

  /**
   * 201 with the AcceptanceDto. 400 without an Idempotency-Key or with a bad body (accepting needs an evidence
   * kind, rejecting a comment); 404 outside the entity or scope; 409 not Sent, expired or stale; 422 evidence the
   * entity's policy does not accept, or a decision dated after today.
   */
  @Post(':id/versions/:vid/outcome')
  @Can('quotation.record_acceptance')
  record(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vid', ParseUUIDPipe) vid: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<AcceptanceDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.outcomes.record(id, vid, parseOr400(RecordOutcomeBodySchema, body), key);
  }

  /** 200 with the QuotationEvidenceDto (F1-Q28). 404 outside the caller's read, or for a version not accepted. */
  @Get(':id/versions/:vid/evidence')
  @Can('quotation.read')
  evidence(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vid', ParseUUIDPipe) vid: string,
  ): Promise<QuotationEvidenceDto> {
    return this.outcomes.evidence(id, vid);
  }

  /**
   * 201 with the QuotationEvidenceDto (F1-Q28): staff confirm a portal acceptance's evidence. 400 without an
   * Idempotency-Key or with a bad body; 404 outside the entity or scope; 409 not accepted or already confirmed;
   * 422 evidence the policy does not accept, or a document of another entity.
   */
  @Post(':id/versions/:vid/evidence-confirmation')
  @Can('quotation.record_acceptance')
  confirmEvidence(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vid', ParseUUIDPipe) vid: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<QuotationEvidenceDto> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.outcomes.confirmEvidence(id, vid, parseOr400(ConfirmEvidenceBodySchema, body), key);
  }
}
