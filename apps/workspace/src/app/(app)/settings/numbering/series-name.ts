const NAMES: Record<string, string> = {
  quotation: 'Quotations',
  quote: 'Quotations',
  invoice: 'Invoices',
  memo: 'Memos',
  sales_order: 'Sales orders',
  payment: 'Payments',
  purchase_request: 'Purchase requests',
  purchase_order: 'Purchase orders',
  rfq: 'Requests for quotation',
  receipt: 'Receipts',
  bill: 'Bills',
};

/** A counter's product name ("Quotations"), never its storage key. Unknown keys read as words. */
export function seriesName(key: string): string {
  const known = NAMES[key.toLowerCase().replace(/[.\-\s]+/g, '_')];
  if (known) return known;
  const words = key.replace(/[._-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}
