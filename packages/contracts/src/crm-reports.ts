// CRM reports (round 5, P5 item 2): the lost-deal report, counts of lost opportunities by lost reason and month.
import { z } from 'zod';

import { LeadLostReasonRefSchema } from './crm.js';

/** A calendar month in Asia/Kathmandu, for example 2026-11. */
export const ReportMonthSchema = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');

/** The most months one report covers (five years). */
export const LOST_REASON_REPORT_MAX_MONTHS = 60;

/** `GET /v1/opportunities/reports/lost-reasons`: `from` and `to` are months, both inclusive. */
export const LostReasonReportQuerySchema = z
  .strictObject({
    from: ReportMonthSchema.optional(),
    to: ReportMonthSchema.optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: 'from must not be after to',
    path: ['from'],
  });
export type LostReasonReportQuery = z.infer<typeof LostReasonReportQuerySchema>;

/** One reason's counts. `reason` is null for deals lost without a reason option (older deals). */
export const LostReasonReportRowSchema = z.object({
  reason: LeadLostReasonRefSchema.nullable(),
  /** One count per entry of the report's `months`, in the same order. */
  counts: z.array(z.number().int().min(0)),
  total: z.number().int().min(0),
});
export type LostReasonReportRow = z.infer<typeof LostReasonReportRowSchema>;

/**
 * Deals whose stage is now Lost, counted by reason and by the month they were lost, over the deals the caller may
 * read. Rows are ordered by total, largest first; months run oldest first.
 */
export const LostReasonReportSchema = z.object({
  from: ReportMonthSchema,
  to: ReportMonthSchema,
  months: z.array(ReportMonthSchema),
  rows: z.array(LostReasonReportRowSchema),
  /** One total per month, across every reason. */
  monthTotals: z.array(z.number().int().min(0)),
  total: z.number().int().min(0),
});
export type LostReasonReport = z.infer<typeof LostReasonReportSchema>;
