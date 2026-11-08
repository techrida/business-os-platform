// Who is calling the portal-access route, read from the request store. A class so tests can switch the caller
// without an HTTP request (same pattern as CustomersCaller). The actor is the staff user the audit rows name.
import { Injectable } from '@nestjs/common';

import { principal, type Principal } from '../../platform/authz/principal';
import { requestTx, type Actor, type TxScope } from '../../platform/db/tx';

export interface PortalAccessCallerInfo {
  scope: TxScope;
  actor: Actor;
  principal: Principal;
}

@Injectable()
export class PortalAccessCaller {
  current(): PortalAccessCallerInfo {
    const { scope, actor } = requestTx();
    return { scope, actor, principal: principal() };
  }
}
