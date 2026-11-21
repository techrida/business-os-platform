import type { Metadata } from 'next';
import Link from 'next/link';

import type { SalesVatRegister } from '@bos/contracts';

import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { getSalesVatRegister, SalesVatPeriodSchema } from '@/lib/api-billing';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { getGrants, hasGrant } from '@/lib/grants';

import { poMoney } from '../../procurement/orders/_lib/model';
import styles from './vat-register.module.css';

export const metadata: Metadata = { title: 'Sales VAT register · Business OS' };
export const dynamic = 'force-dynamic';

const KIND_LABEL = {
  tax_invoice: 'Tax invoice',
  credit_note: 'Credit note',
  debit_note: 'Debit note',
} as const;

export default async function SalesVatRegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string | string[]; to?: string | string[] }>;
}) {
  const session = await requireStaffSession('/invoices/vat-register');
  const numberSystems = await getNumberSystems();
  const params = await searchParams;
  const from = typeof params.from === 'string' ? params.from : '';
  const to = typeof params.to === 'string' ? params.to : '';
  const period = SalesVatPeriodSchema.safeParse({ from, to });
  const header = (
    <PageHeader
      title="Sales VAT register"
      description="VAT charged on issued tax invoices, with credit notes as negative rows and debit notes as positive rows, by issue date. Drafts, proformas and discarded documents are excluded. Totals are kept per currency, and every row also shows its NPR equivalent at the rate frozen at issue, with one NPR total across currencies for the filing. Dates below use the AD calendar; each result includes its BS date."
    />
  );
  // Live grants (GET /v1/me), not the role defaults: an admin may grant the register to any role.
  if (!hasGrant(await getGrants(session), 'vat.sales.read'))
    return (
      <Page>
        {header}
        <Alert tone="info" role="alert">
          Your roles do not include the sales VAT register.
        </Alert>
      </Page>
    );
  let register: SalesVatRegister | undefined;
  let error: string | undefined;
  if (period.success) {
    try {
      register = await getSalesVatRegister(session, period.data.from, period.data.to);
    } catch (err) {
      error = failureOf(err).message;
    }
  }
  return (
    <Page>
      {header}
      <form method="get" action="/invoices/vat-register" className={styles.filter}>
        <Field label="From (AD)">
          {(control) => <DatePicker name="from" defaultValue={from} required {...control} />}
        </Field>
        <Field label="To (AD)">
          {(control) => <DatePicker name="to" defaultValue={to} required {...control} />}
        </Field>
        <Button type="submit" variant="secondary">
          Show register
        </Button>
      </form>
      {!period.success && (from !== '' || to !== '') ? (
        <Alert tone="warning" role="alert">
          Choose valid start and end dates, with the end on or after the start.
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="error" role="alert" title="The register did not load">
          {error}
        </Alert>
      ) : null}
      {register ? (
        <div className={styles.totals}>
          {register.totals.flatMap((t) => [
            <StatCard
              key={`${t.currency}-taxable`}
              label={`Taxable sales (${t.currency})`}
              value={poMoney(t.taxableAmount, t.currency, numberSystems)}
              icon="receipt"
            />,
            <StatCard
              key={`${t.currency}-vat`}
              label={`VAT charged (${t.currency})`}
              value={poMoney(t.vatAmount, t.currency, numberSystems)}
              icon="credit-card"
            />,
          ])}
          <StatCard
            key="npr-taxable"
            label="Taxable sales (NPR equivalent, all currencies)"
            value={poMoney(register.nprTotal.taxableAmount, 'NPR', numberSystems)}
            icon="receipt"
          />
          <StatCard
            key="npr-vat"
            label="VAT charged (NPR equivalent, all currencies)"
            value={poMoney(register.nprTotal.vatAmount, 'NPR', numberSystems)}
            icon="credit-card"
          />
        </div>
      ) : null}
      {register ? (
        <Panel
          title="Sales VAT"
          actions={
            <LinkButton
              variant="secondary"
              href={`/invoices/vat-register/export?${new URLSearchParams({ from, to })}`}
            >
              Export CSV
            </LinkButton>
          }
        >
          {register.rows.length === 0 ? (
            <EmptyState title="No issued documents in this period." icon="receipt" headingLevel={3}>
              Choose another period to view issued invoices and notes.
            </EmptyState>
          ) : (
            <Table caption="Sales VAT register" minWidth={2000}>
              <thead>
                <tr>
                  <Th>BS date</Th>
                  <Th>Document</Th>
                  <Th>Buyer / PAN</Th>
                  <Th>Currency</Th>
                  <Th align="end">Taxable</Th>
                  <Th align="end">VAT</Th>
                  <Th align="end">Exempt</Th>
                  <Th align="end">Zero-rated</Th>
                  <Th align="end">Total</Th>
                  <Th align="end">Rate to NPR</Th>
                  <Th align="end">Taxable (NPR)</Th>
                  <Th align="end">VAT (NPR)</Th>
                  <Th align="end">Exempt (NPR)</Th>
                  <Th align="end">Zero-rated (NPR)</Th>
                  <Th align="end">Total (NPR)</Th>
                </tr>
              </thead>
              <tbody>
                {register.rows.map((row) => (
                  <tr key={row.invoiceId}>
                    <Td nowrap>{row.issueDateBs}</Td>
                    <Td>
                      <Link href={`/invoices/${row.invoiceId}`}>{row.number}</Link>
                      <div className={styles.note}>{KIND_LABEL[row.kind]}</div>
                    </Td>
                    <Td>
                      <span className={styles.long}>{row.buyerName}</span>
                      <div className={styles.note}>{row.buyerPan ?? 'No PAN'}</div>
                    </Td>
                    <Td>{row.currency}</Td>
                    <Td align="end">{poMoney(row.taxableAmount, row.currency, numberSystems)}</Td>
                    <Td align="end">{poMoney(row.vatAmount, row.currency, numberSystems)}</Td>
                    <Td align="end">{poMoney(row.exemptAmount, row.currency, numberSystems)}</Td>
                    <Td align="end">{poMoney(row.zeroRatedAmount, row.currency, numberSystems)}</Td>
                    <Td align="end">{poMoney(row.totalAmount, row.currency, numberSystems)}</Td>
                    <Td align="end">{Number(row.fxRate)}</Td>
                    <Td align="end">{poMoney(row.nprTaxableAmount, 'NPR', numberSystems)}</Td>
                    <Td align="end">{poMoney(row.nprVatAmount, 'NPR', numberSystems)}</Td>
                    <Td align="end">{poMoney(row.nprExemptAmount, 'NPR', numberSystems)}</Td>
                    <Td align="end">{poMoney(row.nprZeroRatedAmount, 'NPR', numberSystems)}</Td>
                    <Td align="end">{poMoney(row.nprTotalAmount, 'NPR', numberSystems)}</Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {register.totals.map((t) => (
                  <tr key={t.currency}>
                    <Td>Total</Td>
                    <Td>{t.documents} documents</Td>
                    <Td />
                    <Td>{t.currency}</Td>
                    <Td align="end">{poMoney(t.taxableAmount, t.currency, numberSystems)}</Td>
                    <Td align="end">{poMoney(t.vatAmount, t.currency, numberSystems)}</Td>
                    <Td align="end">{poMoney(t.exemptAmount, t.currency, numberSystems)}</Td>
                    <Td align="end">{poMoney(t.zeroRatedAmount, t.currency, numberSystems)}</Td>
                    <Td align="end">{poMoney(t.totalAmount, t.currency, numberSystems)}</Td>
                    <Td colSpan={6} />
                  </tr>
                ))}
                <tr>
                  <Td>Total NPR</Td>
                  <Td>{register.nprTotal.documents} documents</Td>
                  <Td colSpan={7}>All currencies at their issue rates, for the filing</Td>
                  <Td />
                  <Td align="end">
                    {poMoney(register.nprTotal.taxableAmount, 'NPR', numberSystems)}
                  </Td>
                  <Td align="end">{poMoney(register.nprTotal.vatAmount, 'NPR', numberSystems)}</Td>
                  <Td align="end">
                    {poMoney(register.nprTotal.exemptAmount, 'NPR', numberSystems)}
                  </Td>
                  <Td align="end">
                    {poMoney(register.nprTotal.zeroRatedAmount, 'NPR', numberSystems)}
                  </Td>
                  <Td align="end">
                    {poMoney(register.nprTotal.totalAmount, 'NPR', numberSystems)}
                  </Td>
                </tr>
              </tfoot>
            </Table>
          )}
        </Panel>
      ) : !error && from === '' && to === '' ? (
        <EmptyState title="Choose a period." icon="receipt">
          The register and its CSV use the same server totals.
        </EmptyState>
      ) : null}
    </Page>
  );
}
