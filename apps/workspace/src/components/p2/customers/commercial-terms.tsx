import type {
  CustomerActingEntity,
  CustomerCan,
  CustomerOwnerOption,
  CustomerPortalAccess,
  PartyAccountDto,
  PaymentTerm,
} from '@bos/contracts';
import type { NumberSystems } from '@bos/locale';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Panel } from '@/components/ui/panel';
import { money } from '@/lib/kernel-format';

import { CREDIT_LIMIT_NOTE, sameLimit } from './terms-form';
import { changeOwnerAction, setCreditLimitAction, setPaymentTermAction } from './terms-actions';
import { CreditLimitForm, OwnerForm, PaymentTermForm } from './terms-forms';
import styles from './commercial-terms.module.css';

/**
 * The customer's commercial terms in one card: account owner, payment terms and credit limit with the legal entity
 * the reader acts for, and portal access. Each field is changed on its own, and only where the API's `can` flag for
 * that field says this person may (a control the API would refuse is never shown). The API audits every change.
 * Other entities' terms stay in the read-only "Terms by legal entity" table.
 */
export interface CommercialTermsProps {
  customerId: string;
  /** The customer's row version: an owner change sends it. */
  customerVersion: number;
  merged: boolean;
  can: CustomerCan;
  /** `name` is the label to show (null when the customer has no owner). */
  owner: { userId: string | null; name: string | null };
  /** Absent when the API did not say which entity the reader acts for. */
  actingEntity: CustomerActingEntity | undefined;
  /** Absent when the API sent no terms. */
  accounts: readonly PartyAccountDto[] | undefined;
  paymentTerms: PromiseSettledResult<readonly PaymentTerm[]>;
  /** The people an owner may be changed to; null when this person may not change owners, so it was not asked for. */
  owners: PromiseSettledResult<readonly CustomerOwnerOption[]> | null;
  portal: {
    access: CustomerPortalAccess | undefined;
    /** The account owner by name, for the first-admin sentence; null without an owner. */
    ownerLabel: string | null;
    /** The invite control; null when this person may not invite now. */
    invite: ReactNode;
    /** This person may invite, but the customer has no contact to invite yet. */
    noContact: boolean;
  };
  numberSystems: NumberSystems;
}

/** One row: what it is, its value with an optional caption, and the change control when there is one. */
function Row({
  term,
  children,
  note,
  action,
}: {
  term: string;
  children: ReactNode;
  note?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <dt className={styles.term}>{term}</dt>
      <dd className={styles.value}>
        {children}
        {note ? <span className={styles.note}>{note}</span> : null}
      </dd>
      {action ? <dd className={styles.action}>{action}</dd> : null}
    </div>
  );
}

const quiet = (text: string) => <span className={styles.quiet}>{text}</span>;

/** F1-Q31 in a sentence, for someone who may change the customer (only they get `blocked`). */
function portalNote(
  access: CustomerPortalAccess,
  ownerLabel: string | null,
  noContact: boolean,
): string | null {
  if (access.canInvite && noContact) return 'Add a contact with an email first, then invite them.';
  if (access.hasUser) return null;
  if (access.blocked === 'kyb_not_verified') {
    return "Portal access opens once this customer's KYB verification is approved.";
  }
  if (access.blocked === 'owner_only' && ownerLabel !== null) {
    return `The account owner, ${ownerLabel}, invites the first portal admin.`;
  }
  if (access.blocked === 'owner_missing') {
    return 'It has no account owner, and the account owner invites the first portal admin.';
  }
  return access.canInvite ? 'Invite one of its contacts as the portal admin.' : null;
}

function PortalStatus({ access }: { access: CustomerPortalAccess }) {
  if (access.hasUser) return <Badge tone="success">Active</Badge>;
  if (access.blocked === 'kyb_not_verified') return <Badge tone="warning">Waiting for KYB</Badge>;
  return <Badge tone="neutral">Not invited</Badge>;
}

