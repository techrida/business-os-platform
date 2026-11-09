// Who is calling the vendor bill routes, read from the request store. A class (not a bare function call inside the
// service) so tests can switch the caller without an HTTP request; same pattern as PurchaseOrdersCaller.
import { Injectable } from '@nestjs/common';

import { principal, type Principal } from '../../../platform/authz/principal';
import { requestTx, type Actor, type TxScope } from '../../../platform/db/tx';

export interface VendorBillsCallerInfo {
  scope: TxScope;
  actor: Actor;
  principal: Principal;
}

@Injectable()
export class VendorBillsCaller {
  current(): VendorBillsCallerInfo {
    const { scope, actor } = requestTx();
    return { scope, actor, principal: principal() };
  }
}
