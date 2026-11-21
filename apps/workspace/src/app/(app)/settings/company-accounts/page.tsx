import { randomUUID } from 'node:crypto';

import type { CompanyBankAccount, ExpenseAccount } from '@bos/contracts';
import type { Metadata } from 'next';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { listCompanyBankAccounts, listExpenseAccounts } from '@/lib/api-company-accounts';
import { currencyChoices } from '@/lib/enabled-currencies';
import { loadEnabledCurrencies } from '@/lib/enabled-currencies.server';

import { BackToSettings } from '../_components/back-link';
import styles from '../_components/settings.module.css';
import admin from '../admin.module.css';
import { requireSection } from '../guard';
import { section } from '../section';
import { SectionError } from '../ui';
import {
  AddBankAccountForm,
  AddExpenseAccountForm,
  ReactivateButton,
  RenameableName,
  RetireButton,
} from './account-forms';
import local from './company-accounts.module.css';

export const metadata: Metadata = { title: 'Bank and expense accounts · Business OS' };

const bankLabel = (a: CompanyBankAccount) => `${a.name} (${a.bankName} ····${a.last4})`;
const expenseLabel = (a: ExpenseAccount) => `${a.code} ${a.name}`;

function StatusBadge({ status }: { status: 'active' | 'retired' }) {
  return status === 'active' ? (
    <Badge tone="success">Active</Badge>
  ) : (
    <Badge tone="neutral">Retired</Badge>
  );
}

function BankTable({ rows, caption }: { rows: readonly CompanyBankAccount[]; caption: string }) {
  return (
    <Table caption={caption} className={admin.local ?? ''}>
      <thead>
        <tr>
          <Th>Name</Th>
          <Th>Bank</Th>
          <Th>Account ending</Th>
          <Th>Currency</Th>
          <Th>Status</Th>
          <Th align="end">
            <span className="sr-only">Actions</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const retired = row.status === 'retired';
          return (
            <tr key={row.id} className={retired ? local.retired : undefined}>
              <Th scope="row">
                {retired ? row.name : <RenameableName kind="bank" id={row.id} name={row.name} />}
              </Th>
              <Td>{row.bankName}</Td>
              <Td>
                <span className={local.ending}>····{row.last4}</span>
              </Td>
              <Td>{row.currency}</Td>
              <Td>
                <StatusBadge status={row.status} />
              </Td>
              <Td align="end">
                <div className={local.rowActions}>
                  {retired ? (
                    <ReactivateButton kind="bank" id={row.id} label={bankLabel(row)} />
                  ) : (
                    <RetireButton kind="bank" id={row.id} label={bankLabel(row)} />
                  )}
                </div>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function ExpenseTable({ rows, caption }: { rows: readonly ExpenseAccount[]; caption: string }) {
  return (
    <Table caption={caption} className={admin.local ?? ''} minWidth={480}>
      <thead>
        <tr>
          <Th>Code</Th>
          <Th>Name</Th>
          <Th>Status</Th>
          <Th align="end">
            <span className="sr-only">Actions</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const retired = row.status === 'retired';
          return (
            <tr key={row.id} className={retired ? local.retired : undefined}>
              <Th scope="row">{row.code}</Th>
              <Td>
                {retired ? (
                  row.name
                ) : (
                  <RenameableName kind="expense" id={row.id} name={row.name} prefix={row.code} />
                )}
              </Td>
              <Td>
                <StatusBadge status={row.status} />
              </Td>
              <Td align="end">
                <div className={local.rowActions}>
                  {retired ? (
                    <ReactivateButton kind="expense" id={row.id} label={expenseLabel(row)} />
                  ) : (
                    <RetireButton kind="expense" id={row.id} label={expenseLabel(row)} />
                  )}
                </div>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
const byCode = (a: { code: string }, b: { code: string }) =>
  a.code.localeCompare(b.code, undefined, { numeric: true });

export default async function CompanyAccountsPage() {
  const session = await requireSection('company-accounts');
  // Lists include retired rows so they can be shown and reactivated. Each list fails on its own.
  const [banks, expenses, enabled] = await Promise.all([
    section('view bank accounts', () => listCompanyBankAccounts(session, { includeRetired: true })),
    section('view expense accounts', () => listExpenseAccounts(session, { includeRetired: true })),
    loadEnabledCurrencies(session),
  ]);
  const currencies = currencyChoices(enabled);

  const activeBanks = banks.ok ? banks.data.filter((a) => a.status === 'active').sort(byName) : [];
  const retiredBanks = banks.ok
    ? banks.data.filter((a) => a.status === 'retired').sort(byName)
    : [];
  const activeExpenses = expenses.ok
    ? expenses.data.filter((a) => a.status === 'active').sort(byCode)
    : [];
  const retiredExpenses = expenses.ok
    ? expenses.data.filter((a) => a.status === 'retired').sort(byCode)
    : [];

  return (
    <Page className={admin.page}>
      <BackToSettings />
      <PageHeader
        title="Bank and expense accounts"
        description="The company bank accounts payments leave from, and the expense accounts bills are booked to. Retire an account you no longer use; documents that already name it keep working."
      />
      <div className={styles.column}>
        <Panel
          title="Company bank accounts"
          description="Offered on payment requests. Only the last four characters of each account number are kept."
        >
          {!banks.ok ? (
            <SectionError message={banks.message} />
          ) : (
            <>
              <AddBankAccountForm currencies={currencies} idempotencyKey={randomUUID()} />
              {activeBanks.length > 0 ? (
                <BankTable rows={activeBanks} caption="Company bank accounts in use" />
              ) : (
                <EmptyState
                  title={
                    retiredBanks.length > 0 ? 'No bank accounts in use' : 'No bank accounts yet'
                  }
                  headingLevel={3}
                >
                  Add the account your payments leave from above, for example your main operating
                  account.
                </EmptyState>
              )}
              {retiredBanks.length > 0 ? (
                <>
                  <h3 className={styles.sub}>Retired</h3>
                  <BankTable rows={retiredBanks} caption="Retired company bank accounts" />
                </>
              ) : null}
            </>
          )}
        </Panel>

        <Panel
          title="Expense accounts"
          description="Offered on bill lines. The code is fixed once added; the name can change."
        >
          {!expenses.ok ? (
            <SectionError message={expenses.message} />
          ) : (
            <>
              <AddExpenseAccountForm idempotencyKey={randomUUID()} />
              {activeExpenses.length > 0 ? (
                <ExpenseTable rows={activeExpenses} caption="Expense accounts in use" />
              ) : (
                <EmptyState
                  title={
                    retiredExpenses.length > 0
                      ? 'No expense accounts in use'
                      : 'No expense accounts yet'
                  }
                  headingLevel={3}
                >
                  Add the first expense account above, for example 5100 Office supplies.
                </EmptyState>
              )}
              {retiredExpenses.length > 0 ? (
                <>
                  <h3 className={styles.sub}>Retired</h3>
                  <ExpenseTable rows={retiredExpenses} caption="Retired expense accounts" />
                </>
              ) : null}
            </>
          )}
        </Panel>
      </div>
    </Page>
  );
}
