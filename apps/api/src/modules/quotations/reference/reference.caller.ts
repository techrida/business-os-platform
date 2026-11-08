// The tenant of the request, read from the request store. A class (not a bare function call inside the service)
// so tests can switch the tenant without an HTTP request; same pattern as ActivitiesCaller. Tax codes and payment
// terms are tenant-level (ADR 0027 section 6), so the tenant is all the service needs.
import { Injectable } from '@nestjs/common';

import { requestTx } from '../../../platform/db/tx';

@Injectable()
export class ReferenceCaller {
  tenantId(): string {
    return requestTx().scope.tenantId;
  }
}
