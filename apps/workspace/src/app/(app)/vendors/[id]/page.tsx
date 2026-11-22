import { randomUUID } from 'node:crypto';

import {
  ALLOWED_MIME,
  countryName,
  formatAddressLines,
  formatPartyPhoneForPrint,
  MAX_UPLOAD_BYTES,
  type BankAccountStatus,
  type CountryCode,
  type VendorAccountDto,
  type VendorBankAccountDto,
  type VendorDto,
  type VerificationCaseDto,
} from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { listVerificationCases, type Listing } from '@/components/p2/customers/api';
import { isGuid, VERIFICATION_STATUS_LABEL } from '@/components/p2/customers/format';
import { Alert } from '@/components/ui/alert';
import { SuccessNotice } from '@/components/p4/success-notice';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import {
  getVendor,
  getVendorReviewReadiness,
  listBankAccounts,
  listVendorAccounts,
  listVendorContacts,
  type VendorContact,
} from '@/lib/api-vendors';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';
import { getPermissionCheck } from '@/lib/live-permissions';

import {
  BankDecision,
  ContactForm,
  LifecycleForm,
  PortalForm,
  ProposeBankForm,
} from '../_components/panel-forms';
import { CompanyLogoUpload } from '../../customers/_components/company-logo-upload';
import { vendorFailure } from '../_lib/failure';
import {
  isEditable,
  lifecycleOptions,
  mayGrantPortal,
  sendForReviewHint,
  VENDOR_KIND_LABEL,
  VENDOR_STATUS_LABEL,
  type VendorGrants,
} from '../_lib/model';
import styles from '../vendors.module.css';

export const metadata: Metadata = { title: 'Vendor · Business OS' };
export const dynamic = 'force-dynamic';

const BANK_STATUS: Record<
  BankAccountStatus,
  { tone: 'neutral' | 'warning' | 'success' | 'error'; text: string }
