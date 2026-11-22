// The sales VAT register (round 5, K1; Kuu decision K-M1): the issued tax invoices, credit notes and debit notes of a
// period, by issue date, for the acting legal entity. It mirrors the purchase VAT register (payables/bills): the same
// period filter, the same row-per-document shape and the same BS date column. Two differences, both by design:
//   * a sales document carries its own currency, so totals are kept per currency and never summed across currencies;
//   * the amounts come from the frozen header of the issued document (taxable, VAT, exempt, zero-rated, total), not
//     from a recomputation of its lines, so the register always agrees with the document the customer holds.
// A credit note is stored positive (invoices_amounts_check) and listed negative; a debit note stays positive.
// Each row also carries its NPR equivalents (round 5, FU11; Kuu decision K1 Q3 b): every amount times the rate frozen at
// issue, rounded half-up to two decimals, and the document's own frozen NPR total. The register adds one NPR filing total
// across currencies, the sum of those row values, next to the per-currency totals.
// Proformas, drafts, returned, submitted, approved and discarded documents are not tax documents and never appear.
import {
  CURRENCIES,
  SALES_VAT_REGISTER_KINDS,
  type Currency,
  type SalesVatRegister,
  type SalesVatRegisterNprTotal,
  type SalesVatRegisterRow,
  type SalesVatRegisterTotal,
} from '@bos/contracts';
import { invoices, scoped } from '@bos/db';
import { Dec } from '@bos/money-rules';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, between, eq, inArray } from 'drizzle-orm';

import { DB, type Db } from '../../platform/db/db.module';
import { READ_ONLY, withTx } from '../../platform/db/tx';
import { InvoiceCaller } from './invoice-support';

/** The buyer as frozen at issue (`buyer_snapshot`); a malformed snapshot reads as no name and no PAN. */
function buyerOf(snapshot: unknown): { name: string; pan: string | null } {
  const value = (snapshot ?? {}) as { legalName?: unknown; panVatNo?: unknown };
  const name = typeof value.legalName === 'string' ? value.legalName : '';
  const pan =
    typeof value.panVatNo === 'string' && value.panVatNo.trim() !== '' ? value.panVatNo : null;
  return { name, pan };
}

const zero = () => new Dec(0);

