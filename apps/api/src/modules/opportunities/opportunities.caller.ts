// Who is calling the opportunity routes, read from the request store. A class (not a bare function call inside
// the service) so tests can switch the caller without an HTTP request; same pattern as TestMemoCaller.
import { Injectable } from '@nestjs/common';

import { principal, type Principal } from '../../platform/authz/principal';
import { requestTx, type Actor, type TxScope } from '../../platform/db/tx';

export interface OpportunityCaller {
  scope: TxScope;
  actor: Actor;
  principal: Principal;
}

@Injectable()
export class OpportunitiesCaller {
  current(): OpportunityCaller {
    const { scope, actor } = requestTx();
    return { scope, actor, principal: principal() };
  }
}
