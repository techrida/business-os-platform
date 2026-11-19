// Unit tests of the sales order rules (P3 unit U9): how a payment schedule becomes billing schedule lines.
// Pure, so every split is pinned here; the service tests run the same rules against a real database.
// Run: pnpm --filter @bos/api exec vitest run src/modules/sales-orders/rules.test.ts
import { DEFAULT_SALES_SCHEDULE } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { planSchedule, ScheduleRuleError, scheduleTemplateOf } from './rules';

const TOTAL = '5045450.00';

describe('planSchedule', () => {
  it('splits the golden 5,045,450.00 as 60/20/20, the advance line billable at once', () => {
    const lines = planSchedule(DEFAULT_SALES_SCHEDULE, TOTAL, TOTAL);
    expect(lines.map((l) => l.amount)).toEqual(['3027270.00', '1009090.00', '1009090.00']);
    expect(lines.map((l) => l.percent)).toEqual(['60', '20', '20']);
    expect(lines.map((l) => l.trigger)).toEqual(['advance', 'milestone', 'uat']);
    expect(lines.map((l) => l.status)).toEqual(['billable', 'planned', 'planned']);
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
  });

  it('splits 40/60 with the advance at 2,018,180.00', () => {
    const lines = planSchedule(
      [
        { label: 'Advance', percent: '40', trigger: 'advance' },
        { label: 'Balance', percent: '60', trigger: 'uat' },
      ],
      TOTAL,
      TOTAL,
    );
    expect(lines.map((l) => l.amount)).toEqual(['2018180.00', '3027270.00']);
  });

  it('copies four-decimal quotation shares and allocates each total to the minor unit', () => {
    const template = scheduleTemplateOf(
      [
        { label: 'A', percent: '33.3333' },
        { label: 'B', percent: '33.3333' },
        { label: 'C', percent: '33.3334' },
      ],
      DEFAULT_SALES_SCHEDULE,
    );
    const lines = planSchedule(template, '100.01', '100.00');
    expect(lines.map((l) => l.percent)).toEqual(['33.3333', '33.3333', '33.3334']);
    expect(lines.map((l) => l.amount)).toEqual(['33.34', '33.34', '33.33']);
    expect(lines.map((l) => l.amountNpr)).toEqual(['33.33', '33.33', '33.34']);
  });

  it('splits the NPR value on its own, so a foreign order adds up in NPR too', () => {
    const lines = planSchedule(DEFAULT_SALES_SCHEDULE, '1000.00', '133000.00');
    expect(lines.map((l) => l.amountNpr)).toEqual(['79800.00', '26600.00', '26600.00']);
  });

  it('refuses a line that would be 0.00 (the table needs amount > 0)', () => {
    expect(() =>
      planSchedule(
        [
          { label: 'A', percent: '99.99', trigger: 'advance' },
          { label: 'B', percent: '0.01', trigger: 'uat' },
        ],
        '0.50',
        '0.50',
      ),
    ).toThrow(ScheduleRuleError);
  });

  it('refuses a 0% line', () => {
    expect(() =>
      planSchedule(
        [
          { label: 'A', percent: '100', trigger: 'advance' },
          { label: 'B', percent: '0', trigger: 'uat' },
        ],
        TOTAL,
        TOTAL,
      ),
    ).toThrow(ScheduleRuleError);
  });
});

describe('scheduleTemplateOf', () => {
  it('uses the fallback when the quotation has no payment schedule', () => {
    expect(scheduleTemplateOf([], DEFAULT_SALES_SCHEDULE)).toEqual(DEFAULT_SALES_SCHEDULE);
  });

  it('turns quotation milestones into triggers: first advance, last uat, the rest milestone', () => {
    const template = scheduleTemplateOf(
      [
        { label: 'On order', percent: '50' },
        { label: 'Design', percent: '30', dueDescription: 'On sign-off' },
        { label: 'Go live', percent: '20' },
      ],
      DEFAULT_SALES_SCHEDULE,
    );
    expect(template.map((l) => [l.label, l.percent, l.trigger])).toEqual([
      ['On order', '50', 'advance'],
      ['Design', '30', 'milestone'],
      ['Go live', '20', 'uat'],
    ]);
  });

  it('makes a single 100% milestone the advance', () => {
    expect(scheduleTemplateOf([{ label: 'All', percent: '100' }], DEFAULT_SALES_SCHEDULE)).toEqual([
      { label: 'All', percent: '100', trigger: 'advance' },
    ]);
  });

  it('refuses a quotation schedule that does not add up to 100', () => {
    expect(() =>
      scheduleTemplateOf(
        [
          { label: 'A', percent: '50' },
          { label: 'B', percent: '40' },
        ],
        DEFAULT_SALES_SCHEDULE,
      ),
    ).toThrow(ScheduleRuleError);
  });

  it('refuses stored data that is not a milestone list', () => {
    expect(() => scheduleTemplateOf({ nope: true }, DEFAULT_SALES_SCHEDULE)).toThrow(
      ScheduleRuleError,
    );
  });
});
