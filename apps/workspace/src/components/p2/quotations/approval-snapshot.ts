import { QuotationApprovalSnapshotSchema, type QuotationApprovalSnapshot } from '@bos/contracts';

/**
 * A discount strictly above this percentage adds the Management approval step. The server decides
 * the route and writes its verdict in `discountApprovalRequired`; this number is only the fallback
 * for the rounded text. It mirrors `DISCOUNT_APPROVAL_THRESHOLD_PCT` in @bos/money-rules, which the
 * workspace does not depend on.
 */
const DISCOUNT_LIMIT_PCT = 12;

/**
 * Reads what the approvers saw (`request.snapshot`, an unknown JSON value) as a quotation
 * snapshot. Null when it is not one: a missing key, a wrong type, a snake_case key or any
 * non-object. The caller then shows the stored values as they are. Nothing is computed here.
 */
export function parseApprovalSnapshot(raw: unknown): QuotationApprovalSnapshot | null {
  const parsed = QuotationApprovalSnapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Whether to highlight the discount: the server's `discountApprovalRequired` flag. It compares the
 * unrounded discount, so it can be true while the stored four-decimal text still reads "12.0000".
 */
export function discountNeedsApproval(snapshot: QuotationApprovalSnapshot): boolean {
  return snapshot.discountApprovalRequired;
}

/** True when the stored four-decimal text is strictly above 12 (so 12.0000 is not). Text only. */
export function exceedsDiscountLimit(effectiveDiscountPct: string): boolean {
  return Number(effectiveDiscountPct) > DISCOUNT_LIMIT_PCT;
}

/** The reason of each approval step, in step order, once each, with blanks left out. */
export function routeReasons(steps: readonly { seq: number; reason: string }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const step of [...steps].sort((a, b) => a.seq - b.seq)) {
    const reason = step.reason.trim();
    if (reason !== '' && !seen.has(reason)) {
      seen.add(reason);
      out.push(reason);
    }
  }
  return out;
}
