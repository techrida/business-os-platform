// Admin HTTP routes for approvals: workflow definitions and versions, approval groups and members,
// and delegations. Thin: bodies are validated here (specs with WorkflowSpecSchema, inside the service),
// the rules live in ApprovalsAdminService. Serves the NFR "authorization is deny-by-default": every
// route names the permission it needs.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';

import { Can } from '../../platform/authz/decorators';
import { ApprovalsAdminService, type WorkflowDto, type WorkflowVersionDto } from './admin.service';
import { parseOr400 } from './approvals.controller';

const PeopleQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  after: z.uuid().optional(),
});

const KEY = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]{0,63}$/, 'lowercase letters, digits, _ . - (max 64)');

const CreateWorkflowSchema = z.strictObject({
  key: KEY,
  name: z.string().trim().min(1).max(200),
  spec: z.unknown(),
});
const AddVersionSchema = z.strictObject({ spec: z.unknown() });
const CreateGroupSchema = z.strictObject({ key: KEY, name: z.string().trim().min(1).max(200) });
const AddMemberSchema = z.strictObject({ userId: z.uuid() });
const CreateDelegationSchema = z.strictObject({
  fromUserId: z.uuid(),
  toUserId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  documentType: z.string().min(1).max(64).nullable().default(null),
});

@Controller('v1/admin/workflows')
export class AdminWorkflowsController {
  constructor(private readonly admin: ApprovalsAdminService) {}

  @Get('people')
  @Can('approvals.definitions.write')
  people(@Query() query: unknown) {
    return this.admin.listAssignmentPeople(parseOr400(PeopleQuery, query));
  }

  @Get()
  @Can('approvals.definitions.read')
  list(): Promise<WorkflowDto[]> {
    return this.admin.listWorkflows();
  }

  @Post()
  @Can('approvals.definitions.write')
  create(@Body() body: unknown): Promise<WorkflowVersionDto> {
    return this.admin.createWorkflow(parseOr400(CreateWorkflowSchema, body));
  }

  @Post(':key/versions')
  @Can('approvals.definitions.write')
  addVersion(@Param('key') key: string, @Body() body: unknown): Promise<WorkflowVersionDto> {
    return this.admin.addVersion(key, parseOr400(AddVersionSchema, body).spec);
  }

  /** 200 with the published version. 403 to whoever saved that draft: a second person publishes (F1-Q11). */
  @Post(':key/versions/:v/publish')
  @HttpCode(200)
  @Can('approvals.definitions.publish')
  publish(
    @Param('key') key: string,
    @Param('v', ParseIntPipe) v: number,
  ): Promise<WorkflowVersionDto> {
    return this.admin.publish(key, v);
  }
}

@Controller('v1/admin/approval-groups')
export class AdminApprovalGroupsController {
  constructor(private readonly admin: ApprovalsAdminService) {}

  @Get('people')
  @Can('approvals.groups.write')
  people(@Query() query: unknown) {
    return this.admin.listAssignmentPeople(parseOr400(PeopleQuery, query));
  }

  @Get()
  @Can('approvals.groups.write')
  list() {
    return this.admin.listGroups();
  }

  @Post()
  @Can('approvals.groups.write')
  create(@Body() body: unknown): Promise<{ id: string }> {
    return this.admin.createGroup(parseOr400(CreateGroupSchema, body));
  }

  @Delete(':id')
  @HttpCode(204)
  @Can('approvals.groups.write')
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.admin.deleteGroup(id);
  }

  @Post(':id/members')
  @HttpCode(204)
  @Can('approvals.groups.write')
  addMember(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    return this.admin.addMember(id, parseOr400(AddMemberSchema, body).userId);
  }

  @Delete(':id/members/:userId')
  @HttpCode(204)
  @Can('approvals.groups.write')
  removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    return this.admin.removeMember(id, userId);
  }
}

@Controller('v1/admin/delegations')
export class AdminDelegationsController {
  constructor(private readonly admin: ApprovalsAdminService) {}

  @Get('people')
  @Can('approvals.delegations.write')
  people(@Query() query: unknown) {
    return this.admin.listAssignmentPeople(parseOr400(PeopleQuery, query));
  }

  @Get()
  @Can('approvals.delegations.write')
  list() {
    return this.admin.listDelegations();
  }

  @Post()
  @Can('approvals.delegations.write')
  create(@Body() body: unknown): Promise<{ id: string }> {
    const b = parseOr400(CreateDelegationSchema, body);
    return this.admin.createDelegation({
      ...b,
      startsAt: new Date(b.startsAt),
      endsAt: new Date(b.endsAt),
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @Can('approvals.delegations.write')
  revoke(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.admin.revokeDelegation(id);
  }
}
