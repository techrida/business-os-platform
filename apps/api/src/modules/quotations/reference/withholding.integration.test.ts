import 'reflect-metadata';

import { WithholdingCodeSchema } from '@bos/contracts';
import { createTenantWithEntity, withholdingCodes } from '@bos/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { AuthzService } from '../../../platform/authz/authz.service';
import { systemActor, withTx } from '../../../platform/db/tx';
import { startHarness, type Harness } from '../../leads/test/harness';
import { ReferenceController } from './reference.controller';
import { ReferenceService } from './reference.service';

vi.mock('../../../platform/authz/principal', () => ({
  principal: () => ({ orgKind: 'staff', status: 'active' }),
}));
vi.setConfig({ testTimeout: 60000, hookTimeout: 180000 });
let h: Harness;
let tenantId: string;
let controller: ReferenceController;

beforeAll(async () => {
  h = await startHarness({ Pool, drizzle });
  tenantId = h.tenantId;
  const other = await createTenantWithEntity(
    h.appPool as unknown as Parameters<typeof createTenantWithEntity>[0],
  );
  const code = (
    tenant: string,
    name: string,
    appliesTo: 'payable' | 'receivable' | 'both',
    from: string,
    to: string | null = null,
  ) => ({
    tenantId: tenant,
    code: name,
    name,
    appliesTo,
    rateBp: 0,
    effectiveFrom: from,
    effectiveTo: to,
  });
  await withTx(h.db, h.scopeA, systemActor('test'), async (tx) => {
    await tx
      .insert(withholdingCodes)
      .values([
        code(h.tenantId, 'PAYABLE', 'payable', '2020-01-01'),
        code(h.tenantId, 'BOTH', 'both', '2020-01-01'),
        code(h.tenantId, 'RECEIVABLE', 'receivable', '2020-01-01'),
        code(h.tenantId, 'OLD', 'payable', '2020-01-01', '2021-01-01'),
        code(h.tenantId, 'FUTURE', 'payable', '2099-01-01'),
      ]);
  });
  await withTx(h.db, other, systemActor('test'), async (tx) => {
    await tx
      .insert(withholdingCodes)
      .values(code(other.tenantId, 'FOREIGN', 'payable', '2020-01-01'));
  });
  const service = new ReferenceService(h.db, { tenantId: () => tenantId }, {
    assert: () => undefined,
  } as unknown as AuthzService);
  controller = new ReferenceController(service);
});
afterAll(async () => {
  await h?.stop();
});

describe('withholding registry real database query', () => {
  it('returns only current payable/both periods in the acting tenant', async () => {
    const list = z.array(WithholdingCodeSchema).parse(await controller.withholdingCodes());
    expect(list.map((row) => row.code)).toEqual(['BOTH', 'PAYABLE']);
    expect(list.every((row) => row.rateBp === 0)).toBe(true);
  });
  it('does not leak codes when the acting tenant has no codes', async () => {
    tenantId = '11111111-1111-4111-8111-111111111111';
    await expect(controller.withholdingCodes()).resolves.toEqual([]);
    tenantId = h.tenantId;
  });
});
