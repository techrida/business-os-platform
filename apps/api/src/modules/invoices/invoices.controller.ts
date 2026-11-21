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
  EditInvoiceDueDateBodySchema,
  InvoiceKindSchema,
  InvoiceStatusSchema,
  IssueInvoiceBodySchema,
  MAX_ROWS,
  multi,
  ReopenInvoiceBodySchema,
  SalesVatRegisterQuerySchema,
  searchParam,
  SettlementStatusSchema,
  SubmitInvoiceBodySchema,
  type InvoiceDetail,
  type InvoiceListItem,
  type SalesVatRegister,
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
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import { Can } from '../../platform/authz/decorators';
import { setMoneyTotals, setTotalCount } from '../../platform/list';
import { parseOr400 } from '../approvals/approvals.controller';
import { requireIdempotencyKey } from '../customers/customers.types';
import { InvoiceApprovalService } from './invoice-approval.service';
import { InvoiceDraftingService, type InvoicesSummary } from './invoice-drafting.service';
import { InvoiceIssueService } from './invoice-issue.service';
import { InvoiceVatRegisterService } from './invoice-vat-register.service';

/** The contract body plus the order id the workspace also names (checked against the line's own order). */
const FromScheduleBodySchema = DraftFromScheduleBodySchema.extend({
  salesOrderId: z.guid().optional(),
});

const isoDay = z.iso.date();
const filters = {
  kind: multi(InvoiceKindSchema),
  customerId: multi(z.guid()),
  issuedFrom: isoDay.optional(),
  issuedTo: isoDay.optional(),
  q: searchParam,
};
const rangeOrdered = (v: { issuedFrom?: string | undefined; issuedTo?: string | undefined }) =>
  v.issuedFrom === undefined || v.issuedTo === undefined || v.issuedFrom <= v.issuedTo;
const rangeIssue = { message: 'issuedFrom must not be after issuedTo', path: ['issuedFrom'] };

/**
 * `GET /v1/invoices`. `kind`, `status`, `settlement` and `customerId` may repeat; an unknown value or key or a
 * repeated `q` is a 400. `settlement` is the derived paid/overdue state. No `limit` means every match.
 */
export const ListInvoicesQuerySchema = z
  .strictObject({
    ...filters,
    status: multi(InvoiceStatusSchema),
    settlement: multi(SettlementStatusSchema),
    limit: z.coerce.number().int().min(1).max(MAX_ROWS).optional(),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine(rangeOrdered, rangeIssue);

/** `GET /v1/invoices/summary`: the counts ignore `status` and `settlement`, so the cards show every status. */
export const InvoicesSummaryQuerySchema = z.strictObject(filters).refine(rangeOrdered, rangeIssue);

@Controller('v1/invoices')
export class InvoicesController {
  constructor(
    private readonly drafting: InvoiceDraftingService,
    private readonly issuing: InvoiceIssueService,
    private readonly approval: InvoiceApprovalService,
    private readonly vatRegister: InvoiceVatRegisterService,
  ) {}

  /**
   * 200 with a bare array of InvoiceListItem, newest first; X-Total-Count is all matches, not this page, and
   * X-Money-Totals their totals summed per currency.
   */
  @Get()
  @Can('invoice.read')
  async list(
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvoiceListItem[]> {
    const { rows, total, totals } = await this.drafting.list(
      parseOr400(ListInvoicesQuerySchema, query),
    );
    setTotalCount(res, total);
    setMoneyTotals(res, totals);
    return rows;
  }

  /** 200 with `{ total, byStatus, customers }` for the same entity and visibility as the list. Before `:id`. */
  @Get('summary')
  @Can('invoice.read')
  summary(@Query() query: unknown): Promise<InvoicesSummary> {
    return this.drafting.summary(parseOr400(InvoicesSummaryQuerySchema, query));
  }

  /**
   * The sales VAT register: issued tax invoices, credit notes and debit notes of the acting entity by issue date.
   * Query `from` and `to` (YYYY-MM-DD, inclusive). Needs `vat.sales.read`, not `invoice.read`. Before `:id`.
   */
  @Get('vat-register')
  @Can('vat.sales.read')
  salesVatRegister(@Query() query: unknown): Promise<SalesVatRegister> {
    const { from, to } = parseOr400(SalesVatRegisterQuerySchema, query);
    return this.vatRegister.register(from, to);
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
   * 200 with the InvoiceDetail carrying the new due date. 404 outside the caller's read, 403 without `invoice.draft` on
   * the drafter, 409 for a kind whose due date is set at issue, a status other than draft or returned or a stale
   * `expectedVersion`, 422 DUE_DATE_BEFORE_ISSUE for a date before today.
   */
  @Patch(':id/due-date')
  @Can('invoice.draft')
  editDueDate(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<InvoiceDetail> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.drafting.editDueDate(id, parseOr400(EditInvoiceDueDateBodySchema, body), key);
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
   * 200 with the InvoiceDetail back in draft: an approved invoice that can no longer be issued as approved (its due
   * date passed). 404 outside the entity, 409 for any other status or a stale `expectedVersion`. The approval no longer
   * counts: a manual tax invoice's due date can then be changed (PATCH :id/due-date), and it must be submitted for
   * approval again before issue.
   */
  @Post(':id/reopen')
  @HttpCode(200)
  @Can('invoice.issue')
  reopen(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<InvoiceDetail> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.approval.reopen(id, parseOr400(ReopenInvoiceBodySchema, body), key);
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
