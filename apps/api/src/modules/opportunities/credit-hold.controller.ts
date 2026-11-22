// The credit hold routes of a deal (F1-Q20, F1-Q26), for holders of `credit.override` only. A controller of its own:
// the reads and writes of the deal itself stay under the opportunity grants.
import { CreditOverrideBodySchema, type CreditHoldDto } from '@bos/contracts';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { Can } from '../../platform/authz/decorators';
import { parseOr400 } from '../approvals/approvals.controller';
import { CreditHoldService } from './credit-hold.service';

@Controller('v1/opportunities')
export class CreditHoldController {
  constructor(private readonly credit: CreditHoldService) {}

  /** 200 with the CreditHoldDto (NPR limit, exposure, held, override). 404 for a deal of another entity. */
  @Get(':id/credit-hold')
  @Can('credit.override')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<CreditHoldDto> {
    return this.credit.get(id);
  }

  /**
   * 200 with the CreditHoldDto after the override (or as it was, when already overridden for that version and
   * value). 400 without a reason, a quotation version id or an order value (R5 FU10); 404 for a deal of another
   * entity or a version of another deal; 409 when the version is not accepted or already ordered, when the deal is not
   * on credit hold for it, or when the order is worth something else now.
   */
  @Post(':id/credit-override')
  @Can('credit.override')
  override(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<CreditHoldDto> {
    return this.credit.override(id, parseOr400(CreditOverrideBodySchema, body));
  }
}
