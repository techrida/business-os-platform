import { SetMetadata } from '@nestjs/common';

/** Metadata key the AuthGuard reads to find routes that need no token. */
export const IS_PUBLIC_KEY = 'bos:isPublic';

/**
 * Marks a route (or a whole controller) as reachable without a token.
 *
 * The AuthGuard is global and denies by default, so this decorator is the only way to open a
 * route. In P0 only the health routes use it; the e2e route sweep asserts exactly that.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
