// HTTP routes of the opportunities. Thin on purpose: parsing here, every rule in OpportunitiesService. Each
// route names its permission with @Can (route level); the service then checks the record itself (entity,
// own scope), so a salesperson cannot read a colleague's deal by guessing its id.
import { OpportunityStageChangeBodySchema, type OpportunityDto } from '@bos/contracts';
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Can } from '../../platform/authz/decorators';
import { setTotalCount } from '../../platform/list';
import { parseOr400 } from '../approvals/approvals.controller';
import { OpportunitiesService } from './opportunities.service';
import { ListOpportunitiesQuerySchema } from './opportunities.types';

@Controller('v1/opportunities')
export class OpportunitiesController {
  constructor(private readonly opportunities: OpportunitiesService) {}

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
