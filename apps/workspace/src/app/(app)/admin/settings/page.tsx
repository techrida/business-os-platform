import { SETTING_KEYS, type SettingKey } from '@bos/contracts';

import { EmptyState } from '@/components/ui/empty-state';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { getSetting, listFxRates, listNumberSeries } from '@/lib/api-admin';

import admin from '../admin.module.css';
import { requireSession } from '../guard';
import { todayInKathmandu, trimRate } from '../format';
import { section } from '../section';
import { SectionError } from '../ui';
import { FxForm } from './fx-form';
import { SettingForm } from './setting-form';
import { settingValueText } from './setting-input';
import styles from './settings.module.css';

const SETTING_COPY: Record<SettingKey, { label: string; help: string }> = {
  'approvals.sla_defaults': {
    label: 'Approval timing defaults',
    help: 'Used by a workflow that does not set its own reminder and escalation times.',
  },
  'currency.enabled': {
    label: 'Enabled currencies',
    help: 'Currencies a document may use. NPR is the books currency and stays on.',
  },
  'tax.vat_rate': {
    label: 'VAT rate (%)',
    help: 'Enter 0 to 100 with up to two decimal places.',
  },
  'numbering.memo_prefix': {
    label: 'Memo number prefix',
    help: 'Two to ten capitals or digits, as in MEMO-2082/83-00001.',
  },
};

const SECTIONS = [
  { id: 'fx-rates', label: 'FX rates' },
  { id: 'number-series', label: 'Number series' },
  { id: 'values', label: 'Values' },
] as const;

export default async function SettingsPage() {
  const session = await requireSession('/admin/settings');

  // Each block loads on its own, so one missing permission or one failed call hides only that block.
  const [rates, series, ...settings] = await Promise.all([
    section('view FX rates', () => listFxRates(session, { limit: 50 })),
    section('view number series', () => listNumberSeries(session)),
    ...SETTING_KEYS.map(async (key) => ({
      key,
      result: await section('view settings', () => getSetting(session, key)),
    })),
  ]);

  return (
    <Page className={admin.page}>
      <Breadcrumb items={[{ label: 'Administration', href: '/admin' }, { label: 'Settings' }]} />
      <PageHeader
        title="Settings"
        description="Rates, numbering and defaults. Every change is saved as a new version and recorded in the audit trail."
      />

      <div className={styles.layout}>
        <nav aria-label="Settings sections" className={styles.sections}>
          <p className={styles.sectionsTitle}>Sections</p>
          <ul className={styles.sectionList}>
            {SECTIONS.map((item) => (
              <li key={item.id}>
                <a href={`#${item.id}`} className={styles.sectionLink}>
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className={styles.column}>
          <Panel
            id="fx-rates"
            className={styles.anchor}
            title="FX rates"
            description="How much NPR one unit of a foreign currency is worth. A document keeps the rate that was in force when it was written, so adding a rate never changes old documents."
          >
            <FxForm today={todayInKathmandu()} />
            <h3 className={styles.sub}>Recent rates</h3>
            {!rates.ok ? (
              <SectionError message={rates.message} />
            ) : rates.data.length === 0 ? (
              <EmptyState title="No FX rates yet" headingLevel={3}>
                Add the first one above.
              </EmptyState>
            ) : (
              <Table caption="FX rates, newest first" className={admin.local ?? ''}>
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

          <Panel
            id="number-series"
            className={styles.anchor}
            title="Number series"
            description="Document numbers are handed out by the system, one counter per series and fiscal year. Counters are read-only here."
          >
            {!series.ok ? (
              <SectionError message={series.message} />
            ) : series.data.length === 0 ? (
              <EmptyState title="No number series yet" headingLevel={3}>
                One is created when its first document is numbered.
              </EmptyState>
            ) : (
              <Table caption="Number series" className={admin.local ?? ''}>
                <thead>
                  <tr>
                    <Th>Series</Th>
                    <Th>Fiscal year</Th>
                    <Th>Prefix</Th>
                    <Th align="end">Next value</Th>
                    <Th align="end">Digits</Th>
                  </tr>
                </thead>
                <tbody>
                  {series.data.map((row) => (
                    <tr key={`${row.key}:${row.fiscalYear}`}>
                      <Th scope="row" className={admin.rowHead}>
                        {row.key}
                      </Th>
                      <Td>{row.fiscalYear}</Td>
                      <Td>
                        <span className={styles.mono}>{row.prefix}</span>
                      </Td>
                      <Td align="end">{row.nextValue}</Td>
                      <Td align="end">{row.pad}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>

          <Panel
            id="values"
            className={styles.anchor}
            title="Values"
            description="The current version applies to new records. Saving a change creates a new version."
          >
            <ul className={styles.rows}>
              {settings.map(({ key, result }) => {
                const copy = SETTING_COPY[key];
                return (
                  <li key={key} className={styles.row}>
                    <div className={styles.rowText}>
                      <h3 className={styles.rowTitle}>{copy.label}</h3>
                      <p className={styles.caption}>{copy.help}</p>
                      {result.ok ? (
                        <p className={styles.caption}>
                          {result.data.version === null
                            ? 'Built-in default, never saved.'
                            : `Current: version ${result.data.version}.`}
                        </p>
                      ) : null}
                    </div>
                    {result.ok ? (
                      <SettingForm
                        settingKey={key}
                        label={copy.label}
                        current={settingValueText(result.data.value)}
                      />
                    ) : (
                      <div className={styles.rowError}>
                        <SectionError message={result.message} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </Panel>
        </div>
      </div>
    </Page>
  );
}
