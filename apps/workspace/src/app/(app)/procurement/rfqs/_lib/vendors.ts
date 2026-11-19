import 'server-only';

import type { VendorDto } from '@bos/contracts';

import { listVendors } from '@/lib/api-vendors';
import type { Session } from '@/lib/session';

import { rfqFailure } from './failure';

/** What the vendor lookups hand a page: the rows, or the reason there are none (the page degrades, it does not fail). */
export type VendorLookup =
  { vendors: VendorDto[]; problem?: undefined } | { vendors?: undefined; problem: string };

/** The name a person knows a vendor by. */
export const vendorName = (v: Pick<VendorDto, 'legalName' | 'tradeName'>): string =>
  v.tradeName !== null && v.tradeName !== '' ? v.tradeName : v.legalName;

/** One vendor call per page. A failed call is a message, so an RFQ page can still show ids instead. */
export async function loadVendors(session: Session, status?: 'approved'): Promise<VendorLookup> {
  try {
    const list = await listVendors(session, { ...(status ? { status } : {}), limit: 100 });
    return { vendors: list.items };
  } catch (err) {
    return { problem: rfqFailure(err, 'load').message };
  }
}
