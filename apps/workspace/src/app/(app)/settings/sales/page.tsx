import type { Metadata } from 'next';

import { listLeadOwners } from '@/components/p2/crm/crm-api';
import { LostReasonsCard } from '@/components/settings/lost-reasons/lost-reasons-card';
import { Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { listLeadLostReasons } from '@/lib/api-lead-lost-reasons';

import { BackToSettings } from '../_components/back-link';
import { loadFields } from '../_components/load-fields';
import { SettingCard } from '../_components/setting-card';
import { SettingsForm } from '../_components/settings-form';
import styles from '../_components/settings.module.css';
import admin from '../admin.module.css';
import { requireSection } from '../guard';
import { section } from '../section';
import { SectionError } from '../ui';

export const metadata: Metadata = { title: 'Sales · Business OS' };

export default async function SalesSettingsPage() {
  const session = await requireSection('sales');
  const [leadOwner, quotations, evidence, schedule, deliveryHold] = await Promise.all([
    // The people a new lead may be handed to, as the new-lead form offers them (F1-Q21).
    loadFields(session, ['crm.default_lead_owner'], () => listLeadOwners(session, 'create')),
    loadFields(session, ['quotation.validity_days']),
    loadFields(session, ['sales.evidence_policy']),
    loadFields(session, ['sales.default_schedule']),
    loadFields(session, ['sales.delivery_hold.management_npr']),
  ]);
  const lostReasons = await section('view lost reasons', () => listLeadLostReasons(session));
  const cards = [
    { title: 'Lead owner', result: leadOwner },
    { title: 'Quotations', description: 'Applies to new quotations.', result: quotations },
    { title: 'Winning a deal', result: evidence },
    {
      title: 'Billing schedule',
      description: 'How an accepted quotation is billed when it has no schedule of its own.',
      result: schedule,
    },
    {
      title: 'Delivery holds',
      description: 'Who may release a delivery that is on hold.',
      result: deliveryHold,
    },
  ];

  const allFields = cards.flatMap((c) => (c.result.ok ? c.result.data : []));
  const cardNodes = cards.map(({ title, description, result }) =>
    result.ok ? (
      <SettingCard
        key={title}
        title={title}
        {...(description ? { description } : {})}
        fields={result.data}
      />
    ) : (
      <SectionError key={title} message={result.message} />
    ),
  );

  return (
    <Page className={admin.page}>
      <BackToSettings />
      <PageHeader
        title="Sales"
        description="Who owns new leads, defaults for quotations and the deals they win, who releases a held delivery, and the reasons a lead or opportunity can be lost. Every change is recorded in the audit trail."
      />
      <div className={`${styles.column} ${styles.narrow}`}>
        {allFields.length > 0 ? (
          <SettingsForm section="sales" fields={allFields}>
            {cardNodes}
          </SettingsForm>
        ) : (
          cardNodes
        )}
        {lostReasons.ok ? (
          <Panel
            title="Lost reasons"
            description="The reasons offered when a lead or opportunity is marked lost."
          >
            <LostReasonsCard reasons={lostReasons.data} />
          </Panel>
        ) : (
          <SectionError message={lostReasons.message} />
        )}
      </div>
    </Page>
  );
}
