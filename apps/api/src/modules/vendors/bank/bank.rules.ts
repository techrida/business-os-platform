// Pure rules of the vendor bank accounts (P4 unit V2, AD9): how an account number is normalised before it is
// encrypted and fingerprinted, the AAD that binds a ciphertext to its row, the DTO that shows the last four digits
// only, and the errors the service answers with. No I/O here, so the unit test covers every rule.
import { type VendorBankAccountDto } from '@bos/contracts';
import { type vendorBankAccounts } from '@bos/db';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';

export type BankAccountRow = typeof vendorBankAccounts.$inferSelect;

/** The document owner type of the call-back evidence: a document attached to one bank account. */
export const BANK_EVIDENCE_OWNER_TYPE = 'vendor_bank_account';

/**
 * The account number as it is encrypted, fingerprinted and masked: spaces and hyphens are formatting and go,
 * letters are upper-cased, so "0012 3456-7890" and "001234567890" are the same account (and the same fingerprint).
 * 400 when what is left is not 6 to 34 letters or digits, or does not end in four digits: the column keeps a
 * numeric last4 (vendor_bank_accounts_last4_check), and showing letters as "the last four digits" would mislead
 * the person who makes the call-back.
 */
export function normalizeAccountNumber(raw: string): { number: string; last4: string } {
  const number = raw.replace(/[\s-]+/g, '').toUpperCase();
  if (!/^[0-9A-Z]{6,34}$/.test(number)) {
    throw new BadRequestException({
      code: 'bad_request',
      message: 'The account number must be 6 to 34 letters or digits',
    });
  }
  const last4 = number.slice(-4);
  if (!/^[0-9]{4}$/.test(last4)) {
    throw new BadRequestException({
      code: 'bad_request',
      message: 'The account number must end in four digits',
    });
  }
  return { number, last4 };
}

/**
 * Strips whitespace from `accountNumber` of a raw request body before the contract parses it (the contract regex
 * refuses spaces, people type them). Anything that is not an object with a string accountNumber passes unchanged.
 */
export function stripAccountSpaces(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const value = (body as { accountNumber?: unknown }).accountNumber;
  if (typeof value !== 'string') return body;
  return { ...body, accountNumber: value.replace(/\s+/g, '') };
}

/** The AAD of a row's ciphertext: a value copied into another row does not decrypt. */
export const bankAccountAad = (id: string): string => `vendor_bank_accounts:${id}`;

/**
 * The internal view: last four digits only, never the number, its ciphertext or its fingerprint. 0032 has no
 * branch, swift or verified_at column, so `branch` and `verifiedAt` are null (reported to the lead); updated_at is
 * not a stand-in for the verification time, as retiring the account changes it.
 */
export function toBankAccountDto(row: BankAccountRow): VendorBankAccountDto {
  return {
    id: row.id,
    vendorPartyId: row.vendorId,
    bankName: row.bankName,
    branch: null,
    accountName: row.accountName,
    accountLast4: row.last4,
    status: row.status,
    proposedVia: row.proposedVia,
    verifiedAt: null,
  };
}

/** What a payment request (A2) copies from the vendor's verified account. No number, no ciphertext. */
export interface VerifiedBankAccountSnapshot {
  id: string;
  vendorPartyId: string;
  bankName: string;
  accountName: string;
  accountLast4: string;
  currency: string;
  verifiedBy: string;
  callbackEvidenceDocumentId: string;
  version: number;
}

export function toSnapshot(row: BankAccountRow): VerifiedBankAccountSnapshot {
  if (
    row.status !== 'active' ||
    row.verifiedBy === null ||
    row.callbackEvidenceDocumentId === null
  ) {
    throw noVerifiedBankAccount();
  }
  return {
    id: row.id,
    vendorPartyId: row.vendorId,
    bankName: row.bankName,
    accountName: row.accountName,
    accountLast4: row.last4,
    currency: row.currency,
    verifiedBy: row.verifiedBy,
    callbackEvidenceDocumentId: row.callbackEvidenceDocumentId,
    version: row.version,
  };
}

/** A document version as the evidence check reads it (DocumentVersionDto has more). */
export interface EvidenceVersion {
  documentId: string;
  version: number;
  status: string;
}

/**
 * True when `documentId` is a live attachment of the account and its newest version that was not rejected is
 * clean: the per-document form of DocumentsService.allClean. `versions` are the account's (listForOwner).
 */
export function evidenceIsClean(versions: readonly EvidenceVersion[], documentId: string): boolean {
  let latest: EvidenceVersion | undefined;
  for (const v of versions) {
    if (v.documentId !== documentId || v.status === 'rejected') continue;
    if (latest === undefined || v.version > latest.version) latest = v;
  }
  return latest?.status === 'clean';
}

export const noVerifiedBankAccount = () =>
  new ConflictException({
    code: 'no_verified_bank_account',
    message: 'The vendor has no verified bank account',
  });

export const evidenceNotClean = () =>
  new ConflictException({
    code: 'callback_evidence_not_clean',
    message:
      'The call-back evidence must be a document of this account whose virus scan came back clean',
  });

export const notProposed = (status: string) =>
  new ConflictException({
    code: 'invalid_transition',
    message: `A bank account in status ${status} cannot be decided`,
  });

export const proposerCannotVerify = () =>
  new ForbiddenException({
    code: 'forbidden',
    message: 'The proposer of a bank account cannot verify it',
    reason: 'separation_of_duties',
  });
