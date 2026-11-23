import { randomUUID } from 'node:crypto';

import {
  type ContactDto,
  type CountryCode,
  countryName,
  formatPartyPhoneForPrint,
  type PartyAccountDto,
  type VerificationCaseDto,
} from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { NumberSystems } from '@bos/locale';

import { addContactAction, invitePortalAdminAction } from '@/components/p2/customers/actions';
import {
  customerCan,
  getCustomerDetail,
  listContacts,
  listCustomerOwners,
  listCustomerPaymentTerms,
  listVerificationCases,
  type CustomerDetail,
  type Listing,
} from '@/components/p2/customers/api';
import { CommercialTerms } from '@/components/p2/customers/commercial-terms';
import { ContactForm } from '@/components/p2/customers/contact-form';
import { CustomerAddress } from '@/components/p2/customers/customer-address';
import { primaryPhone } from '@/components/p2/customers/display';
import { PortalInviteForm } from '@/components/p2/customers/portal-invite-form';
import {
  checklistProgress,
  isGuid,
  VERIFICATION_STATUS_LABEL,
} from '@/components/p2/customers/format';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { Breadcrumb, Page } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';
import { userNames } from '@/lib/business-labels';

import { OpenCaseForm } from '../../verification/open-case-form';
import { CompanyLogoUpload } from '../_components/company-logo-upload';

import { CustomerFeedback } from './customer-feedback';
import { kybBanner, kybStanding } from './verification-state';
import styles from './customer.module.css';

