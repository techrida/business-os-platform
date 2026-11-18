import type { Metadata } from 'next';
import Link from 'next/link';

import { hasPermission } from '@/components/p2/customers/permissions';
import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { DatePicker } from '@/components/ui/date-picker';
import { Field } from '@/components/ui/field';
import { Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th } from '@/components/ui/table';
import { getVatRegister, VatPeriodSchema, type VatRegister } from '@/lib/api-payables';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';

import { poMoney } from '../../procurement/orders/_lib/model';
import styles from '../payables.module.css';

export const metadata: Metadata = { title: 'Purchase VAT register · Business OS' };
export const dynamic = 'force-dynamic';

export default async function VatRegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string | string[]; to?: string | string[] }>;
}) {
  const session = await requireStaffSession('/payables/vat-register');
  const params = await searchParams;
  const from = typeof params.from === 'string' ? params.from : '';
  const to = typeof params.to === 'string' ? params.to : '';
  const period = VatPeriodSchema.safeParse({ from, to });
  const header = (
    <PageHeader
      title="Purchase VAT register"
      description="Creditable input VAT on approved bills, by invoice date. Voided and draft bills are excluded. Dates below use the AD calendar; each result includes its BS date."
    />
  );
  if (!hasPermission(session.roles, 'payables.vat_register.read'))
    return (
      <Page>
        {header}
        <Alert tone="info" role="alert">
          Your roles do not include the purchase VAT register.
        </Alert>
      </Page>
    );
  let register: VatRegister | undefined;
  let error: string | undefined;
  if (period.success) {
    try {
      register = await getVatRegister(session, period.data.from, period.data.to);
    } catch (err) {
      error = failureOf(err).message;
    }
  }
  return (
    <Page>
      {header}
      <form method="get" action="/payables/vat-register" className={styles.filter}>
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
        <div className={styles.registerTotals}>
          <StatCard
            label="Taxable purchases"
            value={poMoney(register.total.taxableAmount, 'NPR')}
            icon="receipt"
          />
          <StatCard
            label="Creditable VAT"
            value={poMoney(register.total.vatAmount, 'NPR')}
            icon="credit-card"
          />
        </div>
      ) : null}
      {register ? (
        <Panel
          title="Purchase VAT"
          actions={
            <LinkButton
              variant="secondary"
              href={`/payables/vat-register/export?${new URLSearchParams({ from, to })}`}
            >
              Export CSV
            </LinkButton>
          }
        >
          {register.rows.length === 0 ? (
            <EmptyState title="No creditable VAT in this period." icon="receipt" headingLevel={3}>
              Choose another period to view approved bills.
            </EmptyState>
          ) : (
            <Table caption="Purchase VAT register" minWidth={850}>
              <thead>
                <tr>
                  <Th>Vendor / PAN</Th>
                  <Th>Invoice</Th>
                  <Th>BS date</Th>
                  <Th align="end">Taxable (NPR)</Th>
                  <Th align="end">VAT (NPR)</Th>
                </tr>
              </thead>
              <tbody>
                {register.rows.map((row) => (
                  <tr key={row.vendorBillId}>
                    <Td>
                      <span className={styles.long}>{row.vendorName}</span>
                      <div className={styles.note}>{row.vendorPan ?? 'Foreign vendor'}</div>
                    </Td>
                    <Td>
                      <Link href={`/payables/bills/${row.vendorBillId}`}>
                        {row.vendorInvoiceNo}
                      </Link>
                    </Td>
                    <Td nowrap>{row.invoiceDateBs}</Td>
                    <Td align="end">{poMoney(row.taxableAmount, 'NPR')}</Td>
                    <Td align="end">{poMoney(row.vatAmount, 'NPR')}</Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <Td>Total</Td>
                  <Td />
                  <Td />
                  <Td align="end">{poMoney(register.total.taxableAmount, 'NPR')}</Td>
                  <Td align="end">{poMoney(register.total.vatAmount, 'NPR')}</Td>
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
