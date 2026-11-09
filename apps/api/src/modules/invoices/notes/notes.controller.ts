// HTTP routes of credit-note and debit-note drafting (P3 unit U12 part B). The workspace calls exactly
// `POST /v1/credit-notes` and `POST /v1/debit-notes` and expects an InvoiceDetail. Thin on purpose: parsing here, every
// rule in NoteDraftingService. Both need an Idempotency-Key and `invoice.credit_note` (debit notes share it: there is no
// separate permission). A drafted note then goes through the shared `v1/invoices/:id/submit` and `:id/issue` routes.
// There is no route that cancels an issued document (D6): a mistake is corrected with a note.
import { CreditNoteBodySchema, DebitNoteBodySchema, type InvoiceDetail } from '@bos/contracts';
import { Body, Controller, Headers, Post } from '@nestjs/common';

import { Can } from '../../../platform/authz/decorators';
import { parseOr400 } from '../../approvals/approvals.controller';
import { requireIdempotencyKey } from '../../customers/customers.types';
import { NoteDraftingService } from './note-drafting.service';

@Controller('v1')
export class NotesController {
  constructor(private readonly notes: NoteDraftingService) {}

  /**
   * 201 with the InvoiceDetail of a credit-note draft. 404 for an original of another entity, 409 when it is not an
   * issued tax invoice, 409 CREDIT_EXCEEDS_INVOICE over the amount not yet credited.
   */
  @Post('credit-notes')
  @Can('invoice.credit_note')
  draftCreditNote(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<InvoiceDetail> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.notes.draftCreditNote(parseOr400(CreditNoteBodySchema, body), key);
  }

  /** 201 with the InvoiceDetail of a debit-note draft. 404 / 409 as for a credit note. */
  @Post('debit-notes')
  @Can('invoice.credit_note')
  draftDebitNote(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<InvoiceDetail> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.notes.draftDebitNote(parseOr400(DebitNoteBodySchema, body), key);
  }
}
