import type { Metadata } from 'next';

import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { listFxRates } from '@/lib/api-admin';

import { BackToSettings } from '../_components/back-link';
import { cardKey, loadFields } from '../_components/load-fields';
import { SettingCard } from '../_components/setting-card';
import styles from '../_components/settings.module.css';
import admin from '../admin.module.css';
import { todayInKathmandu, trimRate } from '../format';
import { requireSection } from '../guard';
import { section } from '../section';
import { SectionError } from '../ui';
import { FxForm } from './fx-form';

export const metadata: Metadata = { title: 'Currencies and exchange rates · Business OS' };

export default async function CurrenciesPage() {
  const session = await requireSection('currencies');
  const [fields, rates] = await Promise.all([
    loadFields(session, ['currency.enabled', 'fx.max_rate_age_days']),
    section('view exchange rates', () => listFxRates(session, { limit: 50 })),
  ]);

  return (
    <Page className={admin.page}>
      <BackToSettings />
      <PageHeader
        title="Currencies and exchange rates"
        description="Which currencies documents may use, and how much NPR each is worth. Every change is recorded in the audit trail."
      />
      <div className={styles.column}>
        {fields.ok ? (
          <div className={styles.narrow}>
            <SettingCard
              key={cardKey(fields.data)}
              section="currencies"
              title="Currencies"
              fields={fields.data}
            />
          </div>
        ) : (
          <SectionError message={fields.message} />
        )}

        <Panel
          title="Exchange rates"
          description="How much NPR one unit of a foreign currency is worth. A document keeps the rate that was in force when it was written, so adding a rate never changes old documents."
        >
          <FxForm today={todayInKathmandu()} />
          <h3 className={styles.sub}>Recent rates</h3>
          {!rates.ok ? (
            <SectionError message={rates.message} />
          ) : rates.data.length === 0 ? (
            <EmptyState title="No exchange rates yet" headingLevel={3}>
              Add the first one above.
            </EmptyState>
          ) : (
            <Table caption="Exchange rates, newest first" className={admin.local ?? ''}>
              <thead>
                <tr>
                  <Th>Applies from</Th>
                  <Th>Currency</Th>
                  <Th align="end">Rate (NPR)</Th>
                  <Th>Source</Th>
                </tr>
              </thead>
              <tbody>
                {rates.data.map((rate) => (
                  <tr key={rate.id}>
                    <Th scope="row" className={admin.rowHead}>
                      {rate.rateDate}
                    </Th>
                    <Td>{rate.currency}</Td>
                    <Td align="end">{trimRate(rate.rateNpr)}</Td>
                    <Td>{rate.source ?? <span className={styles.muted}>Not recorded</span>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </div>
    </Page>
  );
}
