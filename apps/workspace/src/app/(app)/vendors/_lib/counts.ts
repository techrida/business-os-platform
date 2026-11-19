import { VENDOR_STATUSES, type VendorStatus } from '@bos/contracts';

import { listVendors } from '@/lib/api-vendors';
import type { Session } from '@/lib/session';

/** The groups the list's KPI cards count. Every status falls in exactly one, so the cards add up to the total. */
export type VendorBucket = 'approved' | 'onboarding' | 'inactive';

export const VENDOR_BUCKET: Record<VendorStatus, VendorBucket> = {
  draft: 'onboarding',
  pending_kyc: 'onboarding',
  under_review: 'onboarding',
  approved: 'approved',
  suspended: 'inactive',
  blocked: 'inactive',
  archived: 'inactive',
};

export const VENDOR_BUCKETS: readonly VendorBucket[] = ['approved', 'onboarding', 'inactive'];

export function statusesIn(bucket: VendorBucket): VendorStatus[] {
  return VENDOR_STATUSES.filter((s) => VENDOR_BUCKET[s] === bucket);
}

export type VendorCounts = Record<VendorBucket, number> & { total: number };

/**
 * The vendors this person may read, counted per bucket: one `limit: 1` list call per bucket, read for its
 * `total`, so the API's own scope decides what is counted. Unfiltered on purpose (the cards describe the
 * register, not the search). `null` when any call fails: the cards are then left out, never shown as zero.
 */
export async function countVendorsByBucket(session: Session): Promise<VendorCounts | null> {
  try {
    const totals = await Promise.all(
      VENDOR_BUCKETS.map((bucket) =>
        listVendors(session, { status: statusesIn(bucket), limit: 1 }).then((r) => r.total),
      ),
    );
    const [approved, onboarding, inactive] = totals;
    if (approved === undefined || onboarding === undefined || inactive === undefined) return null;
    return { approved, onboarding, inactive, total: approved + onboarding + inactive };
  } catch {
    return null;
  }
}
