import { AsyncLocalStorage } from 'node:async_hooks';

import type { OrgKind } from '@bos/contracts';

import type { Principal } from '../authz/principal';

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
  /** Client address as Express sees it (`req.ip`), truncated to 512 characters; null when absent. */
  ip: string | null;
  /** The `user-agent` header, truncated to 512 characters; null when absent. */
  userAgent: string | null;
}

/**
 * The part of the context that exists only after authentication and org resolution. `ip` and
 * `userAgent` are known from the start (the middleware sets them), so callers of `bindIdentity`
 * do not pass them.
 */
export type RequestIdentity = Omit<RequestContext, 'correlationId' | 'ip' | 'userAgent'>;

/** Client details the middleware captures when it opens the store. */
export interface RequestClientInfo {
  ip: string | null;
  userAgent: string | null;
}

/**
 * What the AsyncLocalStorage holds. It starts with only the correlation id (the middleware runs
 * before auth) and the TenancyInterceptor fills in `context` later. One mutable object per request
 * is deliberate: every later async step in the request sees the update.
 */
interface RequestStore {
  correlationId: string;
  ip: string | null;
  userAgent: string | null;
  context?: RequestContext;
  principal?: Principal;
}

const storage = new AsyncLocalStorage<RequestStore>();

/**
 * Runs `fn` (and everything it awaits) inside a fresh request store. Used by the middleware and by
 * tests. `client` is optional; `ip` and `userAgent` default to null.
 */
export function runWithRequestStore<T>(
  correlationId: string,
  fn: () => T,
  client?: Partial<RequestClientInfo>,
): T {
  return storage.run(
    { correlationId, ip: client?.ip ?? null, userAgent: client?.userAgent ?? null },
    fn,
  );
}

/** Completes the current request's context once the caller is authenticated and their org is known. */
export function bindIdentity(identity: RequestIdentity): void {
  const store = storage.getStore();
  if (!store) {
    throw new Error(
      'bindIdentity() called outside a request: is CorrelationMiddleware registered?',
    );
  }
  store.context = {
    ...identity,
    correlationId: store.correlationId,
    ip: store.ip,
    userAgent: store.userAgent,
  };
}

/**
 * Stores the resolved `Principal` (the `app.users` row and its permissions) for the current request.
 * Throws outside a request and before `bindIdentity`: a principal without a tenant context is a bug.
 */
export function bindPrincipal(principal: Principal): void {
  const store = storage.getStore();
  if (!store) {
    throw new Error(
      'bindPrincipal() called outside a request: is CorrelationMiddleware registered?',
    );
  }
  if (!store.context) {
    throw new Error('bindPrincipal() called before bindIdentity(): bind the identity first');
  }
  store.principal = principal;
}

/** The principal bound to the current request, or undefined outside a request or before binding. */
export function currentPrincipal(): Principal | undefined {
  return storage.getStore()?.principal;
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
