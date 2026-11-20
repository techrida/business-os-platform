// The record-reach registry against the contracts: the read permissions that reach creators and
// assignees are exactly `RECORD_REACH_READ_PERMISSIONS`, so a change on either side fails here
// instead of in a service whose list and record check quietly disagree. No database.
import { PERMISSIONS, RECORD_REACH_READ_PERMISSIONS } from '@bos/contracts';
import { invoices, leads, opportunities, quotations, salesOrders } from '@bos/db';
import { describe, expect, it } from 'vitest';

import type { Db } from '../db/db.module';
import { loadReaders, readReachOf, recordReachOf } from './record-reach';

describe('record-reach registry', () => {
  it('gives read reach to exactly RECORD_REACH_READ_PERMISSIONS', () => {
    const reaching = PERMISSIONS.filter((permission) => readReachOf(permission) !== undefined);
    expect([...reaching].sort()).toEqual([...RECORD_REACH_READ_PERMISSIONS].sort());
  });

  it('honours the creator on leads only, and assignees on leads, opportunities and quotations', () => {
    expect(readReachOf('crm.lead.read')).toEqual({ creator: true, assignee: true });
    expect(readReachOf('crm.opportunity.read')).toEqual({ creator: false, assignee: true });
    expect(readReachOf('quotation.read')).toEqual({ creator: false, assignee: true });
    expect(readReachOf('crm.lead.write')).toBeUndefined();
  });

  it('describes each reach table with its own read permission', () => {
    expect(recordReachOf(leads)?.readPermission).toBe('crm.lead.read');
    expect(recordReachOf(opportunities)?.readPermission).toBe('crm.opportunity.read');
    expect(recordReachOf(quotations)?.readPermission).toBe('quotation.read');
    expect(recordReachOf(invoices)?.owner).toBe(invoices.createdBy);
  });

  it('reaches a sales order through its creator and its source quotation owner (U20a2-Q1)', () => {
    const reach = recordReachOf(salesOrders);
    expect(reach?.owner).toBe(salesOrders.createdBy);
    expect(reach?.ownerVia).toEqual({
      parent: quotations,
      key: salesOrders.quotationId,
      parentId: quotations.id,
      parentOwner: quotations.ownerUserId,
    });
  });

  it('refuses to load readers for a table without read reach', async () => {
    await expect(
      loadReaders({} as Db, { tenantId: 't', organizationId: 'o' }, invoices, ['x']),
    ).rejects.toThrow(/no read reach/);
  });
});
