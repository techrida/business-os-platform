// Who is calling the company account routes, read from the request store. A class so tests can switch the caller
// without an HTTP request; same pattern as PurchaseRequestsCaller.
import { Injectable } from '@nestjs/common';

import { principal, type Principal } from '../../platform/authz/principal';
import { requestTx, type Actor, type TxScope } from '../../platform/db/tx';

export interface CompanyAccountsCallerInfo {
  scope: TxScope;
  actor: Actor;
  principal: Principal;
}

@Injectable()
export class CompanyAccountsCaller {
  current(): CompanyAccountsCallerInfo {
    const { scope, actor } = requestTx();
    return { scope, actor, principal: principal() };
  }
}
