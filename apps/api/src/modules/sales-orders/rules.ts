// Sales order rules (P3 unit U9; plan decision A7): turns a payment schedule into the billing schedule lines of an
// order. Pure and I/O-free, so rules.test.ts pins every split. The amounts come from money-rules' splitSchedule
// (last-line remainder), so the lines add up to the order total to the paisa, which the database re-checks at commit
// (billing_schedule_lines_sum).
import {
  PaymentMilestoneSchema,
  ScheduleTemplateSchema,
  type ScheduleLineInput,
  type ScheduleLineStatus,
  type ScheduleTemplate,
  type ScheduleTrigger,
} from '@bos/contracts';
import { Dec, splitSchedule } from '@bos/money-rules';
import { z } from 'zod';

/** A schedule that cannot become billing lines. The service turns it into a 422 `invalid_payment_schedule`. */
export class ScheduleRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleRuleError';
  }
}

/** One billing_schedule_lines row, before the order id and scope are added. */
export interface PlannedScheduleLine {
  seq: number;
  label: string;
  trigger: ScheduleTrigger;
  /** The exact share as written ('60', '33.3334'); informational next to the amount. */
  percent: string;
  /** VAT-inclusive slice of the order total, 2 decimals. */
  amount: string;
  /** The same slice of the order's NPR total, split on its own so it adds up in NPR too. */
  amountNpr: string;
  /** An advance line is billable the moment the order is confirmed; every other line waits for its trigger. */
  status: Extract<ScheduleLineStatus, 'billable' | 'planned'>;
}

/**
 * The template the order is billed on: the accepted version's payment schedule, or `fallback` (the
 * `sales.default_schedule` setting) when the version has none. A quotation milestone has no trigger, so the first
 * becomes the advance, the last (when there are several) the UAT line and any in between a milestone.
 */
export function scheduleTemplateOf(
  paymentSchedule: unknown,
  fallback: ScheduleTemplate,
): ScheduleTemplate {
  const parsed = z.array(PaymentMilestoneSchema).safeParse(paymentSchedule);
  if (!parsed.success) {
    throw new ScheduleRuleError('The quotation payment schedule is not a list of milestones');
  }
  const milestones = parsed.data;
  if (milestones.length === 0) return fallback;
  const lines: ScheduleLineInput[] = milestones.map((m, i) => ({
    label: m.label,
    percent: m.percent,
    trigger: i === 0 ? 'advance' : i === milestones.length - 1 ? 'uat' : 'milestone',
  }));
  const template = ScheduleTemplateSchema.safeParse(lines);
  if (!template.success) {
    throw new ScheduleRuleError(
      `The quotation payment schedule is not valid: ${template.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return template.data;
}

/**
 * Splits `total` (and `totalNpr`) over `template`. A line with 0% or an amount under one paisa is refused: the
 * table needs a positive amount and a positive percent.
 */
export function planSchedule(
  template: ScheduleTemplate,
  total: string,
  totalNpr: string,
): PlannedScheduleLine[] {
  const percents = template.map((l) => new Dec(l.percent));
  let amounts: Dec[];
  let amountsNpr: Dec[];
  try {
    amounts = splitSchedule(new Dec(total), percents);
    amountsNpr = splitSchedule(new Dec(totalNpr), percents);
  } catch (error) {
    throw new ScheduleRuleError(error instanceof Error ? error.message : 'Cannot split the total');
  }
  return template.map((line, i) => {
    const amount = amounts[i]!;
    const amountNpr = amountsNpr[i]!;
    if (percents[i]!.lte(0) || amount.lte(0) || amountNpr.lte(0)) {
      throw new ScheduleRuleError(
        `Schedule line "${line.label}" would be ${amount.toFixed(2)}; every line needs a positive amount`,
      );
    }
    return {
      seq: i + 1,
      label: line.label,
      trigger: line.trigger,
      percent: line.percent,
      amount: amount.toFixed(2),
      amountNpr: amountNpr.toFixed(2),
      status: line.trigger === 'advance' ? 'billable' : 'planned',
    };
  });
}
