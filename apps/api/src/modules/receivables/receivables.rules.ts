// Pure receivables rules (P3 U8; decisions A8, A13): settlement rows and the aging report, built from what the
// ledger reads return. Nothing here is stored: paid, open and the settlement status are derived on every read.
//
// The contract's aging buckets (current, d1_30, d31_60, d61_90, d91_plus) are coarser than money-rules'
// (current, 1-15, 16-30, 31-60, 61-90, 90+): 1-15 and 16-30 both fold into d1_30.
import {
  type AgingBucket,
  type ArAgingReport,
  type ArAgingRow,
  type Currency,
  type InvoiceKind,
  type InvoiceSettlement,
} from '@bos/contracts';
import { kathmanduDate } from '@bos/locale';
import {
  Dec,
  agingBucket,
  settlementOf,
  type AgingBucket as RuleAgingBucket,
} from '@bos/money-rules';

const DAY_MS = 86_400_000;

const BUCKET_OF_RULE: Readonly<Record<RuleAgingBucket, AgingBucket>> = {
  current: 'current',
  '1-15': 'd1_30',
  '16-30': 'd1_30',
  '31-60': 'd31_60',
  '61-90': 'd61_90',
  '90+': 'd91_plus',
};

type Buckets = Record<AgingBucket, string>;

/** `YYYY-MM-DD` of the Kathmandu day containing `at` (the server's "today", A10). */
export function kathmanduDay(at: Date): string {
  const { y, m, d } = kathmanduDate(at);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** The contract aging bucket of an amount due on `dueDate`, as of `today` (both ISO dates). */
export function contractAgingBucket(dueDate: string, today: string): AgingBucket {
  return BUCKET_OF_RULE[agingBucket(dueDate, today)];
}

/** Whole days after the due date; 0 on or before it. */
export function daysOverdue(dueDate: string, today: string): number {
  const days = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / DAY_MS,
  );
  return Math.max(0, days);
}

export interface SettlementInput {
  invoiceId: string;
  number: string;
  kind: InvoiceKind;
  customerId: string;
  currency: Currency;
  issueDate: string;
  dueDate: string | null;
  /** The invoice total (= its debit item's amount). */
  total: string;
  /** Net of every allocation on the debit item (payments and credit notes, reversals included). */
  allocated: string;
  /** The part of `allocated` whose credit item is a credit note. */
  credited: string;
}

/**
 * One invoice's derived money position. `allocatedAmount` is what payments settled; `openAmount` is the total less
 * payments and credit notes. Without a due date the invoice is due on its issue date.
 */
export function settlementRow(input: SettlementInput, today: string): InvoiceSettlement {
  const total = new Dec(input.total);
  const allocated = new Dec(input.allocated);
  const credited = new Dec(input.credited);
  const open = total.minus(allocated);
  const due = input.dueDate ?? input.issueDate;
  return {
    invoiceId: input.invoiceId,
    number: input.number,
    kind: input.kind,
    customerId: input.customerId,
    currency: input.currency,
    issueDate: input.issueDate,
    total: total.toFixed(2),
    allocatedAmount: allocated.minus(credited).toFixed(2),
    openAmount: open.toFixed(2),
    dueDate: input.dueDate,
    daysOverdue: open.isZero() ? 0 : daysOverdue(due, today),
    settlement: settlementOf({ total, openAmount: open, dueDate: due, today, credited }),
  };
}

export interface AgingItem {
  customerId: string;
  customerName: string;
  currency: Currency;
  /** Above zero. */
  openAmount: string;
  /** The item's due date, or its document date when it has none. */
  dueDate: string;
}

function emptyBuckets(): Record<AgingBucket, InstanceType<typeof Dec>> {
  return {
    current: new Dec(0),
    d1_30: new Dec(0),
    d31_60: new Dec(0),
    d61_90: new Dec(0),
    d91_plus: new Dec(0),
  };
}

function fixed(buckets: Record<AgingBucket, InstanceType<typeof Dec>>): Buckets {
  return {
    current: buckets.current.toFixed(2),
    d1_30: buckets.d1_30.toFixed(2),
    d31_60: buckets.d31_60.toFixed(2),
    d61_90: buckets.d61_90.toFixed(2),
    d91_plus: buckets.d91_plus.toFixed(2),
  };
}

function sumOf(buckets: Record<AgingBucket, InstanceType<typeof Dec>>): string {
  return Object.values(buckets)
    .reduce((acc, v) => acc.plus(v), new Dec(0))
    .toFixed(2);
}

