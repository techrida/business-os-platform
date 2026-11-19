import { randomUUID } from 'node:crypto';

import { LEAD_SOURCES } from '@bos/contracts';
import type { Metadata } from 'next';

import { listLeadOwners } from '@/components/p2/crm/crm-api';
import { sentence } from '@/components/p2/crm/format';
import { LeadForm } from '@/components/p2/crm/lead-form';
import { Breadcrumb, Page } from '@/components/ui/page';
import { getMe } from '@/lib/api';
import { requireStaffSession } from '@/lib/bff';
import { loadEnabledCurrencies } from '@/lib/enabled-currencies.server';

import { createLeadAction } from '../actions';

export const metadata: Metadata = { title: 'Create Lead · Business OS' };

export default async function NewLeadPage() {
  const session = await requireStaffSession('/leads/new');
  const sources = LEAD_SOURCES.map((s) => ({ value: s, label: sentence(s) }));
  // Either failing leaves the form usable: no owner list means the API makes the lead the caller's.
  // The currency read never throws: a failed read gives the default list.
  const enabledRead = loadEnabledCurrencies(session);
  const [ownerList, me] = await Promise.allSettled([listLeadOwners(session), getMe(session)]);
  const enabledCurrencies = await enabledRead;
  const owners =
    ownerList.status === 'fulfilled'
      ? ownerList.value.map((o) => ({ value: o.userId, label: o.displayName || o.email }))
      : [];
  const meId = me.status === 'fulfilled' ? me.value.userId : undefined;
  const defaultOwnerId = owners.some((o) => o.value === meId) ? meId : undefined;
  return (
    <Page>
      <Breadcrumb items={[{ label: 'Leads', href: '/leads' }, { label: 'Create Lead' }]} />
      <LeadForm
        action={createLeadAction}
        sources={sources}
        owners={owners}
        enabledCurrencies={enabledCurrencies}
        defaultOwnerId={defaultOwnerId}
        idempotencyKey={randomUUID()}
      />
    </Page>
  );
}
