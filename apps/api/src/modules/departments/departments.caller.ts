// Request caller adapter for DepartmentsAdminService: reads scope, actor and principal from the
// request AsyncLocalStorage. Kept as an injectable class so tests can drive the service directly
// or through HTTP.
import { Injectable } from '@nestjs/common';

import { type Principal, principal } from '../../platform/authz/principal';
import { type Actor, requestTx, type TxScope } from '../../platform/db/tx';

@Injectable()
export class DepartmentsCaller {
  tx(): { scope: TxScope; actor: Actor } {
    return requestTx();
  }

  principal(): Principal {
    return principal();
  }
}
