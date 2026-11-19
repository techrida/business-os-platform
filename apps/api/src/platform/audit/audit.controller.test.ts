// Unit tests for AuditController (fakes, no database, no request).
// Run with: pnpm --filter @bos/api exec vitest run src/platform/audit/audit.controller.test.ts
//
// The controller's job is validation and scope: a malformed query is a 400 before the service is touched, and
// the tenant always comes from ctx(), never from the query string. The SQL side is covered by
// audit.service.test.ts.
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditController } from './audit.controller';
import type { AuditService } from './audit.service';

const caller = { tenantId: 't-caller', organizationId: 'o-caller' };

vi.mock('../tenancy/request-context', () => ({ ctx: () => caller, currentPrincipal: () => undefined }));

const fakeAudit = { list: vi.fn(), verifyChain: vi.fn() };
let controller: AuditController;

beforeEach(() => {
  vi.resetAllMocks();
  controller = new AuditController(fakeAudit as unknown as AuditService);
});

describe('GET /v1/audit/verify', () => {
  it.each(['2025-13', '2025-00', '2025-1', '25-01', '2025-01-01', '', 'january', '2025/01'])(
    'answers 400 for the month %j, before touching the service',
    async (month) => {
      await expect(controller.verify({ month })).rejects.toBeInstanceOf(BadRequestException);
      expect(fakeAudit.verifyChain).not.toHaveBeenCalled();
    },
  );

  it('answers 400 when the month is missing', async () => {
    await expect(controller.verify({})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('verifies the caller tenant, whatever tenantId the query carries', async () => {
    fakeAudit.verifyChain.mockResolvedValue({ ok: true });
    await controller.verify({ month: '2025-07', tenantId: 't-someone-else' });
    expect(fakeAudit.verifyChain).toHaveBeenCalledWith('t-caller', '2025-07');
  });
});

describe('GET /v1/audit', () => {
  it('lists in the caller scope with a default limit of 50', async () => {
    fakeAudit.list.mockResolvedValue([]);
    await expect(controller.list({})).resolves.toEqual({ items: [] });
    expect(fakeAudit.list).toHaveBeenCalledWith(caller, { limit: 50 });
  });

  it('turns query strings into typed filters, and an empty value into "not given"', async () => {
    fakeAudit.list.mockResolvedValue([]);
    await controller.list({
      entityType: 'memo',
      entityId: '',
      from: '2025-07-01T00:00:00Z',
      to: '2025-08-01T00:00:00+05:45',
      afterId: '120',
      limit: '25',
    });
    expect(fakeAudit.list).toHaveBeenCalledWith(caller, {
      entityType: 'memo',
      from: new Date('2025-07-01T00:00:00Z'),
      to: new Date('2025-08-01T00:00:00+05:45'),
      afterId: '120',
      limit: 25,
    });
  });

  it.each([
    { limit: '0' },
    { limit: '501' },
    { limit: 'many' },
    { afterId: '-1' },
    { afterId: '12.5' },
    { afterId: '1'.repeat(19) },
    { from: 'yesterday' },
    { to: '2025-07-01' },
  ])('answers 400 for %j', async (query) => {
    await expect(controller.list(query)).rejects.toBeInstanceOf(BadRequestException);
    expect(fakeAudit.list).not.toHaveBeenCalled();
  });
});
