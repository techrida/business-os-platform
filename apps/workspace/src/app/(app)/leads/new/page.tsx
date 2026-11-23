import { randomUUID } from 'node:crypto';

import { LEAD_SOURCES } from '@bos/contracts';
import type { Metadata } from 'next';

import { listLeadOwners } from '@/components/p2/crm/crm-api';
import { sentence } from '@/components/p2/crm/format';
import { Breadcrumb, Page } from '@/components/ui/page';
import { getMe } from '@/lib/api';
import { requireStaffSession } from '@/lib/bff';
import { loadEnabledCurrencies } from '@/lib/enabled-currencies.server';

import { createLeadAction } from '../actions';
import { NewLeadForm } from './new-lead-form';

export const metadata: Metadata = { title: 'Create Lead · Business OS' };

export default async function NewLeadPage() {
  const session = await requireStaffSession('/leads/new');
  const sources = LEAD_SOURCES.map((s) => ({ value: s, label: sentence(s) }));
  // Either failing leaves the form usable: no owner list means the API makes the lead the caller's.
  // The currency read never throws: a failed read gives the default list.
  const enabledRead = loadEnabledCurrencies(session);
  const [ownerList, me] = await Promise.allSettled([
    listLeadOwners(session, 'create'),
    getMe(session),
  ]);
  const enabledCurrencies = await enabledRead;
  const owners =
    ownerList.status === 'fulfilled'
      ? ownerList.value.map((o) => ({ value: o.userId, label: o.displayName || o.email }))
      : [];
  const meId = me.status === 'fulfilled' ? me.value.userId : undefined;
  const defaultOwnerId = owners.some((o) => o.value === meId) ? meId : undefined;
  // Known, and not someone the lead may go to: the API gives it to the default lead owner instead.
  const callerUnplaced = meId !== undefined && defaultOwnerId === undefined && owners.length > 0;
  return (
    <Page>
      <Breadcrumb items={[{ label: 'Leads', href: '/leads' }, { label: 'Create Lead' }]} />
      {/* BOS-UI-002: Company and Contact person search what the user may read and always offer Create. */}
      <NewLeadForm
        action={createLeadAction}
        sources={sources}
        owners={owners}
        enabledCurrencies={enabledCurrencies}
        defaultOwnerId={defaultOwnerId}
        callerUnplaced={callerUnplaced}
        idempotencyKey={randomUUID()}
      />
    </Page>
  );
}
