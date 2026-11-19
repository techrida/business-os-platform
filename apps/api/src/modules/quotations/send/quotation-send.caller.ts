// Who is calling the send route, read from the request store. A class (not a bare function call inside the
// service) so tests can switch the caller without an HTTP request; same pattern as QuotationSubmitCaller.
import { Injectable } from '@nestjs/common';

import { principal, type Principal } from '../../../platform/authz/principal';
import { requestTx, type Actor, type TxScope } from '../../../platform/db/tx';

export interface QuotationSendCallerInfo {
  scope: TxScope;
  actor: Actor;
  /** Who is asking: the send answer carries the cost figures only for a caller who may read them. */
  principal: Principal;
}

@Injectable()
export class QuotationSendCaller {
  current(): QuotationSendCallerInfo {
    const { scope, actor } = requestTx();
    return { scope, actor, principal: principal() };
  }
}
