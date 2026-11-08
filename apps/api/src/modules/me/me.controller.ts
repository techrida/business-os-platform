import type { MeResponse } from '@bos/contracts';
import { Controller, Get } from '@nestjs/common';

import { ctx } from '../../platform/tenancy/request-context';

@Controller('v1/me')
export class MeController {
  /** Who the caller is, straight from the request context (no database read of its own). */
  @Get()
  me(): MeResponse {
    const c = ctx();
    return {
      userId: c.userId,
      tenantId: c.tenantId,
      organizationId: c.organizationId,
      orgKind: c.orgKind,
      // Copy: the context's array is shared for the whole request, and a response body must not alias it.
      roles: [...c.roles],
      correlationId: c.correlationId,
    };
  }
}
