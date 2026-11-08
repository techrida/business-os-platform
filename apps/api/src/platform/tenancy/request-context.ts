import { AsyncLocalStorage } from 'node:async_hooks';

import type { OrgKind } from '@bos/contracts';

/**
 * Who is calling and for which tenant, for the lifetime of one HTTP request.
 * Business code reads it with `ctx()`; nothing passes it around by hand.
 */
export interface RequestContext {
  correlationId: string;
  tenantId: string;
  organizationId: string;
  orgKind: OrgKind;
  /** ZITADEL `sub`. */
  userId: string;
  roles: readonly string[];
  /** Token expiry as epoch seconds (the JWT `exp` claim). */
  tokenExp: number;
}

/** The part of the context that exists only after authentication and org resolution. */
export type RequestIdentity = Omit<RequestContext, 'correlationId'>;

/**
 * What the AsyncLocalStorage holds. It starts with only the correlation id (the middleware runs
 * before auth) and the TenancyInterceptor fills in `context` later. One mutable object per request
 * is deliberate: every later async step in the request sees the update.
 */
interface RequestStore {
  correlationId: string;
  context?: RequestContext;
}

const storage = new AsyncLocalStorage<RequestStore>();

/** Runs `fn` (and everything it awaits) inside a fresh request store. Used by the middleware and by tests. */
export function runWithRequestStore<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

/** Completes the current request's context once the caller is authenticated and their org is known. */
export function bindIdentity(identity: RequestIdentity): void {
  const store = storage.getStore();
  if (!store) {
    throw new Error(
      'bindIdentity() called outside a request: is CorrelationMiddleware registered?',
    );
  }
  store.context = { ...identity, correlationId: store.correlationId };
}

/**
 * The correlation id of the current request, available even before authentication.
 * Returns undefined outside a request. The error filter uses this so a 401 still carries an id.
 */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * The full request context. Throws outside a request, and on a route where no identity was bound
 * (a `@Public()` route): failing loudly beats guessing a tenant.
 */
export function ctx(): RequestContext {
  const store = storage.getStore();
  if (!store) {
    throw new Error('ctx() called outside a request');
  }
  if (!store.context) {
    throw new Error('ctx() called before the request was authenticated (public route?)');
  }
  return store.context;
}