export const metadata: Metadata = { title: 'Organization · Business OS' };
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
  customerCountry,
}: {
  result: PromiseSettledResult<Listing<ContactDto>>;
  here: string;
  mayWrite: boolean;
  customerId: string;
  /** A contact based elsewhere names their own country; one in the customer's country does not. */
  customerCountry: CountryCode;
}) {
  // What the add-contact form needs from the loaded list. Unknown (the list failed) reads as "no",
  // and the API still refuses a second main contact (409) or a missing first email (422).
  const loaded = result.status === 'fulfilled' ? result.value.items : [];
  const hasPrimary = loaded.some((c) => c.isPrimary);
  const requireEmail = result.status === 'fulfilled' && !loaded.some((c) => c.email !== null);
  return (
    <Panel
      title="Contacts"
      className={styles.contacts}
      actions={
        mayWrite ? (
          <ContactForm
            action={addContactAction}
            customerId={customerId}
            idempotencyKey={randomUUID()}
            hasPrimary={hasPrimary}
            requireEmail={requireEmail}
            customerCountry={customerCountry}
            inDialog
          />
        ) : null
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
        <Table caption="Contacts" minWidth={400} className={styles.contactTable ?? ''}>
          <thead>
            <tr>
              <Th>Contact</Th>
              <Th>Job title</Th>
              <Th>Phone</Th>
            </tr>
          </thead>
          <tbody>
            {result.value.items.map((c) => {
              const phone = primaryPhone(c.phones);
              return (
                <tr key={c.id}>
                  <Td>
                    <div className={styles.identity}>
                      <Avatar name={c.fullName} shape="circle" />
                      <div className={styles.identityText}>
                        <span className={styles.contactName}>{c.fullName}</span>
                        {c.email !== null ? (
                          <a href={`mailto:${c.email}`} className={styles.email}>
                            {c.email}
                          </a>
                        ) : null}
                        {c.country !== customerCountry ? (
                          <span className={styles.note}>{countryName(c.country)}</span>
                        ) : null}
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <div className={styles.contactTitle}>
                      {c.title !== null ? <span>{c.title}</span> : null}
                      {c.isPrimary ? <Badge tone="info">Main contact</Badge> : null}
                      {c.title === null && !c.isPrimary ? (
                        <span className={styles.quiet}>Not set</span>
                      ) : null}
                    </div>
                  </Td>
                  <Td nowrap>
                    {phone !== null ? (
                      <a href={`tel:${phone.e164}`} className={styles.numeric}>
                        {formatPartyPhoneForPrint(phone.e164)}
                      </a>
                    ) : (
                      <span className={styles.quiet}>Not set</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

function Accounts({
  customer,
  terms,
  numberSystems,
}: {
  customer: CustomerDetail;
  terms: Map<string, string>;
  numberSystems: NumberSystems;
}) {
  const accounts: PartyAccountDto[] | undefined = customer.accounts;
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
              {accounts.map((a) => (
                <tr key={a.organizationId}>
                  <Td>
                    <span>{a.organizationName ?? 'Legal entity name unavailable'}</span>
                  </Td>
                  <Td>
                    {a.paymentTermId !== null ? (
                      <span>{terms.get(a.paymentTermId) ?? 'Payment terms unavailable'}</span>
                    ) : (
                      <span className={styles.quiet}>Not set</span>
                    )}
                  </Td>
                  <Td align="end" nowrap>
                    {a.creditLimit === null ? (
                      <span className={styles.quiet}>Not set</span>
                    ) : (
                      <span className={styles.numeric}>
                        {money(a.creditLimit, 'NPR', numberSystems)}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className={styles.note}>
            Credit limits are held in NPR, whatever the customer&apos;s default currency is.
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
  caseExists,
  open,
}: {
  result: PromiseSettledResult<Listing<VerificationCaseDto>>;
  here: string;
  maySee: boolean;
  /** The customer has a case, whether or not this person may open it. */
  caseExists: boolean;
  /** Set when the API says this person may start or reopen this customer's case. */
  open: { customerId: string; idempotencyKey: string } | null;
}) {
  return (
    <Panel title="Verification" as="aside" id="verification" className={styles.verificationCard}>
      {result.status === 'rejected' ? (
        <PanelProblem
          what="verification status"
          err={result.reason as unknown}
          retry={here}
          forbiddenText="Verification is for the finance team."
        />
      ) : result.value.items.length === 0 && !maySee && caseExists ? (
        <p className={styles.note}>
          This customer has a verification case. The account owner or a reviewer can open it.
        </p>
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

/**
 * The account owner's name: from the record itself first (the API sends it to every staff reader), then from the
 * admin directory, which only administrators can read.
 */
function ownerName(
  customer: CustomerDetail,
  directory: PromiseSettledResult<Map<string, string>>,
): string {
  const owner = customer.ownerUserId;
  if (owner === null) return 'Owner name unavailable';
  return (
    customer.people?.find((p) => p.userId === owner)?.name ??
    (directory.status === 'fulfilled' ? directory.value.get(owner) : undefined) ??
    'Owner name unavailable'
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
  const numberSystems = await getNumberSystems();
  const flags = await searchParams;

  let customer: CustomerDetail;
  try {
    customer = await getCustomerDetail(session, id);
  } catch (err) {
    const f = failureOf(err);
    if (f.status === 404) notFound();
    return (
      <Page width="narrow">
        <Breadcrumb
          items={[{ label: 'Organizations', href: '/customers' }, { label: 'Organization' }]}
        />
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            f.status === 403
              ? 'You cannot open this organization'
              : 'This organization did not load'
          }
          actions={f.status !== 403 ? <a href={here}>Try again</a> : null}
        >
          {f.status === 403
            ? 'Organizations are for the sales and finance teams. Ask an administrator if you need access.'
            : f.message}
        </Alert>
      </Page>
    );
  }

  // What this person may do here, decided by the API on this customer (scope included).
  const can = customerCan(customer);
  // The panels below load on their own: one failing leaves the profile and the other panels usable.
  // The case list is asked for only when the API says this person may read this customer's case.
  const merged = customer.mergedIntoId !== null;
  // The people list is asked for only when this person may change the owner (it is a 403 otherwise).
  const mayChangeOwner = can.owner === true && !merged;
  const [contacts, cases, people, paymentTerms, owners] = await Promise.allSettled([
    listContacts(session, id),
    can.readVerification
      ? listVerificationCases(session, { partyId: id })
      : Promise.resolve<Listing<VerificationCaseDto>>({ items: [], total: 0 }),
    userNames(session),
    listCustomerPaymentTerms(session),
    mayChangeOwner ? listCustomerOwners(session) : Promise.resolve([]),
  ]);

  const standing = kybStanding({
    mayRead: can.readVerification,
    cases: cases.status === 'fulfilled' ? cases.value.items : null,
    caseExists: customer.verification === undefined ? null : customer.verification.exists,
    portalBlock: customer.portalAccess?.blocked ?? null,
  });
  // A not-verified customer puts the Verification card first and says so at the top of the page.
  const unverified = standing.kind === 'unverified' && !merged ? standing : null;
  const banner =
    unverified !== null
      ? kybBanner(unverified, { mayRead: can.readVerification, mayOpen: can.openVerification })
      : null;

  const mayWrite = can.write;
  const maySeeVerification = can.readVerification;
  const relationship = RELATIONSHIP[customer.relationship];
  const ownerLabel = customer.ownerUserId !== null ? ownerName(customer, people) : null;
  // Portal access (F1-Q31): the invite offers only the customer's own contacts; one without an email is listed but
  // cannot be chosen. The API decides every invite.
  const portalAccess = customer.portalAccess;
  const inviteOptions =
    contacts.status === 'fulfilled'
      ? contacts.value.items.map((c) => ({
          id: c.id,
          label: c.email !== null ? `${c.fullName} (${c.email})` : c.fullName,
          name: c.fullName,
          detail: [c.title, c.email].filter(Boolean).join(' · ') || undefined,
          hasEmail: c.email !== null && c.email !== '',
        }))
      : [];
  const mayInvite = portalAccess?.canInvite === true && mayWrite && !merged;

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
      key: 'updated',
      label: 'Last updated',
      value: <time dateTime={customer.updatedAt}>{when(customer.updatedAt)}</time>,
    },
    {
      key: 'address',
      label: 'Address',
      value: (
        <CustomerAddress
          address={customer.address}
          country={customer.country}
          className={styles.address}
        />
      ),
    },
  ];

  const verificationCard = (
    <Verification
      result={cases}
      here={here}
      maySee={maySeeVerification}
      caseExists={customer.verification?.exists === true}
      // One key per render, so retrying names the same request.
      open={can.openVerification ? { customerId: customer.id, idempotencyKey: randomUUID() } : null}
    />
  );

  return (
    <Page>
      <Breadcrumb
        items={[{ label: 'Organizations', href: '/customers' }, { label: customer.legalName }]}
      />
      {flags.created !== undefined || flags.saved !== undefined ? (
        <CustomerFeedback created={flags.created !== undefined} href={here} />
      ) : null}

      {merged ? (
        <Alert tone="warning" role="status" title="This record was merged into another customer.">
          <Link href={`/customers/${encodeURIComponent(customer.mergedIntoId ?? '')}`}>
            Open the customer it was merged into
          </Link>
        </Alert>
      ) : null}

      {banner !== null ? (
        <Alert
          tone="warning"
          role="status"
          title={banner.title}
          actions={banner.action ? <a href={banner.action.href}>{banner.action.label}</a> : null}
        >
          {banner.text}
        </Alert>
      ) : null}

      <Tabs defaultSelectedKey="contacts">
        <TabList aria-label="Organization sections">
          <Tab id="contacts">Contacts</Tab>
          <Tab id="terms">Terms by legal entity</Tab>
        </TabList>
        <div
          className={[styles.columns, unverified !== null ? styles.columnsUnverified : '']
            .filter(Boolean)
            .join(' ')}
        >
          {unverified !== null ? <div className={styles.attention}>{verificationCard}</div> : null}
          <Card className={styles.profile} as="aside" aria-labelledby="organization-name">
            <div className={styles.profileIdentity}>
              <div className={styles.profileLogo}>
                <CompanyLogoUpload
                  ownerType="customer_logo"
                  companyId={customer.id}
                  legalName={customer.legalName}
                  logoDocumentId={customer.logoDocumentId ?? null}
                  label="Customer logo"
                  readOnly={!(mayWrite && !merged)}
                  size="xlarge"
                />
              </div>
              <h1 id="organization-name" className={styles.profileName}>
                {customer.legalName}
              </h1>
              <Badge tone={relationship.tone}>{relationship.text}</Badge>
              {mayWrite && !merged ? (
                <LinkButton href={`${here}/edit`} className={styles.editLink}>
                  Edit Details
                </LinkButton>
              ) : null}
            </div>
            <Panel
              title={
                <span className={styles.infoHeading}>
                  <Icon name="user" size={16} />
                  Organization Information
                </span>
              }
              className={styles.info}
            >
              <FactList facts={facts} className={styles.facts ?? ''} />
            </Panel>
          </Card>
          <div className={styles.main}>
            <TabPanel id="contacts">
              <Contacts
                result={contacts}
                here={here}
                mayWrite={mayWrite && !merged}
                customerId={customer.id}
                customerCountry={customer.country}
              />
            </TabPanel>
            <TabPanel id="terms">
              <Accounts
                numberSystems={numberSystems}
                customer={customer}
                terms={
                  new Map(
                    paymentTerms.status === 'fulfilled'
                      ? paymentTerms.value.map((t) => [t.id, t.label])
                      : [],
                  )
                }
              />
            </TabPanel>
          </div>
          <div className={styles.verification}>
            <CommercialTerms
              customerId={customer.id}
              customerVersion={customer.version}
              merged={merged}
              can={can}
              owner={{ userId: customer.ownerUserId, name: ownerLabel }}
              actingEntity={customer.actingEntity}
              accounts={customer.accounts}
              paymentTerms={paymentTerms}
              owners={mayChangeOwner ? owners : null}
              numberSystems={numberSystems}
              portal={{
                access: portalAccess,
                ownerLabel,
                invite:
                  mayInvite && inviteOptions.length > 0 ? (
                    <PortalInviteForm
                      action={invitePortalAdminAction}
                      customerId={customer.id}
                      contacts={inviteOptions}
                      createContact={{
                        action: addContactAction,
                        customerId: customer.id,
                        customerCountry: customer.country,
                      }}
                      // One key per render, so retrying names the same request.
                      idempotencyKey={randomUUID()}
                      first={portalAccess?.hasUser !== true}
                    />
                  ) : null,
                noContact:
                  mayInvite && contacts.status === 'fulfilled' && inviteOptions.length === 0,
              }}
            />
            {unverified === null ? verificationCard : null}
          </div>
        </div>
      </Tabs>
    </Page>
  );
}
