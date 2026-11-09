import type { VendorPortalRfqListItem, VendorPortalRfqView } from '@bos/contracts';

/**
 * Test fixtures for the vendor RFQ screens. Every field is filled, so a test that scans the
 * rendered markup sees everything a view can show. Not imported by any page.
 */

export const RFQ_ID = '3d594650-3436-4a8f-b3a8-1c6a2f9d7e01';

/** 14:00 on 20 Nov 2026 in Kathmandu (UTC+05:45). */
export const RFQ_DEADLINE = '2026-11-20T08:15:00.000Z';

/** A moment well before the sample deadline, and one after it. */
export const BEFORE_DEADLINE = new Date('2026-11-09T06:00:00.000Z');
export const AFTER_DEADLINE = new Date('2026-11-21T06:00:00.000Z');

export function sampleRfqListItem(
  over: Partial<VendorPortalRfqListItem> = {},
): VendorPortalRfqListItem {
  return { id: RFQ_ID, number: 'RFQ-2082-0012', deadline: RFQ_DEADLINE, ...over };
}

export function sampleRfq(over: Partial<VendorPortalRfqView> = {}): VendorPortalRfqView {
  return {
    ...sampleRfqListItem(),
    lines: [
      {
        lineNo: 1,
        description: 'Cat6 patch cable, 3 m, shielded',
        uom: 'pcs',
        quantity: '120.0000',
      },
      {
        lineNo: 2,
        description:
          'Rack-mount managed switch, 48 port gigabit with four SFP+ uplinks and redundant power supply, including five-year onsite warranty',
        uom: 'unit',
        quantity: '2.5000',
      },
    ],
    ...over,
  };
}
