import type { Metadata } from 'next';

import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { listNumberSeries } from '@/lib/api-admin';

import { BackToSettings } from '../_components/back-link';
import { loadFields } from '../_components/load-fields';
import { SettingCard } from '../_components/setting-card';
import { SettingsForm } from '../_components/settings-form';
import styles from '../_components/settings.module.css';
import admin from '../admin.module.css';
import { requireSection } from '../guard';
import { section } from '../section';
import { SectionError } from '../ui';
import { seriesName } from './series-name';

export const metadata: Metadata = { title: 'Document numbering · Business OS' };

export default async function NumberingPage() {
  const session = await requireSection('numbering');
  const [fields, series] = await Promise.all([
    loadFields(session, ['numbering.memo_prefix']),
    section('view document numbering', () => listNumberSeries(session)),
  ]);

  return (
    <Page className={admin.page}>
      <BackToSettings />
      <PageHeader
        title="Document numbering"
        description="Numbers are handed out by the system, one counter per kind of document and fiscal year."
      />
      <div className={styles.column}>
        {fields.ok ? (
          <div className={styles.narrow}>
            <SettingsForm section="numbering" fields={fields.data}>
              <SettingCard title="Memos" fields={fields.data} />
            </SettingsForm>
          </div>
        ) : (
          <SectionError message={fields.message} />
        )}

        <Panel
          title="Counters"
          description="Read-only. A counter is created when its first document is numbered."
        >
          {!series.ok ? (
            <SectionError message={series.message} />
          ) : series.data.length === 0 ? (
            <EmptyState title="No counters yet" headingLevel={3}>
              One appears when its first document is numbered.
            </EmptyState>
          ) : (
            <Table caption="Document counters" className={admin.local ?? ''}>
              <thead>
                <tr>
                  <Th>Document</Th>
                  <Th>Fiscal year</Th>
                  <Th>Prefix</Th>
                  <Th align="end">Next number</Th>
                </tr>
              </thead>
              <tbody>
                {series.data.map((row) => (
                  <tr key={`${row.key}:${row.fiscalYear}`}>
                    <Th scope="row" className={admin.rowHead}>
                      {seriesName(row.key)}
                    </Th>
                    <Td>{row.fiscalYear}</Td>
                    <Td>
                      <span className={styles.mono}>{row.prefix}</span>
                    </Td>
                    <Td align="end">{String(row.nextValue).padStart(row.pad, '0')}</Td>
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
