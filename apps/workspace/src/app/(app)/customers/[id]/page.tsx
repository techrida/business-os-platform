import { randomUUID } from 'node:crypto';

import type { ContactDto, PartyAccountDto, VerificationCaseDto } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { addContactAction } from '@/components/p2/customers/actions';
import {
  getCustomerDetail,
  listContacts,
  listVerificationCases,
  type CustomerDetail,
  type Listing,
} from '@/components/p2/customers/api';
import { ContactForm } from '@/components/p2/customers/contact-form';
import { addressLines } from '@/components/p2/customers/display';
import {
  checklistProgress,
  isGuid,
  VERIFICATION_STATUS_LABEL,
} from '@/components/p2/customers/format';
import { hasPermission } from '@/components/p2/customers/permissions';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { money, when } from '@/lib/kernel-format';

import { OpenCaseForm } from '../../verification/open-case-form';

import styles from './customer.module.css';

export const metadata: Metadata = { title: 'Customer · Business OS' };
export const dynamic = 'force-dynamic';

const RELATIONSHIP = {
  prospect: { tone: 'info', text: 'Prospect' },
  active: { tone: 'success', text: 'Active' },
  inactive: { tone: 'neutral', text: 'Inactive' },
} as const;

/** A panel that could not load: its own words and its own way back, never the whole page. */
function PanelProblem({
  what,
  err,
  retry,
  forbiddenText,
}: {
  what: string;
  err: unknown;
  retry: string;
  forbiddenText: string;
}) {
  const f = failureOf(err);
  return f.status === 403 ? (
    <Alert tone="info" role="status" title={`Your roles do not include ${what}`}>
      {forbiddenText}
    </Alert>
  ) : (
    <Alert
      tone="error"
      role="alert"
      title={`The ${what} did not load`}
      actions={<Link href={retry}>Try again</Link>}
    >
      {f.message}
    </Alert>
  );
}

