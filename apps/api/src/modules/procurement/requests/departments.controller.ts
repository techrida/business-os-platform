// HTTP route of the departments lookup (P4 unit P2e): the purchase request form's department picker. Carries
// @AnyAuthenticated, not @Can, because no permission names "may fill in a purchase request form" for every
// requester role; DepartmentsService answers 403 unless the caller is active staff, and the list is the acting
// entity's only.
import { Controller, Get } from '@nestjs/common';

import { AnyAuthenticated } from '../../../platform/authz/decorators';
import { DepartmentsService, type DepartmentLookupItem } from './departments.service';

@Controller('v1/departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  /** The acting entity's departments as `{ id, name }`, ordered by name. 403 for a portal or inactive caller. */
  @Get()
  @AnyAuthenticated()
  list(): Promise<DepartmentLookupItem[]> {
    return this.departments.list();
  }
}