> = {
  proposed: { tone: 'warning', text: 'Awaiting verification' },
  active: { tone: 'success', text: 'Verified, in use' },
  retired: { tone: 'neutral', text: 'Retired' },
  rejected: { tone: 'error', text: 'Rejected' },
};

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
  const f = vendorFailure(err, 'load');
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
  vendorId,
  vendorCountry,
  mayWrite,
}: {
  result: PromiseSettledResult<VendorContact[]>;
  here: string;
  vendorId: string;
  vendorCountry: CountryCode;
  mayWrite: boolean;
}) {
  return (
    <Panel
      title="Contacts"
      description={
        result.status === 'fulfilled' && result.value.length > 0
          ? `${result.value.length} on file.`
          : undefined
      }
    >
      {result.status === 'rejected' ? (
        <PanelProblem
          what="contacts"
          err={result.reason as unknown}
          retry={here}
          forbiddenText="Contacts are for the procurement and finance teams."
        />
      ) : result.value.length === 0 ? (
        <EmptyState title="No contacts yet." icon="users" headingLevel={3}>
          {mayWrite
            ? 'Add the person who handles orders and the person who sends invoices. A contact with an email can be given portal access.'
            : 'Nobody has been added for this vendor yet.'}
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
            {result.value.map((c) => (
              <tr key={c.id}>
                <Td>
                  <CellTitle
                    title={<span className={styles.long}>{c.name}</span>}
                    meta={c.isPrimary ? <Badge tone="info">Main contact</Badge> : null}
                    note={c.role !== null ? <span className={styles.long}>{c.role}</span> : null}
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
                  {/* The API lists the primary number first. */}
                  {c.phones[0] !== undefined ? (
                    <a href={`tel:${c.phones[0].e164}`} className={styles.numeric}>
                      {formatPartyPhoneForPrint(c.phones[0].e164)}
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
        <div className={styles.addBlock}>
          <h3 className={styles.subhead}>Add a contact</h3>
          {/* One key per render of this page, so a double click saves the contact once. */}
          <ContactForm
            vendorId={vendorId}
            vendorCountry={vendorCountry}
            idempotencyKey={randomUUID()}
          />
        </div>
      ) : null}
    </Panel>
  );
}

function Accounts({
  result,
  here,
}: {
  result: PromiseSettledResult<VendorAccountDto[]>;
  here: string;
}) {
  return (
    <Panel
      title="Terms by legal entity"
      description="Payment terms and currency are agreed with each legal entity separately. You see the terms of the entity you are working in."
    >
      {result.status === 'rejected' ? (
        <PanelProblem
          what="terms"
          err={result.reason as unknown}
          retry={here}
          forbiddenText="Terms are for the procurement and finance teams."
        />
      ) : result.value.length === 0 ? (
        <EmptyState title="No terms set yet." icon="building" headingLevel={3}>
          This legal entity has not agreed payment terms with this vendor.
        </EmptyState>
      ) : (
        <Table caption="Terms by legal entity" minWidth={520}>
          <thead>
            <tr>
              <Th>Legal entity</Th>
              <Th align="end">Payment terms</Th>
              <Th>Currency</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {result.value.map((a) => (
              <tr key={a.organizationId}>
                <Td>
                  <span>Legal entity</span>
                </Td>
                <Td align="end" nowrap>
                  <span className={styles.numeric}>{a.paymentTermsDays} days</span>
                </Td>
                <Td nowrap>{a.defaultCurrency}</Td>
                <Td nowrap>
                  <Badge tone={a.active ? 'success' : 'neutral'}>
                    {a.active ? 'Active' : 'Inactive'}
                  </Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

function Kyb({
  result,
  here,
  maySee,
  status,
}: {
  result: PromiseSettledResult<Listing<VerificationCaseDto>> | null;
  here: string;
  maySee: boolean;
  status: VendorDto['status'];
}) {
  return (
    <Panel title="KYB review" as="aside">
      {result === null ? (
        <p className={styles.note}>
          Reviewing KYB cases is for the finance team. The vendor&apos;s status above shows where it
          stands.
        </p>
      ) : result.status === 'rejected' ? (
        <PanelProblem
          what="KYB review"
          err={result.reason as unknown}
          retry={here}
          forbiddenText="KYB review is for the finance team."
        />
      ) : result.value.items.length === 0 ? (
        <p className={styles.note}>
          {status === 'draft'
            ? 'No KYB case yet. Start the KYB review below to open one and collect the vendor documents.'
            : 'No KYB case is on file for this vendor.'}
        </p>
      ) : (
        <ul className={styles.stack}>
          {result.value.items.map((c) => {
            const s = VERIFICATION_STATUS_LABEL[c.status];
            return (
              <li key={c.id} className={styles.item}>
                <Badge tone={s.tone}>{s.text}</Badge>
                {maySee ? (
                  <Link href={`/verification/${encodeURIComponent(c.id)}`}>
                    Open the KYB case
                    <span className="sr-only"> ({s.text})</span>
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function Banks({
  result,
  here,
  vendor,
  grants,
}: {
  result: PromiseSettledResult<VendorBankAccountDto[]>;
  here: string;
  vendor: VendorDto;
  grants: VendorGrants;
}) {
  const open = vendor.status !== 'archived';
  return (
    <Panel
      title="Bank accounts"
      description="Shown by their last four characters only. A payment goes only to an account that someone other than its proposer has verified."
    >
      {result.status === 'rejected' ? (
        <PanelProblem
          what="bank accounts"
          err={result.reason as unknown}
          retry={here}
          forbiddenText="Bank accounts are for the procurement and finance teams."
        />
      ) : result.value.length === 0 ? (
        <EmptyState title="No bank account yet." icon="building" headingLevel={3}>
          {grants.propose && open
            ? 'Propose one below. Finance verifies it after a call-back to the bank.'
            : 'Procurement proposes an account; finance verifies it after a call-back to the bank.'}
        </EmptyState>
      ) : (
        <ul className={styles.stack}>
          {result.value.map((a) => {
            const s = BANK_STATUS[a.status];
            return (
              <li key={a.id} className={styles.account}>
                <div className={styles.accountHead}>
                  <Badge tone={s.tone}>{s.text}</Badge>
                  <span className={styles.long}>
                    {a.bankName}
                    {a.branch !== null ? `, ${a.branch}` : ''}
                  </span>
                </div>
                <span className={styles.long}>{a.accountName}</span>
                <span className={styles.note}>
                  Account ending <span className={styles.last4}>{a.accountLast4}</span>
                  {a.verifiedAt !== null ? (
                    <>
                      {' '}
                      · verified <time dateTime={a.verifiedAt}>{when(a.verifiedAt, 'date')}</time>
                    </>
                  ) : null}
                  {a.proposedVia === 'portal' ? ' · proposed by the vendor' : ''}
                </span>
                {a.status === 'proposed' && grants.verify ? (
                  <BankDecision
                    vendorId={vendor.id}
                    accountId={a.id}
                    verifyKey={randomUUID()}
                    rejectKey={randomUUID()}
                    maxBytes={MAX_UPLOAD_BYTES}
                    allowedMime={[...ALLOWED_MIME]}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {grants.propose && open ? (
        <div className={styles.addBlock}>
          <h3 className={styles.subhead}>Propose a bank account</h3>
          <ProposeBankForm vendorId={vendor.id} idempotencyKey={randomUUID()} />
        </div>
      ) : null}
    </Panel>
  );
}

export default async function VendorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string | string[]; saved?: string | string[] }>;
}) {
  const { id } = await params;
  // An id that is not a GUID cannot be a vendor, so it never reaches the API.
  if (!isGuid(id)) notFound();
  const here = `/vendors/${id}`;
  const session = await requireStaffSession(here);
  const flags = await searchParams;

  let vendor: VendorDto;
  try {
    vendor = await getVendor(session, id);
  } catch (err) {
    const f = vendorFailure(err, 'load');
    if (f.status === 404) notFound();
    return (
      <Page width="narrow">
        <Breadcrumb items={[{ label: 'Vendors', href: '/vendors' }, { label: 'Vendor' }]} />
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={f.status === 403 ? 'You cannot open this vendor' : 'This vendor did not load'}
          actions={f.status !== 403 ? <a href={here}>Try again</a> : null}
        >
          {f.status === 403
            ? 'Vendors are for the procurement and finance teams. Ask an administrator if you need access.'
            : f.message}
        </Alert>
      </Page>
    );
  }

  const allowed = await getPermissionCheck(session);
  const grants: VendorGrants = {
    read: allowed('vendor.read'),
    write: vendor.can?.write ?? allowed('vendor.write'),
    activate: vendor.can?.activate ?? allowed('vendor.activate'),
    propose: vendor.can?.proposeBank ?? allowed('vendor.bank.propose'),
    verify: vendor.can?.verifyBank ?? allowed('vendor.bank.verify'),
  };
  const maySeeKyb = allowed('verification.read');
  const lifecycleCan = vendor.can ?? grants;
  // "Send for review" needs the KYB case submitted, the state the API checks; asked only when it could show.
  const askReadiness = vendor.status === 'pending_kyc' && lifecycleCan.write;
  // The panels below load on their own: one failing leaves the profile and the other panels usable.
  const [contacts, accounts, banks, cases, readiness] = await Promise.allSettled([
    listVendorContacts(session, id),
    listVendorAccounts(session, id),
    listBankAccounts(session, id),
    maySeeKyb ? listVerificationCases(session, { partyId: id }) : Promise.resolve(null),
    askReadiness ? getVendorReviewReadiness(session, id) : Promise.resolve(null),
  ]);
  // Unknown (not asked, or the read failed) counts as not submitted: the button stays hidden.
  const kybSubmitted =
    readiness.status === 'fulfilled' && readiness.value !== null
      ? readiness.value.kybSubmitted
      : undefined;

  const status = VENDOR_STATUS_LABEL[vendor.status];
  const editable = isEditable(vendor.status);
  const options = lifecycleOptions(vendor.status, lifecycleCan, kybSubmitted);
  const reviewHint = sendForReviewHint(vendor.status, lifecycleCan.write, kybSubmitted);
  const canEdit = grants.write && editable;
  const hasPrimaryMove = options.some((o) => o.tone === 'primary');
  const hasHeaderActions = options.length > 0 || canEdit;
  const contactList = contacts.status === 'fulfilled' ? contacts.value : [];
  const activationBlock = vendor.can?.activateBlockedBySod
    ? vendor.status === 'suspended'
      ? {
          title: 'Reinstatement requires another approver',
          message:
            'You created this vendor, so another person with approval access must reinstate it.',
        }
      : {
          title: 'Approval requires another approver',
          message:
            'You created this vendor, so another person with approval access must approve it.',
        }
    : vendor.can?.activateBlockedByKyb
      ? {
          title: 'KYB review must be approved first',
          message:
            'Approve the vendor’s KYB case before this vendor can be approved or reinstated.',
        }
      : vendor.can?.activateBlockedByKycExpired
        ? {
            title: 'Tax clearance has expired',
            message:
              'Renew the vendor’s tax clearance before this vendor can be approved or reinstated.',
          }
        : null;

  const facts: Fact[] = [
    { key: 'kind', label: 'Kind', value: VENDOR_KIND_LABEL[vendor.kind] },
    {
      key: 'pan',
      label: vendor.kind === 'foreign' ? 'Tax ID' : 'PAN',
      value:
        vendor.pan !== null ? (
          <span className={styles.numeric}>{vendor.pan}</span>
        ) : (
          <span className={styles.quiet}>Not set</span>
        ),
    },
    { key: 'country', label: 'Country', value: countryName(vendor.country) },
    {
      key: 'address',
      label: 'Address',
      value:
        vendor.address !== null ? (
          <span className={styles.long}>
            {formatAddressLines(vendor.address, vendor.country).join(', ')}
          </span>
        ) : (
          <span className={styles.quiet}>Not set</span>
        ),
    },
    { key: 'vat', label: 'VAT', value: vendor.vatRegistered ? 'Registered' : 'Not registered' },
    {
      key: 'approved',
      label: 'Approved',
      value:
        vendor.approvedAt !== null ? (
          <time dateTime={vendor.approvedAt}>{when(vendor.approvedAt)}</time>
        ) : (
          <span className={styles.quiet}>Not yet</span>
        ),
    },
  ];

  return (
    <Page>
      <Breadcrumb items={[{ label: 'Vendors', href: '/vendors' }, { label: vendor.legalName }]} />

      <PageHeader
        title={vendor.legalName}
        status={<Badge tone={status.tone}>{status.text}</Badge>}
        description={vendor.tradeName ?? undefined}
        actions={
          hasHeaderActions ? (
            <>
              {options.map((o) => (
                <LifecycleForm
                  key={o.command}
                  vendorId={vendor.id}
                  status={vendor.status}
                  option={o}
                  idempotencyKey={randomUUID()}
                />
              ))}
              {canEdit ? (
                <LinkButton
                  href={`${here}/edit`}
                  variant={hasPrimaryMove ? 'secondary' : 'primary'}
                >
                  Edit Details
                </LinkButton>
              ) : null}
            </>
          ) : null
        }
      />

      {flags.created !== undefined ? (
        <SuccessNotice message="Vendor added. Add a contact and a bank account before starting review." />
      ) : flags.saved !== undefined ? (
        <SuccessNotice message="Changes saved." />
      ) : null}

      {activationBlock !== null ? (
        <Alert tone="info" role="status" title={activationBlock.title}>
          {activationBlock.message}
        </Alert>
      ) : null}

      <div className={styles.columns}>
        <Card className={styles.profile} as="section" aria-labelledby="vendor-name">
          <div className={styles.profileIdentity}>
            <div className={styles.profileLogo}>
              <CompanyLogoUpload
                ownerType="vendor_logo"
                companyId={vendor.id}
                legalName={vendor.legalName}
                logoDocumentId={vendor.logoDocumentId ?? null}
                label="Vendor logo"
                readOnly={!canEdit}
              />
            </div>
            <h2 id="vendor-name" className={styles.profileName}>
              Vendor details
            </h2>
          </div>
          <Panel title="Profile" className={styles.info}>
            <FactList facts={facts} />
          </Panel>
        </Card>

        <div className={styles.main}>
          <Contacts
            result={contacts}
            here={here}
            vendorId={vendor.id}
            vendorCountry={vendor.country}
            mayWrite={canEdit}
          />
          <Accounts result={accounts} here={here} />
          <Banks result={banks} here={here} vendor={vendor} grants={grants} />
        </div>

        <div className={styles.sideStack}>
          <Panel
            title="Status"
            as="aside"
            description={`This vendor is ${status.text.toLowerCase()}.`}
          >
            <p className={styles.note}>
              {vendor.status === 'archived'
                ? 'This vendor is archived. Nothing more can be done.'
                : activationBlock !== null
                  ? activationBlock.message
                  : reviewHint !== null
                    ? reviewHint
                    : options.length === 0
                      ? 'No status action is open to your current permissions at this status.'
                      : 'Use the header actions to move this vendor to the next stage.'}
            </p>
          </Panel>
          <Kyb
            result={
              maySeeKyb ? (cases as PromiseSettledResult<Listing<VerificationCaseDto>>) : null
            }
            here={here}
            maySee={maySeeKyb}
            status={vendor.status}
          />
          {mayGrantPortal(vendor.status, grants.write) ? (
            <Panel
              title="Portal access"
              as="aside"
              description="Lets one contact sign in to the vendor portal. While KYC is pending they can only complete onboarding."
            >
              {contactList.length === 0 ? (
                <p className={styles.note}>Add a contact with an email address first.</p>
              ) : (
                <PortalForm
                  vendorId={vendor.id}
                  idempotencyKey={randomUUID()}
                  contacts={contactList.map((c) => ({
                    id: c.id,
                    label: c.name,
                    hasEmail: c.email !== null,
                  }))}
                />
              )}
            </Panel>
          ) : null}
        </div>
      </div>
    </Page>
  );
}
