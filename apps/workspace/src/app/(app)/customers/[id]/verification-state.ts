import type { VerificationCaseDto } from '@bos/contracts';

/** Where a customer stands on KYB (Know Your Business) as far as this reader may know. */
export type KybStanding =
  | { kind: 'verified' }
  /** Not verified. `case` is the live case (readers only); `none`: no case yet; `unknown`: a case exists that this person may not read. */
  | {
      kind: 'unverified';
      state: 'none' | 'draft' | 'submitted' | 'rejected' | 'expired' | 'unreadable';
      caseId: string | null;
    }
  /** The page cannot tell (the list failed, or the person may not read it and nothing says it is open). */
  | { kind: 'unknown' };

const LIVE_ORDER = ['submitted', 'draft', 'rejected', 'expired'] as const;

/**
 * The customer's KYB standing for the page.
 * - A reader (verification read on this record) gets it from the case list: any approved case means verified;
 *   otherwise the most live case decides (submitted, then draft, rejected, expired); no case means `none`.
 * - Someone who may not read the case learns only what the API sends on the record: no case at all, or the
 *   portal-invite block `kyb_not_verified`. Anything else is `unknown`, so the page never guesses.
 */
export function kybStanding(input: {
  mayRead: boolean;
  cases: readonly VerificationCaseDto[] | null;
  caseExists: boolean | null;
  portalBlock: string | null;
}): KybStanding {
  if (input.mayRead) {
    if (input.cases === null) return { kind: 'unknown' };
    if (input.cases.some((c) => c.status === 'approved')) return { kind: 'verified' };
    for (const status of LIVE_ORDER) {
      const found = input.cases.find((c) => c.status === status);
      if (found) return { kind: 'unverified', state: status, caseId: found.id };
    }
    return { kind: 'unverified', state: 'none', caseId: null };
  }
  if (input.caseExists === false) return { kind: 'unverified', state: 'none', caseId: null };
  if (input.portalBlock === 'kyb_not_verified') {
    return { kind: 'unverified', state: 'unreadable', caseId: null };
  }
  return { kind: 'unknown' };
}

export interface KybBanner {
  title: string;
  text: string;
  /** What the link says and where it goes; null for a person who may not read verification. */
  action: { label: string; href: string } | null;
}

const BLOCKS = 'Portal access stays closed until the KYB verification is approved.';

/** The page-level alert for a not-verified customer, in the words of the real state. */
export function kybBanner(
  standing: Extract<KybStanding, { kind: 'unverified' }>,
  opts: { mayRead: boolean; mayOpen: boolean },
): KybBanner {
  const title = "This customer isn't verified yet";
  const caseHref = standing.caseId ? `/verification/${encodeURIComponent(standing.caseId)}` : null;
  const card = '#verification';
  switch (standing.state) {
    case 'none':
      return {
        title,
        text: `No verification case has been started. ${BLOCKS}`,
        action: opts.mayOpen ? { label: 'Start verification', href: card } : null,
      };
    case 'draft':
      return {
        title,
        text: `The verification case is open and not yet submitted. ${BLOCKS}`,
        action:
          opts.mayRead && caseHref ? { label: 'Continue verification', href: caseHref } : null,
      };
    case 'submitted':
      return {
        title,
        text: `The verification case has been submitted and is waiting for review. ${BLOCKS}`,
        action: opts.mayRead && caseHref ? { label: 'Review submission', href: caseHref } : null,
      };
    case 'rejected':
      return {
        title,
        text: `The last verification case was rejected. ${BLOCKS}`,
        action: opts.mayRead && caseHref ? { label: 'Open the case', href: caseHref } : null,
      };
    case 'expired':
      return {
        title,
        text: `The last verification has expired. ${BLOCKS}`,
        action: opts.mayOpen ? { label: 'Reopen verification', href: card } : null,
      };
    case 'unreadable':
      return {
        title,
        text: `A verification case exists but is not approved. ${BLOCKS}`,
        action: null,
      };
  }
}
