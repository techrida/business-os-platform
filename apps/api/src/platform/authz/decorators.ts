// Route-level permission markers. The tenancy interceptor reads them after binding the principal,
// and the e2e route sweep checks every protected route has one. A route with neither is refused:
// that is the NFR "authorization is deny-by-default" (P1 plan §6.2, finding 3).
import { PERMISSIONS, type Permission } from '@bos/contracts';
import { SetMetadata } from '@nestjs/common';

/** Metadata key holding the `Permission` a route needs. Read with `Reflector.getAllAndOverride`. */
export const CAN_KEY = 'bos:can';

/** Metadata key set to `true` on routes open to any signed-in, active user of the org. */
export const ANY_AUTHENTICATED_KEY = 'bos:anyAuthenticated';

const KNOWN: ReadonlySet<string> = new Set(PERMISSIONS);

/**
 * The route needs `action`. On a class it covers every handler; a method-level `@Can` overrides it.
 * The check is route-level (the grant alone decides); record scope is checked with `authz.assert()`.
 */
export const Can = (action: Permission): MethodDecorator & ClassDecorator => {
  // The type already limits `action`, but a cast or plain JS could slip a typo through, and a
  // typo would name a permission nobody holds. Fail when the module loads instead.
  if (!KNOWN.has(action)) {
    throw new Error(`@Can(): unknown permission ${JSON.stringify(action)}`);
  }
  return SetMetadata(CAN_KEY, action);
};

/** The route needs no particular permission, only an active principal (for example `/v1/me`). */
export const AnyAuthenticated = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ANY_AUTHENTICATED_KEY, true);
