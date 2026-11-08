// HTTP routes of the activities. Thin on purpose: parsing here, every rule in ActivitiesService. The routes carry
// @AnyAuthenticated, not @Can, because an activity takes the permission of its subject (a lead's activity needs
// crm.lead.*, a customer's needs customer.*): the service asserts that permission on the subject row, so the
// route is still deny-by-default.
import { CreateActivityBodySchema, type ActivityDto } from '@bos/contracts';
import { Body, Controller, Get, Headers, Post, Query } from '@nestjs/common';

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
}
