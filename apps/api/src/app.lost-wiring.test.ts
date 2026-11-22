import 'reflect-metadata';

import { randomBytes } from 'node:crypto';

import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OpportunitiesService } from './modules/opportunities/opportunities.service';
import { QuotationsModule } from './modules/quotations/quotations.module';

// Production wiring of the Lost cascade. The integration tests register handlers by hand, which is how the
// handler stayed unregistered in production: nothing compiled the real AppModule and asked the one registry
// the opportunity service loops over. This compiles the real graph (as worker.module.boot.test.ts does: no
// init(), no connection, the URLs point at a closed port), runs the quotations module's start hook the way
// Nest would, and reads the registry back.
describe('AppModule: the Lost cascade is wired', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
      VALKEY_URL: 'redis://127.0.0.1:1',
      GOTENBERG_URL: 'http://127.0.0.1:1',
      FILES_ROOT: 'lost-wiring-test-files',
      OIDC_ISSUER: 'http://127.0.0.1:1',
      OIDC_AUDIENCE: 'lost-wiring-test',
      OIDC_CLIENT_ID: 'lost-wiring-test-client',
      FIELD_ENC_KEYS: `k1:${randomBytes(32).toString('base64')}`,
    });
    const { AppModule } = await import('./app.module');
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    moduleRef.get(QuotationsModule, { strict: false }).onModuleInit();
  }, 60_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('registers the quotations cancel handler on the opportunity service the routes use', () => {
    const opportunities = moduleRef.get(OpportunitiesService, { strict: false });
    const registry = (opportunities as unknown as { lostHandlers: Map<string, unknown> })
      .lostHandlers;
    expect([...registry.keys()]).toEqual(['quotations.cancel']);
  });
});
