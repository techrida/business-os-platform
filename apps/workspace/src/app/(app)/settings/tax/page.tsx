import type { Metadata } from 'next';

import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { listAdminTaxCodes } from '@/lib/api-master-data';
import { listWithholdingCodes } from '@/lib/api-withholding-codes';

import { BackToSettings } from '../_components/back-link';
import styles from '../_components/settings.module.css';
import admin from '../admin.module.css';
import { todayInKathmandu } from '../format';
import { requireSection } from '../guard';
import { section } from '../section';
import { SectionError } from '../ui';
import { TaxCodesManager } from './tax-codes-manager';

export const metadata: Metadata = { title: 'Tax · Business OS' };

const percent = (basisPoints: number): string => `${(basisPoints / 100).toFixed(2)}%`;

/**
 * VAT and withholding codes. The `tax.vat_rate` setting keeps its key, default and save/reset actions, but no card
 * shows it, because nothing reads it (round 5, UX1; Kuu decided to hide it).
 */
export default async function TaxPage() {
  const session = await requireSection('tax');
  const [vat, withholding] = await Promise.all([
    section('view VAT codes', () => listAdminTaxCodes(session)),
    section('view withholding codes', () => listWithholdingCodes(session)),
  ]);

  return (
    <Page className={admin.page}>
      <BackToSettings />
      <PageHeader
        title="Tax"
        description="The VAT and withholding codes documents can use. Every change is recorded in the audit trail."
      />
      <div className={styles.column}>
        <Panel
          title="VAT codes"
          description="The codes quotations, orders and bills can use, with the rate in force today."
        >
          {!vat.ok ? (
            <SectionError message={vat.message} />
          ) : (
            <TaxCodesManager codes={vat.data} today={todayInKathmandu()} />
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
