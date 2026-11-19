// HTTP routes of the activities. Thin on purpose: parsing here, every rule in ActivitiesService. The routes carry
// @AnyAuthenticated, not @Can, because an activity takes the permission of its subject (a lead's activity needs
// crm.lead.*, a customer's needs customer.*): the service asserts that permission on the subject row, so the
// route is still deny-by-default.
import {
  CancelActivityBodySchema,
  CompleteActivityBodySchema,
  CreateActivityBodySchema,
  RescheduleActivityBodySchema,
  type ActivityDto,
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
} from '@nestjs/common';

import { AnyAuthenticated } from '../../platform/authz/decorators';
import { parseOr400 } from '../approvals/approvals.controller';
import { requireIdempotencyKey } from '../customers/customers.types';
import { ActivitiesService } from './activities.service';
import { ListActivitiesQuerySchema } from './activities.types';

@Controller('v1/activities')
export class ActivitiesController {
  constructor(private readonly activities: ActivitiesService) {}

  /** 200 with a bare array of ActivityDto, latest first. 404 when the named subject is out of the caller's reach. */
  @Get()
  @AnyAuthenticated()
  list(@Query() query: unknown): Promise<ActivityDto[]> {
    return this.activities.list(parseOr400(ListActivitiesQuerySchema, query));
  }

  /** 201 with the new ActivityDto. 400 unless exactly one subject is named; 404 for a subject out of reach. */
  @Post()
  @AnyAuthenticated()
  create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<ActivityDto> {
    const key = idempotencyKey === undefined ? undefined : requireIdempotencyKey(idempotencyKey);
    return this.activities.create(parseOr400(CreateActivityBodySchema, body), key);
  }

  /**
   * 200 with the completed (now logged) ActivityDto. 404 when the activity or its subject is out of reach;
   * 409 when it is not planned, is written by the system, or `expectedVersion` is stale.
   */
  @Patch(':id/complete')
  @AnyAuthenticated()
  complete(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<ActivityDto> {
    return this.activities.complete(id, parseOr400(CompleteActivityBodySchema, body));
  }

  /** 200 with the rescheduled ActivityDto; 400 for an assignee outside the tenant; 404 and 409 as complete. */
  @Patch(':id/reschedule')
  @AnyAuthenticated()
  reschedule(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<ActivityDto> {
    return this.activities.reschedule(id, parseOr400(RescheduleActivityBodySchema, body));
  }

  /** 200 with the cancelled ActivityDto, which no list shows again; 404 and 409 as complete. */
  @Patch(':id/cancel')
  @AnyAuthenticated()
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<ActivityDto> {
    return this.activities.cancel(id, parseOr400(CancelActivityBodySchema, body));
  }
}