/** The key of an aging row: one customer in one currency. */
export function agingRowKey(customerId: string, currency: Currency): string {
  return `${customerId}|${currency}`;
}

/** An open or missed promise to pay on an invoice that still has an open amount, as the aging read returns it. */
export interface AgingPromise {
  customerId: string;
  currency: Currency;
  status: 'open' | 'missed';
  promisedDate: string;
  invoiceId: string;
  invoiceNumber: string;
}

interface RowPromises {
  missed: AgingPromise | null;
  open: AgingPromise | null;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Same day: the lower invoice number, then id, so the pick never depends on row order. */
const byInvoice = (x: AgingPromise, y: AgingPromise) =>
  cmp(x.invoiceNumber, y.invoiceNumber) || cmp(x.invoiceId, y.invoiceId);

/** Per row key: the missed promise with the latest day and the open promise with the earliest day. */
function promisesByRow(promises: readonly AgingPromise[]): Map<string, RowPromises> {
  const out = new Map<string, RowPromises>();
  for (const p of promises) {
    const key = agingRowKey(p.customerId, p.currency);
    const row = out.get(key) ?? { missed: null, open: null };
    if (p.status === 'missed') {
      const m = row.missed;
      if (
        m === null ||
        cmp(p.promisedDate, m.promisedDate) > 0 ||
        (p.promisedDate === m.promisedDate && byInvoice(p, m) < 0)
      ) {
        row.missed = p;
      }
    } else {
      const o = row.open;
      if (
        o === null ||
        cmp(p.promisedDate, o.promisedDate) < 0 ||
        (p.promisedDate === o.promisedDate && byInvoice(p, o) < 0)
      ) {
        row.open = p;
      }
    }
    out.set(key, row);
  }
  return out;
}

const invoiceRef = (p: AgingPromise | null) =>
  p === null ? null : { id: p.invoiceId, number: p.invoiceNumber };

/**
 * The aging report as of `today`: one row per customer and currency (sorted by customer name, then id, then
 * currency) and one total per currency. Currencies are never added together.
 *
 * `promises` are the open and missed promises to pay on invoices that are still open. F1-Q33: a row with a missed one
 * is flagged `promiseMissed` with the latest missed day and its invoice; a row with an open one shows the earliest
 * open day (the next one due) and its invoice. A promise whose row has no open item makes no row of its own.
 */
export function agingReport(
  items: readonly AgingItem[],
  today: string,
  promises: readonly AgingPromise[] = [],
): ArAgingReport {
  const rows = new Map<
    string,
    {
      head: Pick<ArAgingRow, 'customerId' | 'customerName' | 'currency'>;
      b: ReturnType<typeof emptyBuckets>;
    }
  >();
  const totals = new Map<Currency, ReturnType<typeof emptyBuckets>>();
  for (const item of items) {
    const key = agingRowKey(item.customerId, item.currency);
    let row = rows.get(key);
    if (row === undefined) {
      row = {
        head: {
          customerId: item.customerId,
          customerName: item.customerName,
          currency: item.currency,
        },
        b: emptyBuckets(),
      };
      rows.set(key, row);
    }
    let total = totals.get(item.currency);
    if (total === undefined) {
      total = emptyBuckets();
      totals.set(item.currency, total);
    }
    const bucket = contractAgingBucket(item.dueDate, today);
    row.b[bucket] = row.b[bucket].plus(item.openAmount);
    total[bucket] = total[bucket].plus(item.openAmount);
  }
  const flags = promisesByRow(promises);
  return {
    asOf: today,
    rows: [...rows.values()]
      .sort(
        (x, y) =>
          cmp(x.head.customerName, y.head.customerName) ||
          cmp(x.head.customerId, y.head.customerId) ||
          cmp(x.head.currency, y.head.currency),
      )
      .map(({ head, b }) => {
        const { missed, open } = flags.get(agingRowKey(head.customerId, head.currency)) ?? {
          missed: null,
          open: null,
        };
        return {
          ...head,
          buckets: fixed(b),
          totalOpen: sumOf(b),
          promiseMissed: missed !== null,
          promiseMissedOn: missed?.promisedDate ?? null,
          promiseMissedInvoice: invoiceRef(missed),
          openPromiseDate: open?.promisedDate ?? null,
          openPromiseInvoice: invoiceRef(open),
        };
      }),
    totals: [...totals.entries()]
      .sort(([x], [y]) => cmp(x, y))
      .map(([currency, b]) => ({ currency, buckets: fixed(b), totalOpen: sumOf(b) })),
  };
}
