import type { Metadata } from 'next';

import { Page, PageHeader } from '@/components/ui/page';

import { BackToSettings } from '../_components/back-link';
import { loadFields } from '../_components/load-fields';
import { SettingCard } from '../_components/setting-card';
import { SettingsForm } from '../_components/settings-form';
import styles from '../_components/settings.module.css';
import admin from '../admin.module.css';
import { requireSection } from '../guard';
import { SectionError } from '../ui';

export const metadata: Metadata = { title: 'Purchasing · Business OS' };

export default async function PurchasingSettingsPage() {
  const session = await requireSection('purchasing');
  const [quotes, matching, bands] = await Promise.all([
    loadFields(session, ['procurement.min_quotes']),
    loadFields(session, [
      'procurement.match.qty_pct',
      'procurement.match.price_pct',
      'procurement.match.price_npr',
    ]),
    loadFields(session, ['procurement.band.management_npr', 'procurement.band.founder_npr']),
  ]);
  const cards = [
    { title: 'Sourcing', result: quotes },
    {
      title: 'Bill matching tolerance',
      description: 'How far a supplier bill may differ from its purchase order before it is held.',
      result: matching,
    },
    {
      title: 'Approval bands',
      description: 'Totals above which a purchase commitment or payment needs more approval.',
      result: bands,
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
        title="Purchasing"
        description="Sourcing, bill matching and approval limits. Every change is recorded in the audit trail."
      />
      <div className={`${styles.column} ${styles.narrow}`}>
        {allFields.length > 0 ? (
          <SettingsForm section="purchasing" fields={allFields}>
            {cardNodes}
          </SettingsForm>
        ) : (
          cardNodes
        )}
      </div>
    </Page>
  );
}
