import { SETTING_KEYS, type SettingKey } from '@bos/contracts';

import { getSetting, listFxRates, listNumberSeries } from '@/lib/api-admin';

import styles from '../admin.module.css';
import { requireSession } from '../guard';
import { todayInKathmandu, trimRate } from '../format';
import { section } from '../section';
import { Notice, PageHead, SectionError } from '../ui';
import { FxForm } from './fx-form';
import { SettingForm } from './setting-form';
import { settingValueText } from './setting-input';

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
    help: 'A percentage: 13 means 13%. From 0 to 100 with at most 2 decimals.',
  },
  'numbering.memo_prefix': {
    label: 'Memo number prefix',
    help: 'Two to ten capitals or digits, as in MEMO-2082/83-00001.',
  },
};

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
    <>
      <PageHead title="Settings">
        Rates, numbering and defaults. Every change is saved as a new version and recorded in the
        audit trail.
      </PageHead>

      <section className={styles.section} style={{ marginTop: 0 }} aria-labelledby="fx-heading">
        <div className={styles.sectionHead}>
          <h2 id="fx-heading">FX rates</h2>
          <p>
            How much NPR one unit of a foreign currency is worth. A document keeps the rate that was
            in force when it was written, so adding a rate never changes old documents.
          </p>
        </div>
        <FxForm today={todayInKathmandu()} />
        <h3 className={styles.sub}>Recent rates</h3>
        {!rates.ok ? (
          <SectionError message={rates.message} />
        ) : rates.data.length === 0 ? (
          <p className={styles.empty}>No FX rates yet. Add the first one above.</p>
        ) : (
          <div className={styles.tableWrap} role="region" aria-labelledby="fx-caption" tabIndex={0}>
            <table className={styles.table}>
              <caption id="fx-caption" className={styles.srOnly}>
                FX rates, newest first
              </caption>
              <thead>
                <tr>
                  <th scope="col">Applies from</th>
                  <th scope="col">Currency</th>
                  <th scope="col" className={styles.num}>
                    Rate (NPR)
                  </th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {rates.data.map((rate) => (
                  <tr key={rate.id}>
                    <th scope="row">{rate.rateDate}</th>
                    <td>{rate.currency}</td>
                    <td className={styles.num}>{trimRate(rate.rateNpr)}</td>
                    <td className={styles.cellWrap}>
                      {rate.source ?? <span className={styles.muted}>Not recorded</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.section} aria-labelledby="series-heading">
        <div className={styles.sectionHead}>
          <h2 id="series-heading">Number series</h2>
          <p>
            Document numbers are handed out by the system, one counter per series and fiscal year.
            Counters are read-only here.
          </p>
        </div>
        {!series.ok ? (
          <SectionError message={series.message} />
        ) : series.data.length === 0 ? (
          <p className={styles.empty}>
            No number series yet. One is created when its first document is numbered.
          </p>
        ) : (
          <div
            className={styles.tableWrap}
            role="region"
            aria-labelledby="series-caption"
            tabIndex={0}
          >
            <table className={styles.table}>
              <caption id="series-caption" className={styles.srOnly}>
                Number series
              </caption>
              <thead>
                <tr>
                  <th scope="col">Series</th>
                  <th scope="col">Fiscal year</th>
                  <th scope="col">Prefix</th>
                  <th scope="col" className={styles.num}>
                    Next value
                  </th>
                  <th scope="col" className={styles.num}>
                    Digits
                  </th>
                </tr>
              </thead>
              <tbody>
                {series.data.map((row) => (
                  <tr key={`${row.key}:${row.fiscalYear}`}>
                    <th scope="row">{row.key}</th>
                    <td>{row.fiscalYear}</td>
                    <td className={styles.mono}>{row.prefix}</td>
                    <td className={styles.num}>{row.nextValue}</td>
                    <td className={styles.num}>{row.pad}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.section} aria-labelledby="values-heading">
        <div className={styles.sectionHead}>
          <h2 id="values-heading">Values</h2>
          <p>Each save adds a new version; the latest one is in force.</p>
        </div>
        <Notice>
          The version history is not shown yet: the API keeps every version but has no route to list
          them. Only the current version number is shown.
        </Notice>
        <div className={styles.stack}>
          {settings.map(({ key, result }) => {
            const copy = SETTING_COPY[key];
            return (
              <article key={key} className={styles.workflow} aria-labelledby={`h-${key}`}>
                <div className={styles.workflowHead}>
                  <h3 id={`h-${key}`}>{copy.label}</h3>
                  <span className={`${styles.mono} ${styles.muted}`}>{key}</span>
                </div>
                <p className={styles.hint}>{copy.help}</p>
                {!result.ok ? (
                  <SectionError message={result.message} />
                ) : (
                  <>
                    <p className={styles.hint} style={{ margin: '0.5rem 0' }}>
                      {result.data.version === null
                        ? 'Built-in default, never saved.'
                        : `Current: version ${result.data.version}.`}
                    </p>
                    <SettingForm
                      settingKey={key}
                      label={copy.label}
                      current={settingValueText(result.data.value)}
                    />
                  </>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </>
  );
}
