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

/** How a released delivery was released, or null when the API did not say (an older answer). */
export function releasedText(release: SalesOrderDetail['deliveryRelease']): string | null {
  if (release === null || release === undefined) return null;
  if (release.kind === 'advance_paid') return 'Released: advance paid';
  const by = release.releasedByName !== null ? ` by ${release.releasedByName}` : '';
  const on = release.releasedAt !== null ? ` on ${when(release.releasedAt, 'date')}` : '';
  const why = release.reason !== null ? `: ${release.reason}` : '';
  return `Released${by}${on}${why}`;
}
