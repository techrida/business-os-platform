// HTTP routes of the leads. Thin on purpose: parsing here, every rule in LeadsService. Each route names its
// permission with @Can (route level); the service then checks the record itself (entity, own scope), so a
// salesperson cannot read a colleague's lead by guessing its id. POST /v1/leads/:id/convert is in
// convert/lead-convert.controller.ts.
import {
  CreateLeadBodySchema,
  type LeadDto,
  type LeadOwnerOption,
  LeadStageChangeBodySchema,
  UpdateLeadBodySchema,
} from '@bos/contracts';
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';

import { Can } from '../../platform/authz/decorators';
import { type HeaderTarget, setTotalCount } from '../../platform/list';
import { parseOr400 } from '../approvals/approvals.controller';
import { requireIdempotencyKey } from '../customers/customers.types';
import { LeadsService } from './leads.service';
import { LeadSummaryQuerySchema, ListLeadsQuerySchema, type LeadSummary } from './leads.types';

@Controller('v1/leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  /** 200 with a bare array of LeadDto, newest first; X-Total-Count is all matches, not just this page. */
  @Get()
  @Can('crm.lead.read')
  async list(
    @Query() query: unknown,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<LeadDto[]> {
    const { rows, total } = await this.leads.list(parseOr400(ListLeadsQuerySchema, query));
    setTotalCount(res, total);
    return rows;
  }

  /**
   * 200 with the lead count per stage under the list's scope, search and filters (but no stage filter). Declared
   * before ':id' so that "summary" is not read as an id.
   */
  @Get('summary')
  @Can('crm.lead.read')
  summary(@Query() query: unknown): Promise<LeadSummary> {
    return this.leads.summary(parseOr400(LeadSummaryQuerySchema, query));
  }

  /**
   * 200 with the LeadOwnerOption[] the caller may hand a lead to: just the caller for an `own` grant. Declared before
   * ':id' so "owners" is never read as an id.
   */
  @Get('owners')
  @Can('crm.lead.write')
  owners(): Promise<LeadOwnerOption[]> {
    return this.leads.owners();
  }

  /** 200 with the LeadDto. 404 for a record of another entity or outside the caller's scope. */
  @Get(':id')
  @Can('crm.lead.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<LeadDto> {
    return this.leads.get(id);
  }

  /** 201 with the new LeadDto, numbered from the LD series. An Idempotency-Key, when sent, makes a retry safe. */
  @Post()
  @Can('crm.lead.write')
  create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<LeadDto> {
    const key = idempotencyKey === undefined ? undefined : requireIdempotencyKey(idempotencyKey);
    return this.leads.create(parseOr400(CreateLeadBodySchema, body), key);
  }

  /**
   * 200 with the edited LeadDto; only the fields sent change. 404 out of scope, 409 stale version, 400 for a
   * converted lead, an edit that changes nothing or an owner who is not a user of the tenant, 403 for an owner the
   * caller's grant does not reach (an `own` grant cannot hand the lead to someone else).
   */
  @Patch(':id')
  @Can('crm.lead.write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<LeadDto> {
    return this.leads.update(id, parseOr400(UpdateLeadBodySchema, body));
  }

  /**
   * 200 with the updated LeadDto. 400 for converted or a missing reason and note, 409 for a stale version or a
   * move the stage machine does not have.
   */
  @Patch(':id/stage')
  @Can('crm.lead.write')
  changeStage(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<LeadDto> {
    return this.leads.changeStage(id, parseOr400(LeadStageChangeBodySchema, body));
  }
}
