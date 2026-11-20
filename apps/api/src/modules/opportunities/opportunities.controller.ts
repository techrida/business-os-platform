// HTTP routes of the opportunities. Thin on purpose: parsing here, every rule in OpportunitiesService. Each
// route names its permission with @Can (route level); the service then checks the record itself (entity,
// own scope), so a salesperson cannot read a colleague's deal by guessing its id.
import {
  type LeadOwnerOption,
  OpportunityStageChangeBodySchema,
  type OpportunityDto,
} from '@bos/contracts';
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Can } from '../../platform/authz/decorators';
import { setTotalCount } from '../../platform/list';
import { parseOr400 } from '../approvals/approvals.controller';
import { OpportunitiesService } from './opportunities.service';
import { ListOpportunitiesQuerySchema } from './opportunities.types';
import { OpportunityOwnersService } from './opportunity-owners.service';

@Controller('v1/opportunities')
export class OpportunitiesController {
  constructor(
    private readonly opportunities: OpportunitiesService,
    private readonly owners: OpportunityOwnersService,
  ) {}

  /** 200 with a bare array of OpportunityDto, newest first; X-Total-Count is all matches, not just this page. */
  @Get()
  @Can('crm.opportunity.read')
  async list(
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OpportunityDto[]> {
    const { items, total } = await this.opportunities.list(
      parseOr400(ListOpportunitiesQuerySchema, query),
    );
    setTotalCount(res, total);
    return items;
  }

  /**
   * 200 with the LeadOwnerOption[] the list's Owner filter offers: the owners of opportunities the caller can read
   * and the people they may hand an opportunity's work to, without addresses (`email` is empty). Needs only read,
   * so every role that sees the list gets the filter. Declared before ':id' so "owner-filter" is never read as an id.
   */
  @Get('owner-filter')
  @Can('crm.opportunity.read')
  ownerFilter(): Promise<LeadOwnerOption[]> {
    return this.owners.ownerFilter();
  }

  /**
   * 200 with the LeadOwnerOption[] a deal may be handed to (F1-Q51): exactly whom PATCH :id/owner accepts, without
   * addresses. Needs write, as the change does. Declared before ':id' so "owners" is never read as an id.
   */
  @Get('owners')
  @Can('crm.opportunity.write')
  ownerOptions(): Promise<LeadOwnerOption[]> {
    return this.owners.owners();
  }

  /**
   * 200 with the LeadOwnerOption[] a follow-up on a deal may be assigned to: the owner select's rule, but reading
   * opportunities is enough, as the follow-up's own check asks. Needs write, as scheduling one does. Declared
   * before ':id'.
   */
  @Get('follow-up-assignees')
  @Can('crm.opportunity.write')
  followUpAssignees(): Promise<LeadOwnerOption[]> {
    return this.owners.followUpAssignees();
  }

  /** 200 with the OpportunityDto. 404 for a record of another entity or outside the caller's scope. */
  @Get(':id')
  @Can('crm.opportunity.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<OpportunityDto> {
    return this.opportunities.get(id);
  }

  /**
   * 200 with the updated OpportunityDto. 400 for won, quotation_sent or a missing reason and note, 409 for a
   * stale version or a move the stage machine does not have.
   */
  @Patch(':id/stage')
  @Can('crm.opportunity.write')
  changeStage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<OpportunityDto> {
    return this.opportunities.changeStage(id, parseOr400(OpportunityStageChangeBodySchema, body));
  }
}
