import type { DELIVERY_RELEASE_BLOCKERS, SalesOrderDetail } from '@bos/contracts';

import { when } from '@/lib/kernel-format';

/**
 * The words around releasing a held delivery (F1-Q32). The API sends the roles that may release this order at its
 * amount, not the threshold itself, so the copy names roles and never an amount it does not have.
 */

type Blocker = (typeof DELIVERY_RELEASE_BLOCKERS)[number];
type Can = NonNullable<SalesOrderDetail['can']>;
type ReleaserRole = NonNullable<Can['releaseDeliveryAllowedRoles']>[number];

const ROLE_WORDS: Record<ReleaserRole, string> = {
  finance: 'Finance',
  management: 'Management',
  founder: 'the Founder',
};

function rolesInWords(roles: readonly ReleaserRole[]): string {
  return roles.map((r) => ROLE_WORDS[r]).join(' or ');
}

const GENERIC_RULE =
  'Finance can release orders up to the amount set in Sales settings; above it, Management. The Founder can release any order.';

/**
 * Who may release this order, for the dialog: from the roles the API names, else the general rule. When the
 * small-team rule lets the creator release (`soleEligible`), the dialog does not tell them the creator cannot.
 */
export function whoCanRelease(
  roles: readonly ReleaserRole[] | undefined,
  soleEligible = false,
): string {
  const named =
    roles !== undefined && roles.length > 0
      ? `At this order's amount, ${rolesInWords(roles)} can release its delivery.`
      : GENERIC_RULE;
  return soleEligible ? named : `${named} The person who created the order cannot release it.`;
}

/** Beside the reason when the caller is the only person who may release this order (F1-Q11 a). */
export const SOLE_ELIGIBLE_HINT =
  'You are the only person who can release this; a reason is required.';

/** Why the Release delivery button is off, in one sentence. */
export function releaseBlockedText(
  blockedBy: Blocker | null | undefined,
  roles: readonly ReleaserRole[] | undefined,
): string {
  switch (blockedBy) {
    case 'requester':
      return 'You created this order, so someone else must release it.';
    case 'amount':
      return roles !== undefined && roles.length > 0
        ? `At this order's amount, only ${rolesInWords(roles)} can release it.`
        : 'Your role cannot release an order of this amount.';
    case 'permission':
      return 'Only Finance, Management or the Founder can release a delivery.';
    default:
      return 'You cannot release this delivery.';
  }
}

/**
 * On the reason field when the API refuses a sole-eligible release without one (400 `sole_eligible_reason_required`,
 * F1-Q11 a): the reason stands in for the second person.
 */
export const SOLE_ELIGIBLE_REASON_REQUIRED =
  'You are the only person who can release this delivery, so say why it is released now.';

/** A 403 with no reason, or one this workspace does not know (a newer API): either release rule may apply. */
const GENERIC_REFUSAL =
  'You cannot release this delivery: you created this order, or your role cannot release an order of this amount. Reload this page to see who can.';

/**
 * Words for a 403 from `POST /v1/sales-orders/:id/delivery-release`, by the `reason` the error filter lets through.
 * The release rule's own reasons, and the authz reasons the release check can reach once the order is readable,
 * get release words; a missing or unknown reason gets the general refusal. Null for any other contract reason
 * (`entity_not_permitted` from the tenancy check, `mfa_required` ...): the kernel words fit those, and blaming the
 * release rule would be wrong. `separation_of_duties` cannot reach a release (it is not an
 * SoD permission), and an inactive or out-of-scope reader is refused with a 404 before the release check.
 */
export function releaseRefusedText(reason: string | undefined): string | null {
  switch (reason) {
    case 'requester_cannot_release':
      return 'You created this order, so someone else must release it. Reload this page to see who can.';
    case 'role_cannot_release_amount':
      // The API checks the threshold as it is now, so a Founder's edit since the page loaded lands here too.
      return 'Your role cannot release an order of this amount. The amount set in Sales settings may have changed; reload this page to see who can.';
    case 'no_permission':
      return 'Only Finance, Management or the Founder can release a delivery. Ask an administrator if you need to.';
    case 'out_of_scope':
      return 'Your release access does not reach this order, so someone else must release its delivery.';
    case undefined:
      return GENERIC_REFUSAL;
    default:
      return null;
  }
}

/** How a released delivery was released, or null when the API did not say (an older answer). */
export function releasedText(release: SalesOrderDetail['deliveryRelease']): string | null {
  if (release === null || release === undefined) return null;
  if (release.kind === 'advance_paid') return 'Released: advance paid';
  if (release.kind === 'no_advance') return 'Released: no advance on this order';
  const by = release.releasedByName !== null ? ` by ${release.releasedByName}` : '';
  const on = release.releasedAt !== null ? ` on ${when(release.releasedAt, 'date')}` : '';
  const why = release.reason !== null ? `: ${release.reason}` : '';
  return `Released${by}${on}${why}`;
}
