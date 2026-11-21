// GET /v1/leads/duplicates: the new-lead form's duplicate hint (F1-Q54 a). Its own controller so LeadsController's
// constructor (and the tests that build it) stay as they are. LeadsModule lists it BEFORE LeadsController: Express
// matches routes in registration order, and LeadsController's GET ':id' (ParseUUIDPipe) would otherwise answer
// "duplicates" with a 400.
import { LeadDuplicatesQuerySchema, type LeadDuplicatesResponse } from '@bos/contracts';
import { Controller, Get, Query } from '@nestjs/common';

import { Can } from '../../platform/authz/decorators';
import { parseOr400 } from '../approvals/approvals.controller';
import { LeadDuplicatesService } from './lead-duplicates.service';

@Controller('v1/leads')
export class LeadDuplicatesController {
  constructor(private readonly duplicates: LeadDuplicatesService) {}

  /**
   * 200 with `{ matches }`: up to 5 leads and customers the caller may read that look like the lead being typed
   * (`?company=&name=&email=&phone=`). Gated like the form's other helper (GET owners): whoever may create a lead.
   * Lead matches still need the caller's lead read scope and customer matches their customer read scope, so a kind
   * they cannot read is absent. Never blocks a save; fields under 3 characters (phone under 7 digits) are ignored.
   */
  @Get('duplicates')
  @Can('crm.lead.write')
  async find(@Query() query: unknown): Promise<LeadDuplicatesResponse> {
    return {
      matches: await this.duplicates.find(parseOr400(LeadDuplicatesQuerySchema, query)),
    };
  }
}
