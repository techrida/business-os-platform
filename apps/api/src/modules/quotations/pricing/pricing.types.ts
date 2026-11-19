// The seam between quotation pricing (Q1a part C) and the units that store, preview and submit a version.
// Field names follow @bos/contracts quotations.ts (QuotationLineInput, Discount); the row types follow the
// quotation_lines, quotation_tax_summary and quotation_versions columns of @bos/db, and the compile-time checks
// at the bottom fail tsc if either drifts. Money is text with exactly 2 decimals, quantity 4, never a number.
import type { Currency, Discount } from '@bos/contracts';
import type { quotationLines, quotationTaxSummary, quotationVersions } from '@bos/db';

import type { DbTransaction } from '../../../platform/db/db.module';
import type { TxScope } from '../../../platform/db/tx';

/** One line to price: QuotationLineInput plus its position. `taxCodeId` may name any period of the code. */
export interface PricingLineInput {
  lineNo: number;
  catalogItemId?: string | null;
  description: string;
  uom: string;
  /** numeric(18,4) text, greater than zero. */
  quantity: string;
  /** numeric(18,2) text, not negative. */
  unitPrice: string;
  /** A tax_codes row id. Pricing re-resolves the code's period in force on `issueDate`. */
  taxCodeId: string;
  /** Internal unit cost, numeric(18,2) text. Absent or null: the margin is unknown (null). */
  unitCost?: string | null;
}

export interface PricingInput {
  currency: Currency;
  /** YYYY-MM-DD. Selects the tax code periods and the FX rate day. */
  issueDate: string;
  /** At least one line. */
  lines: PricingLineInput[];
  /** The one quotation discount (contracts Discount), or none. */
  discount: Discount | null;
}

/** A quotation_lines row without its keys and timestamps. */
export interface PricedLineRow {
  lineNo: number;
  catalogItemId: string | null;
  description: string;
  uom: string;
  /** 4 decimals. */
  quantity: string;
  unitPrice: string;
  unitCost: string | null;
  /** The tax_codes period in force on the issue date (may differ from the input id). */
  taxCodeId: string;
  /** round(quantity x unitPrice, 2). */
  gross: string;
  /** This line's share of the quotation discount. */
  discountAlloc: string;
  /** gross - discountAlloc. */
  taxable: string;
}

/** A quotation_tax_summary row without its keys: one per tax code period, tax rounded once per code. */
export interface TaxSummaryRow {
  taxCodeId: string;
  /** tax_codes.name, copied. */
  label: string;
  /** Percent with 4 decimals (rate_bp / 100), copied. */
  rate: string;
  /** Sum of the taxable amounts of the lines with this code. */
  base: string;
  tax: string;
}

/** The priced quotation_versions columns. */
export interface PricedColumns {
  subtotal: string;
  discountAmount: string;
  /** subtotal - discountAmount. */
  taxableAmount: string;
  taxAmount: string;
  /** taxableAmount + taxAmount. */
  total: string;
  /** numeric(9,4) text; display and storage only, never compared with the 12% threshold. */
  effectiveDiscountPct: string;
  /** NPR total including VAT (C-2: rounded on its own). */
  amountNpr: string;
  /** amountNpr - NPR VAT. */
  nprTaxableAmount: string;
  /** numeric(18,6) text; '1.000000' for NPR. */
  fxRate: string;
  /** Null for NPR; the rate row's source for INR and USD. */
  fxSource: string | null;
  /** Null for NPR; the rate row's date for INR and USD. */
  fxDate: string | null;
  calcVersion: number;
  /** round(sum of quantity x unitCost, 2); null unless every line has a unit cost. */
  internalCostTotal: string | null;
  /**
   * (taxable - sum of rounded line costs) / taxable x 100, 4 decimals; null when the cost is unknown, taxable is 0, or the
   * margin is beyond -999.9999 (facts.marginOutOfRange).
   */
  marginPct: string | null;
}

/** The figures the approval facts provider and the UI need. */
export interface QuoteFacts {
  amountNpr: string;
  /**
   * The discount in NPR: round(discountAmount x fxRate, 2), half up, at the same rate as amountNpr. Equal to
   * discountAmount for NPR. A fact, not a column (quotation_versions has none); the approval snapshot reads it.
   */
  nprDiscountAmount: string;
  /** discount / subtotal x 100, unrounded (full precision). */
  effectiveDiscountPct: string;
  /** Strictly above 12%, decided exactly (not from the rounded text). */
  discountApprovalRequired: boolean;
  /** Null when a cost is missing, taxable is 0, or the margin is out of range. */
  marginPct: string | null;
  /**
   * True when every line has a cost but the margin lies beyond -999.9999 (outside margin_pct numeric(9,4) and the
   * approval snapshot regex); marginPct is then null. False when the margin is known or simply unknown.
   */
  marginOutOfRange: boolean;
  currency: Currency;
}

export interface PricedVersion {
  lines: PricedLineRow[];
  taxSummary: TaxSummaryRow[];
  columns: PricedColumns;
  facts: QuoteFacts;
}

/** PricingService.priceVersion: resolves tax codes and FX inside `tx`, then prices. */
export type PriceVersion = (
  tx: DbTransaction,
  scope: TxScope,
  input: PricingInput,
) => Promise<PricedVersion>;

// ---------------------------------------------------------------------------------------------------------------
// Compile-time ties to the schema: a renamed or retyped column breaks tsc here.
// ---------------------------------------------------------------------------------------------------------------

type Keys = 'id' | 'tenantId' | 'organizationId' | 'versionId' | 'createdAt' | 'updatedAt';
type Assignable<T extends U, U> = T;
/** Errors unless the key list is empty (no row field outside the table). */
type NoExtraKeys<Extra extends never> = Extra;

export type SchemaChecks = [
  Assignable<PricedLineRow, Omit<typeof quotationLines.$inferInsert, Keys>>,
  NoExtraKeys<Exclude<keyof PricedLineRow, keyof typeof quotationLines.$inferInsert>>,
  Assignable<TaxSummaryRow, Omit<typeof quotationTaxSummary.$inferInsert, Keys>>,
  NoExtraKeys<Exclude<keyof TaxSummaryRow, keyof typeof quotationTaxSummary.$inferInsert>>,
  Assignable<PricedColumns, Partial<typeof quotationVersions.$inferInsert>>,
  NoExtraKeys<Exclude<keyof PricedColumns, keyof typeof quotationVersions.$inferInsert>>,
];
