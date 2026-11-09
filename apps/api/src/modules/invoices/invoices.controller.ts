// HTTP routes of invoice drafting and proforma issue (P3 unit U10). Thin on purpose: parsing here, every rule in
// InvoiceDraftingService and InvoiceIssueService. Each route names its permission with @Can (does the role hold it at
// all); the services then check the record (entity scope), so an invoice of another entity is a 404.
// Every command needs an Idempotency-Key. U6 adds `:id/submit` (approval); U12 (credit and debit notes) add their routes to
// this controller or a sibling in this module; `:id/issue` is shared (see InvoiceIssueService).
// Route order matters: the literal `from-schedule` and `proforma` come before the `:id` routes.
import {
  CreateManualInvoiceBodySchema,
  CreateProformaBodySchema,
  DiscardInvoiceBodySchema,
  DraftFromScheduleBodySchema,
  InvoiceKindSchema,
  InvoiceStatusSchema,
  IssueInvoiceBodySchema,
  SubmitInvoiceBodySchema,
  type InvoiceDetail,
  type InvoiceListItem,
  type IssueInvoiceResult,
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
} from '@nestjs/common';
import { z } from 'zod';

import { Can } from '../../platform/authz/decorators';
import { parseOr400 } from '../approvals/approvals.controller';
import { requireIdempotencyKey } from '../customers/customers.types';
import { InvoiceApprovalService } from './invoice-approval.service';
import { InvoiceDraftingService } from './invoice-drafting.service';
import { InvoiceIssueService } from './invoice-issue.service';

/** The contract body plus the order id the workspace also names (checked against the line's own order). */
const FromScheduleBodySchema = DraftFromScheduleBodySchema.extend({
  salesOrderId: z.guid().optional(),
});

@Controller('v1/invoices')
export class InvoicesController {
  constructor(
    private readonly drafting: InvoiceDraftingService,
    private readonly issuing: InvoiceIssueService,
    private readonly approval: InvoiceApprovalService,
  ) {}

  /** 200 with a bare array of InvoiceListItem, optionally narrowed by `kind`, `status` and `customerId`. */
  @Get()
  @Can('invoice.read')
  list(
    @Query('kind') kind?: unknown,
    @Query('status') status?: unknown,
    @Query('customerId') customerId?: unknown,
  ): Promise<InvoiceListItem[]> {
    return this.drafting.list({
      kind: kind === undefined ? undefined : parseOr400(InvoiceKindSchema, kind),
      status: status === undefined ? undefined : parseOr400(InvoiceStatusSchema, status),
      customerId: customerId === undefined ? undefined : parseOr400(z.guid(), customerId),
    });
  }

  /** 201 with the InvoiceDetail of a manual draft. 400 without an Idempotency-Key or without `manualReason`. */
  @Post()
  @Can('invoice.draft')
  draftManual(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<InvoiceDetail> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.drafting.draftManual(parseOr400(CreateManualInvoiceBodySchema, body), key);
  }

  /** 201 with the InvoiceDetail. 409 SCHEDULE_LINE_TAKEN when the line already has an invoice. */
  @Post('from-schedule')
  @Can('invoice.draft')
  draftFromSchedule(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<InvoiceDetail> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.drafting.draftFromSchedule(parseOr400(FromScheduleBodySchema, body), key);
  }

  /** 201 with the InvoiceDetail of a proforma draft. The path is this unit's choice: the workspace does not call it yet. */
  @Post('proforma')
  @Can('invoice.draft')
  draftProforma(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<InvoiceDetail> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.drafting.draftProforma(parseOr400(CreateProformaBodySchema, body), key);
  }

  /** 200 with the InvoiceDetail. 404 for an invoice of another entity. */
  @Get(':id')
  @Can('invoice.read')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<InvoiceDetail> {
    return this.drafting.detail(id);
  }

  /** 200 with the discarded InvoiceDetail; the schedule line it held is billable again. */
  @Post(':id/discard')
  @HttpCode(200)
  @Can('invoice.draft')
  discard(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<InvoiceDetail> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.drafting.discard(id, parseOr400(DiscardInvoiceBodySchema, body), key);
  }

  /**
   * 200 with the submitted InvoiceDetail (U6). 404 outside the entity, 409 for a proforma, a status other than draft or
   * returned or a stale `expectedVersion`, 422 NO_ELIGIBLE_APPROVER when the route has nobody who may decide.
   */
  @Post(':id/submit')
  @HttpCode(200)
  @Can('invoice.submit')
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<InvoiceDetail> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.approval.submit(id, parseOr400(SubmitInvoiceBodySchema, body), key);
  }

  /**
   * 200 with `issued` or `already_issued`. A proforma issues from draft; a tax invoice or debit note only once
   * approved (else 409 NOT_APPROVED); a credit note answers 409 not_implemented until U12.
   */
  @Post(':id/issue')
  @HttpCode(200)
  @Can('invoice.issue')
  issue(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<IssueInvoiceResult> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.issuing.issue(id, parseOr400(IssueInvoiceBodySchema, body), key);
  }
}
