// Unit tests of the pure bank-account rules (P4 V2): normalisation, masking, the AAD, the DTO and the evidence check.
// Run: pnpm --filter @bos/api exec vitest run src/modules/vendors/bank/bank.rules.test.ts
import { VendorBankAccountDtoSchema } from '@bos/contracts';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import {
  bankAccountAad,
  evidenceIsClean,
  normalizeAccountNumber,
  proposerCannotVerify,
  stripAccountSpaces,
  toBankAccountDto,
  toSnapshot,
  type BankAccountRow,
} from './bank.rules';

const row = (over: Partial<BankAccountRow> = {}): BankAccountRow => ({
  id: '0b6f8a52-6c1a-4f43-9a8e-0f3e3a3b2c11',
  tenantId: '1b6f8a52-6c1a-4f43-9a8e-0f3e3a3b2c11',
  vendorId: '2b6f8a52-6c1a-4f43-9a8e-0f3e3a3b2c11',
  bankName: 'Nabil Bank',
  accountName: 'Himal Traders',
  accountNumberEnc: Buffer.from('v1:k1:secret'),
  accountFingerprint: 'fp1:k1:abc',
  last4: '1234',
  currency: 'NPR',
  status: 'proposed',
  proposedBy: '3b6f8a52-6c1a-4f43-9a8e-0f3e3a3b2c11',
  proposedVia: 'staff',
  verifiedBy: null,
  callbackEvidenceDocumentId: null,
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe('normalizeAccountNumber', () => {
  it('strips spaces and hyphens, upper-cases, and masks to the last four digits', () => {
    expect(normalizeAccountNumber(' 0012 3456-7890 1234 ')).toEqual({
      number: '0012345678901234',
      last4: '1234',
    });
    expect(normalizeAccountNumber('np-ab-00123456')).toEqual({
      number: 'NPAB00123456',
      last4: '3456',
    });
  });

  it('is 400 for a number that does not end in four digits (the column CHECK is numeric)', () => {
    expect(() => normalizeAccountNumber('12345678AB')).toThrow(BadRequestException);
  });

  it('is 400 for fewer than six characters once formatting is gone, or other characters', () => {
    expect(() => normalizeAccountNumber('12-34-5')).toThrow(BadRequestException);
    expect(() => normalizeAccountNumber('1234_5678')).toThrow(BadRequestException);
  });
});

describe('stripAccountSpaces', () => {
  it('removes whitespace from accountNumber only and leaves other bodies alone', () => {
    expect(stripAccountSpaces({ accountNumber: '12 34 56 78', bankName: 'A B' })).toEqual({
      accountNumber: '12345678',
      bankName: 'A B',
    });
    expect(stripAccountSpaces('x')).toBe('x');
    expect(stripAccountSpaces({ accountNumber: 5 })).toEqual({ accountNumber: 5 });
  });
});

describe('bankAccountAad', () => {
  it('names the table and the row', () => {
    expect(bankAccountAad('abc')).toBe('vendor_bank_accounts:abc');
  });
});

describe('toBankAccountDto', () => {
  it('passes the strict contract and carries neither ciphertext nor fingerprint', () => {
    const dto = toBankAccountDto(row());
    expect(VendorBankAccountDtoSchema.parse(dto)).toEqual(dto);
    const json = JSON.stringify(dto);
    expect(json).not.toContain('secret');
    expect(json).not.toContain('fp1');
    expect(dto.accountLast4).toBe('1234');
  });
});

describe('toSnapshot', () => {
  it('is 409 no_verified_bank_account for an account that is not active', () => {
    for (const status of ['proposed', 'retired', 'rejected'] as const) {
      try {
        toSnapshot(row({ status }));
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'no_verified_bank_account',
        });
      }
    }
  });

  it('returns the active account without the number', () => {
    const snap = toSnapshot(
      row({
        status: 'active',
        verifiedBy: '4b6f8a52-6c1a-4f43-9a8e-0f3e3a3b2c11',
        callbackEvidenceDocumentId: '5b6f8a52-6c1a-4f43-9a8e-0f3e3a3b2c11',
      }),
    );
    expect(snap.accountLast4).toBe('1234');
    expect(JSON.stringify(snap)).not.toContain('secret');
  });
});

describe('evidenceIsClean', () => {
  const doc = 'd1';
  it('reads the newest version that was not rejected of that one document', () => {
    expect(evidenceIsClean([{ documentId: doc, version: 1, status: 'clean' }], doc)).toBe(true);
    expect(
      evidenceIsClean(
        [
          { documentId: doc, version: 1, status: 'clean' },
          { documentId: doc, version: 2, status: 'quarantined' },
        ],
        doc,
      ),
    ).toBe(false);
    expect(
      evidenceIsClean(
        [
          { documentId: doc, version: 1, status: 'clean' },
          { documentId: doc, version: 2, status: 'rejected' },
        ],
        doc,
      ),
    ).toBe(true);
  });

  it('is false for a document that is not an attachment of the account', () => {
    expect(evidenceIsClean([{ documentId: 'other', version: 1, status: 'clean' }], doc)).toBe(
      false,
    );
    expect(evidenceIsClean([], doc)).toBe(false);
  });
});

describe('proposerCannotVerify', () => {
  it('is a 403 with the separation_of_duties reason', () => {
    const e = proposerCannotVerify();
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(e.getResponse()).toMatchObject({ reason: 'separation_of_duties' });
  });
});
