// Unit test of the call-back evidence owner policy (P4 V2b): procurement attaches the evidence with the grant that
// proposes the account, not the generic `documents.upload`. The database is never reached by these assertions.
// Run: pnpm --filter @bos/api exec vitest run src/modules/vendors/bank/bank-evidence.policy.test.ts
import { describe, expect, it } from 'vitest';

import type { Db } from '../../../platform/db/db.module';
import { bankEvidenceOwnerPolicy } from './bank.module';
import { BANK_EVIDENCE_OWNER_TYPE } from './bank.rules';

describe('bankEvidenceOwnerPolicy', () => {
  const policy = bankEvidenceOwnerPolicy({} as Db);

  it('is the vendor_bank_account owner type', () => {
    expect(policy.ownerType).toBe(BANK_EVIDENCE_OWNER_TYPE);
    expect(BANK_EVIDENCE_OWNER_TYPE).toBe('vendor_bank_account');
  });

  it('authorises staff uploads with vendor.bank.propose instead of documents.upload', () => {
    expect(policy.uploadPermission).toBe('vendor.bank.propose');
  });

  it('takes no generated files and no portal uploads (deny by default)', () => {
    expect(policy.allowsSystemActor).toBeUndefined();
    expect(policy.allowsCounterparty).toBeUndefined();
  });
});