@Injectable()
export class InvoiceVatRegisterService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly caller: InvoiceCaller,
  ) {}

  /** `from` and `to` are inclusive AD issue dates. Entity and tenant scoping come from `scoped(scope)`. */
  async register(from: string, to: string): Promise<SalesVatRegister> {
    const { scope, actor } = this.caller.current();
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        const documents = await tx
          .select({
            id: invoices.id,
            kind: invoices.kind,
            number: invoices.number,
            issueDate: invoices.issueDate,
            issueDateBs: invoices.issueDateBs,
            currency: invoices.currency,
            buyerSnapshot: invoices.buyerSnapshot,
            taxable: invoices.taxableVatAmount,
            vat: invoices.taxAmount,
            exempt: invoices.exemptAmount,
            zeroRated: invoices.zeroRatedAmount,
            total: invoices.total,
            fxRate: invoices.fxRate,
            amountNpr: invoices.amountNpr,
          })
          .from(invoices)
          .where(
            scoped(scope).where(
              invoices,
              and(
                eq(invoices.status, 'issued'),
                inArray(invoices.kind, [...SALES_VAT_REGISTER_KINDS]),
                between(invoices.issueDate, from, to),
              ),
            ),
          )
          .orderBy(asc(invoices.issueDate), asc(invoices.number), asc(invoices.id));

        const sums = new Map<
          Currency,
          {
            n: number;
            taxable: Dec;
            vat: Dec;
            exempt: Dec;
            zeroRated: Dec;
            total: Dec;
          }
        >();
        const npr = {
          n: 0,
          taxable: zero(),
          vat: zero(),
          exempt: zero(),
          zeroRated: zero(),
          total: zero(),
        };
        const rows = documents.map((d): SalesVatRegisterRow => {
          const sign = d.kind === 'credit_note' ? -1 : 1;
          const taxable = new Dec(d.taxable).times(sign);
          const vat = new Dec(d.vat).times(sign);
          const exempt = new Dec(d.exempt).times(sign);
          const zeroRated = new Dec(d.zeroRated).times(sign);
          const total = new Dec(d.total).times(sign);
          const acc = sums.get(d.currency) ?? {
            n: 0,
            taxable: zero(),
            vat: zero(),
            exempt: zero(),
            zeroRated: zero(),
            total: zero(),
          };
          sums.set(d.currency, {
            n: acc.n + 1,
            taxable: acc.taxable.plus(taxable),
            vat: acc.vat.plus(vat),
            exempt: acc.exempt.plus(exempt),
            zeroRated: acc.zeroRated.plus(zeroRated),
            total: acc.total.plus(total),
          });
          // Issued implies a frozen rate and NPR total (invoices_issued_snapshot_check).
          const rate = new Dec(d.fxRate!);
          const nprTotal = new Dec(d.amountNpr!).times(sign);
          // Each bucket converted and rounded half-up; the rounding remainder against the frozen NPR total goes to the largest
          // bucket that has an amount (money rule C-2), so a zero bucket stays zero and the columns add up to the total.
          const buckets = [taxable, vat, exempt, zeroRated];
          const converted = buckets.map((x) => x.times(rate).toDecimalPlaces(2, Dec.ROUND_HALF_UP));
          const remainder = nprTotal.minus(Dec.sum(...converted));
          if (!remainder.isZero()) {
            let target = 0;
            buckets.forEach((x, i) => {
              if (!x.isZero() && (buckets[target]!.isZero() || x.abs().gt(buckets[target]!.abs())))
                target = i;
            });
            converted[target] = converted[target]!.plus(remainder);
          }
          const [nprTaxable, nprVat, nprExempt, nprZeroRated] = converted as [Dec, Dec, Dec, Dec];
          npr.n += 1;
          npr.taxable = npr.taxable.plus(nprTaxable);
          npr.vat = npr.vat.plus(nprVat);
          npr.exempt = npr.exempt.plus(nprExempt);
          npr.zeroRated = npr.zeroRated.plus(nprZeroRated);
          npr.total = npr.total.plus(nprTotal);
          const buyer = buyerOf(d.buyerSnapshot);
          return {
            invoiceId: d.id,
            kind: d.kind as SalesVatRegisterRow['kind'],
            // Issued implies numbered, dated and BS-dated (invoices_issued_check and its siblings).
            number: d.number!,
            issueDate: d.issueDate!,
            issueDateBs: d.issueDateBs!,
            buyerName: buyer.name,
            buyerPan: buyer.pan,
            currency: d.currency,
            taxableAmount: taxable.toFixed(2),
            vatAmount: vat.toFixed(2),
            exemptAmount: exempt.toFixed(2),
            zeroRatedAmount: zeroRated.toFixed(2),
            totalAmount: total.toFixed(2),
            fxRate: d.fxRate!,
            nprTaxableAmount: nprTaxable.toFixed(2),
            nprVatAmount: nprVat.toFixed(2),
            nprExemptAmount: nprExempt.toFixed(2),
            nprZeroRatedAmount: nprZeroRated.toFixed(2),
            nprTotalAmount: nprTotal.toFixed(2),
          };
        });
        const totals = CURRENCIES.filter((c) => sums.has(c)).map(
          (currency): SalesVatRegisterTotal => {
            const s = sums.get(currency)!;
            return {
              currency,
              documents: s.n,
              taxableAmount: s.taxable.toFixed(2),
              vatAmount: s.vat.toFixed(2),
              exemptAmount: s.exempt.toFixed(2),
              zeroRatedAmount: s.zeroRated.toFixed(2),
              totalAmount: s.total.toFixed(2),
            };
          },
        );
        const nprTotal: SalesVatRegisterNprTotal = {
          documents: npr.n,
          taxableAmount: npr.taxable.toFixed(2),
          vatAmount: npr.vat.toFixed(2),
          exemptAmount: npr.exempt.toFixed(2),
          zeroRatedAmount: npr.zeroRated.toFixed(2),
          totalAmount: npr.total.toFixed(2),
        };
        return { from, to, rows, totals, nprTotal };
      },
      READ_ONLY,
    );
  }
}
