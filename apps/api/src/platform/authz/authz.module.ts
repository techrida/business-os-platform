// Authz module (U1): the RoleCache (role -> permission/scope grants per org, keyed by authz_versions)
// and AuthzService (assert, scopeWhere, invalidate). Global, because every module that checks a record
// injects AuthzService. The pure can() and the decorators need no DI.
import { Global, Module } from '@nestjs/common';

import { AuthzService } from './authz.service';
import { RoleCache } from './role-cache';

@Global()
@Module({
  providers: [RoleCache, AuthzService],
  exports: [RoleCache, AuthzService],
})
export class AuthzModule {}
