// The vendor portal's RFQ view mappers (P4 unit PV3). Serves the NFR "a vendor sees only what we meant to show": each
// view is built field by field from named inputs and parsed by its strict contract schema, so a row with extra
// columns (estimates, budget code, recommendation, who created it) cannot ride along, and a schema that gains a key
// is caught by portal-vendor-rfq.contract.test.ts.
import {
  VendorPortalRfqListItemSchema,
  VendorPortalRfqViewSchema,
  type VendorPortalRfqListItem,
  type VendorPortalRfqView,
} from '@bos/contracts';

/** What the view reads of an RFQ row. */
export interface RfqSource {
  id: string;
  number: string;
  deadline: Date;
}

/** What the view reads of a line of the RFQ's purchase request (never its estimated price or specification). */
export interface RfqLineSource {
  lineNo: number;
  description: string;
  uom: string;
  quantity: string;
}

/** The list row of one RFQ. */
export function toRfqListItem(src: RfqSource): VendorPortalRfqListItem {
  return VendorPortalRfqListItemSchema.parse({
    id: src.id,
    number: src.number,
    deadline: src.deadline.toISOString(),
  });
}

/** The full view of one RFQ: its header and the lines to quote, in line order. */
export function toRfqView(src: RfqSource, lines: readonly RfqLineSource[]): VendorPortalRfqView {
  return VendorPortalRfqViewSchema.parse({
    id: src.id,
    number: src.number,
    deadline: src.deadline.toISOString(),
    lines: [...lines]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => ({
        lineNo: l.lineNo,
        description: l.description,
        uom: l.uom,
        quantity: l.quantity,
      })),
  });
}
