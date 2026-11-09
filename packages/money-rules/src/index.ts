// @bos/money-rules: pure money arithmetic for P2 quotations and P3 invoices (C-2). No I/O.
export * from './version.js';
export * from './money.js';
export * from './allocate.js';
export * from './tax.js';
export * from './discount.js';
export * from './fx.js';
export * from './pricing.js';
export { invoiceSlice, splitSchedule, type SliceAmounts } from './schedule.js';
export { creditNoteSlice, type CreditNoteInput } from './notes.js';
