// Who is calling the import routes, read from the request store. A class so tests can switch the caller without an
// HTTP request (same pattern as CustomersCaller).
import { Injectable } from '@nestjs/common';

import { principal, type Principal } from '../../platform/authz/principal';
import { requestTx, type Actor, type TxScope } from '../../platform/db/tx';

export interface PartyImportsCallerInfo {
  scope: TxScope;
  actor: Actor;
  principal: Principal;
}

@Injectable()
export class PartyImportsCaller {
  current(): PartyImportsCallerInfo {
    const { scope, actor } = requestTx();
    return { scope, actor, principal: principal() };
  }
}
