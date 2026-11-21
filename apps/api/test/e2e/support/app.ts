import 'reflect-metadata';

import { randomBytes } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Type } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import request from 'supertest';
import { inject } from 'vitest';

import { configureApp } from '../../../src/app.setup';
import { logServerErrors } from './server-error-log';
import { startTestIssuer, zitadelClaims, type MintOptions, type TestIssuer } from './test-issuer';

/** The API's ZITADEL project id: OIDC_AUDIENCE, and the project the roles claim is named after. */
export const PROJECT_ID = '320000000000000001';
/** The web client's id, the second entry of `aud` in real ZITADEL tokens. */
export const CLIENT_ID = '320000000000000002';

export interface TestApp {
  readonly app: NestExpressApplication;
  readonly issuer: TestIssuer;
  /** A supertest request builder bound to the app (it opens its own ephemeral port per request). */
  http(): ReturnType<typeof request>;
  /** A valid access token for a user of the given ZITADEL org. Override one thing via `options`. */
  token(
    org: { zitadelOrgId: string },
    options?: { userId?: string; roles?: readonly string[] } & MintOptions,
  ): Promise<string>;
  close(): Promise<void>;
}

export interface StartAppOptions {
  /** Wraps AppModule in a root module, e.g. to add DiscoveryModule. Default: AppModule itself. */
  wrapRoot?: (appModule: Type<unknown>) => Type<unknown>;
}

/**
 * Builds the API the way `main.ts` does, minus listening on a port:
 * issuer first (the JWKS warm-up starts at bootstrap), then env, then AppModule.
 *
 * AppModule is imported dynamically on purpose. `ConfigModule.forRoot()` reads `process.env` when
 * the module file is evaluated, so the variables must exist before that import runs. Each test
 * file runs in its own worker, so mutating `process.env` here cannot leak into another file.
 */
export async function startApp(options: StartAppOptions = {}): Promise<TestApp> {
  const e2e = inject('e2e');
  const issuer = await startTestIssuer();

  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: e2e.databaseUrl,
    VALKEY_URL: e2e.valkeyUrl,
    // Exactly the issuer's URL, no trailing slash: the verifier compares it character for character.
    OIDC_ISSUER: issuer.url,
    OIDC_AUDIENCE: PROJECT_ID,
    OIDC_CLIENT_ID: CLIENT_ID,
    // CryptoModule (vendor bank accounts) throws at boot without a keyring.
    FIELD_ENC_KEYS: 'k1:' + randomBytes(32).toString('base64'),
  });

  const { AppModule } = await import('../../../src/app.module');
  const root = options.wrapRoot ? options.wrapRoot(AppModule) : AppModule;

  // Same sequence as main.ts: buffered logs handed to pino, shared setup, then init (which runs
  // the lifecycle hooks, including the JWKS warm-up). The tests never call listen().
  let app: NestExpressApplication;
  try {
    // rawBody: true as in main.ts (the ZITADEL webhook HMAC needs the unparsed body).
    app = await NestFactory.create<NestExpressApplication>(root, {
      bufferLogs: true,
      rawBody: true,
    });
  } catch (error) {
    await issuer.close();
    throw error;
  }
  // LOG_LEVEL is silent here, so the stack of any 5xx is written to stderr by this wrapper instead.
  app.useLogger(logServerErrors(app.get(Logger)));
  configureApp(app);
  await app.init();

  return {
    app,
    issuer,
    http: () => request(app.getHttpServer()),
    token: (org, tokenOptions = {}) => {
      const { userId = 'user-e2e-1', roles = ['member'], ...mint } = tokenOptions;
      return issuer.mint(
        zitadelClaims({
          projectId: PROJECT_ID,
          clientId: CLIENT_ID,
          userId,
          orgId: org.zitadelOrgId,
          roles,
        }),
        mint,
      );
    },
    async close() {
      await app.close();
      await issuer.close();
    },
  };
}
