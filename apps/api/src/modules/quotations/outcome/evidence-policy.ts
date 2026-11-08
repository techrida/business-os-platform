// The evidence an acceptance needs (delta C-14: one `sales.evidence_policy` setting and one function, called by
// the staff outcome route and the portal accept alike). D18: by default a signed quote. Pure, so every policy is
// pinned by evidence-policy.test.ts.
import { EVIDENCE_KINDS, type EvidenceKind, type EvidencePolicy } from '@bos/contracts';

/** The kinds each policy requires; `both` is a contract AND a purchase order. Extra kinds are always allowed. */
const REQUIRED: Record<EvidencePolicy, readonly EvidenceKind[]> = {
  contract: ['contract'],
  purchase_order: ['purchase_order'],
  signed_quote: ['signed_quote'],
  both: ['contract', 'purchase_order'],
};

/** The required kinds absent from `kinds`, in EVIDENCE_KINDS order. Empty when the policy is met. */
export function missingEvidence(
  policy: EvidencePolicy,
  kinds: readonly EvidenceKind[],
): EvidenceKind[] {
  const given = new Set(kinds);
  return EVIDENCE_KINDS.filter((k) => REQUIRED[policy].includes(k) && !given.has(k));
}

/** Whether `kinds` carry every kind `policy` requires. */
export function evidenceSatisfies(policy: EvidencePolicy, kinds: readonly EvidenceKind[]): boolean {
  return missingEvidence(policy, kinds).length === 0;
}
