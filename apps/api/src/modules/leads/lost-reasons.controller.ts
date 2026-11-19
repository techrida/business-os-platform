// HTTP routes of the lead lost reasons (D49). Thin: parsing here, every rule in LeadLostReasonsService.
// - GET /v1/lead-lost-reasons: the options the Mark lost dialog offers (retired ones left out); crm.lead.write, the
//   permission of the stage change itself. A new option is added through the stage change (`newLostReason`).
// - /v1/admin/lead-lost-reasons: the Founder's Settings card (admin.settings.write): every option, add, rename and
//   retire, reorder, and reset to the defaults.
import {
  CreateLeadLostReasonBodySchema,
  type LeadLostReason,
  ReorderLeadLostReasonsBodySchema,
  UpdateLeadLostReasonBodySchema,
} from '@bos/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';

import { Can } from '../../platform/authz/decorators';
import { parseOr400 } from '../approvals/approvals.controller';
import { LeadLostReasonsService } from './lost-reasons.service';

@Controller('v1')
export class LeadLostReasonsController {
  constructor(private readonly reasons: LeadLostReasonsService) {}

  /** 200 with a bare array of LeadLostReason, in the list's order, without retired options. */
  @Get('lead-lost-reasons')
  @Can('crm.lead.write')
  choices(): Promise<LeadLostReason[]> {
    return this.reasons.choices();
  }

  /** 200 with every option, retired ones included. */
  @Get('admin/lead-lost-reasons')
  @Can('admin.settings.write')
  listAll(): Promise<LeadLostReason[]> {
    return this.reasons.listAll();
  }

  /** 201 with the new option, at the end of the list. 409 when its words are already an option. */
  @Post('admin/lead-lost-reasons')
  @Can('admin.settings.write')
  create(@Body() body: unknown): Promise<LeadLostReason> {
    return this.reasons.create(parseOr400(CreateLeadLostReasonBodySchema, body));
  }

  /** 200 with the whole list in its new order. 400 unless the ids are every option exactly once. */
  @Put('admin/lead-lost-reasons/order')
  @Can('admin.settings.write')
  reorder(@Body() body: unknown): Promise<LeadLostReason[]> {
    return this.reasons.reorder(parseOr400(ReorderLeadLostReasonsBodySchema, body));
  }

  /** 200 with the whole list back at the defaults (D32). */
  @Post('admin/lead-lost-reasons/reset')
  @HttpCode(200)
  @Can('admin.settings.write')
  reset(): Promise<LeadLostReason[]> {
    return this.reasons.reset();
  }

  /** 200 with the edited option. 404 unknown, 409 stale version or a label already in use. */
  @Patch('admin/lead-lost-reasons/:id')
  @Can('admin.settings.write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<LeadLostReason> {
    return this.reasons.update(id, parseOr400(UpdateLeadLostReasonBodySchema, body));
  }
}
