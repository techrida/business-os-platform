// Unit tests of evidenceSatisfies: each policy asks for its own evidence kind, `both` asks for a contract AND a
// purchase order, extra kinds never hurt, and no kinds never satisfy any policy.
import { EVIDENCE_POLICIES, type EvidenceKind, type EvidencePolicy } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { evidenceSatisfies, missingEvidence } from './evidence-policy';

describe('evidenceSatisfies', () => {
  it.each<[EvidencePolicy, EvidenceKind[], boolean]>([
    ['signed_quote', ['signed_quote'], true],
    ['signed_quote', ['purchase_order'], false],
    ['signed_quote', ['contract', 'purchase_order'], false],
    ['contract', ['contract'], true],
    ['contract', ['signed_quote'], false],
    ['purchase_order', ['purchase_order'], true],
    ['purchase_order', ['contract', 'signed_quote'], false],
    ['both', ['contract', 'purchase_order'], true],
    ['both', ['purchase_order', 'contract', 'signed_quote'], true],
    ['both', ['contract'], false],
    ['both', ['purchase_order'], false],
    ['both', ['signed_quote'], false],
    ['contract', ['contract', 'signed_quote'], true],
  ])('%s with %j is %s', (policy, kinds, expected) => {
    expect(evidenceSatisfies(policy, kinds)).toBe(expected);
  });

  it.each(EVIDENCE_POLICIES)('never accepts an empty list under %s', (policy) => {
    expect(evidenceSatisfies(policy, [])).toBe(false);
  });

  it('names the kinds still missing, in a stable order', () => {
    expect(missingEvidence('both', ['purchase_order'])).toEqual(['contract']);
    expect(missingEvidence('both', [])).toEqual(['contract', 'purchase_order']);
    expect(missingEvidence('signed_quote', ['signed_quote'])).toEqual([]);
  });
});
