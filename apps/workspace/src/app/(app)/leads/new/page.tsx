import { LEAD_SOURCES } from '@bos/contracts';
import type { Metadata } from 'next';

import { sentence } from '@/components/p2/crm/format';
import { LeadForm } from '@/components/p2/crm/lead-form';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { requireStaffSession } from '@/lib/bff';

import { createLeadAction } from '../actions';

export const metadata: Metadata = { title: 'New lead · Business OS' };

export default async function NewLeadPage() {
  await requireStaffSession('/leads/new');
  const sources = LEAD_SOURCES.map((s) => ({ value: s, label: sentence(s) }));
  return (
    <Page width="narrow">
      <Breadcrumb items={[{ label: 'Leads', href: '/leads' }, { label: 'New lead' }]} />
      <PageHeader
        title="New lead"
        description="A lead starts at New. Company and contact are plain text until you convert it to a customer."
      />
      <Panel title="Lead details">
        <LeadForm action={createLeadAction} sources={sources} />
      </Panel>
    </Page>
  );
}
