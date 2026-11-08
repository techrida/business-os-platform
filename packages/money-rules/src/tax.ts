// Effective-dated tax codes (C-8) and per-bucket VAT (C-2: rounded once per tax code).
import { allocateLargestRemainder } from './allocate.js';
import { Dec, roundMoney } from './money.js';

export type TaxKind = 'vat' | 'exempt' | 'zero' | 'reverse_charge';

/**
 * One version of a tax code, as one row of the effective-dated `tax_codes` table.
 * `rateBp` is in basis points (1300 = 13%). The version applies on dates from `effectiveFrom`
 * up to, but not including, `effectiveTo`; `null` means open-ended. Dates are ISO `YYYY-MM-DD`
 * business dates (the caller decides the day in Asia/Kathmandu).
 */
export interface TaxCode {
  code: string;
  kind: TaxKind;
  rateBp: number;
  creditable: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface TaxBucket {
  taxCode: TaxCode;
  /** Sum of the taxable amounts of the lines in this bucket. */
  taxable: Dec;
  /** VAT charged on the document for this bucket: 0 unless `kind` is `vat`. */
  vat: Dec;
  /** VAT the recipient accounts for (`reverse_charge` only); not part of the document total. */
  reverseChargeVat: Dec;
}

const ZERO = new Dec(0);
const BASIS_POINTS = new Dec(10000);

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function assertIsoDate(value: string, label: string): void {
  if (!isCalendarDate(value)) {
    throw new RangeError(`${label} is not a calendar date (YYYY-MM-DD): ${value}`);
  }
}

function assertValidVersion(version: TaxCode): void {
  assertIsoDate(version.effectiveFrom, `Tax code ${version.code} effectiveFrom`);
  if (version.effectiveTo !== null) {
    assertIsoDate(version.effectiveTo, `Tax code ${version.code} effectiveTo`);
    if (version.effectiveTo <= version.effectiveFrom) {
      throw new RangeError(`Tax code ${version.code}: effectiveTo must be after effectiveFrom.`);
    }
  }
  if (!Number.isInteger(version.rateBp) || version.rateBp < 0 || version.rateBp > 10000) {
    throw new RangeError(`Tax code ${version.code}: rateBp must be an integer from 0 to 10000.`);
  }
  if ((version.kind === 'exempt' || version.kind === 'zero') && version.rateBp !== 0) {
    throw new RangeError(`Tax code ${version.code}: ${version.kind} must have rateBp 0.`);
  }
}

/** True when the half-open ranges of two versions share a day. */
function overlaps(a: TaxCode, b: TaxCode): boolean {
  const aEndsAfterBStarts = a.effectiveTo === null || a.effectiveTo > b.effectiveFrom;
  const bEndsAfterAStarts = b.effectiveTo === null || b.effectiveTo > a.effectiveFrom;
  return aEndsAfterBStarts && bEndsAfterAStarts;
}

/**
 * Picks the version of `code` in force on `asOf`. Throws when the code is unknown, no version
 * covers the date, or two versions of the code overlap (it never guesses between them).
 */
export function resolveTaxCode(taxCodes: readonly TaxCode[], code: string, asOf: string): TaxCode {
  assertIsoDate(asOf, 'asOf');
  const versions = taxCodes.filter((t) => t.code === code);
  if (versions.length === 0) throw new RangeError(`Unknown tax code: ${code}`);
  versions.forEach(assertValidVersion);
  for (let i = 0; i < versions.length; i += 1) {
    for (let j = i + 1; j < versions.length; j += 1) {
      if (overlaps(versions[i]!, versions[j]!)) {
        throw new RangeError(`Tax code ${code} has overlapping effective-dated versions.`);
      }
    }
  }
  const inForce = versions.find(
    (v) => v.effectiveFrom <= asOf && (v.effectiveTo === null || asOf < v.effectiveTo),
  );
  if (!inForce) throw new RangeError(`Tax code ${code} has no version in force on ${asOf}.`);
  return inForce;
}

function vatOnBucket(taxable: Dec, taxCode: TaxCode): Dec {
  if (taxCode.kind === 'exempt' || taxCode.kind === 'zero') return ZERO;
  return roundMoney(taxable.times(taxCode.rateBp).div(BASIS_POINTS));
}

/**
 * Groups lines by tax code and computes VAT once per bucket on the bucket's sum (per-line
 * rounding can drift by several paisa and the printed "13% of taxable" would no longer check
 * out on a calculator). Bucket VAT is then spread back over the bucket's lines by largest
 * remainder on taxable, for line-level reporting; the line VAT sums to the bucket VAT exactly.
 * Buckets are returned in order of first appearance.
 */
export function computeTaxBuckets(lines: readonly { taxable: Dec; taxCode: TaxCode }[]): {
  buckets: TaxBucket[];
  lineVat: Dec[];
} {
  for (const line of lines) {
    if (line.taxable.isNegative()) throw new RangeError('A taxable amount must not be negative.');
    if (line.taxable.decimalPlaces() > 2) {
      throw new RangeError('A taxable amount has more than 2 decimals.');
    }
  }

  const indexesByCode = new Map<string, number[]>();
  lines.forEach((line, index) => {
    const key = line.taxCode.code;
    indexesByCode.set(key, [...(indexesByCode.get(key) ?? []), index]);
  });

  const buckets: TaxBucket[] = [];
  const lineVat: Dec[] = lines.map(() => ZERO);
  for (const indexes of indexesByCode.values()) {
    const taxCode = lines[indexes[0]!]!.taxCode;
    const taxables = indexes.map((i) => lines[i]!.taxable);
    const taxable = taxables.reduce((sum, t) => sum.plus(t), ZERO);
    const computed = vatOnBucket(taxable, taxCode);
    const vat = taxCode.kind === 'vat' ? computed : ZERO;
    const reverseChargeVat = taxCode.kind === 'reverse_charge' ? computed : ZERO;
    buckets.push({ taxCode, taxable, vat, reverseChargeVat });

    const shares = allocateLargestRemainder(vat, taxables);
    indexes.forEach((lineIndex, k) => {
      lineVat[lineIndex] = shares[k]!;
    });
  }
  return { buckets, lineVat };
}
