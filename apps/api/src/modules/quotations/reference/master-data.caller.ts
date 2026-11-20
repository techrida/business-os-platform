// The caller of the tax-code and payment-term Settings routes: the request's scope and actor, and the check that the
// caller may edit finance settings. A class so the integration test can name a tenant and grant without a request.
import { Injectable } from '@nestjs/common';

import { type Actor, requestTx, type TxScope } from '../../../platform/db/tx';
import { assertAnyOf, FINANCE_SETTINGS_EDITORS } from '../../../platform/settings/settings-access';

@Injectable()
export class MasterDataCaller {
  current(): { scope: TxScope; actor: Actor } {
    return requestTx();
  }

  /**
   * 403 unless the caller is active staff holding settings.finance.write (Finance, Accountant) or
   * admin.settings.write (the Founder): the people who open Settings > Tax and Saved terms (F1-Q49).
   */
  assertEditor(): void {
    assertAnyOf(FINANCE_SETTINGS_EDITORS);
  }
}