function Contacts({
  result,
  here,
  mayWrite,
  customerId,
}: {
  result: PromiseSettledResult<Listing<ContactDto>>;
  here: string;
  mayWrite: boolean;
  customerId: string;
}) {
  return (
    <Panel
      title="Contacts"
      description={
        result.status === 'fulfilled' && result.value.items.length > 0
          ? `${result.value.total ?? result.value.items.length} on file.`
          : undefined
      }
    >
      {result.status === 'rejected' ? (
        <PanelProblem
          what="contacts"
          err={result.reason as unknown}
          retry={here}
          forbiddenText="Contacts are for the sales and finance teams."
        />
      ) : result.value.items.length === 0 ? (
        <EmptyState title="No contacts yet." icon="users" headingLevel={3}>
          {mayWrite
            ? 'Add the person who signs and the person who pays, so quotations reach the right inbox.'
            : 'Nobody has been added for this customer yet.'}
        </EmptyState>
      ) : (
        <Table caption="Contacts" minWidth={640}>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>Phone</Th>
            </tr>
          </thead>
          <tbody>
            {result.value.items.map((c) => (
              <tr key={c.id}>
                <Td>
                  <CellTitle
                    title={<span className={styles.long}>{c.fullName}</span>}
                    meta={c.isPrimary ? <Badge tone="info">Main contact</Badge> : null}
                    note={c.title !== null ? <span className={styles.long}>{c.title}</span> : null}
                  />
                </Td>
                <Td>
                  {c.email !== null ? (
                    <a href={`mailto:${c.email}`} className={styles.long}>
                      {c.email}
                    </a>
                  ) : (
                    <span className={styles.quiet}>Not set</span>
                  )}
                </Td>
                <Td nowrap>
                  {c.phone !== null ? (
                    <a href={`tel:${c.phone}`} className={styles.numeric}>
                      {c.phone}
                    </a>
                  ) : (
                    <span className={styles.quiet}>Not set</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {mayWrite ? (
        <div className={styles.addContact}>
          <h3 className={styles.subhead}>Add a contact</h3>
          <ContactForm
            action={addContactAction}
            customerId={customerId}
            // One key per render of this page, so a double click saves the contact once.
            idempotencyKey={randomUUID()}
          />
        </div>
      ) : null}
    </Panel>
  );
}

function Accounts({ customer }: { customer: CustomerDetail }) {
  const accounts: PartyAccountDto[] | undefined = customer.accounts;
  const currency = customer.defaultCurrency;
  return (
    <Panel
      title="Terms by legal entity"
      description="Payment terms and credit limits are agreed with each legal entity separately."
    >
      {accounts === undefined ? (
        <EmptyState title="Terms could not be loaded." icon="building" headingLevel={3}>
          This customer&apos;s terms could not be loaded.
        </EmptyState>
      ) : accounts.length === 0 ? (
        <EmptyState title="No terms set yet." icon="building" headingLevel={3}>
          No legal entity has agreed payment terms or a credit limit with this customer.
        </EmptyState>
      ) : (
        <>
          <Table caption="Terms by legal entity" minWidth={520}>
            <thead>
              <tr>
                <Th>Legal entity</Th>
                <Th>Payment terms</Th>
                <Th align="end">Credit limit</Th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a, index) => (
                <tr key={a.organizationId}>
                  <Td>
                    <span className={styles.ref}>Legal entity {index + 1}</span>
                  </Td>
                  <Td>
                    {a.paymentTermId !== null ? (
                      <span className={styles.ref}>Terms assigned</span>
                    ) : (
                      <span className={styles.quiet}>Not set</span>
                    )}
                  </Td>
                  <Td align="end" nowrap>
                    {a.creditLimit === null ? (
                      <span className={styles.quiet}>Not set</span>
                    ) : currency !== null ? (
                      <span className={styles.numeric}>{money(a.creditLimit, currency)}</span>
                    ) : (
                      <span className={styles.numeric}>{a.creditLimit}</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className={styles.note}>
            {currency !== null
              ? `The platform sends no currency with a credit limit, so each is shown in this customer's default currency, ${currency}.`
              : 'The platform sends no currency with a credit limit, and this customer has no default currency, so the limits are shown as plain numbers.'}
          </p>
        </>
      )}
    </Panel>
  );
}

function Verification({
  result,
  here,
  maySee,
  open,
}: {
  result: PromiseSettledResult<Listing<VerificationCaseDto>>;
  here: string;
  maySee: boolean;
  /** Set when this person may start a case (customer.write on a customer that was not merged away). */
  open: { customerId: string; idempotencyKey: string } | null;
}) {
  return (
    <Panel title="Verification" as="aside">
      {result.status === 'rejected' ? (
        <PanelProblem
          what="verification status"
          err={result.reason as unknown}
          retry={here}
          forbiddenText="Verification is for the finance team."
        />
      ) : result.value.items.length === 0 ? (
        <div className={styles.cases}>
          <p className={styles.note}>
            {open !== null
              ? "No verification case yet. Start one to collect this customer's documents and send them for review."
              : "Not submitted for verification yet. A case appears here once the customer's documents are sent for review."}
          </p>
          {open !== null ? (
            <OpenCaseForm
              partyId={open.customerId}
              idempotencyKey={open.idempotencyKey}
              label="Start verification"
            />
          ) : null}
        </div>
      ) : (
        <>
          <ul className={styles.cases}>
            {result.value.items.map((c) => {
              const status = VERIFICATION_STATUS_LABEL[c.status];
              const p = checklistProgress(c.checklist);
              return (
                <li key={c.id} className={styles.case}>
                  <Badge tone={status.tone}>{status.text}</Badge>
                  <span className={styles.note}>
                    {p.required === 0
                      ? 'No required documents yet.'
                      : `${p.accepted} of ${p.required} required documents accepted.`}
                  </span>
                  {maySee ? (
                    <Link href={`/verification/${encodeURIComponent(c.id)}`}>
                      Open this case
                      <span className="sr-only"> ({status.text})</span>
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {open !== null && result.value.items.some((c) => c.status === 'expired') ? (
            <OpenCaseForm
              partyId={open.customerId}
              idempotencyKey={open.idempotencyKey}
              label="Reopen verification"
            />
          ) : null}
        </>
      )}
    </Panel>
  );
}

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string | string[]; saved?: string | string[] }>;
}) {
  const { id } = await params;
  // An id that is not a GUID cannot be a customer, so it never reaches the API.
  if (!isGuid(id)) notFound();
  const here = `/customers/${id}`;
  const session = await requireStaffSession(here);
  const flags = await searchParams;

  let customer: CustomerDetail;
  try {
    customer = await getCustomerDetail(session, id);
  } catch (err) {
    const f = failureOf(err);
    if (f.status === 404) notFound();
    return (
      <Page width="narrow">
        <Breadcrumb items={[{ label: 'Customers', href: '/customers' }, { label: 'Customer' }]} />
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={f.status === 403 ? 'You cannot open this customer' : 'This customer did not load'}
          actions={f.status !== 403 ? <a href={here}>Try again</a> : null}
        >
          {f.status === 403
            ? 'Customers are for the sales and finance teams. Ask an administrator if you need access.'
            : f.message}
        </Alert>
      </Page>
    );
  }

  // The panels below load on their own: one failing leaves the profile and the other panels usable.
  const [contacts, cases] = await Promise.allSettled([
    listContacts(session, id),
    listVerificationCases(session, { partyId: id }),
  ]);

  const mayWrite = hasPermission(session.roles, 'customer.write');
  const maySeeVerification = hasPermission(session.roles, 'verification.read');
  const relationship = RELATIONSHIP[customer.relationship];
  const merged = customer.mergedIntoId !== null;

  const facts: Fact[] = [
    { key: 'number', label: 'Customer number', value: customer.number },
    {
      key: 'pan',
      label: 'PAN or VAT number',
      value: customer.panVatNo ?? <span className={styles.quiet}>Not set</span>,
    },
    {
      key: 'industry',
      label: 'Industry',
      value: customer.industry ?? <span className={styles.quiet}>Not set</span>,
    },
    {
      key: 'currency',
      label: 'Default currency',
      value: customer.defaultCurrency ?? <span className={styles.quiet}>Not set</span>,
    },
    {
      key: 'owner',
      label: 'Account owner',
      value:
        customer.ownerUserId !== null ? (
          <span>Name unavailable</span>
        ) : (
          <span className={styles.quiet}>Not assigned</span>
        ),
    },
    {
      key: 'updated',
      label: 'Last updated',
      value: <time dateTime={customer.updatedAt}>{when(customer.updatedAt)}</time>,
    },
    {
      key: 'address',
      label: 'Address',
      wide: true,
      value: (
        <span className={styles.address}>
          {addressLines(customer.address).map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      ),
    },
  ];

  return (
    <Page>
      <Breadcrumb
        items={[{ label: 'Customers', href: '/customers' }, { label: customer.legalName }]}
      />
      <PageHeader
        title={<span className={styles.long}>{customer.legalName}</span>}
        status={<Badge tone={relationship.tone}>{relationship.text}</Badge>}
        description={customer.number}
        actions={
          mayWrite && !merged ? (
            <LinkButton href={`${here}/edit`} variant="secondary">
              Edit customer
            </LinkButton>
          ) : null
        }
      />

      {flags.created !== undefined ? (
        <Alert tone="success" role="status" title="Customer added.">
          Add a contact below, then send their documents for verification.
        </Alert>
      ) : flags.saved !== undefined ? (
        <Alert tone="success" role="status" title="Changes saved." />
      ) : null}

      {merged ? (
        <Alert tone="warning" role="status" title="This record was merged into another customer.">
          <Link href={`/customers/${encodeURIComponent(customer.mergedIntoId ?? '')}`}>
            Open the customer it was merged into
          </Link>
        </Alert>
      ) : null}

      <div className={styles.columns}>
        <div className={styles.main}>
          <Panel title="Profile">
            <FactList facts={facts} />
          </Panel>
          <Contacts
            result={contacts}
            here={here}
            mayWrite={mayWrite && !merged}
            customerId={customer.id}
          />
          <Accounts customer={customer} />
        </div>

        <div className={styles.sideStack}>
          <Verification
            result={cases}
            here={here}
            maySee={maySeeVerification}
            // One key per render of this page: a double click or a retry after a network error
            // names the same request.
            open={
              mayWrite && !merged ? { customerId: customer.id, idempotencyKey: randomUUID() } : null
            }
          />
        </div>
      </div>
    </Page>
  );
}
