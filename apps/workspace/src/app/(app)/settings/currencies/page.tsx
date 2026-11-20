import type { Metadata } from 'next';

import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { listFxRates } from '@/lib/api-admin';
import { getPermissionCheck } from '@/lib/live-permissions';

import { BackToSettings } from '../_components/back-link';
import { loadFields } from '../_components/load-fields';
import { SettingCard } from '../_components/setting-card';
import { SettingsForm } from '../_components/settings-form';
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
  // Finance opens this page to enter rates (settings.fx_rate.write). Which currencies are enabled
  // and how old a rate may be stay with the Founder (admin.settings.write), so that card is neither
  // read nor shown without the live grant.
  const can = await getPermissionCheck(session);
  const canChangeCurrencies = can('admin.settings.write');
  const [fields, rates] = await Promise.all([
    canChangeCurrencies
      ? loadFields(session, ['currency.enabled', 'fx.max_rate_age_days'])
      : Promise.resolve(null),
    section('view exchange rates', () => listFxRates(session, { limit: 50 })),
  ]);

  return (
    <Page className={admin.page}>
      <BackToSettings />
      <PageHeader
        title="Currencies and exchange rates"
        description="How much NPR each foreign currency is worth, and how old a rate may be. Every change is recorded in the audit trail."
      />
      <div className={styles.column}>
        {fields === null ? null : fields.ok ? (
          <div className={styles.narrow}>
            <SettingsForm section="currencies" fields={fields.data}>
              <SettingCard title="Currencies" fields={fields.data} />
            </SettingsForm>
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
