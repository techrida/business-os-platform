// Who is calling the customers routes, read from the request store. A class (not a bare function call inside
// the service) so tests can switch the caller without an HTTP request. Same pattern as TestMemoCaller.
// Serves the NFR "every change is audited": the actor that withTx() stamps on the audit row is the app.users id
// of this principal.
import { Injectable } from '@nestjs/common';

import { principal, type Principal } from '../../platform/authz/principal';
import { requestTx, type Actor, type TxScope } from '../../platform/db/tx';

export interface CustomersCallerInfo {
  scope: TxScope;
  actor: Actor;
  principal: Principal;
}

@Injectable()
export class CustomersCaller {
  current(): CustomersCallerInfo {
    const { scope, actor } = requestTx();
    return { scope, actor, principal: principal() };
  }
}
