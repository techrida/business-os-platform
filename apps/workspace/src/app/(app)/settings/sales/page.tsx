import type { Metadata } from 'next';

import { LostReasonsCard } from '@/components/settings/lost-reasons/lost-reasons-card';
import { Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { listLeadLostReasons } from '@/lib/api-lead-lost-reasons';

import { BackToSettings } from '../_components/back-link';
import { cardKey, loadFields } from '../_components/load-fields';
import { SettingCard } from '../_components/setting-card';
import styles from '../_components/settings.module.css';
import admin from '../admin.module.css';
import { requireSection } from '../guard';
import { section } from '../section';
import { SectionError } from '../ui';

export const metadata: Metadata = { title: 'Sales · Business OS' };

export default async function SalesSettingsPage() {
  const session = await requireSection('sales');
  const [quotations, evidence, schedule] = await Promise.all([
    loadFields(session, ['quotation.validity_days']),
    loadFields(session, ['sales.evidence_policy']),
    loadFields(session, ['sales.default_schedule']),
  ]);
  const lostReasons = await section('view lost reasons', () => listLeadLostReasons(session));
  const cards = [
    { title: 'Quotations', description: 'Applies to new quotations.', result: quotations },
    { title: 'Winning a deal', result: evidence },
    {
      title: 'Billing schedule',
      description: 'How an accepted quotation is billed when it has no schedule of its own.',
      result: schedule,
    },
  ];

  return (
    <Page className={admin.page}>
      <BackToSettings />
      <PageHeader
        title="Sales"
        description="Defaults for quotations and the deals they win, and the reasons a lead or opportunity can be lost. Every change is recorded in the audit trail."
      />
      <div className={`${styles.column} ${styles.narrow}`}>
        {cards.map(({ title, description, result }) =>
          result.ok ? (
            <SettingCard
              key={`${title}:${cardKey(result.data)}`}
              section="sales"
              title={title}
              {...(description ? { description } : {})}
              fields={result.data}
            />
          ) : (
            <SectionError key={title} message={result.message} />
          ),
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
