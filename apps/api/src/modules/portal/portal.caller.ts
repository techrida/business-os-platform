// Who is calling the customer portal routes, read from the request store. A class (not a bare function call inside
// the service) so tests can switch the caller without an HTTP request; same pattern as DraftingCaller.
// Serves the NFR "a customer sees only what we meant to show": the portal answers only customer principals that
// carry a party. A staff founder holds the portal permissions at `all`, and `scopeWhereFor` would then match every
// row of the entity, so PortalService runs `assertCustomerCaller` before any query, whatever caller it is given.
import { ForbiddenException, Injectable } from '@nestjs/common';

import { principal, type Principal } from '../../platform/authz/principal';
import { requestTx, type Actor } from '../../platform/db/tx';

/** 403 unless `p` is a customer portal principal with a party. Same body as AuthzService.assert. */
export function assertCustomerCaller(p: Principal): void {
  if (p.orgKind !== 'customer' || p.partyId === null || p.partyId === '') {
    throw new ForbiddenException({
      code: 'forbidden',
      message: 'Forbidden',
      reason: 'no_permission',
    });
  }
}

@Injectable()
export class PortalCaller {
  /** The current principal. PortalService checks it with assertCustomerCaller before it reads anything. */
  current(): Principal {
    return principal();
  }
}

/**
 * The actor withTx stamps on the audit row of a portal answer: the request's user (the principal's app.users id),
 * with its IP, user agent and correlation id. Its own class so the PA-2 read tests keep their one-method caller.
 */
@Injectable()
export class PortalTxActor {
  current(): Actor {
    return requestTx().actor;
  }
}
