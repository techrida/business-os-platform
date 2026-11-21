import type { ReceiptKind } from '@bos/contracts';

import { type CapSource, kindsOffered } from '../../receipts/_lib/model';

/** The order's receipt progress as far as the receive button needs it: each line's room left, and the order's `can`. */
export interface ReceiveProgress {
  lines: readonly (CapSource & { kind: ReceiptKind })[];
  can?: { goods: boolean; service: boolean } | undefined;
}

/**
 * The label of the order's receive button, or null when it is not offered. The order's `can.receive` must allow it,
 * and with the progress known some line must still have room for a kind the person may receive, as the receipts page
 * decides (`kindsOffered`). Only service lines offered: "Receive service". Progress that did not load leaves the
 * decision to `can.receive` and the receipt form.
 */
export function receiveAction(
  mayReceive: boolean,
  progress: ReceiveProgress | undefined,
  grants: { confirm: boolean },
): 'Receive goods' | 'Receive service' | null {
  if (!mayReceive) return null;
  if (progress === undefined) return 'Receive goods';
  const kinds = kindsOffered(progress.lines, grants, progress.can);
  if (kinds.length === 0) return null;
  return kinds.includes('goods') ? 'Receive goods' : 'Receive service';
}
