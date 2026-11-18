import { randomUUID } from 'node:crypto';

import { LEAD_SOURCES } from '@bos/contracts';
import type { Metadata } from 'next';

import { sentence } from '@/components/p2/crm/format';
import { LeadForm } from '@/components/p2/crm/lead-form';
import { Breadcrumb, Page } from '@/components/ui/page';
import { requireStaffSession } from '@/lib/bff';

import { createLeadAction } from '../actions';

export const metadata: Metadata = { title: 'Create Lead · Business OS' };

export default async function NewLeadPage() {
  await requireStaffSession('/leads/new');
  const sources = LEAD_SOURCES.map((s) => ({ value: s, label: sentence(s) }));
  return (
    <Page>
      <Breadcrumb items={[{ label: 'Leads', href: '/leads' }, { label: 'Create Lead' }]} />
      <LeadForm action={createLeadAction} sources={sources} idempotencyKey={randomUUID()} />
    </Page>
  );
}
