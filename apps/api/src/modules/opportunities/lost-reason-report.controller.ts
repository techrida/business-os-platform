// The lost-deal report route. Gated like the opportunity list (crm.opportunity.read at the route, 403 without it);
// the service counts only the deals the caller may read.
import { type LostReasonReport, LostReasonReportQuerySchema } from '@bos/contracts';
import { Controller, Get, Query } from '@nestjs/common';

import { Can } from '../../platform/authz/decorators';
import { parseOr400 } from '../approvals/approvals.controller';
import { LostReasonReportService } from './lost-reason-report.service';

@Controller('v1/opportunities/reports')
export class LostReasonReportController {
  constructor(private readonly report: LostReasonReportService) {}

  /**
   * 200 with the LostReasonReport: counts of deals now Lost, by reason and month lost. `from` and `to` are months
   * (YYYY-MM, both inclusive; default the last 12 months). 400 for a bad month, `from` after `to`, or over 60 months.
   */
  @Get('lost-reasons')
  @Can('crm.opportunity.read')
  lostReasons(@Query() query: unknown): Promise<LostReasonReport> {
    return this.report.lostReasons(parseOr400(LostReasonReportQuerySchema, query));
  }
}
