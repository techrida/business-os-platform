// Two reads that VendorsService and the daily KYC expiry check share: the vendor row under FOR UPDATE, and the
// KYB case of a vendor party. Free functions, so the expiry check can run in the worker without VendorsService
// (which needs VerificationService and so DocumentsModule).
import { vendors, verificationCases } from '@bos/db';
import { and, eq } from 'drizzle-orm';

import { type Db, type DbTransaction } from '../../platform/db/db.module';
import { type KycItem } from './vendors.rules';

export type VendorRow = typeof vendors.$inferSelect;

/** The vendor row under `FOR UPDATE`: lifecycle moves, contacts and accounts of one vendor run one at a time. */
export async function lockVendor(
  tx: DbTransaction,
  tenantId: string,
  id: string,
): Promise<VendorRow | undefined> {
  const [row] = await tx
    .select()
    .from(vendors)
    .where(and(eq(vendors.tenantId, tenantId), eq(vendors.id, id)))
    .for('update');
  return row;
}

/** The KYB case of the vendor party: its status and the checklist items the expiry check reads. */
export async function kybCaseOf(
  q: Db | DbTransaction,
  tenantId: string,
  partyId: string,
): Promise<{ status: string; items: KycItem[] } | undefined> {
  const [row] = await q
    .select({ status: verificationCases.status, checklist: verificationCases.checklist })
    .from(verificationCases)
    .where(and(eq(verificationCases.tenantId, tenantId), eq(verificationCases.partyId, partyId)));
  if (row === undefined) return undefined;
  return {
    status: row.status,
    items: (Array.isArray(row.checklist) ? row.checklist : []) as KycItem[],
  };
}
