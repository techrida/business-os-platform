// Who is calling the sales order routes, read from the request store. A class (not a bare function call inside
// the service) so tests can switch the caller without an HTTP request. Same pattern as DraftingCaller.
// Serves the NFR "every change is audited": the actor that withTx() stamps on the audit row is the app.users id
// of this principal.
import { Injectable } from '@nestjs/common';

import { principal, type Principal } from '../../platform/authz/principal';
import { requestTx, type Actor, type TxScope } from '../../platform/db/tx';

export interface SalesOrdersCallerInfo {
  scope: TxScope;
  actor: Actor;
  principal: Principal;
}

@Injectable()
export class SalesOrdersCaller {
  current(): SalesOrdersCallerInfo {
    const { scope, actor } = requestTx();
    return { scope, actor, principal: principal() };
  }
}