export function CommercialTerms({
  customerId,
  customerVersion,
  merged,
  can,
  owner,
  actingEntity,
  accounts,
  paymentTerms,
  owners,
  portal,
  numberSystems,
}: CommercialTermsProps) {
  const entityName = actingEntity?.name || 'your legal entity';
  // Without the entity or the terms list the version is unknown, so nothing about the terms can be changed.
  const termsKnown = actingEntity !== undefined && accounts !== undefined;
  const account = termsKnown
    ? accounts.find((a) => a.organizationId === actingEntity.organizationId)
    : undefined;
  const version = account?.version ?? null;
  const termId = account?.paymentTermId ?? null;
  const limit = account?.creditLimit ?? null;
  const terms = paymentTerms.status === 'fulfilled' ? paymentTerms.value : [];

  const mayOwner = can.owner === true && !merged;
  const mayTerms = can.paymentTerms === true && !merged && termsKnown;
  const mayLimit = can.creditLimit === true && !merged && termsKnown;

  // ---- owner
  const ownerValue = owner.userId === null ? quiet('Not assigned') : <span>{owner.name}</span>;
  let ownerAction: ReactNode = null;
  let ownerNote: ReactNode = null;
  if (mayOwner && owners?.status === 'fulfilled') {
    ownerAction = (
      <OwnerForm
        action={changeOwnerAction}
        customerId={customerId}
        version={customerVersion}
        current={owner}
        people={owners.value}
      />
    );
  } else if (mayOwner) {
    ownerNote = 'The list of people did not load. Reload the page to change the owner.';
  }

  // ---- payment terms
  const termValue = !termsKnown
    ? quiet('Unavailable')
    : termId === null
      ? quiet('Not set')
      : (terms.find((t) => t.id === termId)?.label ?? quiet('Payment terms unavailable'));
  let termAction: ReactNode = null;
  let termNote: ReactNode = null;
  if (mayTerms && paymentTerms.status === 'fulfilled') {
    termAction = (
      <PaymentTermForm
        action={setPaymentTermAction}
        customerId={customerId}
        version={version}
        current={termId}
        terms={terms}
        entityName={entityName}
      />
    );
  } else if (mayTerms) {
    termNote = 'The list of payment terms did not load. Reload the page to change them.';
  }

  // ---- credit limit: no limit (null) and a zero limit read differently, because they act differently.
  const limitValue = !termsKnown ? (
    quiet('Unavailable')
  ) : limit === null ? (
    quiet('No limit set')
  ) : (
    <span className={styles.amount}>{money(limit, 'NPR', numberSystems)}</span>
  );
  const limitNote = !termsKnown
    ? 'The terms did not load. Reload the page to try again.'
    : limit === null
      ? 'Orders are never held for credit.'
      : sameLimit(limit, '0')
        ? `A zero limit holds every order until someone overrides the hold. ${CREDIT_LIMIT_NOTE}`
        : CREDIT_LIMIT_NOTE;

  return (
    <Panel
      title="Commercial terms"
      as="aside"
      description={
        actingEntity !== undefined
          ? `Payment terms and credit limit agreed with ${entityName}, in NPR.`
          : undefined
      }
    >
      <dl className={styles.rows}>
        <Row term="Account owner" note={ownerNote} action={ownerAction}>
          {ownerValue}
        </Row>
        <Row term="Payment terms" note={termNote} action={termAction}>
          {termValue}
        </Row>
        <Row
          term="Credit limit"
          note={limitNote}
          action={
            mayLimit ? (
              <CreditLimitForm
                action={setCreditLimitAction}
                customerId={customerId}
                version={version}
                current={limit}
                entityName={entityName}
              />
            ) : null
          }
        >
          {limitValue}
        </Row>
        <Row
          term="Portal access"
          note={
            portal.access !== undefined
              ? portalNote(portal.access, portal.ownerLabel, portal.noContact)
              : undefined
          }
          action={portal.invite}
        >
          {portal.access !== undefined ? <PortalStatus access={portal.access} /> : quiet('Unknown')}
        </Row>
      </dl>
    </Panel>
  );
}
