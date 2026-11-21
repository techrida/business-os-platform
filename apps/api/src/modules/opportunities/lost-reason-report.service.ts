// The lost-deal report (round 5, P5 item 2): deals whose stage is now Lost, counted by lost reason and by the month
// they were lost (Asia/Kathmandu). It covers exactly the deals the opportunity list shows the caller: the same
// entity filter and the same crm.opportunity.read scope, so the counts never reveal a deal the caller cannot open.
//
// The lost date is the latest move to Lost in opportunity_stage_history. History starts with migration 0162, so a
// deal lost before then has no row; its last update time stands in (a later edit to such a deal moves its month).
import {
  LOST_REASON_REPORT_MAX_MONTHS,
  type LostReasonReport,
  type LostReasonReportQuery,
  type LostReasonReportRow,
} from '@bos/contracts';
import { opportunities, opportunityStageHistory, scoped } from '@bos/db';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, lt, sql } from 'drizzle-orm';

import { scopeWhereFor } from '../../platform/authz/authz.service';
import { DB, type Db } from '../../platform/db/db.module';
import { READ_ONLY, withTx } from '../../platform/db/tx';
import { lostReasonRefs } from '../leads/lost-reasons.service';
import { OpportunitiesCaller } from './opportunities.caller';

/** Asia/Kathmandu is UTC+5:45 all year (no daylight saving). */
const KATHMANDU_OFFSET = '+05:45';
const KATHMANDU_OFFSET_MS = (5 * 60 + 45) * 60 * 1000;
const DEFAULT_MONTHS = 12;

/** `YYYY-MM` plus `n` months (n may be negative). */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const index = y * 12 + (m - 1) + n;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** The month `now` falls in, in Asia/Kathmandu. */
export function kathmanduMonth(now: Date): string {
  return new Date(now.getTime() + KATHMANDU_OFFSET_MS).toISOString().slice(0, 7);
}

/** Every month from `from` to `to`, both inclusive. */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to && out.length <= LOST_REASON_REPORT_MAX_MONTHS; m = addMonths(m, 1))
    out.push(m);
  return out;
}

const monthStart = (month: string) => new Date(`${month}-01T00:00:00${KATHMANDU_OFFSET}`);

/**
 * The months a query covers. With neither bound, the last 12 months to this one; one bound alone spans 12 months
 * from or to it. 400 when `from` is after `to` or the span is over the cap.
 */
export function reportMonths(
  q: LostReasonReportQuery,
  now: Date,
): { from: string; to: string; months: string[] } {
  const to =
    q.to ?? (q.from !== undefined ? addMonths(q.from, DEFAULT_MONTHS - 1) : kathmanduMonth(now));
  const from = q.from ?? addMonths(to, -(DEFAULT_MONTHS - 1));
  if (from > to) {
    throw new BadRequestException('from: from must not be after to');
  }
  const months = monthsBetween(from, to);
  if (months.length > LOST_REASON_REPORT_MAX_MONTHS) {
    throw new BadRequestException(
      `from: a report covers at most ${LOST_REASON_REPORT_MAX_MONTHS} months`,
    );
  }
  return { from, to, months };
}

@Injectable()
export class LostReasonReportService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly caller: OpportunitiesCaller,
  ) {}

  async lostReasons(q: LostReasonReportQuery, now = new Date()): Promise<LostReasonReport> {
    const { scope, actor, principal } = this.caller.current();
    const { from, to, months } = reportMonths(q, now);
    const h = opportunityStageHistory;
    // The latest move to Lost, one value per deal (a deal lost, reopened and lost again counts once).
    const lostAt = sql<Date>`coalesce((select max(${h.createdAt}) from ${h} where ${h.tenantId} = ${opportunities.tenantId} and ${h.organizationId} = ${opportunities.organizationId} and ${h.opportunityId} = ${opportunities.id} and ${h.toStage} = 'lost'), ${opportunities.updatedAt})`;
    const month = sql<string>`to_char(${lostAt} at time zone 'Asia/Kathmandu', 'YYYY-MM')`;

    const { counts, refs } = await withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        const rows = await tx
          .select({
            reasonId: opportunities.lostReasonId,
            month,
            n: sql<number>`count(*)::int`,
          })
          .from(opportunities)
          .where(
            scoped(scope).where(
              opportunities,
              and(
                scopeWhereFor(principal, opportunities, 'crm.opportunity.read'),
                eq(opportunities.stage, 'lost'),
                gte(lostAt, monthStart(from)),
                lt(lostAt, monthStart(addMonths(to, 1))),
              ),
            ),
          )
          .groupBy(opportunities.lostReasonId, month);
        return {
          counts: rows,
          refs: await lostReasonRefs(
            tx,
            scope.tenantId,
            rows.map((r) => r.reasonId),
          ),
        };
      },
      READ_ONLY,
    );

    const monthIndex = new Map(months.map((m, i) => [m, i]));
    const byReason = new Map<string | null, number[]>();
    for (const c of counts) {
      const i = monthIndex.get(c.month);
      if (i === undefined) continue;
      // A reason that no longer resolves counts with the deals that gave none, not as a second blank row.
      const key = c.reasonId !== null && refs.has(c.reasonId) ? c.reasonId : null;
      const line = byReason.get(key) ?? months.map(() => 0);
      line[i] = (line[i] ?? 0) + c.n;
      byReason.set(key, line);
    }

    const rows: LostReasonReportRow[] = [...byReason].map(([id, line]) => ({
      reason: id === null ? null : (refs.get(id) ?? null),
      counts: line,
      total: line.reduce((a, b) => a + b, 0),
    }));
    // Largest first; ties by label, and deals with no reason last.
    rows.sort(
      (a, b) =>
        b.total - a.total ||
        Number(a.reason === null) - Number(b.reason === null) ||
        (a.reason?.label ?? '').localeCompare(b.reason?.label ?? ''),
    );
    const monthTotals = months.map((_, i) => rows.reduce((sum, r) => sum + (r.counts[i] ?? 0), 0));
    return {
      from,
      to,
      months,
      rows,
      monthTotals,
      total: monthTotals.reduce((a, b) => a + b, 0),
    };
  }
}
