// Who is calling the payment routes, read from the request store. A class so the integration test can call the
// service with an explicit scope and actor instead of an HTTP request (same pattern as TestMemoCaller).
import { Injectable } from '@nestjs/common';

import { requestTx, type Actor, type TxScope } from '../../platform/db/tx';

@Injectable()
export class PaymentsCaller {
  current(): { scope: TxScope; actor: Actor } {
    return requestTx();
  }
}
