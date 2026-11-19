import type { MeResponse } from '@bos/contracts';
import { users } from '@bos/db';
import { Controller, Get, Inject } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { AnyAuthenticated } from '../../platform/authz/decorators';
import { DB, type Db } from '../../platform/db/db.module';
import { ctx, currentPrincipal } from '../../platform/tenancy/request-context';

// Any signed-in user may ask who they are; the tenancy interceptor refuses unmarked routes.
@AnyAuthenticated()
@Controller('v1/me')
export class MeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Who the caller is, from the request context, plus their own picture pointer. */
  @Get()
  async me(): Promise<MeResponse> {
    const c = ctx();
    return {
      userId: c.userId,
      tenantId: c.tenantId,
      organizationId: c.organizationId,
      orgKind: c.orgKind,
      partyId: c.partyId,
      // Copy: the context's array is shared for the whole request, and a response body must not alias it.
      roles: [...c.roles],
      correlationId: c.correlationId,
      id: currentPrincipal()?.userId ?? null,
      avatarDocumentId: await this.avatarOf(c.tenantId),
    };
  }

  /** The caller's own row only (`app.users.id` from the principal, in the context's tenant). */
  private async avatarOf(tenantId: string): Promise<string | null> {
    const appUserId = currentPrincipal()?.userId;
    if (!appUserId) return null;
    const [row] = await this.db
      .select({ avatarDocumentId: users.avatarDocumentId })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, appUserId)))
      .limit(1);
    return row?.avatarDocumentId ?? null;
  }
}
