// The owner change route of an opportunity (F1-Q51). A controller of its own so the change's dependencies (role
// grants, notices) stay out of the read and stage routes.
import { OpportunityOwnerChangeBodySchema, type OpportunityDto } from '@bos/contracts';
import { Body, Controller, Param, ParseUUIDPipe, Patch } from '@nestjs/common';

import { Can } from '../../platform/authz/decorators';
import { parseOr400 } from '../approvals/approvals.controller';
import { OpportunityOwnerChangeService } from './opportunity-owner-change.service';

@Controller('v1/opportunities')
export class OpportunityOwnerChangeController {
  constructor(private readonly ownerChange: OpportunityOwnerChangeService) {}

  /**
   * 200 with the updated OpportunityDto. 404 outside the caller's write scope, 409 for a stale version, 400 for a
   * won or lost deal, the same owner, or a person the assignment rule refuses (`details.assignmentReason`).
   */
  @Patch(':id/owner')
  @Can('crm.opportunity.write')
  changeOwner(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<OpportunityDto> {
    return this.ownerChange.changeOwner(id, parseOr400(OpportunityOwnerChangeBodySchema, body));
  }
}
