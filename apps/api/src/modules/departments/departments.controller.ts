// HTTP routes for the Departments admin API (/v1/admin/departments, U20b / US-106).
// Thin controller: validates input via Zod contracts and delegates every rule to
// DepartmentsAdminService.
//
// Route ordering note: `GET unassigned` MUST stay before `GET :id` so Express does not hand the
// literal segment "unassigned" to ParseUUIDPipe.
//
// Authz:
// - Read routes carry `@AnyAuthenticated()` and the service enforces staff + (`admin.users.read`
//   OR `admin.roles.read`), because `@Can()` only checks a single permission.
// - Write routes carry `@Can('admin.roles.write')` (and the service asserts staff + write too).
import {
  type AdminDepartmentDetail,
  type AdminDepartmentList,
  AdminDepartmentsQuerySchema,
  CreateDepartmentBodySchema,
  RenameDepartmentBodySchema,
  RestoreDepartmentBodySchema,
  RetireDepartmentBodySchema,
  UnassignedPeopleQuerySchema,
  type UnassignedPeopleResponse,
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
  Query,
} from '@nestjs/common';

import { AnyAuthenticated, Can } from '../../platform/authz/decorators';
import { parseOr400 } from '../approvals/approvals.controller';
import { DepartmentsAdminService } from './departments.service';

@Controller('v1/admin/departments')
export class DepartmentsAdminController {
  constructor(private readonly departments: DepartmentsAdminService) {}

  /** 200 with `{ items, unassigned }`. Defaults to `status=active` when no status filter is sent. */
  @Get()
  @AnyAuthenticated()
  list(@Query() query: unknown): Promise<AdminDepartmentList> {
    return this.departments.list(parseOr400(AdminDepartmentsQuerySchema, query));
  }

  /** 200 with active staff in this legal entity who belong to no department. Declared before `:id`. */
  @Get('unassigned')
  @AnyAuthenticated()
  listUnassigned(@Query() query: unknown): Promise<UnassignedPeopleResponse> {
    return this.departments.listUnassigned(parseOr400(UnassignedPeopleQuerySchema, query));
  }

  /** 200 with department detail, active members, version and entity access revision. 404 unknown/other entity. */
  @Get(':id')
  @AnyAuthenticated()
  getById(@Param('id', ParseUUIDPipe) id: string): Promise<AdminDepartmentDetail> {
    return this.departments.getById(id);
  }

  /** 201 with the newly created department. 422 on duplicate active name or invalid headUserId. */
  @Post()
  @Can('admin.roles.write')
  create(@Body() body: unknown): Promise<AdminDepartmentDetail> {
    return this.departments.create(parseOr400(CreateDepartmentBodySchema, body));
  }

  /** 200 with the renamed department. 404 unknown, 409 stale expectedVersion, 422 duplicate active name. */
  @Patch(':id')
  @Can('admin.roles.write')
  rename(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<AdminDepartmentDetail> {
    return this.departments.rename(id, parseOr400(RenameDepartmentBodySchema, body));
  }

  /**
   * 200 with the retired department. Requires `moveMembersTo` (target active department id or
   * explicit `null`) when active members remain. 409 on stale expectedVersion.
   */
  @Post(':id/retire')
  @HttpCode(200)
  @Can('admin.roles.write')
  retire(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<AdminDepartmentDetail> {
    return this.departments.retire(id, parseOr400(RetireDepartmentBodySchema, body));
  }

  /** 200 with the restored department. 409 stale expectedVersion, 422 if another active dept has the same name. */
  @Post(':id/restore')
  @HttpCode(200)
  @Can('admin.roles.write')
  restore(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<AdminDepartmentDetail> {
    return this.departments.restore(id, parseOr400(RestoreDepartmentBodySchema, body));
  }
}
