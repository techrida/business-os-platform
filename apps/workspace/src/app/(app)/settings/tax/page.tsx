import type { Metadata } from 'next';

import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { listTaxCodes } from '@/lib/api-tax-codes';
import { listWithholdingCodes } from '@/lib/api-withholding-codes';

import { BackToSettings } from '../_components/back-link';
import { loadFields } from '../_components/load-fields';
import { SettingCard } from '../_components/setting-card';
import { SettingsForm } from '../_components/settings-form';
import styles from '../_components/settings.module.css';
import admin from '../admin.module.css';
import { requireSection } from '../guard';
import { section } from '../section';
import { SectionError } from '../ui';

export const metadata: Metadata = { title: 'Tax · Business OS' };

const percent = (basisPoints: number): string => `${(basisPoints / 100).toFixed(2)}%`;

export default async function TaxPage() {
  const session = await requireSection('tax');
  const [rate, vat, withholding] = await Promise.all([
    loadFields(session, ['tax.vat_rate']),
    section('view VAT codes', () => listTaxCodes(session)),
    section('view withholding codes', () => listWithholdingCodes(session)),
  ]);

  return (
    <Page className={admin.page}>
      <BackToSettings />
      <PageHeader title="Tax" description="VAT and withholding codes documents can use." />
      <div className={styles.column}>
        {rate.ok ? (
          <div className={styles.narrow}>
            <SettingsForm section="tax" fields={rate.data}>
              <SettingCard title="VAT rate" fields={rate.data} />
            </SettingsForm>
          </div>
        ) : (
          <SectionError message={rate.message} />
        )}

        <Panel title="VAT codes" description="Read-only. Codes are set up with the system.">
          {!vat.ok ? (
            <SectionError message={vat.message} />
          ) : vat.data.length === 0 ? (
            <EmptyState title="No VAT codes yet" headingLevel={3}>
              None have been set up.
            </EmptyState>
          ) : (
            <Table caption="VAT codes" className={admin.local ?? ''}>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Code</Th>
                  <Th align="end">Rate</Th>
                </tr>
              </thead>
              <tbody>
                {vat.data.map((code) => (
                  <tr key={code.id}>
                    <Th scope="row" className={admin.rowHead}>
                      {code.label}
                    </Th>
                    <Td>{code.code ?? <span className={styles.muted}>None</span>}</Td>
                    <Td align="end">
                      {code.rateBp !== undefined
                        ? percent(code.rateBp)
                        : code.rate !== undefined
                          ? `${code.rate}%`
                          : '-'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel title="Withholding codes" description="Read-only. Deducted from supplier payments.">
          {!withholding.ok ? (
            <SectionError message={withholding.message} />
          ) : withholding.data.length === 0 ? (
            <EmptyState title="No withholding codes yet" headingLevel={3}>
              None have been set up.
            </EmptyState>
          ) : (
            <Table caption="Withholding codes" className={admin.local ?? ''}>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Code</Th>
                  <Th align="end">Rate</Th>
                  <Th>Applies from</Th>
                  <Th>Applies until</Th>
                </tr>
              </thead>
              <tbody>
                {withholding.data.map((code) => (
                  <tr key={code.id}>
                    <Th scope="row" className={admin.rowHead}>
                      {code.name}
                    </Th>
                    <Td>{code.code}</Td>
                    <Td align="end">{percent(code.rateBp)}</Td>
                    <Td>{code.effectiveFrom}</Td>
                    <Td>{code.effectiveTo ?? <span className={styles.muted}>No end date</span>}</Td>
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
