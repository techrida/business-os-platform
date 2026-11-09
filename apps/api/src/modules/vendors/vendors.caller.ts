// Who is calling the vendors routes, read from the request store. A class so tests can switch the caller without
// an HTTP request (same pattern as CustomersCaller). The actor withTx() stamps on the audit row is the app.users
// id of this principal, which is also what vendors.created_by and approved_by hold.
import { Injectable } from '@nestjs/common';

import { principal, type Principal } from '../../platform/authz/principal';
import { requestTx, type Actor, type TxScope } from '../../platform/db/tx';

export interface VendorsCallerInfo {
  scope: TxScope;
  actor: Actor;
  principal: Principal;
}

@Injectable()
export class VendorsCaller {
  current(): VendorsCallerInfo {
    const { scope, actor } = requestTx();
    return { scope, actor, principal: principal() };
  }
}
